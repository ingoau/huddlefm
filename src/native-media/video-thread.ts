import type { Lyric } from "@braccato/core";
import type { LyricsCredits } from "./lyrics-view.ts";
import { UnitRing } from "./unit-ring.ts";
import type { CardProgress, DisplayMode } from "./video-card.ts";

/** What the audio thread tells the video worker. */
export type ToVideoWorker =
  | {
      type: "init";
      clock: SharedArrayBuffer;
      units: SharedArrayBuffer;
      lyricsOffset: number;
    }
  | { type: "begin_change"; artwork?: string }
  | { type: "track"; title: string; artist: string; artwork?: string }
  | { type: "reset" }
  | { type: "display_mode"; mode: DisplayMode }
  | { type: "lyrics"; lines: Lyric[]; credits: LyricsCredits }
  | { type: "lyrics_unavailable" }
  | { type: "video"; on: boolean }
  | { type: "keyframe" }
  | { type: "stop" };

/** What the video worker tells the audio thread. */
export type FromVideoWorker =
  | { type: "log"; event: string; message: string; error: string }
  // A worker that dies cannot stop its ffmpeg, so this thread keeps its pid.
  | { type: "encoder"; pid: number | undefined }
  | { type: "stopped" };

export type VideoThreadEvents = {
  onAccessUnit(nals: Buffer[], timestamp: number): void;
  log(event: string, message: string, fields: Record<string, unknown>): void;
};

/** A worker that dies sooner than this after starting is left dead. */
const minWorkerLifeMs = 5_000;
/** How long stop() waits for the worker to shut its encoder down. */
const stopTimeoutMs = 1_000;

/**
 * The video card and its encoder, run in a worker so drawing never holds up
 * the audio pacer on this thread. Stands in for the card and the feed with
 * the same calls. Anything that happens every frame goes through shared
 * memory instead of messages, which Bun makes costly at that rate: the
 * playback position one way, the encoded video (see UnitRing) the other, both
 * on the audio pacer's tick.
 *
 * If the worker dies it is started again with the track, lyrics, display mode
 * and video state it had, unless it keeps dying straight away.
 */
export class VideoThread {
  private worker: Worker | undefined;
  private startedAt = 0;
  private stopping: Promise<void> | undefined;
  private encoderPid: number | undefined;
  // position and duration in seconds; NaN when there is no track.
  private clock = new Float64Array(new SharedArrayBuffer(16)).fill(Number.NaN);
  private units = new UnitRing();
  private state: {
    mode?: DisplayMode;
    track?: Extract<ToVideoWorker, { type: "track" }>;
    lyrics?: Extract<
      ToVideoWorker,
      { type: "lyrics" } | { type: "lyrics_unavailable" }
    >;
    video: boolean;
  } = { video: false };

  constructor(
    private lyricsOffset: number,
    private events: VideoThreadEvents,
    private minLifeMs = minWorkerLifeMs,
  ) {
    this.spawn();
  }

  /**
   * Called on the pacer's tick: hands the worker the playback position and
   * sends on the video it has encoded since the last tick.
   */
  tick(progress: CardProgress | undefined) {
    this.clock[0] = progress ? progress.position : Number.NaN;
    this.clock[1] = progress?.duration ?? Number.NaN;
    this.units.drain((nals, timestamp) =>
      this.events.onAccessUnit(nals, timestamp),
    );
  }

  beginChange(artwork?: string) {
    this.state.track = undefined;
    this.state.lyrics = undefined;
    this.send({ type: "begin_change", artwork });
  }

  setTrack(title: string, artist: string, artwork?: string) {
    this.state.track = { type: "track", title, artist, artwork };
    this.state.lyrics = undefined;
    this.send(this.state.track);
  }

  reset() {
    this.state.track = undefined;
    this.state.lyrics = undefined;
    this.send({ type: "reset" });
  }

  setDisplayMode(mode: DisplayMode) {
    this.state.mode = mode;
    this.send({ type: "display_mode", mode });
  }

  setLyrics(lines: Lyric[], credits: LyricsCredits = {}) {
    this.state.lyrics = { type: "lyrics", lines, credits };
    this.send(this.state.lyrics);
  }

  setLyricsUnavailable() {
    this.state.lyrics = { type: "lyrics_unavailable" };
    this.send(this.state.lyrics);
  }

  /** Starts or stops encoding and sending the tile. */
  setVideo(on: boolean) {
    if (on === this.state.video) return;
    this.state.video = on;
    this.send({ type: "video", on });
  }

  requestKeyframe() {
    this.send({ type: "keyframe" });
  }

  /** Stops the encoder, then the worker. */
  stop() {
    this.stopping ??= (async () => {
      const worker = this.worker;
      if (!worker) return;
      const stopped = Promise.withResolvers<void>();
      worker.addEventListener("message", (event) => {
        if ((event as MessageEvent<FromVideoWorker>).data.type === "stopped")
          stopped.resolve();
      });
      worker.addEventListener("close", () => stopped.resolve());
      worker.postMessage({ type: "stop" } satisfies ToVideoWorker);
      await Promise.race([stopped.promise, Bun.sleep(stopTimeoutMs)]);
      worker.terminate();
      this.worker = undefined;
      this.killEncoder();
    })();
    return this.stopping;
  }

  private send(message: ToVideoWorker) {
    if (!this.stopping) this.worker?.postMessage(message);
  }

  private spawn() {
    const worker = new Worker(new URL("./video-worker.ts", import.meta.url));
    this.worker = worker;
    this.startedAt = performance.now();
    worker.addEventListener("message", (event) =>
      this.receive((event as MessageEvent<FromVideoWorker>).data),
    );
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.died(worker, (event as ErrorEvent).message);
    });
    worker.addEventListener("close", () => this.died(worker, "worker exited"));
    worker.postMessage({
      type: "init",
      clock: this.clock.buffer as SharedArrayBuffer,
      units: this.units.buffer,
      lyricsOffset: this.lyricsOffset,
    } satisfies ToVideoWorker);
    // A replacement picks up where the last one was.
    const { mode, track, lyrics, video } = this.state;
    if (mode) worker.postMessage({ type: "display_mode", mode });
    if (track) worker.postMessage(track);
    if (track && lyrics) worker.postMessage(lyrics);
    if (video) worker.postMessage({ type: "video", on: true });
  }

  private died(worker: Worker, reason: string) {
    if (worker !== this.worker || this.stopping) return;
    this.worker = undefined;
    worker.terminate();
    this.killEncoder();
    const again = performance.now() - this.startedAt >= this.minLifeMs;
    this.events.log(
      "native_video_worker_died",
      again
        ? "Video worker died; starting it again"
        : "Video worker died straight after starting; the tile stays off",
      { error: reason },
    );
    if (again) this.spawn();
  }

  private killEncoder() {
    const pid = this.encoderPid;
    this.encoderPid = undefined;
    if (pid === undefined) return;
    // SIGKILL: ffmpeg only looks at SIGTERM between reads, and a dead worker
    // leaves its input pipe open, so it would wait on that read forever.
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  private receive(message: FromVideoWorker) {
    if (message.type === "encoder") this.encoderPid = message.pid;
    else if (message.type === "log")
      this.events.log(message.event, message.message, {
        error: message.error,
      });
  }
}
