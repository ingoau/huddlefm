// The video card, the screen share and their encoders, off the audio thread.
// VideoThread in video-thread.ts starts this worker and describes the
// messages.
import { UnitRing } from "./unit-ring.ts";
import { VideoCard } from "./video-card.ts";
import { VideoFeed, cardInput } from "./video-feed.ts";
import { FfmpegFrameDecoder, VideoPlayer } from "./video-player.ts";
import type { FromVideoWorker, ToVideoWorker } from "./video-thread.ts";

declare const self: Worker;

/** How often the share checks whether to show the video or the card. */
const shareCheckMs = 100;

let card: VideoCard | undefined;
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
 * frame decoded, and otherwise the card, scaled into the 16:9 frame. Each has
 * its own encoder, since their raw frames differ, and they take turns on one
 * stream with one timestamp base.
 */
class Share {
  private on = false;
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
      { input: cardInput, format, epoch },
    );
    this.videoFeed = new VideoFeed(
      () => this.player.frame(this.position(), this.key(), this.audioStart()),
      write,
      failed,
      encoder,
      {
        input: {
          width: format.width,
          height: format.height,
          pixelFormat: "yuv420p",
        },
        format,
        epoch,
      },
    );
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
    }
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

  private audioStart() {
    const start = this.clock[3]!;
    return Number.isNaN(start) ? undefined : start;
  }

  // Keeps the decoder going while the card is up, so the video can take over
  // as soon as its first frame is ready.
  private check() {
    if (!this.on) return;
    if (this.player.key !== undefined && this.showing !== "video")
      this.player.frame(this.position(), this.key());
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
    const videoCard = new VideoCard(
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
      { lyricsOffset: message.lyricsOffset },
    );
    card = videoCard;
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
      videoCard,
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
  if (!card || !feed || !share) return;
  switch (message.type) {
    case "begin_change":
      return card.beginChange(message.artwork);
    case "track":
      return card.setTrack(message.title, message.artist, message.artwork);
    case "reset":
      return card.reset(message.idle);
    case "display_mode":
      return card.setDisplayMode(message.mode);
    case "lyrics":
      return card.setLyrics(message.lines, message.credits);
    case "lyrics_unavailable":
      return card.setLyricsUnavailable();
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
    case "share_keyframe":
      return share.requestKeyframe();
  }
});
