import { parseLRC, parseTTMLContent, PlainParser } from "@braccato/parsers";
import type { Lyric } from "@braccato/core";
import { logger } from "./logger.ts";
import { sanitizeInlineLyricRoles } from "./lyric-sanitize.ts";
import { enrichLyricsWithRomanization } from "./romanization.ts";
import type { TrackMetadata } from "./tracks.ts";

const log = logger.child({ component: "lyrics" });

export type LyricsPayload = {
  lines: Lyric[];
  source: string;
  priority: number;
  /** Credited writers, when the provider's TTML names them. */
  songwriters?: string[];
};

const xmlEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(text: string) {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (match, code: string) => {
    if (code[0] !== "#") return xmlEntities[code] ?? match;
    const point =
      code[1]?.toLowerCase() === "x"
        ? Number.parseInt(code.slice(2), 16)
        : Number(code.slice(1));
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : match;
  });
}

/**
 * The songwriters a TTML file credits: Apple's iTunesMetadata lists them as
 * `<songwriter>` elements, AMLL's as `<amll:meta key="songwriters">` tags.
 */
export function songwritersFrom(ttml: string) {
  const names = [
    ...ttml.matchAll(
      /<(?:[\w-]+:)?songwriter\b[^>]*>([^<]*)<\/(?:[\w-]+:)?songwriter>/g,
    ),
  ].map((match) => match[1]!);
  const attribute = (attributes: string, name: string) =>
    attributes.match(
      new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`),
    )?.[2];
  for (const [, attributes] of ttml.matchAll(/<(?:[\w-]+:)?meta\b([^>]*)>/g)) {
    const key = attribute(attributes!, "key");
    const value = attribute(attributes!, "value");
    if (value && /^songwriters?$/i.test(key ?? "")) names.push(value);
  }
  return [
    ...new Set(names.map((name) => decodeXml(name).trim()).filter(Boolean)),
  ];
}

function variants(track: TrackMetadata) {
  const featured = track.title.match(/\s*[([]feat\.\s+([^\])]+)[\])]/i);
  const list: [string, string][] = [[track.title, track.artist]];
  if (featured)
    list.push([
      track.title.replace(featured[0], "").trim(),
      `${track.artist}, ${featured[1]!.trim()}`,
    ]);
  return list;
}

const songDurationMs = (track: TrackMetadata) => (track.duration ?? 0) * 1000;

// Every provider accepts the duration and album as optional hints, each under
// its own parameter names.
function withHints(url: URL, track: TrackMetadata, names: [string, string]) {
  if (track.duration)
    url.searchParams.set(names[0], String(Math.round(track.duration)));
  if (track.album) url.searchParams.set(names[1], track.album);
  return url;
}

/** A request's deadline, cut short when `signal` gives up on it first. */
const deadline = (timeoutMs: number, signal?: AbortSignal) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

async function fetchJson<T>(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
  signal?: AbortSignal,
) {
  const response = await fetch(url, {
    ...init,
    signal: deadline(timeoutMs, signal),
  });
  return response.ok ? ((await response.json()) as T) : undefined;
}

async function fetchText(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal: deadline(10_000, signal) });
  return response.ok ? response.text() : undefined;
}

/**
 * The first of `attempts` to find something, in their order, with all of
 * them run at once: a later one's find waits on the earlier ones, as when
 * they were tried in turn, and the rest are stopped once one is chosen. An
 * earlier one's failure fails them all, as it did then.
 */
async function firstFound<T>(
  attempts: ((signal: AbortSignal) => Promise<T | undefined>)[],
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const running = attempts.map((attempt) => attempt(controller.signal));
  // Those after the one chosen are dropped, failures and all.
  for (const work of running) work.catch(() => undefined);
  try {
    for (const work of running) {
      const found = await work;
      if (found !== undefined) return found;
    }
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", stop);
  }
}

/** Lyrics requests kept, most recently used last. */
const maxCachedLyrics = 300;

const payload = (
  lines: Lyric[],
  source: string,
  priority: number,
  ttml?: string,
): LyricsPayload | undefined => {
  if (!lines.length) return;
  const songwriters = ttml ? songwritersFrom(ttml) : [];
  return {
    lines,
    source,
    priority,
    ...(songwriters.length ? { songwriters } : {}),
  };
};

function wordSyncedLines(ttml: string, track: TrackMetadata) {
  const parsed = parseTTMLContent(ttml, {
    songDurationMs: songDurationMs(track),
  });
  return parsed.isWordSynced ? parsed.lyrics : [];
}

type Provider = {
  name: string;
  /**
   * The best (lowest) priority it ever gives, so it is only waited on while
   * it could still beat what has been found. Keep in step with its payloads.
   */
  best: number;
  find: (
    track: TrackMetadata,
    signal: AbortSignal,
  ) => Promise<LyricsPayload | undefined>;
};

export class LyricsCatalog {
  /** Requests by source, least recently used first. */
  private cache = new Map<string, Promise<LyricsPayload | undefined>>();

  // In the order a tie in priority goes by.
  private providers: Provider[] = [
    {
      name: "better-lyrics",
      best: 0,
      find: (track, signal) => this.betterLyrics(track, signal),
    },
    {
      name: "binimum",
      best: 2,
      find: (track, signal) => this.binimum(track, signal),
    },
    {
      name: "unison",
      best: 1,
      find: (track, signal) => this.unison(track, signal),
    },
    {
      name: "amll",
      best: 5,
      find: (track, signal) => this.amll(track, signal),
    },
    {
      name: "lrclib",
      best: 9,
      find: (track, signal) => this.lrclib(track, signal),
    },
  ];

  get(track: TrackMetadata) {
    const cached = this.cache.get(track.sourceId);
    log.debug(
      { event: cached ? "cache_hit" : "cache_miss", sourceId: track.sourceId },
      cached ? "Using cached lyrics request" : "Fetching lyrics",
    );
    if (cached) {
      this.cache.delete(track.sourceId);
      this.cache.set(track.sourceId, cached);
      return cached;
    }
    const forget = () => {
      if (this.cache.get(track.sourceId) === request)
        this.cache.delete(track.sourceId);
    };
    // A failure, or nothing found when a provider failed, may go another
    // way next time, so neither is kept.
    const request: Promise<LyricsPayload | undefined> = this.fetch(track).then(
      ({ selected, failed }) => {
        if (!selected && failed) forget();
        return selected;
      },
      (error) => {
        forget();
        throw error;
      },
    );
    this.cache.set(track.sourceId, request);
    for (const sourceId of this.cache.keys()) {
      if (this.cache.size <= maxCachedLyrics) break;
      this.cache.delete(sourceId);
    }
    return request;
  }

  /**
   * Asks every provider at once and picks the best priority found, the
   * earlier provider on a tie. It picks as soon as no provider still
   * working could give a better one, and stops the rest.
   */
  private async fetch(track: TrackMetadata) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const results: (LyricsPayload | undefined)[] = [];
    const settled = new Set<number>();
    let failed = false;
    const selected = await new Promise<LyricsPayload | undefined>((resolve) => {
      const decide = () => {
        let best: number | undefined;
        for (const [index, result] of results.entries())
          if (
            result &&
            (best === undefined || result.priority < results[best]!.priority)
          )
            best = index;
        const bestPriority =
          best === undefined ? Infinity : results[best]!.priority;
        const couldBeat = this.providers.some(
          (provider, index) =>
            !settled.has(index) &&
            (provider.best < bestPriority ||
              (provider.best === bestPriority && index < best!)),
        );
        if (!couldBeat) resolve(best === undefined ? undefined : results[best]);
      };
      for (const [index, provider] of this.providers.entries())
        void provider
          .find(track, controller.signal)
          .then(
            (result) => {
              results[index] = result;
            },
            (error) => {
              if (controller.signal.aborted) return;
              failed = true;
              log.warn(
                {
                  event: "provider_failed",
                  provider: provider.name,
                  sourceId: track.sourceId,
                  err: error,
                },
                "Lyrics provider failed",
              );
            },
          )
          .finally(() => {
            settled.add(index);
            decide();
          });
    });
    controller.abort();
    if (selected) {
      sanitizeInlineLyricRoles(selected.lines);
      await enrichLyricsWithRomanization(selected.lines, {
        videoId: track.sourceId,
      });
    }
    log.info(
      {
        event: selected ? "found" : "unavailable",
        sourceId: track.sourceId,
        source: selected?.source,
        lines: selected?.lines.length,
        romanized: selected?.lines.filter((line) => line.romanization).length,
        durationMs: Date.now() - startedAt,
      },
      selected ? "Lyrics found" : "Lyrics unavailable",
    );
    return { selected, failed };
  }

  private betterLyrics(track: TrackMetadata, signal: AbortSignal) {
    return firstFound(
      variants(track).map(([title, artist]) => async (signal) => {
        const url = new URL("https://lyrics-api.boidu.dev/getLyrics");
        url.searchParams.set("s", title);
        url.searchParams.set("a", artist);
        const data = await fetchJson<{ ttml?: string }>(
          withHints(url, track, ["d", "al"]),
          {
            headers: {
              accept: "application/json",
              "user-agent": "Mozilla/5.0",
            },
          },
          15_000,
          signal,
        );
        if (!data?.ttml) return;
        return payload(
          wordSyncedLines(data.ttml, track),
          "Better Lyrics",
          0,
          data.ttml,
        );
      }),
      signal,
    );
  }

  private binimum(track: TrackMetadata, signal: AbortSignal) {
    return firstFound(
      variants(track).map(([title, artist]) => async (signal) => {
        const url = new URL("https://lyrics-api.binimum.org/");
        url.searchParams.set("track", title);
        url.searchParams.set("artist", artist);
        const data = await fetchJson<{
          results?: { timing_type?: string; lyricsUrl?: string }[];
        }>(withHints(url, track, ["duration", "album"]), {}, 10_000, signal);
        const lyricsUrl = data?.results?.find(
          (value) => value.timing_type === "word",
        )?.lyricsUrl;
        if (!lyricsUrl?.startsWith("https://lyrics-storage.binimum.org/"))
          return;
        const ttml = await fetchText(lyricsUrl, signal);
        if (!ttml) return;
        return payload(wordSyncedLines(ttml, track), "BiniLyrics", 2, ttml);
      }),
      signal,
    );
  }

  private async unison(track: TrackMetadata, signal: AbortSignal) {
    const url = new URL("https://unison.boidu.dev/lyrics");
    url.searchParams.set("v", track.sourceId);
    url.searchParams.set("song", track.title);
    url.searchParams.set("artist", track.artist);
    const data = (
      await fetchJson<{ data?: { format?: string; lyrics?: string } }>(
        withHints(url, track, ["duration", "album"]),
        {},
        10_000,
        signal,
      )
    )?.data;
    if (!data?.lyrics) return;
    const source = "Better Lyrics · Unison";
    const durationMs = songDurationMs(track);
    if (data.format === "ttml") {
      const parsed = parseTTMLContent(data.lyrics, {
        songDurationMs: durationMs,
      });
      return payload(
        parsed.lyrics,
        source,
        parsed.isWordSynced ? 1 : 7,
        data.lyrics,
      );
    }
    const lines =
      data.format === "lrc"
        ? parseLRC(data.lyrics, durationMs)
        : data.format === "plain"
          ? PlainParser.parse(data.lyrics, durationMs)
          : [];
    return payload(lines, source, data.format === "plain" ? 13 : 7);
  }

  private async amll(track: TrackMetadata, signal: AbortSignal) {
    const results = await fetchJson<
      {
        file?: string;
        title?: string;
        titles?: string[];
        artist?: string;
        artists?: string[];
      }[]
    >(
      "https://amlldb.bikonoo.com/api/search-lyrics",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: track.title, type: "title" }),
      },
      10_000,
      signal,
    );
    if (!results) return;
    const normalize = (value: string) =>
      value.toLowerCase().replace(/\s+/g, " ").trim();
    const matches = (values: (string | undefined)[], expected: string) =>
      values.some((value) => normalize(value ?? "") === normalize(expected));
    const match = results.find(
      (result) =>
        matches([...(result.titles ?? []), result.title], track.title) &&
        matches([...(result.artists ?? []), result.artist], track.artist) &&
        result.file?.endsWith(".ttml"),
    );
    if (!match?.file) return;
    const ttml = await fetchText(
      `https://amlldb.bikonoo.com/raw-lyrics/${encodeURIComponent(match.file)}`,
      signal,
    );
    if (!ttml) return;
    return payload(wordSyncedLines(ttml, track), "AMLL TTML DB", 5, ttml);
  }

  private async lrclib(track: TrackMetadata, signal: AbortSignal) {
    const url = new URL("https://lrclib.net/api/get");
    url.searchParams.set("track_name", track.title);
    url.searchParams.set("artist_name", track.artist);
    const data = await fetchJson<{
      syncedLyrics?: string;
      plainLyrics?: string;
    }>(withHints(url, track, ["duration", "album_name"]), {}, 10_000, signal);
    if (!data) return;
    const durationMs = songDurationMs(track);
    const lines = data.syncedLyrics
      ? parseLRC(data.syncedLyrics, durationMs)
      : data.plainLyrics
        ? PlainParser.parse(data.plainLyrics, durationMs)
        : [];
    return payload(lines, "Better Lyrics · LRCLIB", data.syncedLyrics ? 9 : 14);
  }
}
