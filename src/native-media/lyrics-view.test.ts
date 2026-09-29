import { describe, expect, test } from "bun:test";
import type { Lyric, LyricPart } from "@braccato/core";
import { createCanvas } from "@napi-rs/canvas";
import { LyricsView } from "./lyrics-view.ts";
import { cubicBezier, Spring, spring, Tween } from "./motion.ts";
import { cardSize, VideoCard } from "./video-card.ts";

const part = (
  words: string,
  startTimeMs: number,
  durationMs: number,
  isBackground = false,
): LyricPart => ({ words, startTimeMs, durationMs, isBackground });

function line(
  startTimeMs: number,
  durationMs: number,
  parts?: LyricPart[],
  extra: Partial<Lyric> = {},
): Lyric {
  return {
    startTimeMs,
    durationMs,
    words: parts?.map((value) => value.words).join("") ?? "",
    parts,
    ...extra,
  };
}

const song: Lyric[] = [
  line(0, 4_000, undefined, { isInstrumental: true }),
  line(
    4_000,
    2_000,
    [
      part("Hel", 4_000, 400),
      part("lo ", 4_400, 400),
      part("world", 4_800, 1_200),
    ],
    { agent: "v1" },
  ),
  line(
    6_000,
    2_000,
    [
      part("Other ", 6_000, 800),
      part("voice", 6_800, 800),
      part(" (ooh ", 7_000, 500, true),
      part("yeah)", 7_500, 500, true),
    ],
    { agent: "v2" },
  ),
  line(
    8_000,
    2_000,
    [part("Back ", 8_000, 1_000), part("again", 9_000, 1_000)],
    { agent: "v1" },
  ),
  // A long gap, then a line with no syllable timing.
  line(20_000, 3_000, undefined, { words: "Only the line is timed" }),
];

describe("lyrics view", () => {
  test("builds lines, voices, background vocals and interludes", () => {
    const view = new LyricsView(song, 600);
    const items = view.describe();
    expect(items.map((item) => item.kind)).toEqual([
      "dots",
      "line",
      "line",
      "line",
      "dots",
      "line",
    ]);
    expect(items[1]).toMatchObject({
      text: "Hello world",
      align: "left",
      timed: true,
    });
    // Other voices sit on the right; background vocals lose their brackets.
    expect(items[2]).toMatchObject({
      text: "Other voice",
      align: "right",
      background: "ooh yeah",
    });
    expect(items[5]).toMatchObject({
      text: "Only the line is timed",
      timed: false,
    });
  });

  test("romanizes only lines in other scripts", () => {
    const view = new LyricsView(
      [
        line(1_000, 1_000, [part("아파트", 1_000, 1_000)], {
          romanization: "a pa teu",
        }),
        line(2_000, 1_000, [part("Uh-huh", 2_000, 1_000)], {
          romanization: "Uh-huh",
        }),
      ],
      600,
    );
    expect(view.describe().map((item) => item.roman)).toEqual([
      "a pa teu",
      undefined,
    ]);
  });

  test("the sung line is current, larger, and shows its background vocals", () => {
    const view = new LyricsView(song, 600);
    view.update(6.5, 0, 480);
    const items = view.describe();
    expect(view.focusIndex).toBe(2);
    expect(items[2]).toMatchObject({ active: true, scale: 1, shown: 1 });
    expect(items[1]).toMatchObject({ active: false, shown: 0 });
    expect(items[1]!.scale).toBeLessThan(1);
    // Lines stack in order around the current one; idle dots take no room.
    expect(items[2]!.y).toBeGreaterThan(items[1]!.y);
    expect(items[3]!.y).toBeGreaterThan(items[2]!.y);
    expect(items[4]!.y).toBe(items[5]!.y);
    expect(items[5]!.y).toBeGreaterThan(items[3]!.y);
  });

  test("background vocals take room only while their line is current", () => {
    const view = new LyricsView(song, 600);
    view.update(6.5, 0, 480);
    const during = view.describe();
    const gapDuring = during[3]!.y - during[2]!.y;
    view.update(4.5, 0, 480);
    const before = view.describe();
    expect(before[3]!.y - before[2]!.y).toBeLessThan(gapDuring);
  });

  test("a short gap keeps the last line current; a long one breathes", () => {
    const view = new LyricsView(song, 600);
    view.update(12, 0, 480);
    expect(view.describe()[4]).toMatchObject({ kind: "dots", active: true });
    expect(view.focusIndex).toBe(4);
    view.update(1, 0, 480);
    expect(view.focusIndex).toBe(0);
  });

  test("lines move on springs with a stagger after the first frame", () => {
    const view = new LyricsView(song, 600);
    view.update(4.5, 0, 480);
    const start = view.describe().map((item) => item.y);
    let moved = false;
    for (let frame = 1; frame < 150; frame++) {
      view.update(4.5 + frame / 30, 1 / 30, 480);
      if (!view.settled) moved = true;
    }
    expect(moved).toBe(true);
    expect(view.settled).toBe(true);
    expect(view.describe()[2]!.y).toBeLessThan(start[2]!);
  });

  test("new lyrics fly up into place instead of snapping", () => {
    const view = new LyricsView(song, 600);
    view.enter();
    view.update(4.2, 0, 480);
    expect(view.settled).toBe(false);
    // Before the next line comes up at 6s.
    for (let frame = 1; frame < 45; frame++)
      view.update(4.2 + frame / 30, 1 / 30, 480);
    expect(view.settled).toBe(true);
  });

  test("draws without throwing at every stage of a song", () => {
    const view = new LyricsView(song, 600);
    const canvas = createCanvas(600, 480);
    const context = canvas.getContext("2d");
    for (let seconds = 0; seconds < 24; seconds += 0.25) {
      view.update(seconds, 0.25, 480);
      context.clearRect(0, 0, 600, 480);
      view.draw(context, 480);
    }
  });
});

describe("motion", () => {
  test("cubic-bezier matches its endpoints and the linear curve", () => {
    const linear = cubicBezier(0.25, 0.25, 0.75, 0.75);
    for (const x of [0, 0.2, 0.5, 0.9, 1]) expect(linear(x)).toBeCloseTo(x, 3);
    const out = cubicBezier(0.22, 1, 0.36, 1);
    expect(out(0.5)).toBeGreaterThan(0.9);
  });

  test("a tween eases toward its target from wherever it was", () => {
    const tween = new Tween(0);
    tween.set(1, 0, 100);
    expect(tween.value(50)).toBeGreaterThan(0);
    expect(tween.value(50)).toBeLessThan(1);
    tween.set(0, 50, 100);
    expect(tween.value(50)).toBeCloseTo(tween.value(50), 5);
    expect(tween.value(150)).toBe(0);
    expect(tween.settled(150)).toBe(true);
  });

  test("a spring waits out its delay and settles on the target", () => {
    const value = new Spring(0, spring(300, 1));
    value.set(100, 0.1);
    value.update(0.05);
    expect(value.position).toBe(0);
    for (let frame = 0; frame < 90; frame++) value.update(1 / 30);
    expect(value.position).toBeCloseTo(100, 1);
    expect(value.settled).toBe(true);
  });
});

describe("video card", () => {
  function card() {
    let now = 0;
    let position = 5;
    const value = new VideoCard(
      () => ({ position, duration: 30 }),
      () => {},
      { now: () => now },
    );
    return {
      card: value,
      step(seconds: number, playing = true) {
        for (let frame = 0; frame < seconds * 30; frame++) {
          now += 1_000 / 30;
          if (playing) position += 1 / 30;
          value.rgba();
        }
      },
    };
  }

  test("hands out the same frame while nothing moves", () => {
    const { card: value, step } = card();
    step(1, false);
    expect(value.rgba()).toBe(value.rgba());
  });

  test("switches to the lyrics layout and back when they are missing", () => {
    const { card: value, step } = card();
    step(0.5, false);
    const plain = Buffer.from(value.rgba());
    value.setDisplayMode("lyrics");
    value.setLyrics(song);
    step(1, false);
    const lyrics = Buffer.from(value.rgba());
    expect(lyrics.equals(plain)).toBe(false);
    // Plain lyrics with no timing have nothing to follow.
    value.setLyrics([line(0, 0, undefined, { words: "Unsynced" })]);
    step(1, false);
    const fallback = value.rgba();
    expect(fallback.equals(plain)).toBe(true);
  });

  test("a track change animates, then settles on the new track", () => {
    const { card: value, step } = card();
    step(0.5, false);
    const before = Buffer.from(value.rgba());
    value.beginChange();
    step(0.2, false);
    value.setTrack("Next", "Someone");
    const during = value.rgba();
    step(0.1, false);
    expect(value.rgba()).not.toBe(during);
    step(2, false);
    const after = value.rgba();
    expect(value.rgba()).toBe(after);
    expect(after.equals(before)).toBe(false);
  });

  test("draws at the card's size", () => {
    const { card: value } = card();
    expect(value.rgba().length).toBe(cardSize * cardSize * 4);
  });

  test("keeps redrawing while lyrics play", () => {
    const { card: value, step } = card();
    value.setDisplayMode("lyrics");
    value.setLyrics(song);
    step(1);
    const first = value.rgba();
    step(0.1);
    expect(value.rgba()).not.toBe(first);
  });
});
