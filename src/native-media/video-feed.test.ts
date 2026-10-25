import { describe, expect, test } from "bun:test";
import { cardSize, shareFormat } from "./video-format.ts";
import { cardInput, encoderArgs, VideoFeed } from "./video-feed.ts";

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

test("leaves frames out while the encoder has not taken the last one", async () => {
  // Far more than a pipe holds, to an encoder that reads nothing for a while.
  const frame = Buffer.alloc(4_000_000);
  let asked = 0;
  const feed = new VideoFeed(
    () => {
      asked++;
      return Buffer.from(frame);
    },
    () => {},
    () => {},
    undefined,
    { command: ["sh", "-c", "sleep 0.4; cat > /dev/null"] },
  );
  feed.start();
  try {
    await Bun.sleep(300);
    // Ticking at 24 a second, but only the first frame was asked for.
    expect(asked).toBe(1);
    await Bun.sleep(400);
    expect(asked).toBeGreaterThan(1);
  } finally {
    feed.stop();
  }
});

test("the screen share is 16:9 at the configured height, within Chime's levels", () => {
  expect(shareFormat()).toEqual({
    width: 1280,
    height: 720,
    fps: 30,
    maxKbps: 2_488,
    profileLevelId: "42e01f",
  });
  expect(shareFormat({ maxHeight: 1080, maxFps: 30 })).toMatchObject({
    width: 1920,
    height: 1080,
    maxKbps: 4_000,
    profileLevelId: "42e028",
  });
  expect(shareFormat({ maxHeight: 480, maxFps: 24 })).toMatchObject({
    width: 854,
    height: 480,
    fps: 24,
  });
});

test("the card is scaled into the share's frame, and a video's frames are not", () => {
  const share = shareFormat();
  const card = encoderArgs(cardInput, share);
  expect(card).toContain(
    "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
  );
  expect(card).toContain("2488k");
  const video = encoderArgs(
    { width: 1280, height: 720, pixelFormat: "yuv420p" },
    share,
  );
  expect(video).not.toContain("-vf");
  expect(video).toContain("yuv420p");
  expect(video[video.indexOf("-g") + 1]).toBe("60");
});
