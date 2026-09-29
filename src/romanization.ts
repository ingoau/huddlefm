import { containsNonLatin, detectNonLatinLanguage } from "@braccato/core/text";
import type { Lyric } from "@braccato/core";
import { transliterate } from "transliteration";
import { isJapanese, toRomaji } from "wanakana";
import { logger } from "./logger.ts";
import { buildTimedRomanization } from "./timed-romanization.ts";

export { buildTimedRomanization };

const log = logger.child({ component: "romanization" });

const UNISON_TRANSLATE_URL = "https://unison.boidu.dev/translate";
const BATCH_SEPARATOR = "\n\n;\n\n";
const MAX_URL_LENGTH = 15_000;
const ROMANIZATION_TIMEOUT_MS = 12_000;
const MUSIC_NOTES = /^[\s♪𝅘𝅥𝅮♫♬♩♭♮♯]+$/u;

export type RomanizeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type RomanizeOptions = {
  videoId?: string;
  signal?: AbortSignal;
  fetch?: RomanizeFetch;
};

type RomanizeRequestOptions = RomanizeOptions & { signal: AbortSignal };

type PendingLine = {
  lineIndex: number;
  text: string;
  lang: string;
};

function isSameText(a: string, b: string) {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replaceAll(/(\p{P})/gu, "")
      .trim();
  return normalize(a) === normalize(b);
}

function tidyRomanization(text: string) {
  return text
    .replace(/\s+(?=[.,!?])/gu, "")
    .replace(/(?<=[.,!?])(?=\w)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isRomanizableLine(line: Lyric) {
  if (line.isInstrumental || line.romanization?.trim()) return false;
  const text = line.words?.trim();
  if (!text || MUSIC_NOTES.test(text)) return false;
  return containsNonLatin(text);
}

function googleRomajiUrl(lang: string, text: string) {
  const source = lang === "zh" ? "zh-CN" : lang;
  return `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(`${source}-Latn`)}&dt=t&dt=rm&q=${encodeURIComponent(text)}`;
}

function localRomanize(text: string, lang: string | null) {
  if (lang === "ja" || isJapanese(text)) {
    const romaji = toRomaji(text);
    const hasCjk = /[\u3040-\u30ff\u4e00-\u9fff]/u.test(romaji);
    if (romaji && !isSameText(romaji, text) && !hasCjk) return romaji.trim();
  }
  const result = transliterate(text).trim();
  return result && !isSameText(result, text) ? result : undefined;
}

async function romanizeViaUnison(
  items: PendingLine[],
  sourceLanguage: string,
  options: RomanizeRequestOptions,
) {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(UNISON_TRANSLATE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lines: items.map((item) => item.text),
      to: "en",
      from: sourceLanguage === "auto" ? undefined : sourceLanguage,
      videoId: options.videoId,
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Unison translate HTTP ${response.status}`);
  const data = (await response.json()) as {
    lines?: { romanization?: string | null }[];
  };
  if (!Array.isArray(data.lines) || data.lines.length !== items.length)
    throw new Error("Unison translate returned unexpected shape");
  const results = new Map<number, string>();
  data.lines.forEach((line, index) => {
    const romanization = line?.romanization?.trim();
    if (!romanization || isSameText(romanization, items[index]!.text)) return;
    results.set(items[index]!.lineIndex, romanization);
  });
  return results;
}

async function romanizeViaGoogle(
  items: PendingLine[],
  sourceLanguage: string,
  options: RomanizeRequestOptions,
) {
  const fetchImpl = options.fetch ?? fetch;
  const results = new Map<number, string>();
  const baseLength = googleRomajiUrl(sourceLanguage, "").length;
  const separatorLength = encodeURIComponent(BATCH_SEPARATOR).length;
  const chunks: PendingLine[][] = [[]];
  let urlLength = baseLength;

  for (const item of items) {
    const current = chunks.at(-1)!;
    const itemLength = encodeURIComponent(item.text).length;
    const added = (current.length ? separatorLength : 0) + itemLength;
    if (current.length && urlLength + added > MAX_URL_LENGTH) {
      chunks.push([item]);
      urlLength = baseLength + itemLength;
    } else {
      current.push(item);
      urlLength += added;
    }
  }

  for (const chunk of chunks) {
    const combined = chunk.map((item) => item.text).join(BATCH_SEPARATOR);
    const response = await fetchImpl(
      googleRomajiUrl(sourceLanguage, combined),
      {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0",
        },
        signal: options.signal,
      },
    );
    if (!response.ok) continue;
    const data = (await response.json()) as unknown[][];
    if (!Array.isArray(data?.[0])) continue;
    const full = data[0]
      .map((part) =>
        Array.isArray(part) ? ((part[3] ?? part[2]) as string | undefined) : "",
      )
      .filter(Boolean)
      .join("");
    let romanizedLines = full.split(BATCH_SEPARATOR);
    if (romanizedLines.length !== chunk.length) {
      // Google sometimes collapses the separator; fall back to whichever
      // split yields one line per input, or give up on the whole chunk so
      // no line is handed another line's romanization.
      romanizedLines =
        [full.split(";"), full.split(/\r?\n/)]
          .map((lines) => lines.filter((line) => line.trim()))
          .find((lines) => lines.length === chunk.length) ?? [];
    }
    chunk.forEach((item, index) => {
      const romanized = romanizedLines[index]?.trim();
      if (romanized && !isSameText(romanized, item.text))
        results.set(item.lineIndex, romanized);
    });
  }
  return results;
}

async function romanizeLanguageGroup(
  items: PendingLine[],
  lang: string,
  options: RomanizeOptions,
  results: Map<number, string>,
) {
  const timeoutSignal = AbortSignal.timeout(ROMANIZATION_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const requestOptions = { ...options, signal };
  const attempt = async (
    provider: "Unison" | "Google",
    romanize: typeof romanizeViaUnison,
    pending: PendingLine[],
  ) => {
    try {
      for (const [lineIndex, romanization] of await romanize(
        pending,
        lang,
        requestOptions,
      ))
        results.set(lineIndex, romanization);
    } catch (error) {
      log.warn(
        {
          event: `${provider.toLowerCase()}_romanization_failed`,
          lang,
          err: error,
        },
        `${provider} romanization failed`,
      );
    }
  };

  await attempt("Unison", romanizeViaUnison, items);
  const missing = items.filter((item) => !results.has(item.lineIndex));
  if (missing.length && !signal.aborted)
    await attempt("Google", romanizeViaGoogle, missing);
}

/**
 * Attaches romanizations to lyric lines that use non-Latin scripts.
 * Prefers provider-supplied romanization, then Unison, then Google Translate
 * romaji, then a local transliteration fallback. Never throws.
 */
export async function enrichLyricsWithRomanization(
  lines: Lyric[],
  options: RomanizeOptions = {},
) {
  const pending = lines.flatMap((line, lineIndex) => {
    if (!isRomanizableLine(line)) return [];
    const text = line.words.trim();
    return [{ lineIndex, text, lang: detectNonLatinLanguage(text) ?? "auto" }];
  });

  const results = new Map<number, string>();
  for (const [lang, group] of Map.groupBy(pending, (item) => item.lang))
    await romanizeLanguageGroup(group, lang, options, results);

  let attached = 0;
  for (const item of pending) {
    const romanization =
      results.get(item.lineIndex) ??
      localRomanize(item.text, item.lang === "auto" ? null : item.lang);
    if (!romanization || isSameText(romanization, item.text)) continue;
    lines[item.lineIndex]!.romanization = tidyRomanization(romanization);
    attached += 1;
  }

  attachTimedRomanizations(lines);

  if (attached)
    log.info(
      {
        event: "romanized",
        lines: attached,
        languages: [...new Set(pending.map((item) => item.lang))],
        videoId: options.videoId,
      },
      "Attached lyric romanizations",
    );
  return lines;
}

function attachTimedRomanizations(lines: Lyric[]) {
  for (const line of lines) {
    if (!line.romanization?.trim()) continue;
    line.romanization = tidyRomanization(line.romanization);
    if (line.timedRomanization?.length) continue;
    const timed = buildTimedRomanization(line);
    if (timed?.length) line.timedRomanization = timed;
  }
}

/** True when any line carries a romanization that should be rendered. */
export function lyricsHaveRomanization(lines: Lyric[]) {
  return lines.some((line) => Boolean(line.romanization?.trim()));
}
