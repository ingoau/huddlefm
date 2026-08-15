import { parseLRC, parseTTMLContent, PlainParser } from "@braccato/parsers";
import type { Lyric } from "@braccato/core";
import type { TrackMetadata } from "./tracks.ts";

export type LyricsPayload = {
  lines: Lyric[];
  source: string;
  priority: number;
};

function variants(track: TrackMetadata) {
  const featured = track.title.match(/\s*[([]feat\.\s+([^\])]+)[\])]/i);
  return [
    [track.title, track.artist],
    ...(featured
      ? [
          [
            track.title.replace(featured[0], "").trim(),
            `${track.artist}, ${featured[1]!.trim()}`,
          ],
        ]
      : []),
  ];
}

export class LyricsCatalog {
  private cache = new Map<string, Promise<LyricsPayload | undefined>>();

  get(track: TrackMetadata) {
    let request = this.cache.get(track.sourceId);
    if (!request) {
      request = this.fetch(track);
      this.cache.set(track.sourceId, request);
    }
    return request;
  }

  private async fetch(track: TrackMetadata) {
    const results = await Promise.allSettled([
      this.betterLyrics(track),
      this.binimum(track),
      this.unison(track),
      this.amll(track),
      this.lrclib(track),
    ]);
    return results
      .flatMap((result) =>
        result.status === "fulfilled" && result.value ? [result.value] : [],
      )
      .sort((a, b) => a.priority - b.priority)[0];
  }

  private async betterLyrics(track: TrackMetadata) {
    for (const [title, artist] of variants(track)) {
      const url = new URL("https://lyrics-api.boidu.dev/getLyrics");
      url.searchParams.set("s", title!);
      url.searchParams.set("a", artist!);
      if (track.duration)
        url.searchParams.set("d", String(Math.round(track.duration)));
      if (track.album) url.searchParams.set("al", track.album);
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;
      const { ttml } = (await response.json()) as { ttml?: string };
      if (!ttml) continue;
      const parsed = parseTTMLContent(ttml, {
        songDurationMs: (track.duration ?? 0) * 1000,
      });
      if (parsed.isWordSynced && parsed.lyrics.length)
        return { lines: parsed.lyrics, source: "Better Lyrics", priority: 0 };
    }
  }

  private async binimum(track: TrackMetadata) {
    for (const [title, artist] of variants(track)) {
      const url = new URL("https://lyrics-api.binimum.org/");
      url.searchParams.set("track", title!);
      url.searchParams.set("artist", artist!);
      if (track.duration)
        url.searchParams.set("duration", String(Math.round(track.duration)));
      if (track.album) url.searchParams.set("album", track.album);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const result = (
        (await response.json()) as {
          results?: { timing_type?: string; lyricsUrl?: string }[];
        }
      ).results?.find((value) => value.timing_type === "word");
      if (!result?.lyricsUrl?.startsWith("https://lyrics-storage.binimum.org/"))
        continue;
      const lyricResponse = await fetch(result.lyricsUrl, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!lyricResponse.ok) continue;
      const parsed = parseTTMLContent(await lyricResponse.text(), {
        songDurationMs: (track.duration ?? 0) * 1000,
      });
      if (parsed.isWordSynced && parsed.lyrics.length)
        return { lines: parsed.lyrics, source: "BiniLyrics", priority: 2 };
    }
  }

  private async unison(track: TrackMetadata) {
    const url = new URL("https://unison.boidu.dev/lyrics");
    url.searchParams.set("v", track.sourceId);
    url.searchParams.set("song", track.title);
    url.searchParams.set("artist", track.artist);
    if (track.duration)
      url.searchParams.set("duration", String(Math.round(track.duration)));
    if (track.album) url.searchParams.set("album", track.album);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return;
    const data = (
      (await response.json()) as { data?: { format?: string; lyrics?: string } }
    ).data;
    if (!data?.lyrics) return;
    const duration = (track.duration ?? 0) * 1000;
    const parsed =
      data.format === "ttml"
        ? parseTTMLContent(data.lyrics, { songDurationMs: duration })
        : undefined;
    const lines =
      parsed?.lyrics ??
      (data.format === "lrc"
        ? parseLRC(data.lyrics, duration)
        : data.format === "plain"
          ? PlainParser.parse(data.lyrics, duration)
          : []);
    return lines.length
      ? {
          lines,
          source: "Better Lyrics · Unison",
          priority: parsed?.isWordSynced ? 1 : data.format === "plain" ? 13 : 7,
        }
      : undefined;
  }

  private async amll(track: TrackMetadata) {
    const response = await fetch(
      "https://amlldb.bikonoo.com/api/search-lyrics",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: track.title, type: "title" }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return;
    const normalize = (value: string) =>
      value.toLowerCase().replace(/\s+/g, " ").trim();
    const results = (await response.json()) as {
      file?: string;
      title?: string;
      titles?: string[];
      artist?: string;
      artists?: string[];
    }[];
    const match = results.find(
      (result) =>
        [...(result.titles ?? []), result.title ?? ""].some(
          (value) => normalize(value) === normalize(track.title),
        ) &&
        [...(result.artists ?? []), result.artist ?? ""].some(
          (value) => normalize(value) === normalize(track.artist),
        ) &&
        result.file?.endsWith(".ttml"),
    );
    if (!match?.file) return;
    const lyricResponse = await fetch(
      `https://amlldb.bikonoo.com/raw-lyrics/${encodeURIComponent(match.file)}`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!lyricResponse.ok) return;
    const parsed = parseTTMLContent(await lyricResponse.text(), {
      songDurationMs: (track.duration ?? 0) * 1000,
    });
    return parsed.isWordSynced && parsed.lyrics.length
      ? { lines: parsed.lyrics, source: "AMLL TTML DB", priority: 5 }
      : undefined;
  }

  private async lrclib(track: TrackMetadata) {
    const url = new URL("https://lrclib.net/api/get");
    url.searchParams.set("track_name", track.title);
    url.searchParams.set("artist_name", track.artist);
    if (track.duration)
      url.searchParams.set("duration", String(Math.round(track.duration)));
    if (track.album) url.searchParams.set("album_name", track.album);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return;
    const data = (await response.json()) as {
      syncedLyrics?: string;
      plainLyrics?: string;
    };
    const duration = (track.duration ?? 0) * 1000;
    const lines = data.syncedLyrics
      ? parseLRC(data.syncedLyrics, duration)
      : data.plainLyrics
        ? PlainParser.parse(data.plainLyrics, duration)
        : [];
    return lines.length
      ? {
          lines,
          source: "Better Lyrics · LRCLIB",
          priority: data.syncedLyrics ? 9 : 14,
        }
      : undefined;
  }
}
