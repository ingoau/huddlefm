import { AnnexBSplitter } from "./rtp.ts";
import {
  cameraFormat,
  cardSize,
  wideCardWidth,
  type VideoFormat,
} from "./video-format.ts";
/** An unchanged frame is skipped, but one still goes out this often. */
const keepAliveMs = 500;
/** Seconds between keyframes, so a new viewer gets a picture quickly. */
const keyframeSeconds = 2;
/** Keyframe requests this soon after a keyframe wait out the rest. */
const minKeyframeGapMs = 500;

/** The raw frames a feed hands its encoder. */
export type FeedInput = {
  width: number;
  height: number;
  pixelFormat: "rgba" | "yuv420p";
};

/** The card's frames, as the camera tile sends them. */
export const cardInput: FeedInput = {
  width: cardSize,
  height: cardSize,
  pixelFormat: "rgba",
};

/** The wide card's frames, as the screen share sends them. */
export const wideCardInput: FeedInput = {
  width: wideCardWidth,
  height: cardSize,
  pixelFormat: "rgba",
};

/** Bytes in one raw frame of `input`. */
export function frameBytes(input: FeedInput) {
  return input.pixelFormat === "rgba"
    ? input.width * input.height * 4
    : (input.width * input.height * 3) / 2;
}

/**
 * ffmpeg's arguments: raw frames in, stamped with the wall clock as they
 * arrive so frames can be skipped, and H.264 constrained baseline out, with
 * keyframes on the clock rather than every so many frames. Input of another
 * size is scaled to fit the output and centred on black.
 */
export function encoderArgs(
  input: FeedInput = cardInput,
  format: VideoFormat = cameraFormat,
) {
  const resized =
    input.width !== format.width || input.height !== format.height;
  return [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    input.pixelFormat,
    "-s",
    `${input.width}x${input.height}`,
    "-use_wallclock_as_timestamps",
    "1",
    "-i",
    "pipe:0",
    ...(resized
      ? [
          "-vf",
          `scale=${format.width}:${format.height}:force_original_aspect_ratio=decrease,pad=${format.width}:${format.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        ]
      : []),
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    // superfast on one thread: about a quarter less CPU than veryfast with
    // sliced threads, at the same quality and a few percent more bits.
    "-preset",
    "superfast",
    "-threads",
    "1",
    "-tune",
    "zerolatency",
    "-profile:v",
    "baseline",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "26",
    "-maxrate",
    `${format.maxKbps}k`,
    "-bufsize",
    `${format.maxKbps}k`,
    "-force_key_frames",
    `expr:gte(t,n_forced*${keyframeSeconds})`,
    "-g",
    String(format.fps * keyframeSeconds),
    "-bf",
    "0",
    "-x264-params",
    "aud=1:repeat-headers=1",
    "-f",
    "h264",
    "pipe:1",
  ];
}

/**
 * Encodes frames, the card's or a video's, with ffmpeg and hands out access
 * units with 90 kHz timestamps. A frame that did not change is not sent
 * again, which leaves a still card a couple of frames a second instead of
 * the full rate.
 * Keyframes come every two seconds, and sooner when a viewer asks for one
 * (PLI) through `requestKeyframe`.
 */
export class VideoFeed {
  private encoder?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private timer?: ReturnType<typeof setInterval>;
  private input: FeedInput;
  private format: VideoFormat;
  // One timestamp base for every encoder this feed runs, so a restart
  // continues the stream instead of jumping back to zero. Feeds that take
  // turns on one stream share it.
  private readonly epoch: number;
  private keyframeAt = 0;
  private awaitingKeyframe = false;
  private keyframeTimer?: ReturnType<typeof setTimeout>;
  private sent: Buffer | undefined;
  private sentAt = 0;

  constructor(
    /** The frame to send now, or undefined to send nothing new. */
    private frame: () => Buffer | undefined,
    private onAccessUnit: (nals: Buffer[], timestamp: number) => void,
    private onError: (message: string) => void,
    /** The running encoder's pid, or undefined once there is none. */
    private onEncoder: (pid: number | undefined) => void = () => {},
    options: {
      input?: FeedInput;
      format?: VideoFormat;
      epoch?: number;
    } = {},
  ) {
    this.input = options.input ?? cardInput;
    this.format = options.format ?? cameraFormat;
    this.epoch = options.epoch ?? performance.now();
  }

  get running() {
    return Boolean(this.encoder);
  }

  start() {
    if (this.encoder) return;
    const encoder = Bun.spawn(encoderArgs(this.input, this.format), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.encoder = encoder;
    this.onEncoder(encoder.pid);
    this.awaitingKeyframe = true;
    void this.read(encoder);
    void encoder.exited.then(async (code) => {
      if (this.encoder !== encoder) return;
      this.stop();
      const stderr = await new Response(encoder.stderr).text().catch(() => "");
      this.onError(
        stderr.trim().split("\n").at(-1) || `video encoder exited with ${code}`,
      );
    });
    const write = () => {
      try {
        const frame = this.frame();
        if (!frame) return;
        const now = performance.now();
        if (frame === this.sent && now - this.sentAt < keepAliveMs) return;
        this.sent = frame;
        this.sentAt = now;
        encoder.stdin.write(frame);
        void encoder.stdin.flush();
      } catch {}
    };
    // The first frame goes in now rather than a tick later, even if the card
    // has not changed, so the opening keyframe is out as soon as ffmpeg is.
    this.sent = undefined;
    write();
    this.timer = setInterval(write, 1_000 / this.format.fps);
  }

  /**
   * Answers a viewer's request for a full picture. ffmpeg cannot be told to
   * make a keyframe mid-stream, but a new encoder opens with one, so this
   * restarts it. Requests that arrive while that keyframe is still coming, or
   * together from several viewers, share one restart.
   */
  requestKeyframe() {
    if (!this.encoder || this.awaitingKeyframe || this.keyframeTimer) return;
    const wait = this.keyframeAt + minKeyframeGapMs - performance.now();
    this.keyframeTimer = setTimeout(
      () => {
        this.keyframeTimer = undefined;
        if (!this.encoder) return;
        this.stop();
        this.start();
      },
      Math.max(0, wait),
    );
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.keyframeTimer);
    this.keyframeTimer = undefined;
    const encoder = this.encoder;
    this.encoder = undefined;
    if (!encoder) return;
    this.onEncoder(undefined);
    try {
      void encoder.stdin.end();
    } catch {}
    encoder.kill();
  }

  private async read(encoder: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    const splitter = new AnnexBSplitter();
    const reader = encoder.stdout.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const nals of splitter.push(value)) {
          // A replaced encoder's last frames would corrupt the new stream.
          if (this.encoder !== encoder) return;
          if (nals.some((nal) => (nal[0]! & 0x1f) === 5)) {
            // Any keyframe, scheduled or requested, answers pending requests.
            this.awaitingKeyframe = false;
            this.keyframeAt = performance.now();
            clearTimeout(this.keyframeTimer);
            this.keyframeTimer = undefined;
          }
          this.onAccessUnit(
            nals,
            Math.round((performance.now() - this.epoch) * 90) >>> 0,
          );
        }
      }
    } catch {}
  }
}
