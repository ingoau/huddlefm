import type { Lyric } from "@braccato/core";
import type { LyricsCredits } from "./lyrics-view.ts";
import { UnitRing } from "./unit-ring.ts";
import type { CardProgress, DisplayMode } from "./video-card.ts";
import { shareFormat, type VideoFormat } from "./video-format.ts";
import type { VideoSource } from "./video-player.ts";

/** What the card says when nothing is playing. */
export type IdleText = { title: string; subtitle: string };

/** What the audio thread tells the video worker. */
export type ToVideoWorker =
  | {
      type: "init";
      clock: SharedArrayBuffer;
      units: SharedArrayBuffer;
      shareUnits: SharedArrayBuffer;
      share: VideoFormat;
      lyricsOffset: number;
    }
  | { type: "begin_change"; artwork?: string }
  | { type: "track"; title: string; artist: string; artwork?: string }
  | { type: "reset"; idle?: IdleText }
  | { type: "display_mode"; mode: DisplayMode }
  | { type: "lyrics"; lines: Lyric[]; credits: LyricsCredits }
  | { type: "lyrics_unavailable" }
  | { type: "video"; on: boolean }
  | { type: "keyframe" }
  | { type: "share"; on: boolean }
  | { type: "share_source"; source: VideoSource | undefined }
  | { type: "captions"; on: boolean }
  | { type: "share_keyframe" }
  | { type: "stop" };

/** What the video worker tells the audio thread. */
export type FromVideoWorker =
  | { type: "log"; event: string; message: string; error: string }
  // A worker that dies cannot stop its ffmpeg, so this thread keeps its pid.
  | { type: "encoder"; pid: number | undefined }
  | { type: "share_encoder"; pid: number | undefined }
  | { type: "player_decoder"; pid: number | undefined }
  | { type: "stopped" };

export type VideoThreadEvents = {
  onAccessUnit(nals: Buffer[], timestamp: number): void;
  /** Encoded video for the screen share. */
  onShareUnit?(nals: Buffer[], timestamp: number): void;
  log(event: string, message: string, fields: Record<string, unknown>): void;
};

/** A worker that dies sooner than this after starting is left dead. */
const minWorkerLifeMs = 5_000;
/** How long stop() waits for the worker to shut its encoder down. */
const stopTimeoutMs = 1_000;

/**
 * The video card, the screen share and their encoders, run in a worker so
 * drawing, decoding and encoding never hold up the audio pacer on this
 * thread. Stands in for the card and the feeds with the same calls. Anything
 * that happens every frame goes through shared memory instead of messages,
 * which Bun makes costly at that rate: the playback position one way, the
 * encoded video (see UnitRing) the other, both on the audio pacer's tick.
 *
 * If the worker dies it is started again with the track, lyrics, display
 * mode, share and video state it had, unless it keeps dying straight away.
 */
export class VideoThread {
  private worker: Worker | undefined;
  private startedAt = 0;
  private stopping: Promise<void> | undefined;
  private pids = new Map<FromVideoWorker["type"], number>();
  // position and duration in seconds, then which entry they belong to; NaN
  // when there is no track.
  private clock = new Float64Array(new SharedArrayBuffer(24)).fill(Number.NaN);
  private units = new UnitRing();
  private shareUnits = new UnitRing();
  private state: {
    mode?: DisplayMode;
    track?: Extract<ToVideoWorker, { type: "track" }>;
    lyrics?: Extract<
      ToVideoWorker,
      { type: "lyrics" } | { type: "lyrics_unavailable" }
    >;
    idle?: IdleText;
    video: boolean;
    share: boolean;
    source?: VideoSource;
    captions: boolean;
  } = { video: false, share: false, captions: false };

  constructor(
    private lyricsOffset: number,
    private events: VideoThreadEvents,
    private minLifeMs = minWorkerLifeMs,
    /** The size and rate the screen share is sent at. */
    private share: VideoFormat = shareFormat(),
  ) {
    this.spawn();
  }

  /**
   * Called on the pacer's tick: hands the worker the playback position and
   * which entry it is on, and sends on the video encoded since the last tick.
   */
  tick(progress: CardProgress | undefined, key?: number) {
    this.clock[0] = progress ? progress.position : Number.NaN;
    this.clock[1] = progress?.duration ?? Number.NaN;
    this.clock[2] = progress && key !== undefined ? key : Number.NaN;
    this.units.drain((nals, timestamp) =>
      this.events.onAccessUnit(nals, timestamp),
    );
    this.shareUnits.drain((nals, timestamp) =>
      this.events.onShareUnit?.(nals, timestamp),
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

  /** Shows the idle card, saying `idle` or the usual words. */
  reset(idle?: IdleText) {
    this.state.track = undefined;
    this.state.lyrics = undefined;
    this.state.idle = idle;
    this.send({ type: "reset", idle });
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

  /** Starts or stops encoding the screen share. */
  setShare(on: boolean) {
    if (on === this.state.share) return;
    this.state.share = on;
    this.send({ type: "share", on });
  }

  /** The video the share shows, or none for the card. */
  setShareSource(source: VideoSource | undefined) {
    this.state.source = source;
    this.send({ type: "share_source", source });
  }

  setCaptions(on: boolean) {
    if (on === this.state.captions) return;
    this.state.captions = on;
    this.send({ type: "captions", on });
  }

  requestShareKeyframe() {
    this.send({ type: "share_keyframe" });
  }

  /** Stops the encoders, then the worker. */
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
      this.killProcesses();
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
      shareUnits: this.shareUnits.buffer,
      share: this.share,
      lyricsOffset: this.lyricsOffset,
    } satisfies ToVideoWorker);
    // A replacement picks up where the last one was.
    const { mode, track, lyrics, idle, video, share, source, captions } =
      this.state;
    if (mode) worker.postMessage({ type: "display_mode", mode });
    if (track) worker.postMessage(track);
    else if (idle) worker.postMessage({ type: "reset", idle });
    if (track && lyrics) worker.postMessage(lyrics);
    if (captions) worker.postMessage({ type: "captions", on: true });
    if (source) worker.postMessage({ type: "share_source", source });
    if (video) worker.postMessage({ type: "video", on: true });
    if (share) worker.postMessage({ type: "share", on: true });
  }

  private died(worker: Worker, reason: string) {
    if (worker !== this.worker || this.stopping) return;
    this.worker = undefined;
    worker.terminate();
    this.killProcesses();
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

  private killProcesses() {
    // SIGKILL: ffmpeg only looks at SIGTERM between reads, and a dead worker
    // leaves its pipes open, so it would wait on them forever.
    for (const pid of this.pids.values())
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    this.pids.clear();
  }

  private receive(message: FromVideoWorker) {
    if (
      message.type === "encoder" ||
      message.type === "share_encoder" ||
      message.type === "player_decoder"
    ) {
      if (message.pid === undefined) this.pids.delete(message.type);
      else this.pids.set(message.type, message.pid);
    } else if (message.type === "log")
      this.events.log(message.event, message.message, {
        error: message.error,
      });
  }
}
