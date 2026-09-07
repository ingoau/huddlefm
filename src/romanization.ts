import { containsNonLatin, detectNonLatinLanguage } from "@braccato/core/text";
import type { Lyric } from "@braccato/core";
import { transliterate } from "transliteration";
import { isJapanese, toRomaji } from "wanakana";
import { logger } from "./logger.ts";

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

function isRomanizableLine(line: Lyric) {
  if (line.isInstrumental || line.romanization?.trim()) return false;
  const text = line.words?.trim();
  if (!text || MUSIC_NOTES.test(text)) return false;
  return containsNonLatin(text);
}

function googleLang(lang: string) {
  return lang === "zh" ? "zh-CN" : lang;
}

function googleRomajiUrl(lang: string, text: string) {
  const source = googleLang(lang);
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

function lineLanguage(text: string) {
  return detectNonLatinLanguage(text) ?? "auto";
}

function groupByLanguage(pending: PendingLine[]) {
  const groups = new Map<string, PendingLine[]>();
  for (const item of pending) {
    const group = groups.get(item.lang) ?? [];
    group.push(item);
    groups.set(item.lang, group);
  }
  return groups;
}

async function romanizeViaUnison(
  items: PendingLine[],
  sourceLanguage: string,
  options: RomanizeRequestOptions,
) {
  if (items.length === 0) return new Map<number, string>();
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
  if (items.length === 0) return new Map<number, string>();
  const fetchImpl = options.fetch ?? fetch;
  const results = new Map<number, string>();
  const chunks: PendingLine[][] = [];
  let current: PendingLine[] = [];
  let encodedLength = 0;
  const baseUrl = googleRomajiUrl(sourceLanguage, "");
  const separatorEncoded = encodeURIComponent(BATCH_SEPARATOR);

  for (const item of items) {
    const itemEncoded = encodeURIComponent(item.text);
    const added =
      (current.length > 0 ? separatorEncoded.length : 0) + itemEncoded.length;
    if (
      current.length > 0 &&
      baseUrl.length + encodedLength + added > MAX_URL_LENGTH
    ) {
      chunks.push(current);
      current = [];
      encodedLength = 0;
    }
    current.push(item);
    encodedLength +=
      (current.length > 1 ? separatorEncoded.length : 0) + itemEncoded.length;
  }
  if (current.length) chunks.push(current);

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
    let full = "";
    for (const part of data[0] as unknown[]) {
      if (!Array.isArray(part)) continue;
      const romanized = (part[3] ?? part[2]) as string | undefined;
      if (romanized) full += romanized;
    }
    let romanizedLines = full.split(BATCH_SEPARATOR);
    if (romanizedLines.length < chunk.length) {
      const semicolonSplit = full.split(";").filter((line) => line.trim());
      if (semicolonSplit.length === chunk.length)
        romanizedLines = semicolonSplit;
      else {
        const newlineSplit = full.split(/\r?\n/).filter((line) => line.trim());
        if (newlineSplit.length === chunk.length) romanizedLines = newlineSplit;
        else if (romanizedLines.length === 1 && chunk.length > 1)
          romanizedLines = [];
      }
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
  const stillNeeded = () =>
    items.filter((item) => !results.has(item.lineIndex));

  try {
    for (const [lineIndex, romanization] of await romanizeViaUnison(
      stillNeeded(),
      lang,
      requestOptions,
    ))
      results.set(lineIndex, romanization);
  } catch (error) {
    log.warn(
      { event: "unison_romanization_failed", lang, err: error },
      "Unison romanization failed",
    );
  }

  const missing = stillNeeded();
  if (missing.length === 0 || signal.aborted) return;

  try {
    for (const [lineIndex, romanization] of await romanizeViaGoogle(
      missing,
      lang === "auto" ? "auto" : lang,
      requestOptions,
    ))
      results.set(lineIndex, romanization);
  } catch (error) {
    log.warn(
      { event: "google_romanization_failed", lang, err: error },
      "Google romanization failed",
    );
  }
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
    return [{ lineIndex, text, lang: lineLanguage(text) }];
  });
  if (pending.length === 0) return lines;

  const results = new Map<number, string>();
  for (const [lang, group] of groupByLanguage(pending))
    await romanizeLanguageGroup(group, lang, options, results);

  let attached = 0;
  for (const item of pending) {
    let romanization = results.get(item.lineIndex);
    if (!romanization)
      romanization = localRomanize(
        item.text,
        item.lang === "auto" ? null : item.lang,
      );
    if (!romanization || isSameText(romanization, item.text)) continue;
    lines[item.lineIndex]!.romanization = romanization;
    attached += 1;
  }

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

/** True when any line carries a romanization that should be rendered. */
export function lyricsHaveRomanization(lines: Lyric[]) {
  return lines.some((line) => Boolean(line.romanization?.trim()));
}
