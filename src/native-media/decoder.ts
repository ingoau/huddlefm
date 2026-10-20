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
  /** Where the input's timestamps start, once known; see FfmpegLog. */
  readonly streamStart?: number;
  close(): void;
}

export type DecoderFactory = (
  url: string,
  startSeconds: number,
  input?: StreamInput,
) => Decoder;

/**
 * How to read a source that plays as it arrives from another server, rather
 * than a prepared file: a live stream, or a Jellyfin item.
 */
export type StreamInput = {
  /** The public network proxy, which keeps the stream off the host network. */
  proxy?: string;
  /** Headers the source asks for, such as its own user agent. */
  headers?: Record<string, string>;
  /** Has no end and no start to seek from; joins where the stream is now. */
  live?: boolean;
  /** The container's stream to take the audio from, when not its default. */
  audioStream?: number;
};

const headerName = /^[A-Za-z0-9-]+$/;

/** ffmpeg's options for opening `url` at `startSeconds`, then `-i url`. */
export function inputArgs(
  url: string,
  startSeconds: number,
  input?: StreamInput,
) {
  const headers = Object.entries(input?.headers ?? {}).filter(
    ([name, value]) =>
      headerName.test(name) &&
      name.toLowerCase() !== "user-agent" &&
      !/[\r\n]/.test(value),
  );
  const userAgent = Object.entries(input?.headers ?? {}).find(
    ([name, value]) =>
      name.toLowerCase() === "user-agent" && !/[\r\n]/.test(value),
  )?.[1];
  return [
    ...(startSeconds > 0 && !input?.live
      ? ["-ss", startSeconds.toFixed(3)]
      : []),
    ...(input?.proxy ? ["-http_proxy", input.proxy] : []),
    ...(input && /^https?:/i.test(url)
      ? [
          // A short drop on the far end's connection is picked up again
          // instead of ending the item.
          "-reconnect",
          "1",
          "-reconnect_streamed",
          "1",
          "-reconnect_on_network_error",
          "1",
          "-reconnect_delay_max",
          "10",
          "-rw_timeout",
          "30000000",
        ]
      : []),
    ...(userAgent ? ["-user_agent", userAgent] : []),
    ...(headers.length
      ? [
          "-headers",
          headers.map(([name, value]) => `${name}: ${value}\r\n`).join(""),
        ]
      : []),
    "-i",
    url,
  ];
}

const logLevel = /\[(panic|fatal|error|warning|info|verbose|debug|trace)\] ?/;

/**
 * Reads ffmpeg's log as it runs (`-loglevel level+info`), so a long stream
 * never fills the pipe: keeps where the input's timestamps start, which lines
 * up two decoders that joined a live stream at different points, and the
 * last error, for when it fails.
 */
export class FfmpegLog {
  /** The input's first timestamp, in seconds, once ffmpeg has opened it. */
  start: number | undefined;
  lastError: string | undefined;
  readonly done: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.done = this.read(stream).catch(() => {});
  }

  /** Takes in one line of the log. */
  line(line: string) {
    const level = logLevel.exec(line);
    const text = (
      level ? line.slice(level.index + level[0].length) : line
    ).trim();
    if (!text) return;
    if (this.start === undefined) {
      const start = /^Duration: .*?\bstart: (-?\d+(?:\.\d+)?)/.exec(text);
      if (start) this.start = Number(start[1]);
    }
    if (!level || ["panic", "fatal", "error"].includes(level[1]!))
      this.lastError = text;
  }

  private async read(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let pending = "";
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) this.line(line);
    }
    if (pending) this.line(pending);
  }
}

/** ffmpeg's leading options: quiet, but logging levels for FfmpegLog. */
export const ffmpegLogArgs = [
  "-nostdin",
  "-hide_banner",
  "-nostats",
  "-loglevel",
  "level+info",
];

/** Finds how long a track's file really runs, in seconds. */
export type DurationProbe = (
  url: string,
  signal: AbortSignal,
) => Promise<number | undefined>;

/**
 * Reads the file's own duration with ffprobe, which is what the page's
 * <audio> element reports: the length listed for a track can be off by a
 * second or more.
 */
export async function probeDuration(url: string, signal: AbortSignal) {
  const probe = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      url,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 15_000,
      signal,
    },
  );
  const [output, exitCode] = await Promise.all([
    new Response(probe.stdout).text(),
    probe.exited,
  ]);
  const seconds = Number(output.trim());
  return exitCode === 0 && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : undefined;
}

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
  private log: FfmpegLog;
  private finished = false;
  private closed = false;
  error: string | undefined;

  constructor(
    url: string,
    startSeconds: number,
    input?: StreamInput,
    // A stream keeps more ahead, to ride out a slow patch on the far end.
    private aheadFrames = sampleRate * (input ? 30 : 10),
  ) {
    this.process = Bun.spawn(
      [
        "ffmpeg",
        ...ffmpegLogArgs,
        ...inputArgs(url, startSeconds, input),
        ...(input?.audioStream !== undefined
          ? ["-map", `0:${input.audioStream}`]
          : []),
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
    this.log = new FfmpegLog(this.process.stderr);
    void this.pump();
  }

  /** Where the input's timestamps start, once known; see FfmpegLog. */
  get streamStart() {
    return this.log.start;
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
      await this.log.done;
      this.error = this.log.lastError || `ffmpeg exited with ${exitCode}`;
    }
    this.finished = true;
  }
}
