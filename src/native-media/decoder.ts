export const sampleRate = 48_000;
/** Bytes in one interleaved stereo float frame. */
const frameBytes = 8;

/** A source of interleaved 48 kHz stereo float samples for one track. */
export interface Decoder {
  /** Copies up to `frames` frames into the start of `out`; returns how many. */
  read(out: Float32Array, frames: number): number;
  /** Decoded frames waiting to be read. */
  readonly bufferedFrames: number;
  /** Decoding finished cleanly and every frame has been read. */
  readonly drained: boolean;
  /** Why decoding failed, once it has. */
  readonly error: string | undefined;
  close(): void;
}

export type DecoderFactory = (url: string, startSeconds: number) => Decoder;

/** Queued sample chunks, read from the front. */
export class SampleQueue {
  private chunks: Float32Array[] = [];
  private offset = 0;
  frames = 0;

  push(chunk: Float32Array) {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.frames += chunk.length / 2;
  }

  read(out: Float32Array, frames: number) {
    let written = 0;
    while (written < frames && this.chunks.length) {
      const chunk = this.chunks[0]!;
      const take = Math.min(frames - written, (chunk.length - this.offset) / 2);
      out.set(chunk.subarray(this.offset, this.offset + take * 2), written * 2);
      written += take;
      this.offset += take * 2;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    this.frames -= written;
    return written;
  }

  clear() {
    this.chunks = [];
    this.offset = 0;
    this.frames = 0;
  }
}

/**
 * Decodes one track with ffmpeg into 48 kHz stereo floats, starting at
 * `startSeconds`. It decodes ahead of playback but stops reading at about ten
 * seconds, so a long track never sits in memory whole.
 */
export class FfmpegDecoder implements Decoder {
  private queue = new SampleQueue();
  private process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  private finished = false;
  private closed = false;
  error: string | undefined;

  constructor(
    url: string,
    startSeconds: number,
    private aheadFrames = sampleRate * 10,
  ) {
    this.process = Bun.spawn(
      [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        ...(startSeconds > 0 ? ["-ss", startSeconds.toFixed(3)] : []),
        "-i",
        url,
        "-vn",
        "-f",
        "f32le",
        "-ac",
        "2",
        "-ar",
        String(sampleRate),
        "pipe:1",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    void this.pump();
  }

  get bufferedFrames() {
    return this.queue.frames;
  }

  get drained() {
    return this.finished && !this.error && this.queue.frames === 0;
  }

  read(out: Float32Array, frames: number) {
    return this.queue.read(out, frames);
  }

  close() {
    this.closed = true;
    this.queue.clear();
    this.process.kill();
  }

  private async pump() {
    const reader = this.process.stdout.getReader();
    let remainder = new Uint8Array(0);
    try {
      while (!this.closed) {
        while (!this.closed && this.queue.frames >= this.aheadFrames)
          await Bun.sleep(40);
        if (this.closed) break;
        const { value, done } = await reader.read();
        if (done) break;
        const bytes = remainder.length
          ? Buffer.concat([remainder, value])
          : value;
        const usable = bytes.length - (bytes.length % frameBytes);
        const samples = new Float32Array(usable / 4);
        new Uint8Array(samples.buffer).set(bytes.subarray(0, usable));
        this.queue.push(samples);
        remainder = bytes.slice(usable);
      }
    } catch (error) {
      if (!this.closed) this.error = String(error);
    }
    if (this.closed) return;
    const exitCode = await this.process.exited;
    if (exitCode !== 0 && !this.closed) {
      const stderr = await new Response(this.process.stderr)
        .text()
        .catch(() => "");
      this.error =
        stderr.trim().split("\n").at(-1) || `ffmpeg exited with ${exitCode}`;
    }
    this.finished = true;
  }
}
