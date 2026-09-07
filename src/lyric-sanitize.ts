import type { Lyric, LyricPart } from "@braccato/core";
import { containsNonLatin, detectNonLatinLanguage } from "@braccato/core/text";

/**
 * AMLL (and similar) TTML often inlines `ttm:role="x-translation"` /
 * `ttm:role="x-roman"` spans inside each `<p>`. `@braccato/parsers` currently
 * treats those as sung parts, so Japanese, Chinese, and spaced romaji get
 * concatenated into one lyric line.
 *
 * Untimed role spans typically parse as `{ startTimeMs: 0, durationMs: 0 }`
 * after the real syllables. The `#text` path can instead inherit the previous
 * syllable's end time with `durationMs: 0`.
 */
function isOrphanedRolePart(part: LyricPart, sawTimedPart: boolean) {
  if (!sawTimedPart || part.durationMs !== 0) return false;
  if (part.startTimeMs === 0) return true;
  return Boolean(part.words.trim());
}

function isLatinRomanization(text: string) {
  const trimmed = text.trim();
  return Boolean(trimmed) && !containsNonLatin(trimmed);
}

/**
 * Strips inline translation/romanization junk from word-synced lyric parts and
 * rebuilds `words`. Preserves non-Latin orphans as translations when missing.
 * Drops spaced Latin orphans so romanization enrichment can regenerate cleaner
 * text instead of keeping AMLL's mora-spaced `x-roman` strings.
 */
export function sanitizeInlineLyricRoles(lines: Lyric[]) {
  for (const line of lines) {
    if (!line.parts?.length) continue;

    const sung: LyricPart[] = [];
    const orphaned: LyricPart[] = [];
    let sawTimedPart = false;

    for (const part of line.parts) {
      if (part.durationMs > 0) sawTimedPart = true;
      if (isOrphanedRolePart(part, sawTimedPart)) orphaned.push(part);
      else sung.push(part);
    }

    if (orphaned.length === 0 || sung.length === 0) continue;

    line.parts = sung;
    line.words = sung.map((part) => part.words).join("");

    for (const part of orphaned) {
      const text = part.words.trim();
      if (!text) continue;
      if (isLatinRomanization(text)) {
        if (line.romanization?.trim() === text) {
          delete line.romanization;
          delete line.timedRomanization;
        }
        continue;
      }

      const lang = detectNonLatinLanguage(text) ?? "und";
      line.translations ??= {};
      if (!Object.values(line.translations).includes(text))
        line.translations[lang] ??= text;
      if (!line.translation?.text?.trim()) line.translation = { text, lang };
    }
  }

  return lines;
}
