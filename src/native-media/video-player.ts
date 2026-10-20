import { frameBytes, type FeedInput } from "./video-feed.ts";

/** A video for the screen share: the playing entry's file, and its captions. */
export type VideoSource = {
  /** Which entry the playback clock must be on for this to show. */
  key: number;
  url: string;
  /** An SRT file to burn in while captions are on. */
  subtitles?: string;
};

export type PlayerFormat = { width: number; height: number; fps: number };

/** Decoded frames the player keeps ahead of what it shows. */
const aheadFrames = 12;
/** A jump this far ahead of what is decoded seeks instead of catching up. */
const seekAheadSeconds = 5;
/** A jump back further than this seeks. */
const seekBackSeconds = 1;

// Captions in a plain subtitle style, unlike the lyrics: white on a
// semi-transparent black box at the bottom, in the Noto Sans the image has.
// Sizes are in the subtitles filter's 384x288 script space.
const captionStyle = [
  "FontName=Noto Sans",
  "Fontsize=18",
  "PrimaryColour=&H00FFFFFF",
  "OutlineColour=&H59000000",
  "BackColour=&H59000000",
  "BorderStyle=3",
  "Outline=2",
  "Shadow=0",
  "Alignment=2",
  "MarginV=14",
].join(",");

// Paths go into an ffmpeg filter graph, where quotes, colons, commas and
// backslashes mean something. Prepared files never have them.
const safeFilterPath = /^[\w./-]+$/;

/** The filter graph that turns a video into the share's frames. */
export function playerFilter(
  format: PlayerFormat,
  startSeconds: number,
  subtitles?: string,
) {
  const { width, height, fps } = format;
  return [
    // -ss before -i restarts the clock at zero; the subtitles need it on the
    // video's own timeline.
    ...(startSeconds > 0 ? [`setpts=PTS+${startSeconds.toFixed(3)}/TB`] : []),
    `fps=${fps}`,
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    ...(subtitles && safeFilterPath.test(subtitles)
      ? [`subtitles=filename='${subtitles}':force_style='${captionStyle}'`]
      : []),
    // Back to zero, or ffmpeg pads the gap before the first frame with copies
    // of it.
    ...(startSeconds > 0 ? ["setpts=PTS-STARTPTS"] : []),
    "format=yuv420p",
  ].join(",");
}

export function decoderArgs(
  url: string,
  format: PlayerFormat,
  startSeconds: number,
  subtitles?: string,
) {
  return [
    "ffmpeg",
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    ...(startSeconds > 0 ? ["-ss", startSeconds.toFixed(3)] : []),
    "-i",
    url,
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-vf",
    playerFilter(format, startSeconds, subtitles),
    // The fps filter already made the frames even; nothing to add or drop.
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    "pipe:1",
  ];
}

/** Raw frames of one video, from `start` seconds at a fixed frame rate. */
export interface FrameDecoder {
  /** Where the first frame is, in seconds. */
  readonly start: number;
  /** Decoded frames not yet taken, oldest first, numbered from the start. */
  readonly frames: { index: number; data: Buffer }[];
  /** The number of the last frame decoded so far, or -1. */
  readonly decoded: number;
  /** Every frame has been decoded. */
  readonly finished: boolean;
  /** Why decoding failed, once it has. */
  readonly error: string | undefined;
  close(): void;
}

export type FrameDecoderFactory = (
  url: string,
  startSeconds: number,
  subtitles: string | undefined,
) => FrameDecoder;

/** Decodes a video's frames with ffmpeg, a few ahead of where they show. */
export class FfmpegFrameDecoder implements FrameDecoder {
  readonly frames: { index: number; data: Buffer }[] = [];
  decoded = -1;
  finished = false;
  error: string | undefined;
  private closed = false;
  private process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  private frameSize: number;

  constructor(
    url: string,
    readonly start: number,
    subtitles: string | undefined,
    format: PlayerFormat,
    /** The running ffmpeg's pid, or undefined once it is gone. */
    private onProcess: (pid: number | undefined) => void = () => {},
  ) {
    const input: FeedInput = { ...format, pixelFormat: "yuv420p" };
    this.frameSize = frameBytes(input);
    this.process = Bun.spawn(decoderArgs(url, format, start, subtitles), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    onProcess(this.process.pid);
    void this.process.exited.then(() => {
      if (!this.closed) this.onProcess(undefined);
    });
    void this.pump();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.frames.length = 0;
    this.process.kill();
    this.onProcess(undefined);
  }

  private async pump() {
    const reader = this.process.stdout.getReader();
    let frame = Buffer.allocUnsafe(this.frameSize);
    let filled = 0;
    try {
      while (!this.closed) {
        while (!this.closed && this.frames.length >= aheadFrames)
          await Bun.sleep(5);
        if (this.closed) break;
        const { value, done } = await reader.read();
        if (done) break;
        let offset = 0;
        while (offset < value.length) {
          const take = Math.min(this.frameSize - filled, value.length - offset);
          frame.set(value.subarray(offset, offset + take), filled);
          filled += take;
          offset += take;
          if (filled === this.frameSize) {
            this.frames.push({ index: ++this.decoded, data: frame });
            frame = Buffer.allocUnsafe(this.frameSize);
            filled = 0;
          }
        }
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

/**
 * The picture for the screen share while a video plays. Follows the audio's
 * playback clock rather than its own: each call names where the audio is, and
 * gets the frame for that moment, so pausing, seeking and a slow start all
 * stay in step with what is heard. Seeks restart the decoder there; a frame
 * that is not decoded yet leaves the last one up.
 */
export class VideoPlayer {
  private source: VideoSource | undefined;
  private captions = false;
  private decoder: FrameDecoder | undefined;
  private current: Buffer | undefined;
  private shownIndex = -1;
  private lastPosition = 0;
  private failedKey: number | undefined;

  constructor(
    private format: PlayerFormat,
    private onError: (message: string) => void,
    private factory: FrameDecoderFactory = (url, start, subtitles) =>
      new FfmpegFrameDecoder(url, start, subtitles, format),
  ) {}

  /** A frame is up for the current source. */
  get ready() {
    return Boolean(this.current) && this.failedKey !== this.source?.key;
  }

  get key() {
    return this.source?.key;
  }

  setSource(source: VideoSource | undefined) {
    if (
      source?.key === this.source?.key &&
      source?.url === this.source?.url &&
      source?.subtitles === this.source?.subtitles
    )
      return;
    this.closeDecoder();
    this.source = source;
    this.current = undefined;
    this.shownIndex = -1;
    this.lastPosition = 0;
  }

  setCaptions(on: boolean) {
    if (on === this.captions) return;
    this.captions = on;
    // Captions are burned in, so the decoder starts again with or without
    // them where the picture is.
    if (this.decoder) this.restart(this.lastPosition);
  }

  /**
   * The frame for `position` seconds into the entry `key` is playing, or the
   * last one shown while that frame is still being decoded.
   */
  frame(position: number | undefined, key: number | undefined) {
    const source = this.source;
    if (!source || key !== source.key || position === undefined)
      return this.current;
    if (this.failedKey === source.key) return undefined;
    this.lastPosition = position;
    let decoder = this.decoder;
    if (decoder?.error) {
      this.failedKey = source.key;
      this.onError(decoder.error);
      this.closeDecoder();
      return undefined;
    }
    const target = decoder
      ? Math.floor((position - decoder.start) * this.format.fps + 1e-6)
      : -1;
    // Half a second of slack: the clock can read a little before where the
    // decoder was started.
    if (
      !decoder ||
      target < -this.format.fps / 2 ||
      target < this.shownIndex - seekBackSeconds * this.format.fps ||
      (!decoder.finished &&
        target > decoder.decoded + seekAheadSeconds * this.format.fps)
    ) {
      decoder = this.restart(position);
      return this.current;
    }
    const frames = decoder.frames;
    while (frames.length && frames[0]!.index <= target) {
      const next = frames.shift()!;
      this.current = next.data;
      this.shownIndex = next.index;
    }
    return this.current;
  }

  /** Lets the decoder go while nothing shows the video; it starts again. */
  release() {
    this.closeDecoder();
    this.current = undefined;
    this.shownIndex = -1;
  }

  stop() {
    this.release();
    this.source = undefined;
  }

  private restart(position: number) {
    this.closeDecoder();
    const source = this.source!;
    const start = Math.max(0, position);
    this.decoder = this.factory(
      source.url,
      start,
      this.captions ? source.subtitles : undefined,
    );
    this.shownIndex = -1;
    return this.decoder;
  }

  private closeDecoder() {
    this.decoder?.close();
    this.decoder = undefined;
  }
}
