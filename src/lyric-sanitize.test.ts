import { expect, test } from "bun:test";
import type { Lyric } from "@braccato/core";
import { parseTTMLContent } from "@braccato/parsers";
import { sanitizeInlineLyricRoles } from "./lyric-sanitize.ts";

function line(partial: Partial<Lyric> & Pick<Lyric, "words">): Lyric {
  return {
    startTimeMs: partial.startTimeMs ?? 1000,
    durationMs: partial.durationMs ?? 1000,
    words: partial.words,
    parts: partial.parts,
    romanization: partial.romanization,
    timedRomanization: partial.timedRomanization,
    translation: partial.translation,
    translations: partial.translations,
    isInstrumental: partial.isInstrumental,
  };
}

test("strips AMLL inline Chinese translation and spaced romanization", () => {
  const lines = [
    line({
      startTimeMs: 2674,
      durationMs: 1411,
      words:
        "共振で苦しんでし罵倒疲于共情直接开骂吧kyo u shi n de ku ru shi n de shi ba to u",
      parts: [
        { startTimeMs: 2674, durationMs: 176, words: "共" },
        { startTimeMs: 2850, durationMs: 176, words: "振" },
        { startTimeMs: 3026, durationMs: 177, words: "で" },
        { startTimeMs: 3203, durationMs: 176, words: "苦" },
        { startTimeMs: 3379, durationMs: 89, words: "し" },
        { startTimeMs: 3468, durationMs: 88, words: "ん" },
        { startTimeMs: 3556, durationMs: 88, words: "で" },
        { startTimeMs: 3644, durationMs: 88, words: "し" },
        { startTimeMs: 3732, durationMs: 177, words: "罵" },
        { startTimeMs: 3909, durationMs: 176, words: "倒" },
        { startTimeMs: 0, durationMs: 0, words: "疲于共情直接开骂吧" },
        {
          startTimeMs: 0,
          durationMs: 0,
          words: "kyo u shi n de ku ru shi n de shi ba to u",
        },
      ],
    }),
  ];

  sanitizeInlineLyricRoles(lines);

  expect(lines[0]!.words).toBe("共振で苦しんでし罵倒");
  expect(lines[0]!.parts?.map((part) => part.words).join("")).toBe(
    "共振で苦しんでし罵倒",
  );
  expect(lines[0]!.parts?.every((part) => part.durationMs > 0)).toBe(true);
  expect(lines[0]!.translation?.text).toBe("疲于共情直接开骂吧");
  expect(lines[0]!.translations?.zh).toBe("疲于共情直接开骂吧");
  expect(lines[0]!.romanization).toBeUndefined();
});

test("strips untimed leftover text that inherited the previous syllable time", () => {
  const lines = [
    line({
      startTimeMs: 1000,
      durationMs: 400,
      words: "ありがとうni hao",
      parts: [
        { startTimeMs: 1000, durationMs: 200, words: "あり" },
        { startTimeMs: 1200, durationMs: 200, words: "がとう" },
        { startTimeMs: 1400, durationMs: 0, words: "ni hao" },
      ],
    }),
  ];

  sanitizeInlineLyricRoles(lines);

  expect(lines[0]!.words).toBe("ありがとう");
  expect(lines[0]!.parts?.map((part) => part.words).join("")).toBe(
    "ありがとう",
  );
});

test("keeps clean word-synced lines untouched", () => {
  const parts = [
    { startTimeMs: 1000, durationMs: 120, words: "あ" },
    { startTimeMs: 1120, durationMs: 120, words: "り" },
    { startTimeMs: 1240, durationMs: 120, words: "が" },
    { startTimeMs: 1360, durationMs: 120, words: "と" },
  ];
  const lines = [
    line({
      startTimeMs: 1000,
      durationMs: 480,
      words: "ありがとう",
      parts: [...parts],
    }),
  ];

  sanitizeInlineLyricRoles(lines);

  expect(lines[0]!.words).toBe("ありがとう");
  expect(lines[0]!.parts).toEqual(parts);
  expect(lines[0]!.translation).toBeUndefined();
});

test("keeps zero-duration interstitial parts that continue timing", () => {
  const parts = [
    { startTimeMs: 1000, durationMs: 200, words: "hello" },
    { startTimeMs: 1200, durationMs: 0, words: " " },
    { startTimeMs: 1200, durationMs: 200, words: "world" },
  ];
  const lines = [
    line({
      startTimeMs: 1000,
      durationMs: 400,
      words: "hello world",
      parts: [...parts],
    }),
  ];

  sanitizeInlineLyricRoles(lines);

  expect(lines[0]!.words).toBe("hello world");
  expect(lines[0]!.parts).toEqual(parts);
});

test("clears spaced romanization that matched an orphaned role span", () => {
  const lines = [
    line({
      startTimeMs: 500,
      durationMs: 400,
      words: "你好ni hao",
      romanization: "ni hao",
      parts: [
        { startTimeMs: 500, durationMs: 200, words: "你" },
        { startTimeMs: 700, durationMs: 200, words: "好" },
        { startTimeMs: 0, durationMs: 0, words: "ni hao" },
      ],
    }),
  ];

  sanitizeInlineLyricRoles(lines);

  expect(lines[0]!.words).toBe("你好");
  expect(lines[0]!.romanization).toBeUndefined();
});

test("strips inline AMLL roles from a real TTML snippet", () => {
  const ttml = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div><p begin="00:02.674" end="00:04.085"><span begin="00:02.674" end="00:02.850">共</span><span begin="00:02.850" end="00:03.026">振</span><span begin="00:03.026" end="00:03.203">で</span><span begin="00:03.203" end="00:03.379">苦</span><span begin="00:03.379" end="00:03.468">し</span><span begin="00:03.468" end="00:03.556">ん</span><span begin="00:03.556" end="00:03.644">で</span><span begin="00:03.644" end="00:03.732">し</span><span begin="00:03.732" end="00:03.909">罵</span><span begin="00:03.909" end="00:04.085">倒</span><span ttm:role="x-translation" xml:lang="zh-CN">疲于共情直接开骂吧</span><span ttm:role="x-roman">kyo u shi n de ku ru shi n de shi ba to u</span></p></div></body></tt>`;
  const parsed = parseTTMLContent(ttml, { songDurationMs: 10_000 });
  const sung = parsed.lyrics.filter((item) => !item.isInstrumental);
  expect(sung[0]!.words).toContain("疲于共情直接开骂吧");

  sanitizeInlineLyricRoles(sung);

  expect(sung[0]!.words).toBe("共振で苦しんでし罵倒");
  expect(sung[0]!.parts?.every((part) => part.durationMs > 0)).toBe(true);
  expect(sung[0]!.translation?.text).toBe("疲于共情直接开骂吧");
});
