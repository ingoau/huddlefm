import type { Lyric, LyricPart } from "@braccato/core";

// Kept apart from romanization.ts so the native media process can use it
// without loading the romanizers or the logger, which writes to stdout.

/**
 * Maps a line romanization onto the sung timeline so Braccato can karaoke-sync
 * the romanized words with the original line.
 */
export function buildTimedRomanization(line: Lyric): LyricPart[] | undefined {
  const text = line.romanization?.trim();
  if (!text || line.isInstrumental) return;
  const tokens = text.match(/\S+/gu);
  if (!tokens?.length) return;

  const timed =
    line.parts
      ?.filter((part) => part.durationMs > 0)
      .map((part) => ({
        startTimeMs: part.startTimeMs,
        endTimeMs: part.startTimeMs + part.durationMs,
      }))
      .sort((a, b) => a.startTimeMs - b.startTimeMs) ?? [];
  const active = timed.reduce<{ startTimeMs: number; endTimeMs: number }[]>(
    (intervals, interval) => {
      const previous = intervals.at(-1);
      if (previous && interval.startTimeMs <= previous.endTimeMs)
        previous.endTimeMs = Math.max(previous.endTimeMs, interval.endTimeMs);
      else intervals.push({ ...interval });
      return intervals;
    },
    [],
  );
  if (active.length === 0)
    active.push({
      startTimeMs: line.startTimeMs,
      endTimeMs: line.startTimeMs + Math.max(0, line.durationMs),
    });
  const letters = tokens.reduce((sum, token) => sum + token.length, 0);
  if (letters === 0) return;

  let durationMs = 0;
  const activeSegments = active.map((interval) => {
    const offsetStart = durationMs;
    durationMs += interval.endTimeMs - interval.startTimeMs;
    return { ...interval, offsetStart, offsetEnd: durationMs };
  });
  const timelineTime = (offset: number) => {
    const bounded = Math.max(0, Math.min(durationMs, offset));
    const interval =
      activeSegments.find((item) => bounded < item.offsetEnd) ??
      activeSegments.at(-1)!;
    return (
      interval.startTimeMs +
      Math.max(
        0,
        Math.min(
          interval.offsetEnd - interval.offsetStart,
          bounded - interval.offsetStart,
        ),
      )
    );
  };

  const parts: LyricPart[] = [];
  let cursor = 0;
  for (const [index, token] of tokens.entries()) {
    const startOffset = Math.round((durationMs * cursor) / letters);
    cursor += token.length;
    const endOffset = Math.round((durationMs * cursor) / letters);
    const overlaps = activeSegments.filter(
      (interval) =>
        startOffset < interval.offsetEnd && endOffset > interval.offsetStart,
    );
    if (overlaps.length === 0) {
      parts.push({
        startTimeMs: timelineTime(startOffset),
        durationMs: 0,
        words: index === tokens.length - 1 ? token : `${token} `,
      });
      continue;
    }

    const tokenParts: LyricPart[] = [];
    let tokenCursor = 0;
    for (const [overlapIndex, interval] of overlaps.entries()) {
      const segmentStart = Math.max(startOffset, interval.offsetStart);
      const segmentEnd = Math.min(endOffset, interval.offsetEnd);
      const nextTokenCursor =
        overlapIndex === overlaps.length - 1
          ? token.length
          : Math.round(
              (token.length * (segmentEnd - startOffset)) /
                (endOffset - startOffset),
            );
      const words = token.slice(tokenCursor, nextTokenCursor);
      tokenCursor = nextTokenCursor;
      if (!words) continue;
      const start =
        interval.startTimeMs + (segmentStart - interval.offsetStart);
      const end = interval.startTimeMs + (segmentEnd - interval.offsetStart);
      tokenParts.push({
        startTimeMs: start,
        durationMs: Math.max(0, end - start),
        words,
      });
    }
    if (index < tokens.length - 1 && tokenParts.length > 0)
      tokenParts.at(-1)!.words += " ";
    parts.push(...tokenParts);
  }
  return parts;
}
