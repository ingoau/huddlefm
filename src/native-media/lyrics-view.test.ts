import { describe, expect, test } from "bun:test";
import type { Lyric, LyricPart } from "@braccato/core";
import { createCanvas } from "@napi-rs/canvas";
import { buildTimedRomanization } from "../timed-romanization.ts";
import { LyricsView } from "./lyrics-view.ts";
import { cubicBezier, Spring, spring, Tween } from "./motion.ts";
import { ArtworkLoader, VideoCard } from "./video-card.ts";
import { cardSize, wideCardWidth } from "./video-format.ts";

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

  test("lays right-to-left lines out from the right", () => {
    const items = new LyricsView(
      [
        line(1_000, 2_000, [
          part("قل", 1_000, 400),
          part("بي ", 1_400, 400),
          part("يحبك", 1_800, 1_200),
        ]),
        line(3_000, 2_000, undefined, { words: "أنا habibi you ٢٠٢٦" }),
        line(5_000, 2_000, [
          part("Hello ", 5_000, 1_000),
          part("world", 6_000, 1_000),
        ]),
      ],
      600,
    ).describe();
    // Syllables of a word stay one word, and the first word is rightmost.
    expect(items[0]).toMatchObject({
      align: "right",
      visual: ["يحبك", "قلبي"],
    });
    // A Latin run keeps its own order, and digits sit after it.
    expect(items[1]).toMatchObject({
      align: "right",
      visual: ["٢٠٢٦", "habibi", "you", "أنا"],
    });
    expect(items[2]).toMatchObject({
      align: "left",
      visual: ["Hello", "world"],
    });
  });

  test("wraps lines without spaces between words, like Japanese", () => {
    const text = "あとちょっとで分かりかけていたのに";
    const items = new LyricsView(
      [
        // Timed in two syllables, and line synced as one piece.
        line(1_000, 2_000, [
          part("あとちょっとで", 1_000, 1_000),
          part("分かりかけていたのに", 2_000, 1_000),
        ]),
        line(3_000, 2_000, undefined, { words: text }),
        line(5_000, 2_000, undefined, {
          words: "ねえ、「行こうよ」って言ったのに",
        }),
      ],
      400,
    ).describe();
    for (const item of items) {
      expect(item.rows).toBeGreaterThan(1);
      expect(item.right).toBeLessThanOrEqual(400);
    }
    expect(items[0]).toMatchObject({ text, timed: true });
    expect(items[1]).toMatchObject({ text, timed: false });
    // No row starts with a small kana or closing mark, or ends on an opening one.
    for (const item of items)
      for (const row of item.rowTexts!) {
        expect(row).not.toMatch(/^[、。」ょっ]/);
        expect(row).not.toMatch(/「$/);
      }
  });

  test("a wrapped Japanese line glows and is timed as it is unwrapped", () => {
    // No spaces, so the line is one word, held long enough to glow.
    const lines = [
      line(1_000, 4_000, [
        part("あとちょっとで", 1_000, 1_000),
        part("分かりかけていたのに", 2_000, 3_000),
      ]),
    ];
    const [whole] = new LyricsView(lines, 2_000).describe();
    expect(whole).toMatchObject({
      rows: 1,
      glow: ["あとちょっとで分かりかけていたのに"],
      times: [
        [1_000, 2_000],
        [2_000, 5_000],
      ],
    });
    const [wrapped] = new LyricsView(lines, 300).describe();
    expect(wrapped!.rows).toBeGreaterThan(1);
    expect(wrapped!.right).toBeLessThanOrEqual(300);
    expect(wrapped!.glow).toEqual(whole!.glow);
    // Cut pieces keep their whole syllable's time, never a share of it.
    expect(wrapped!.times!.length).toBeGreaterThan(2);
    for (const time of wrapped!.times!)
      expect(whole!.times).toContainEqual(time);
  });

  test("draws each row of a wrapped line-synced Japanese line on its own row", () => {
    // How many bands of text the drawn view has, top to bottom.
    const bands = (lines: Lyric[], width: number) => {
      const view = new LyricsView(lines, width);
      const canvas = createCanvas(width, 400);
      const context = canvas.getContext("2d");
      for (let seconds = 1; seconds <= 3; seconds += 1 / 24)
        view.update(seconds, 1 / 24, 400);
      view.draw(context, 400);
      const { data } = context.getImageData(0, 0, width, 400);
      let count = 0;
      let inked = false;
      for (let y = 0; y < 400; y++) {
        let row = false;
        for (let x = 0; x < width && !row; x++)
          row = data[(y * width + x) * 4 + 3]! > 64;
        if (row && !inked) count++;
        inked = row;
      }
      return count;
    };
    const lines = [
      line(1_000, 4_000, undefined, {
        words: "あとちょっとで分かりかけていたのに",
      }),
    ];
    expect(bands(lines, 2_000)).toBe(1);
    expect(bands(lines, 300)).toBeGreaterThan(1);
  });

  test("keeps Chinese quotes, wave dashes and halfwidth kana with their text", () => {
    const lines = [
      "他说“我们一起走吧”然后就离开了这个城市",
      "ずっと待ってる～ずっと待ってる～ずっと",
      "ｱｲｼﾃﾙｯﾃｲｯﾀﾉﾆﾓｳｲﾁﾄﾞｷｲﾃﾎｼｲｰ",
    ].map((words, index) => line(index * 2_000, 2_000, undefined, { words }));
    for (let width = 100; width <= 400; width += 10)
      for (const item of new LyricsView(lines, width).describe()) {
        expect(item.right).toBeLessThanOrEqual(width);
        for (const row of item.rowTexts!) {
          expect(row).not.toMatch(/^[”’～〜ｯｰﾞﾟｧ-ｮ]/);
          expect(row).not.toMatch(/[“‘]$/);
        }
      }
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

  test("sweeps timed romanization, and lights untimed lines' at once", () => {
    const timed = line(
      1_000,
      2_000,
      [
        part("아", 1_000, 500),
        part("파", 1_500, 500),
        part("트", 2_000, 1_000),
      ],
      { romanization: "a pa teu" },
    );
    timed.timedRomanization = buildTimedRomanization(timed);
    const untimed = line(4_000, 2_000, undefined, {
      words: "아파트",
      romanization: "a pa teu",
    });
    untimed.timedRomanization = buildTimedRomanization(untimed);
    const view = new LyricsView([timed, untimed], 600);
    expect(
      view.describe().map(({ roman, romanTimed }) => ({ roman, romanTimed })),
    ).toEqual([
      { roman: "a pa teu", romanTimed: true },
      { roman: "a pa teu", romanTimed: false },
    ]);
    const canvas = createCanvas(600, 480);
    const context = canvas.getContext("2d");
    for (let seconds = 0; seconds < 7; seconds += 0.25) {
      view.update(seconds, 0.25, 480);
      context.clearRect(0, 0, 600, 480);
      view.draw(context, 480);
    }
  });

  test("timed romanization leaves the background vocals to their own", () => {
    const withBackground = line(
      1_000,
      3_000,
      [
        part("아파트 ", 1_000, 1_500),
        part("(오 ", 2_500, 500, true),
        part("예)", 3_000, 1_000, true),
      ],
      { romanization: "a pa teu (o ye)" },
    );
    withBackground.timedRomanization = buildTimedRomanization(withBackground);
    const [item] = new LyricsView([withBackground], 600).describe();
    expect(item).toMatchObject({
      text: "아파트",
      background: "오 예",
      roman: "a pa teu",
      romanTimed: true,
      // Swept over the main vocals, done before the background vocals sing.
      romanEnd: 2_500,
    });
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

  test("credits follow the last line and take the focus once it ends", () => {
    const view = new LyricsView(song, 600, 1, {
      songwriters: ["Amy Allen", "Bruno Mars"],
      source: "Better Lyrics",
    });
    const items = view.describe();
    expect(items.at(-1)!.kind).toBe("credits");
    view.update(22, 0, 480);
    expect(view.focusIndex).toBe(items.length - 2);
    view.update(25, 0, 480);
    expect(view.focusIndex).toBe(items.length - 1);
  });

  test("no credits when there is nothing to credit", () => {
    const view = new LyricsView(song, 600, 1, {});
    expect(view.describe().at(-1)!.kind).toBe("line");
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

  test("a word's frame is the same whatever was drawn before it", () => {
    // A long held word glows in bigger sprites than the words rising around
    // it; nothing of it may be left to show in theirs.
    const words = ["you ", "made ", "such ", "a "];
    const parts = words.map((words, index) => part(words, index * 300, 300));
    const lines = [line(0, 4_000, [...parts, part("mess", 1_200, 3_000)])];
    const render = (drawEvery: boolean) => {
      const view = new LyricsView(lines, 619, 0.75);
      const canvas = createCanvas(464, 300);
      const context = canvas.getContext("2d");
      context.scale(0.75, 0.75);
      for (let seconds = 0; seconds <= 3; seconds += 1 / 24) {
        view.update(seconds, 1 / 24, 400);
        if (!drawEvery) continue;
        context.clearRect(0, 0, 619, 400);
        view.draw(context, 400);
      }
      context.clearRect(0, 0, 619, 400);
      view.draw(context, 400);
      return canvas.data();
    };
    expect(render(true).equals(render(false))).toBe(true);
  });
});

describe("lyrics view changes", () => {
  // A word-synced line with a long held, glowing word, long enough to stay
  // current well after it is sung, then a line-synced one.
  const held: Lyric[] = [
    line(0, 12_000, [part("you ", 0, 300), part("mess", 300, 1_500)]),
    line(12_000, 6_000, undefined, { words: "Only the line is timed" }),
  ];
  const settle = (view: LyricsView, seconds: number) => {
    for (let frame = 0; frame < 60; frame++)
      view.update(seconds + frame / 30, 1 / 30, 400);
    expect(view.settled).toBe(true);
  };
  const pixels = (view: LyricsView) => {
    const canvas = createCanvas(600, 400);
    view.draw(canvas.getContext("2d"), 400);
    return canvas.data();
  };

  test("change while a word-synced line is sung", () => {
    const view = new LyricsView(held, 600);
    view.update(0, 0, 400);
    pixels(view);
    for (let seconds = 1 / 30; seconds < 1.5; seconds += 1 / 30) {
      view.update(seconds, 1 / 30, 400);
      expect(view.changed).toBe(true);
      pixels(view);
    }
  });

  test("hold still once the line is sung, as it then looks", () => {
    const view = new LyricsView(held, 600);
    view.update(4, 0, 400);
    settle(view, 4);
    pixels(view);
    view.update(6, 0.1, 400);
    expect(view.changed).toBe(false);
    const kept = pixels(view);
    // Drawn afresh at that time, it is the same.
    const fresh = new LyricsView(held, 600);
    fresh.update(6, 0, 400);
    expect(fresh.settled).toBe(true);
    expect(pixels(fresh).equals(kept)).toBe(true);
  });

  test("hold still through a line-synced line, until a seek", () => {
    const view = new LyricsView(held, 600);
    view.update(13, 0, 400);
    settle(view, 13);
    pixels(view);
    view.update(15, 0.1, 400);
    expect(view.changed).toBe(false);
    view.update(11.9, 0, 400);
    expect(view.changed).toBe(true);
  });

  test("an interlude's dots keep moving", () => {
    const view = new LyricsView(song, 600);
    view.update(12, 0, 400);
    settle(view, 12);
    pixels(view);
    view.update(14.1, 0.1, 400);
    expect(view.changed).toBe(true);
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
    // Retargeting mid-flight starts from where the tween is, not where it
    // was going.
    const midway = tween.value(50);
    tween.set(0, 50, 100);
    expect(tween.value(50)).toBeCloseTo(midway, 5);
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
  function card(wide = false) {
    let now = 0;
    let position = 5;
    const value = new VideoCard(
      () => ({ position, duration: 30 }),
      () => {},
      { now: () => now, wide },
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

  test("the screen share's wide card fills 16:9, with no lyrics", () => {
    const { card: value, step } = card(true);
    expect(value.rgba().length).toBe(wideCardWidth * cardSize * 4);
    step(1, false);
    const still = Buffer.from(value.rgba());
    value.setDisplayMode("lyrics");
    value.setLyrics(song);
    step(1, false);
    expect(value.rgba().equals(still)).toBeTrue();
  });

  test("the wide card's timeline is only for a track with a length", () => {
    let now = 0;
    let position = 5;
    let duration: number | undefined = 30;
    const value = new VideoCard(
      () => ({ position, duration }),
      () => {},
      { now: () => now, wide: true },
    );
    const step = (seconds: number) => {
      for (let frame = 0; frame < seconds * 30; frame++) {
        now += 1_000 / 30;
        position += 1 / 30;
        value.rgba();
      }
    };
    step(1);
    const playing = value.rgba();
    step(2);
    // A song without a picture: its time moves on.
    expect(value.rgba()).not.toBe(playing);
    // A live stream has no length, so nothing moves.
    duration = undefined;
    step(1);
    const live = value.rgba();
    step(2);
    expect(value.rgba()).toBe(live);
  });

  test("the wide card says it is idle in the middle", () => {
    const pixels = (wide: boolean) => {
      const { card: value, step } = card(wide);
      value.reset({
        title: "Video mode",
        subtitle: "Queue something to watch",
      });
      step(1, false);
      return { frame: value.rgba(), width: wide ? wideCardWidth : cardSize };
    };
    // How bright the middle of the frame is, where centred words would be.
    const middle = ({ frame, width }: { frame: Buffer; width: number }) => {
      let total = 0;
      for (let y = cardSize / 2 - 30; y < cardSize / 2; y++)
        for (let x = width / 2 - 40; x < width / 2 + 40; x++)
          total += frame[(y * width + x) * 4]!;
      return total;
    };
    expect(middle(pixels(true))).toBeGreaterThan(middle(pixels(false)) * 4);
  });

  test("the lyrics offset delays the lyrics against the audio", () => {
    let now = 0;
    const focusAt = (lyricsOffset: number) => {
      now = 0;
      const value = new VideoCard(
        () => ({ position: 6.5, duration: 30 }),
        () => {},
        { now: () => now, lyricsOffset },
      );
      value.setDisplayMode("lyrics");
      value.setLyrics(song);
      // Past the lyrics fading in.
      for (; now < 1_000; now += 1_000 / 30) value.rgba();
      return (value as any).track.view.focusIndex;
    };
    expect(focusAt(0)).toBe(2);
    expect(focusAt(2)).toBe(1);
  });

  test("cards showing the same artwork fetch it once, scaled for the widest", async () => {
    const art = createCanvas(1_200, 1_200);
    const context = art.getContext("2d");
    context.fillStyle = "#c04080";
    context.fillRect(0, 0, 1_200, 1_200);
    const png = art.toBuffer("image/png");
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        requests++;
        return new Response(new Uint8Array(png), {
          headers: { "content-type": "image/png" },
        });
      },
    });
    try {
      const artwork = new ArtworkLoader([
        { width: cardSize, height: cardSize },
        { width: wideCardWidth, height: cardSize },
      ]);
      const url = `http://127.0.0.1:${server.port}/artwork.png`;
      for (const wide of [false, true])
        new VideoCard(
          () => ({ position: 0 }),
          () => {},
          {
            wide,
            artwork,
          },
        ).setTrack("Title", "Artist", url);
      const image = await artwork.get(url);
      expect(requests).toBe(1);
      expect([image.width, image.height]).toEqual([
        wideCardWidth,
        wideCardWidth,
      ]);
    } finally {
      server.stop(true);
    }
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
