import { AnnexBSplitter } from "./rtp.ts";
import { cardSize } from "./video-card.ts";

/** The card changes at most every few hundred milliseconds. */
export const videoFps = 5;

/**
 * Encodes card frames to H.264 constrained baseline with ffmpeg and hands out
 * access units with 90 kHz timestamps. A two-second keyframe interval lets a
 * participant who asks for a picture (PLI) recover without an encoder restart.
 */
export class VideoFeed {
  private encoder?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = 0;

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
    this.timer = setInterval(() => {
      try {
        encoder.stdin.write(this.frame());
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
