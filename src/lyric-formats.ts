import { parseLrc } from "@applemusic-like-lyrics/lyric";
import type { LyricLine } from "@applemusic-like-lyrics/lyric";
import { TTMLParser, toAmllLyrics } from "@applemusic-like-lyrics/ttml";
import { DOMParser } from "@xmldom/xmldom";

export type { LyricLine } from "@applemusic-like-lyrics/lyric";

/**
 * AMLL's TTML parser reaches for a global `DOMParser`, which Bun does not have,
 * so it gets xmldom's instead. One parser is enough: it holds no per-document
 * state between calls.
 */
const ttmlParser = new TTMLParser({ domParser: new DOMParser() });

/** `parseLrc` ends the last line at a sentinel far past any real song. */
const LRC_OPEN_ENDED_MS = 60_000_000;

/**
 * Parses AMLL/Apple-style TTML. Roles (`x-translation`, `x-roman`, `x-bg`) and
 * singer agents are resolved by the parser itself, so translations,
 * romanizations, background vocals, and duet alignment arrive already separated
 * from the sung words.
 */
export function parseTtml(ttml: string, durationMs = 0) {
  const { lines } = toAmllLyrics(ttmlParser.parse(ttml));
  return clampToDuration(lines, durationMs);
}

/** Parses an LRC file, including the enhanced word-timed A2 extension. */
export function parseLrcFile(lrc: string, durationMs = 0) {
  return clampToDuration(parseLrc(lrc), durationMs);
}

/**
 * Turns unsynced lyrics into lines spread evenly across the song. The result
 * never lines up with the vocals, which is why plain text sits at the bottom of
 * the provider ranking, but it still scrolls rather than sitting frozen.
 */
export function parsePlain(text: string, durationMs = 0): LyricLine[] {
  const texts = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (texts.length === 0) return [];
  const span = durationMs > 0 ? durationMs / texts.length : 0;
  return texts.map((words, index) => {
    const startTime = Math.round(span * index);
    const endTime = span ? Math.round(span * (index + 1)) : 0;
    return {
      words: [{ startTime, endTime, word: words }],
      translatedLyric: "",
      romanLyric: "",
      isBG: false,
      isDuet: false,
      startTime,
      endTime,
    };
  });
}

/**
 * True when the lines carry per-word timings, which is what makes the karaoke
 * sweep possible. Line-synced lyrics parse into a single word per line.
 */
export function isWordSynced(lines: LyricLine[]) {
  return lines.some((line) => line.words.length > 1);
}

/**
 * Open-ended trailing lines would leave the player waiting on a line that never
 * ends, so the song's own duration closes them off. Words are held inside their
 * line as well, so a stray timestamp cannot stretch the karaoke sweep past the
 * line it belongs to.
 */
function clampToDuration(lines: LyricLine[], durationMs: number) {
  if (durationMs <= 0) return lines;
  for (const line of lines) {
    if (line.endTime >= LRC_OPEN_ENDED_MS) line.endTime = durationMs;
    for (const word of line.words)
      if (word.endTime > line.endTime) word.endTime = line.endTime;
  }
  return lines;
}
