// The video card and its encoder, off the audio thread. VideoThread in
// video-thread.ts starts this worker and describes the messages.
import { UnitRing } from "./unit-ring.ts";
import { VideoCard } from "./video-card.ts";
import { VideoFeed } from "./video-feed.ts";
import type { FromVideoWorker, ToVideoWorker } from "./video-thread.ts";

declare const self: Worker;

let card: VideoCard | undefined;
let feed: VideoFeed | undefined;

const send = (message: FromVideoWorker) => self.postMessage(message);

self.addEventListener("message", (event) => {
  const message = (event as MessageEvent<ToVideoWorker>).data;
  if (message.type === "init") {
    const clock = new Float64Array(message.clock);
    const units = new UnitRing(message.units);
    let dropping = false;
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
      (nals, timestamp) => {
        const queued = units.write(nals, timestamp);
        // Say so once per run of drops, not once a frame.
        if (!queued && !dropping)
          send({
            type: "log",
            event: "native_video_dropped",
            message: "Video frames dropped; the audio thread is behind",
            error: "unit queue full",
          });
        dropping = !queued;
      },
      (error) =>
        send({
          type: "log",
          event: "native_video_failed",
          message: "Video encoder stopped",
          error,
        }),
      (pid) => send({ type: "encoder", pid }),
    );
    return;
  }
  if (message.type === "stop") {
    feed?.stop();
    send({ type: "stopped" });
    return;
  }
  if (!card || !feed) return;
  switch (message.type) {
    case "begin_change":
      return card.beginChange(message.artwork);
    case "track":
      return card.setTrack(message.title, message.artist, message.artwork);
    case "reset":
      return card.reset();
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
  }
});
