import { describe, expect, test } from "bun:test";
import { cardSize } from "./video-card.ts";
import { VideoFeed } from "./video-feed.ts";

const hasFfmpeg = Boolean(Bun.which("ffmpeg"));

describe("video feed", () => {
  test.skipIf(!hasFfmpeg)(
    "answers keyframe requests with one prompt keyframe",
    async () => {
      const frame = Buffer.alloc(cardSize * cardSize * 4, 40);
      const units: { at: number; keyframe: boolean; timestamp: number }[] = [];
      const firstKeyframe = Promise.withResolvers<void>();
      const startedAt = performance.now();
      const feed = new VideoFeed(
        () => frame,
        (nals, timestamp) => {
          const keyframe = nals.some((nal) => (nal[0]! & 0x1f) === 5);
          units.push({
            at: performance.now() - startedAt,
            keyframe,
            timestamp,
          });
          if (keyframe) firstKeyframe.resolve();
        },
        (message) => firstKeyframe.reject(new Error(message)),
      );
      feed.start();
      let requestedAt = 0;
      try {
        await firstKeyframe.promise;
        requestedAt = performance.now() - startedAt;
        // Several viewers asking at once share one restart.
        feed.requestKeyframe();
        feed.requestKeyframe();
        feed.requestKeyframe();
        await Bun.sleep(1_500);
      } finally {
        feed.stop();
      }
      const answers = units.filter(
        (unit) => unit.keyframe && unit.at >= requestedAt,
      );
      // The scheduled one would not come until two seconds after the first.
      expect(answers).toHaveLength(1);
      expect(answers[0]!.at - requestedAt).toBeLessThan(1_200);
      const timestamps = units.map((unit) => unit.timestamp);
      expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    },
    10_000,
  );
});
