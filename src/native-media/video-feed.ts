import { AnnexBSplitter } from "./rtp.ts";
import { cardSize } from "./video-card.ts";

/**
 * Smooth enough for the lyrics and the layout swaps, and a fifth cheaper than
 * the page's 30.
 */
export const videoFps = 24;
/** The Chime JS SDK's default ceiling for a camera. */
export const videoMaxKbps = 1_400;
/** An unchanged frame is skipped, but one still goes out this often. */
const keepAliveMs = 500;
/** Seconds between keyframes, so a new viewer gets a picture quickly. */
const keyframeSeconds = 2;

/**
 * ffmpeg's arguments: raw RGBA in, stamped with the wall clock as it arrives
 * so frames can be skipped, and H.264 constrained baseline out, with keyframes
 * on the clock rather than every so many frames.
 */
export function encoderArgs(size = cardSize) {
  return [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${size}x${size}`,
    "-use_wallclock_as_timestamps",
    "1",
    "-i",
    "pipe:0",
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
    `${videoMaxKbps}k`,
    "-bufsize",
    `${videoMaxKbps}k`,
    "-force_key_frames",
    `expr:gte(t,n_forced*${keyframeSeconds})`,
    "-g",
    String(videoFps * keyframeSeconds),
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
 * Encodes card frames with ffmpeg and hands out access units with 90 kHz
 * timestamps. A frame the card did not redraw is not sent again, which leaves
 * a still card a couple of frames a second instead of the full rate.
 */
export class VideoFeed {
  private encoder?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = 0;
  private sent: Buffer | undefined;
  private sentAt = 0;

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
    const encoder = Bun.spawn(encoderArgs(), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.encoder = encoder;
    this.startedAt = performance.now();
    void this.read(encoder);
    void encoder.exited.then(async (code) => {
      if (this.encoder !== encoder) return;
      this.stop();
      const stderr = await new Response(encoder.stderr).text().catch(() => "");
      this.onError(
        stderr.trim().split("\n").at(-1) || `video encoder exited with ${code}`,
      );
    });
    this.sent = undefined;
    this.timer = setInterval(() => {
      try {
        const frame = this.frame();
        const now = performance.now();
        if (frame === this.sent && now - this.sentAt < keepAliveMs) return;
        this.sent = frame;
        this.sentAt = now;
        encoder.stdin.write(frame);
        void encoder.stdin.flush();
      } catch {}
    }, 1_000 / videoFps);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
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
        for (const nals of splitter.push(value))
          this.onAccessUnit(
            nals,
            Math.round((performance.now() - this.startedAt) * 90) >>> 0,
          );
      }
    } catch {}
  }
}
