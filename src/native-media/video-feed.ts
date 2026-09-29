import { AnnexBSplitter } from "./rtp.ts";
import { cardSize } from "./video-card.ts";

/** The card changes at most every few hundred milliseconds. */
export const videoFps = 5;
/** Keyframe requests this soon after a keyframe wait out the rest. */
const minKeyframeGapMs = 500;

/**
 * Encodes card frames to H.264 constrained baseline with ffmpeg and hands out
 * access units with 90 kHz timestamps. Keyframes come every two seconds, and
 * sooner when a viewer asks for one (PLI) through `requestKeyframe`.
 */
export class VideoFeed {
  private encoder?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private timer?: ReturnType<typeof setInterval>;
  // One timestamp base for every encoder this feed runs, so a restart
  // continues the stream instead of jumping back to zero.
  private readonly epoch = performance.now();
  private keyframeAt = 0;
  private awaitingKeyframe = false;
  private keyframeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private frame: () => Buffer,
    private onAccessUnit: (nals: Buffer[], timestamp: number) => void,
    private onError: (message: string) => void,
  ) {}

  get running() {
    return Boolean(this.encoder);
  }

  start() {
    if (this.encoder) return;
    const encoder = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
        `${cardSize}x${cardSize}`,
        "-r",
        String(videoFps),
        "-i",
        "pipe:0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "baseline",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "28",
        "-maxrate",
        "600k",
        "-bufsize",
        "1200k",
        "-g",
        String(videoFps * 2),
        "-bf",
        "0",
        "-x264-params",
        "aud=1:repeat-headers=1",
        "-f",
        "h264",
        "pipe:1",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    this.encoder = encoder;
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
        encoder.stdin.write(this.frame());
        void encoder.stdin.flush();
      } catch {}
    };
    // The first frame goes in now rather than a tick later, so the opening
    // keyframe is out as soon as ffmpeg is.
    write();
    this.timer = setInterval(write, 1_000 / videoFps);
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
