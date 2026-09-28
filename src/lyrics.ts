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
};

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

async function fetchJson<T>(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response.ok ? ((await response.json()) as T) : undefined;
}

async function fetchText(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return response.ok ? response.text() : undefined;
}

const payload = (lines: Lyric[], source: string, priority: number) =>
  lines.length ? { lines, source, priority } : undefined;

function wordSyncedLines(ttml: string, track: TrackMetadata) {
  const parsed = parseTTMLContent(ttml, {
    songDurationMs: songDurationMs(track),
  });
  return parsed.isWordSynced ? parsed.lyrics : [];
}

export class LyricsCatalog {
  private cache = new Map<string, Promise<LyricsPayload | undefined>>();

  get(track: TrackMetadata) {
    const cached = this.cache.get(track.sourceId);
    log.debug(
      { event: cached ? "cache_hit" : "cache_miss", sourceId: track.sourceId },
      cached ? "Using cached lyrics request" : "Fetching lyrics",
    );
    if (cached) return cached;
    const request = this.fetch(track);
    this.cache.set(track.sourceId, request);
    return request;
  }

  private async fetch(track: TrackMetadata) {
    const startedAt = Date.now();
    const providers: [string, Promise<LyricsPayload | undefined>][] = [
      ["better-lyrics", this.betterLyrics(track)],
      ["binimum", this.binimum(track)],
      ["unison", this.unison(track)],
      ["amll", this.amll(track)],
      ["lrclib", this.lrclib(track)],
    ];
    const results = await Promise.all(
      providers.map(async ([provider, work]) => {
        try {
          return await work;
        } catch (error) {
          log.warn(
            {
              event: "provider_failed",
              provider,
              sourceId: track.sourceId,
              err: error,
            },
            "Lyrics provider failed",
          );
        }
      }),
    );
    const selected = results
      .flatMap((result) => (result ? [result] : []))
      .sort((a, b) => a.priority - b.priority)[0];
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
    return selected;
  }

  private async betterLyrics(track: TrackMetadata) {
    for (const [title, artist] of variants(track)) {
      const url = new URL("https://lyrics-api.boidu.dev/getLyrics");
      url.searchParams.set("s", title);
      url.searchParams.set("a", artist);
      const data = await fetchJson<{ ttml?: string }>(
        withHints(url, track, ["d", "al"]),
        {
          headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
        },
        15_000,
      );
      if (!data?.ttml) continue;
      const found = payload(
        wordSyncedLines(data.ttml, track),
        "Better Lyrics",
        0,
      );
      if (found) return found;
    }
  }

  private async binimum(track: TrackMetadata) {
    for (const [title, artist] of variants(track)) {
      const url = new URL("https://lyrics-api.binimum.org/");
      url.searchParams.set("track", title);
      url.searchParams.set("artist", artist);
      const data = await fetchJson<{
        results?: { timing_type?: string; lyricsUrl?: string }[];
      }>(withHints(url, track, ["duration", "album"]));
      const lyricsUrl = data?.results?.find(
        (value) => value.timing_type === "word",
      )?.lyricsUrl;
      if (!lyricsUrl?.startsWith("https://lyrics-storage.binimum.org/"))
        continue;
      const ttml = await fetchText(lyricsUrl);
      if (!ttml) continue;
      const found = payload(wordSyncedLines(ttml, track), "BiniLyrics", 2);
      if (found) return found;
    }
  }

  private async unison(track: TrackMetadata) {
    const url = new URL("https://unison.boidu.dev/lyrics");
    url.searchParams.set("v", track.sourceId);
    url.searchParams.set("song", track.title);
    url.searchParams.set("artist", track.artist);
    const data = (
      await fetchJson<{ data?: { format?: string; lyrics?: string } }>(
        withHints(url, track, ["duration", "album"]),
      )
    )?.data;
    if (!data?.lyrics) return;
    const source = "Better Lyrics · Unison";
    const durationMs = songDurationMs(track);
    if (data.format === "ttml") {
      const parsed = parseTTMLContent(data.lyrics, {
        songDurationMs: durationMs,
      });
      return payload(parsed.lyrics, source, parsed.isWordSynced ? 1 : 7);
    }
    const lines =
      data.format === "lrc"
        ? parseLRC(data.lyrics, durationMs)
        : data.format === "plain"
          ? PlainParser.parse(data.lyrics, durationMs)
          : [];
    return payload(lines, source, data.format === "plain" ? 13 : 7);
  }

  private async amll(track: TrackMetadata) {
    const results = await fetchJson<
      {
        file?: string;
        title?: string;
        titles?: string[];
        artist?: string;
        artists?: string[];
      }[]
    >("https://amlldb.bikonoo.com/api/search-lyrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: track.title, type: "title" }),
    });
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
    );
    if (!ttml) return;
    return payload(wordSyncedLines(ttml, track), "AMLL TTML DB", 5);
  }

  private async lrclib(track: TrackMetadata) {
    const url = new URL("https://lrclib.net/api/get");
    url.searchParams.set("track_name", track.title);
    url.searchParams.set("artist_name", track.artist);
    const data = await fetchJson<{
      syncedLyrics?: string;
      plainLyrics?: string;
    }>(withHints(url, track, ["duration", "album_name"]));
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
