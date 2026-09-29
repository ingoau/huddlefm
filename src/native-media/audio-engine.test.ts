import { describe, expect, test } from "bun:test";
import { AudioEngine } from "./audio-engine.ts";
import { sampleRate, type Decoder, type DurationProbe } from "./decoder.ts";

class FakeDecoder implements Decoder {
  closed = false;
  error: string | undefined;
  /** Frames that may be read right now; Infinity means decoding keeps up. */
  available = Infinity;

  constructor(
    readonly url: string,
    readonly start: number,
    private remaining: number,
    private value = 0.1,
  ) {}

  get bufferedFrames() {
    return Math.min(this.remaining, this.available, sampleRate * 10);
  }

  get drained() {
    return this.remaining === 0 && !this.error;
  }

  read(out: Float32Array, frames: number) {
    const count = Math.max(0, Math.min(frames, this.remaining, this.available));
    out.fill(this.value, 0, count * 2);
    this.remaining -= count;
    if (Number.isFinite(this.available)) this.available -= count;
    return count;
  }

  close() {
    this.closed = true;
  }
}

function setup(trackSeconds = 30, probe?: DurationProbe) {
  const events: { type: string; details?: any }[] = [];
  const decoders: FakeDecoder[] = [];
  const engine = new AudioEngine(
    (url, start) => {
      const decoder = new FakeDecoder(
        url,
        start,
        Math.max(0, Math.round((trackSeconds - start) * sampleRate)),
      );
      decoders.push(decoder);
      return decoder;
    },
    (type, details) => events.push({ type, details }),
    probe,
  );
  const run = (seconds: number) => {
    for (let frame = 0; frame < seconds * 50; frame++) engine.render(960);
  };
  const of = (type: string) => events.filter((event) => event.type === type);
  return { engine, events, decoders, run, of };
}

const play = (entryId: string, extra: Record<string, unknown> = {}) => ({
  type: "play",
  entryId,
  url: `http://127.0.0.1/audio/${entryId}`,
  title: "Title",
  artist: "Artist",
  duration: 30,
  ...extra,
});

describe("AudioEngine", () => {
  test("plays a track, reports positions like timeupdate, and ends", () => {
    const { engine, run, of } = setup(12);
    engine.handle(play("a", { duration: 12 }));
    expect(of("playing")).toEqual([
      { type: "playing", details: { entryId: "a" } },
    ]);
    run(13);
    const seconds = of("playback_position").map((event) =>
      Math.floor(event.details.seconds),
    );
    // Every two seconds from a last reported second of -1, like the page.
    expect(seconds).toEqual([1, 3, 5, 7, 9, 11]);
    expect(of("track_ended")).toEqual([
      { type: "track_ended", details: { entryId: "a" } },
    ]);
  });

  test("pause holds the position and resume continues", () => {
    const { engine, run, of } = setup();
    engine.handle(play("a"));
    run(3);
    engine.handle({ type: "pause" });
    expect(of("paused")).toHaveLength(1);
    const before = engine.progress()!.position;
    run(2);
    expect(engine.progress()!.position).toBe(before);
    engine.handle({ type: "resume" });
    run(1);
    expect(engine.progress()!.position).toBeCloseTo(before + 1, 1);
  });

  test("seek clamps to the track and reports the position at once", () => {
    const { engine, of, decoders } = setup();
    engine.handle(play("a", { duration: 30 }));
    engine.handle({ type: "seek", seconds: 42 });
    expect(of("playback_position").at(-1)!.details).toEqual({
      entryId: "a",
      seconds: 30,
    });
    engine.handle({ type: "seek", offset: -10 });
    expect(of("playback_position").at(-1)!.details.seconds).toBe(20);
    expect(decoders.at(-1)!.start).toBe(20);
  });

  test("the file's own duration replaces the listed one once probed", async () => {
    const probed: string[] = [];
    const { engine, of } = setup(31.5, async (url) => {
      probed.push(url);
      return 31.5;
    });
    engine.handle(play("a", { duration: 30 }));
    expect(engine.progress()!.duration).toBe(30);
    await Bun.sleep(0);
    expect(probed).toEqual(["http://127.0.0.1/audio/a"]);
    expect(engine.progress()!.duration).toBe(31.5);
    engine.handle({ type: "seek", seconds: 42 });
    expect(of("playback_position").at(-1)!.details.seconds).toBe(31.5);
    // Seeking reopens the decoder, not the probe.
    expect(probed).toHaveLength(1);
  });

  test("a deck that goes stops its duration probe", () => {
    const signals: AbortSignal[] = [];
    const { engine } = setup(30, (_url, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    engine.handle(play("a"));
    expect(signals[0]!.aborted).toBe(false);
    engine.handle({ type: "stop" });
    expect(signals[0]!.aborted).toBe(true);
  });

  test("a failed probe keeps the listed duration", async () => {
    const { engine } = setup(30, async () => {
      throw new Error("no ffprobe");
    });
    engine.handle(play("a", { duration: 30 }));
    await Bun.sleep(0);
    expect(engine.progress()!.duration).toBe(30);
  });

  test("a play for the entry already playing does not restart it", () => {
    const { engine, run, decoders } = setup();
    engine.handle(play("a"));
    run(3);
    engine.handle(play("a"));
    expect(decoders).toHaveLength(1);
    expect(engine.progress()!.position).toBeCloseTo(3, 1);
  });

  test("gapless hands over at the outro", () => {
    const { engine, run, of } = setup();
    engine.handle({ type: "transition_mode", mode: "gapless" });
    engine.handle(play("a", { outroSeconds: 10 }));
    engine.handle({
      type: "preload",
      nextEntryId: "b",
      entries: [
        { entryId: "b", url: "http://b", introSeconds: 1, fadeInSeconds: 0 },
      ],
    });
    run(9.9);
    expect(of("transition")).toHaveLength(0);
    run(0.2);
    expect(of("transition")).toEqual([
      { type: "transition", details: { entryId: "a" } },
    ]);
    expect(engine.current).toBe("b");
    // The next track started at its intro.
    expect(engine.progress()!.position).toBeGreaterThanOrEqual(1);
    expect(engine.progress()!.position).toBeLessThan(1.2);
  });

  test("passing five seconds is reported straight away", () => {
    const { engine, run, of } = setup();
    engine.handle(play("a"));
    engine.handle({ type: "seek", seconds: 4.5 });
    run(0.6);
    expect(of("playback_position").at(-1)!.details.seconds).toBeGreaterThan(5);
    expect(of("playback_position").at(-1)!.details.seconds).toBeLessThan(5.2);
  });

  test("adaptive crossfades and hands over halfway through the fade", () => {
    const { engine, run, of } = setup();
    engine.handle({ type: "transition_mode", mode: "adaptive" });
    engine.handle(play("a", { outroSeconds: 20, fadeOutSeconds: 4 }));
    engine.handle({
      type: "preload",
      nextEntryId: "b",
      entries: [
        { entryId: "b", url: "http://b", introSeconds: 0, fadeInSeconds: 6 },
      ],
    });
    run(16.1); // the four second fade starts at 16 s
    expect(of("transition")).toHaveLength(0);
    run(1.8);
    expect(of("transition")).toHaveLength(0);
    run(0.3);
    expect(of("transition")).toHaveLength(1);
    expect(engine.current).toBe("b");
  });

  test("none never transitions early", () => {
    const { engine, run, of } = setup(12);
    engine.handle(play("a", { outroSeconds: 5, duration: 12 }));
    engine.handle({
      type: "preload",
      nextEntryId: "b",
      entries: [
        { entryId: "b", url: "http://b", introSeconds: 0, fadeInSeconds: 0 },
      ],
    });
    run(13);
    expect(of("transition")).toHaveLength(0);
    expect(of("track_ended")).toHaveLength(1);
  });

  test("a decoder that stops delivering stalls once", () => {
    const { engine, run, of, decoders } = setup();
    engine.handle(play("a"));
    decoders[0]!.available = 0;
    run(9.9);
    expect(of("stalled")).toHaveLength(0);
    run(1);
    expect(of("stalled")).toEqual([
      { type: "stalled", details: { entryId: "a" } },
    ]);
  });

  test("a decoder error is a track error", () => {
    const { engine, run, of, decoders } = setup();
    engine.handle(play("a"));
    decoders[0]!.error = "Invalid data found when processing input";
    run(0.1);
    expect(of("track_error")).toEqual([
      {
        type: "track_error",
        details: {
          entryId: "a",
          message: "Invalid data found when processing input",
        },
      },
    ]);
  });

  test("preload keeps only the current and listed decks, stop drops all", () => {
    const { engine, decoders } = setup();
    engine.handle(play("a"));
    engine.handle({
      type: "preload",
      entries: [{ entryId: "b", url: "http://b" }],
    });
    engine.handle({
      type: "preload",
      entries: [{ entryId: "c", url: "http://c" }],
    });
    expect(decoders.map((decoder) => decoder.closed)).toEqual([
      false,
      true,
      false,
    ]);
    engine.handle({ type: "stop" });
    expect(decoders.every((decoder) => decoder.closed)).toBe(true);
    expect(engine.current).toBeUndefined();
  });

  test("replay rewinds to the intro", () => {
    const { engine, run, of } = setup();
    engine.handle(play("a"));
    run(6);
    engine.handle({ type: "replay", entryId: "a", introSeconds: 2 });
    expect(engine.progress()!.position).toBe(2);
    expect(of("playing")).toHaveLength(2);
  });

  test("volume and ducking scale the output", () => {
    const { engine } = setup();
    engine.handle(play("a"));
    engine.setVolume(0);
    expect(Math.max(...engine.render(960).map(Math.abs))).toBe(0);
    engine.setVolume(1);
    engine.render(960 * 25); // let the compressor settle
    const loud = Math.max(...engine.render(960).map(Math.abs));
    engine.applyDuck({ gain: 0.15, rampSeconds: 0 });
    engine.render(960 * 25); // let the compressor settle
    const ducked = Math.max(...engine.render(960).map(Math.abs));
    expect(ducked).toBeLessThan(loud);
    expect(engine.duckGain).toBe(0.15);
  });

  test("a failing play is a track error, anything else is fatal", () => {
    const events: { type: string; details?: any }[] = [];
    const engine = new AudioEngine(
      () => {
        throw new Error("spawn failed");
      },
      (type, details) => events.push({ type, details }),
    );
    engine.handle(play("a"));
    expect(events[0]!.type).toBe("track_error");
    engine.handle({
      type: "preload",
      entries: [{ entryId: "b", url: "http://b" }],
    });
    expect(events[1]!.type).toBe("fatal");
  });

  test("the test tone plays until a track starts", () => {
    const { engine, of } = setup();
    engine.setVolume(1);
    engine.handle({ type: "tone", frequency: 440 });
    expect(of("playing")[0]!.details).toEqual({ frequency: 440 });
    expect(Math.max(...engine.render(960).map(Math.abs))).toBeGreaterThan(0.1);
    engine.handle(play("a"));
    engine.setVolume(0);
    engine.render(960); // flush the compressor's 6 ms look-ahead
    expect(Math.max(...engine.render(960).map(Math.abs))).toBe(0);
  });
});
