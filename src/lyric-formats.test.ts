import { expect, test } from "bun:test";
import {
  isWordSynced,
  parseLrcFile,
  parsePlain,
  parseTtml,
} from "./lyric-formats.ts";

const WORD_SYNCED_TTML = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal">
  <head>
    <metadata>
      <ttm:agent type="person" xml:id="v1"/>
      <ttm:agent type="other" xml:id="v2"/>
    </metadata>
  </head>
  <body dur="00:20.000">
    <div begin="00:01.000" end="00:10.000">
      <p begin="00:01.000" end="00:05.000" ttm:agent="v1" itunes:key="L1"><span begin="00:01.000" end="00:02.000">共振</span><span begin="00:02.000" end="00:05.000">で</span><span ttm:role="x-translation" xml:lang="en">Resonating</span><span ttm:role="x-roman">kyoushin de</span></p>
      <p begin="00:05.500" end="00:09.000" ttm:agent="v2" itunes:key="L2"><span begin="00:05.500" end="00:09.000">Second line</span><span ttm:role="x-bg" begin="00:06.000" end="00:07.000"><span begin="00:06.000" end="00:07.000">(ooh)</span></span></p>
    </div>
  </body>
</tt>`;

test("keeps TTML role spans out of the sung words", () => {
  const [line] = parseTtml(WORD_SYNCED_TTML, 20_000);
  expect(line!.words.map((word) => word.word)).toEqual(["共振", "で"]);
  expect(line!.translatedLyric).toBe("Resonating");
  expect(line!.romanLyric).toBe("kyoushin de");
  expect(line!.startTime).toBe(1_000);
  expect(line!.endTime).toBe(5_000);
});

test("splits background vocals and duet lines out of TTML", () => {
  const lines = parseTtml(WORD_SYNCED_TTML, 20_000);
  expect(lines.map((line) => [line.isBG, line.isDuet])).toEqual([
    [false, false],
    [false, true],
    [true, true],
  ]);
  expect(lines[2]!.words.map((word) => word.word)).toEqual(["ooh"]);
});

test("detects word timing", () => {
  expect(isWordSynced(parseTtml(WORD_SYNCED_TTML, 20_000))).toBe(true);
  expect(isWordSynced(parseLrcFile("[00:01.00]Hello\n[00:05.00]World\n"))).toBe(
    false,
  );
});

test("parses LRC into one word per line", () => {
  const lines = parseLrcFile("[00:01.00]Hello\n[00:05.00]World\n", 9_000);
  expect(lines.map((line) => line.words[0]!.word)).toEqual(["Hello", "World"]);
  expect(lines[0]!.startTime).toBe(1_000);
  expect(lines[1]!.startTime).toBe(5_000);
});

test("closes an open-ended trailing LRC line at the song's end", () => {
  const [, last] = parseLrcFile("[00:01.00]Hello\n[00:05.00]World\n", 9_000);
  expect(last!.endTime).toBe(9_000);
});

test("holds word timings inside the line they belong to", () => {
  const [, last] = parseLrcFile("[00:01.00]Hello\n[00:05.00]World\n", 3_000);
  expect(last!.endTime).toBe(3_000);
  expect(last!.words.every((word) => word.endTime <= 3_000)).toBe(true);
});

test("leaves an open-ended LRC line alone when the duration is unknown", () => {
  const [, last] = parseLrcFile("[00:01.00]Hello\n[00:05.00]World\n");
  expect(last!.endTime).toBeGreaterThan(60_000_000 - 1);
});

test("spreads plain lyrics evenly across the song", () => {
  const lines = parsePlain("First\n\n  Second  \nThird\n", 9_000);
  expect(lines.map((line) => line.words[0]!.word)).toEqual([
    "First",
    "Second",
    "Third",
  ]);
  expect(lines.map((line) => [line.startTime, line.endTime])).toEqual([
    [0, 3_000],
    [3_000, 6_000],
    [6_000, 9_000],
  ]);
});

test("returns nothing for empty plain lyrics", () => {
  expect(parsePlain("\n  \n", 9_000)).toEqual([]);
});
