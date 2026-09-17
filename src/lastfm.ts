import { logger } from "./logger.ts";

const log = logger.child({ component: "lastfm" });
const endpoint = "https://ws.audioscrobbler.com/2.0/";
const requestTimeoutMs = 10_000;

/**
 * How many rows one Last.fm link contributes. Each row still has to be matched
 * against YouTube Music before it can play, so this is an upper bound on the
 * searches a single add performs, not on the tracks that reach the queue.
 */
export const lastFmCollectionLimit = 50;

export type LastFmTrack = {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
};

export type LastFmPeriod =
  "overall" | "7day" | "1month" | "3month" | "6month" | "12month";

/** A Last.fm page that lists tracks, and the API call that reproduces it. */
export type LastFmCollection =
  | { kind: "loved"; user: string }
  | { kind: "user-top"; user: string; period: LastFmPeriod }
  | { kind: "user-recent"; user: string }
  | { kind: "artist-top"; artist: string }
  | { kind: "album"; artist: string; album: string }
  | { kind: "tag-top"; tag: string }
  | { kind: "chart-top" };

export type LastFmLink =
  | { type: "collection"; collection: LastFmCollection; label: string }
  | { type: "track"; track: LastFmTrack }
  | { type: "unsupported"; reason: string };

/** A refusal from the Last.fm API, carrying its documented error code. */
export class LastFmError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = "LastFmError";
    this.code = code;
  }
}

// Last.fm writes spaces in artist, album, and track segments as `+`, and
// escapes a literal plus as `%2B`, so the two have to be undone in that order.
// Sub-pages (`+tracks`, `+wiki`) keep their leading plus and are matched raw.
function decodeSegment(value: string) {
  const spaced = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced).trim();
  } catch {
    return spaced.trim();
  }
}

// The date filter on a library page. Anything unrecognized falls back to the
// all-time chart, which is what Last.fm itself shows without a preset.
const periods: Record<string, LastFmPeriod> = {
  LAST_7_DAYS: "7day",
  LAST_30_DAYS: "1month",
  LAST_90_DAYS: "3month",
  LAST_180_DAYS: "6month",
  LAST_365_DAYS: "12month",
  ALL: "overall",
};

const periodLabels: Record<LastFmPeriod, string> = {
  overall: "",
  "7day": " (last 7 days)",
  "1month": " (last 30 days)",
  "3month": " (last 90 days)",
  "6month": " (last 180 days)",
  "12month": " (last year)",
};

export function lastFmCollectionLabel(collection: LastFmCollection) {
  switch (collection.kind) {
    case "loved":
      return `Add Last.fm loved tracks: ${collection.user}`;
    case "user-top":
      return `Add Last.fm top tracks${periodLabels[collection.period]}: ${collection.user}`;
    case "user-recent":
      return `Add Last.fm recent tracks: ${collection.user}`;
    case "artist-top":
      return `Add Last.fm top tracks: ${collection.artist}`;
    case "album":
      return `Add Last.fm album: ${collection.album} — ${collection.artist}`;
    case "tag-top":
      return `Add Last.fm tag: ${collection.tag}`;
    case "chart-top":
      return "Add Last.fm charts";
  }
}

const unsupportedLink = (reason: string) =>
  ({ type: "unsupported", reason }) satisfies LastFmLink;

const collectionLink = (collection: LastFmCollection) =>
  ({
    type: "collection",
    collection,
    label: lastFmCollectionLabel(collection),
  }) satisfies LastFmLink;

/**
 * Classifies a Last.fm URL. Returns undefined for every other host so callers
 * can fall through to their normal link handling; a Last.fm URL that has no
 * API equivalent comes back as `unsupported` with a message for the user,
 * because no extractor will ever make that page playable.
 */
export function lastFmLink(url?: URL): LastFmLink | undefined {
  if (!url) return;
  const host = url.hostname.toLowerCase();
  if (host !== "last.fm" && !host.endsWith(".last.fm")) return;
  const raw = url.pathname.split("/").filter(Boolean);
  const name = (index: number) => decodeSegment(raw[index] ?? "");

  if (raw[0] === "user") {
    const user = name(1);
    if (!user) return unsupportedLink("That Last.fm link is not supported");
    const page = raw[2];
    if (!page)
      return collectionLink({ kind: "user-top", user, period: "overall" });
    if (page === "loved") return collectionLink({ kind: "loved", user });
    if (page === "playlists")
      return unsupportedLink(
        "Last.fm playlists are not in its API — try loved, library, or album links",
      );
    if (page === "recent-tracks" || page === "+recent-tracks")
      return collectionLink({ kind: "user-recent", user });
    if (page === "library" && (!raw[3] || raw[3] === "tracks")) {
      const preset = url.searchParams.get("date_preset") ?? "";
      return collectionLink({
        kind: "user-top",
        user,
        period: periods[preset.toUpperCase()] ?? "overall",
      });
    }
    return unsupportedLink("That Last.fm link is not supported");
  }

  if (raw[0] === "music") {
    const artist = name(1);
    if (!artist || raw[1]!.startsWith("+"))
      return unsupportedLink("That Last.fm link is not supported");
    const second = raw[2];
    if (!second || second === "+tracks")
      return collectionLink({ kind: "artist-top", artist });
    if (second.startsWith("+"))
      return unsupportedLink("That Last.fm link is not supported");
    // `_` stands in for "no particular album" on a track page.
    if (second === "_")
      return raw[3]
        ? { type: "track", track: { title: name(3), artist } }
        : collectionLink({ kind: "artist-top", artist });
    if (raw[3] && !raw[3].startsWith("+"))
      return {
        type: "track",
        track: { title: name(3), artist, album: name(2) },
      };
    return collectionLink({ kind: "album", artist, album: name(2) });
  }

  if (raw[0] === "tag") {
    const tag = name(1);
    if (!tag || (raw[2] && raw[2] !== "tracks"))
      return unsupportedLink("That Last.fm link is not supported");
    return collectionLink({ kind: "tag-top", tag });
  }

  if (raw[0] === "charts") return collectionLink({ kind: "chart-top" });

  return unsupportedLink("That Last.fm link is not supported");
}

type CollectionRequest = {
  method: string;
  params: Record<string, string>;
  /** Where the track rows sit in the response body. */
  path: string[];
};

function collectionRequest(
  collection: LastFmCollection,
  limit: number,
): CollectionRequest {
  const count = String(limit);
  switch (collection.kind) {
    case "loved":
      return {
        method: "user.getLovedTracks",
        params: { user: collection.user, limit: count },
        path: ["lovedtracks", "track"],
      };
    case "user-top":
      return {
        method: "user.getTopTracks",
        params: {
          user: collection.user,
          period: collection.period,
          limit: count,
        },
        path: ["toptracks", "track"],
      };
    case "user-recent":
      return {
        method: "user.getRecentTracks",
        params: { user: collection.user, limit: count },
        path: ["recenttracks", "track"],
      };
    case "artist-top":
      return {
        method: "artist.getTopTracks",
        params: { artist: collection.artist, limit: count, autocorrect: "1" },
        path: ["toptracks", "track"],
      };
    // An album page answers with the whole tracklist, so `limit` only trims it.
    case "album":
      return {
        method: "album.getInfo",
        params: {
          artist: collection.artist,
          album: collection.album,
          autocorrect: "1",
        },
        path: ["album", "tracks", "track"],
      };
    case "tag-top":
      return {
        method: "tag.getTopTracks",
        params: { tag: collection.tag, limit: count },
        path: ["tracks", "track"],
      };
    case "chart-top":
      return {
        method: "chart.getTopTracks",
        params: { limit: count },
        path: ["tracks", "track"],
      };
  }
}

/** Reads the tracks a Last.fm page lists, in the order the page lists them. */
export async function lastFmCollectionTracks(
  collection: LastFmCollection,
  options: {
    apiKey: string;
    limit?: number;
    proxy?: string;
    request?: typeof fetch;
  },
): Promise<LastFmTrack[]> {
  const startedAt = Date.now();
  const limit = Math.min(
    Math.max(options.limit ?? lastFmCollectionLimit, 1),
    200,
  );
  const request = collectionRequest(collection, limit);
  const url = new URL(endpoint);
  url.searchParams.set("method", request.method);
  url.searchParams.set("api_key", options.apiKey);
  url.searchParams.set("format", "json");
  for (const [key, value] of Object.entries(request.params))
    url.searchParams.set(key, value);
  const body = await lastFmJson(url, options);
  const fallbackArtist =
    collection.kind === "album" ? collection.artist : undefined;
  const fallbackAlbum =
    collection.kind === "album" ? collection.album : undefined;
  const seen = new Set<string>();
  const tracks: LastFmTrack[] = [];
  for (const row of asArray(dig(body, request.path))) {
    const track = lastFmTrack(row, fallbackArtist, fallbackAlbum);
    if (!track) continue;
    const key = `${track.artist.toLowerCase()}|${track.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push(track);
    if (tracks.length >= limit) break;
  }
  log.info(
    {
      event: "collection_read",
      collectionKind: collection.kind,
      method: request.method,
      count: tracks.length,
      durationMs: Date.now() - startedAt,
    },
    "Last.fm collection read",
  );
  return tracks;
}

async function lastFmJson(
  url: URL,
  options: { proxy?: string; request?: typeof fetch },
) {
  const send = options.request ?? fetch;
  const response = await send(url.href, {
    headers: { accept: "application/json", "user-agent": "HuddleFM" },
    signal: AbortSignal.timeout(requestTimeoutMs),
    ...(options.proxy ? { proxy: options.proxy } : {}),
  });
  const body = (await response.json().catch(() => undefined)) as
    Record<string, unknown> | undefined;
  if (body && typeof body.error === "number")
    throw new LastFmError(
      String(body.message ?? "Last.fm request failed"),
      body.error,
    );
  if (!response.ok)
    throw new LastFmError(`Last.fm returned HTTP ${response.status}`, 0);
  if (!body) throw new LastFmError("Last.fm returned no data", 0);
  return body;
}

function dig(value: unknown, path: string[]) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asArray(value: unknown) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Artist, album, and track names arrive as a string, `{name}`, or `{#text}`. */
export function lastFmName(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const row = value as { name?: unknown; "#text"?: unknown };
    return String(row.name ?? row["#text"] ?? "");
  }
  return "";
}

function lastFmTrack(
  value: unknown,
  fallbackArtist?: string,
  fallbackAlbum?: string,
): LastFmTrack | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as {
    name?: unknown;
    artist?: unknown;
    album?: unknown;
    duration?: unknown;
  };
  const title = lastFmName(row.name).trim();
  const artist = (lastFmName(row.artist) || fallbackArtist || "").trim();
  if (!title || !artist) return;
  const album = (lastFmName(row.album) || fallbackAlbum || "").trim();
  const duration = Number(row.duration);
  return {
    title,
    artist,
    ...(album ? { album } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
  };
}
