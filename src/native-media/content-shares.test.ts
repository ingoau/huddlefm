import { expect, test } from "bun:test";
import { ContentShares } from "./content-shares.ts";
import type { SignalFrame } from "./signaling.ts";

const streams = (
  ...entries: {
    audio_stream_id: number;
    attendee_id?: string;
    muted?: boolean;
  }[]
) =>
  ({
    type: "AUDIO_STREAM_ID_INFO",
    audio_stream_id_info: { streams: entries },
  }) as SignalFrame;

test("counts other people's screen shares, not the bot's own", () => {
  const counts: number[] = [];
  const shares = new ContentShares("bot", (count) => counts.push(count));
  shares.handle(
    streams(
      { audio_stream_id: 1, attendee_id: "alex" },
      { audio_stream_id: 2, attendee_id: "alex#content" },
      { audio_stream_id: 3, attendee_id: "bot#content" },
    ),
  );
  expect(shares.count).toBe(1);
  shares.handle(streams({ audio_stream_id: 4, attendee_id: "sam#content" }));
  expect(shares.count).toBe(2);
  // A stream with neither an attendee nor a mute state has left.
  shares.handle(streams({ audio_stream_id: 2 }));
  expect(shares.count).toBe(1);
  // A mute change is not a departure.
  shares.handle(streams({ audio_stream_id: 4, muted: true }));
  expect(shares.count).toBe(1);
  shares.reset();
  expect(counts).toEqual([1, 2, 1, 0]);
});
