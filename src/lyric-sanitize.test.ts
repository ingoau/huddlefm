import { expect, test } from "bun:test";
import type { Lyric } from "@braccato/core";
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
