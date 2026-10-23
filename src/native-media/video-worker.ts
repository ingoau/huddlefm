// The video card, the screen share and their encoders, off the audio thread.
// VideoThread in video-thread.ts starts this worker and describes the
// messages.
import { ProgressBarOverlay } from "./progress-bar.ts";
import { UnitRing } from "./unit-ring.ts";
import { VideoCard } from "./video-card.ts";
import { VideoFeed, wideCardInput } from "./video-feed.ts";
import { FfmpegFrameDecoder, VideoPlayer } from "./video-player.ts";
import type { FromVideoWorker, ToVideoWorker } from "./video-thread.ts";

declare const self: Worker;

/** How often the share checks whether to show the video or the card. */
const shareCheckMs = 100;

/** The camera tile's square card, and the screen share's wide one. */
let cards: VideoCard[] = [];
let feed: VideoFeed | undefined;
let share: Share | undefined;

const send = (message: FromVideoWorker) => self.postMessage(message);

/** Queues encoded video, saying so once per run of drops. */
function sink(units: UnitRing, stream: string) {
  let dropping = false;
  return (nals: Buffer[], timestamp: number) => {
    const queued = units.write(nals, timestamp);
    if (!queued && !dropping)
      send({
        type: "log",
        event: "native_video_dropped",
        message: "Video frames dropped; the audio thread is behind",
        error: `${stream} unit queue full`,
      });
    dropping = !queued;
  };
}

/**
 * The screen share's picture: the playing video when there is one with a
 * frame decoded, and otherwise the wide card, which fills the 16:9 frame.
 * Each has its own encoder, since their raw frames differ, and they take
 * turns on one stream with one timestamp base.
 */
class Share {
  private on = false;
  private progressBar = true;
  private overlay: ProgressBarOverlay;
  private showing: "card" | "video" | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly player: VideoPlayer;
  private cardFeed: VideoFeed;
  private videoFeed: VideoFeed;

  constructor(
    format: Extract<ToVideoWorker, { type: "init" }>["share"],
    private clock: Float64Array,
    videoCard: VideoCard,
    units: UnitRing,
  ) {
    const epoch = performance.now();
    this.overlay = new ProgressBarOverlay(format);
    const write = sink(units, "share");
    const failed = (error: string) =>
      send({
        type: "log",
        event: "native_share_video_failed",
        message: "Screen share encoder stopped",
        error,
      });
    const encoder = (pid: number | undefined) =>
      send({ type: "share_encoder", pid });
    this.player = new VideoPlayer(
      format,
      (error) =>
        send({
          type: "log",
          event: "native_video_playback_failed",
          message: "Video could not be decoded; showing the card",
          error,
        }),
      (url, start, subtitles, input) =>
        new FfmpegFrameDecoder(
          url,
          start,
          subtitles,
          format,
          (pid) => send({ type: "player_decoder", pid }),
          input,
        ),
    );
    this.cardFeed = new VideoFeed(
      () => videoCard.rgba(),
      write,
      failed,
      encoder,
      { input: wideCardInput, format, epoch },
    );
    this.videoFeed = new VideoFeed(() => this.frame(), write, failed, encoder, {
      input: {
        width: format.width,
        height: format.height,
        pixelFormat: "yuv420p",
      },
      format,
      epoch,
    });
  }

  setOn(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    clearInterval(this.timer);
    this.timer = undefined;
    if (on) {
      this.timer = setInterval(() => this.check(), shareCheckMs);
      this.check();
    } else {
      this.show(undefined);
      this.player.release();
      this.overlay.clear();
    }
  }

  setProgressBar(on: boolean) {
    this.progressBar = on;
  }

  requestKeyframe() {
    if (this.showing === "video") this.videoFeed.requestKeyframe();
    else if (this.showing === "card") this.cardFeed.requestKeyframe();
  }

  stop() {
    this.setOn(false);
    this.player.stop();
  }

  private position() {
    const position = this.clock[0]!;
    return Number.isNaN(position) ? undefined : position;
  }

  private key() {
    const key = this.clock[2]!;
    return Number.isNaN(key) ? undefined : key;
  }

  private duration() {
    const duration = this.clock[1]!;
    return Number.isNaN(duration) ? undefined : duration;
  }

  private audioStart() {
    const start = this.clock[3]!;
    return Number.isNaN(start) ? undefined : start;
  }

  /**
   * The video's frame for where the audio is. A live stream's picture is
   * only lined up, and so only shown, by where the audio's timestamps start.
   */
  private videoFrame() {
    return this.player.frame(this.position(), this.key(), this.audioStart());
  }

  /** The video's frame, with the progress bar over it when that is on. */
  private frame() {
    const frame = this.videoFrame();
    const position = this.position();
    const duration = this.duration();
    if (
      !frame ||
      !this.progressBar ||
      this.player.live ||
      // The clock can reach the next entry before its video does.
      this.player.key !== this.key() ||
      position === undefined ||
      !duration
    )
      return frame;
    return this.overlay.over(frame, position / duration);
  }

  // Keeps the decoder going while the card is up, so the video can take over
  // as soon as its first frame is ready.
  private check() {
    if (!this.on) return;
    if (this.player.key !== undefined && this.showing !== "video")
      this.videoFrame();
    const video =
      this.player.ready &&
      this.player.key !== undefined &&
      this.player.key === this.key();
    this.show(video ? "video" : "card");
  }

  private show(which: "card" | "video" | undefined) {
    if (which === this.showing) return;
    this.showing = which;
    if (which !== "card") this.cardFeed.stop();
    if (which !== "video") this.videoFeed.stop();
    if (which === "card") this.cardFeed.start();
    if (which === "video") this.videoFeed.start();
  }
}

self.addEventListener("message", (event) => {
  const message = (event as MessageEvent<ToVideoWorker>).data;
  if (message.type === "init") {
    const clock = new Float64Array(message.clock);
    const card = (wide: boolean) =>
      new VideoCard(
        () =>
          Number.isNaN(clock[0]!)
            ? undefined
            : {
                position: clock[0]!,
                duration: Number.isNaN(clock[1]!) ? undefined : clock[1],
              },
        (error) =>
          send({
            type: "log",
            event: "native_artwork_failed",
            message: "Artwork failed to load",
            error,
          }),
        { lyricsOffset: message.lyricsOffset, wide },
      );
    const videoCard = card(false);
    const shareCard = card(true);
    cards = [videoCard, shareCard];
    feed = new VideoFeed(
      () => videoCard.rgba(),
      sink(new UnitRing(message.units), "camera"),
      (error) =>
        send({
          type: "log",
          event: "native_video_failed",
          message: "Video encoder stopped",
          error,
        }),
      (pid) => send({ type: "encoder", pid }),
    );
    share = new Share(
      message.share,
      clock,
      shareCard,
      new UnitRing(message.shareUnits),
    );
    return;
  }
  if (message.type === "stop") {
    feed?.stop();
    share?.stop();
    send({ type: "stopped" });
    return;
  }
  if (!cards.length || !feed || !share) return;
  switch (message.type) {
    case "begin_change":
      for (const card of cards) card.beginChange(message.artwork);
      return;
    case "track":
      for (const card of cards)
        card.setTrack(message.title, message.artist, message.artwork);
      return;
    case "reset":
      for (const card of cards) card.reset(message.idle);
      return;
    case "display_mode":
      for (const card of cards) card.setDisplayMode(message.mode);
      return;
    case "lyrics":
      for (const card of cards) card.setLyrics(message.lines, message.credits);
      return;
    case "lyrics_unavailable":
      for (const card of cards) card.setLyricsUnavailable();
      return;
    case "video":
      return message.on ? feed.start() : feed.stop();
    case "keyframe":
      return feed.requestKeyframe();
    case "share":
      return share.setOn(message.on);
    case "share_source":
      return share.player.setSource(message.source);
    case "captions":
      return share.player.setCaptions(message.on);
    case "progress_bar":
      return share.setProgressBar(message.on);
    case "share_keyframe":
      return share.requestKeyframe();
  }
});
