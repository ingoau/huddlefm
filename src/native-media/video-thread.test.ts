import { describe, expect, test } from "bun:test";
import { VideoThread } from "./video-thread.ts";

const hasFfmpeg = Boolean(Bun.which("ffmpeg"));

function thread(minLifeMs?: number) {
  const units: { keyframe: boolean; bytes: number }[] = [];
  const logs: string[] = [];
  let arrived = Promise.withResolvers<void>();
  const video = new VideoThread(
    0,
    {
      onAccessUnit(nals) {
        units.push({
          keyframe: nals.some((nal) => (nal[0]! & 0x1f) === 5),
          bytes: nals.reduce((sum, nal) => sum + nal.length, 0),
        });
        arrived.resolve();
      },
      log: (event) => logs.push(event),
    },
    minLifeMs,
  );
  // The pacer's tick, which hands over the position and collects the video.
  let progress: { position: number; duration: number } | undefined;
  const ticker = setInterval(() => video.tick(progress), 10);
  const stop = video.stop.bind(video);
  video.stop = () => {
    clearInterval(ticker);
    return stop();
  };
  return {
    video,
    setProgress(value: typeof progress) {
      progress = value;
    },
    units,
    logs,
    /** Resolves on the next access unit after this call. */
    next() {
      arrived = Promise.withResolvers<void>();
      return Promise.race([
        arrived.promise,
        Bun.sleep(5_000).then(() => {
          throw new Error("no video from the worker");
        }),
      ]);
    },
  };
}

describe("video thread", () => {
  test.skipIf(!hasFfmpeg)(
    "draws and encodes in the worker, and stops cleanly",
    async () => {
      const { video, units, next, setProgress } = thread();
      try {
        setProgress({ position: 12, duration: 170 });
        video.setTrack("APT.", "ROSÉ & Bruno Mars");
        const first = next();
        video.setVideo(true);
        await first;
        expect(units[0]!.keyframe).toBe(true);
        expect(units[0]!.bytes).toBeGreaterThan(0);
        const asked = units.length;
        video.requestKeyframe();
        await Bun.sleep(1_200);
        expect(units.slice(asked).some((unit) => unit.keyframe)).toBe(true);
      } finally {
        await video.stop();
      }
      const stoppedAt = units.length;
      await Bun.sleep(700);
      expect(units.length).toBe(stoppedAt);
    },
    15_000,
  );

  test.skipIf(!hasFfmpeg)(
    "a worker that dies is replaced with the video it was sending",
    async () => {
      const { video, units, logs, next } = thread(0);
      try {
        video.setTrack("APT.", "ROSÉ & Bruno Mars");
        const first = next();
        video.setVideo(true);
        await first;
        const orphan = (video as any).encoderPid as number;
        (video as any).worker.terminate();
        await Bun.sleep(100);
        // The dead worker's ffmpeg is killed, not left running.
        const state = await Bun.file(`/proc/${orphan}/stat`)
          .text()
          .then((stat) => stat.slice(stat.lastIndexOf(")") + 2)[0])
          .catch(() => "gone");
        expect(["Z", "X", "gone"]).toContain(state!);
        const before = units.length;
        await next();
        expect(logs).toContain("native_video_worker_died");
        expect(units.length).toBeGreaterThan(before);
      } finally {
        await video.stop();
      }
    },
    15_000,
  );
});
