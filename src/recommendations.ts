import { firstArtist } from "./artist.ts";
import { logger } from "./logger.ts";
import type { Store } from "./store.ts";
import {
  isYoutubeVideoId,
  type TrackCatalog,
  type TrackMetadata,
} from "./tracks.ts";

const log = logger.child({ component: "recommendations" });
const lastFmEndpoint = "https://ws.audioscrobbler.com/2.0/";
const listenBrainzEndpoint = "https://api.listenbrainz.org/1";
const tasteTtlMs = 15 * 60_000;
const userRecTtlMs = 10 * 60_000;
const userRecLimit = 10;
const mixCandidateLimit = 12;
const searchConcurrency = 3;
const requestTimeoutMs = 8_000;

export type TasteTrack = {
  title: string;
  artist: string;
  album?: string;
  sourceId?: string;
  sourceInput?: string;
  canonicalUrl?: string;
  artwork?: string;
  duration?: number;
};

export type TasteContribution = TasteTrack & {
  userId: string;
  weight: number;
  source: string;
};

export type ScoredTrack = TasteTrack & {
  score: number;
  userIds: string[];
  sources: string[];
};

export type PlayableRecommendation = TrackMetadata & {
  id: string;
  sources: string[];
};

export type AutoplayCandidate = {
  sourceId: string;
  score: number;
  seedCount: number;
  metadata: TrackMetadata;
};

export type SkipPenalties = {
  sourceIds?: Iterable<string | undefined>;
  artists?: Iterable<string>;
  tracks?: Iterable<{ title: string; artist: string }>;
};

export type RecommendationTracks = Pick<
  TrackCatalog,
  "searchSong" | "upNextTracks"
>;

type CacheEntry<T> = {
  value: T;
  expires: number;
  inflight?: Promise<T>;
};

export function normalizeToken(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function trackKey(title: string, artist: string) {
  return `${normalizeToken(artist)}\0${normalizeToken(title)}`;
}

export function mergeTaste(tracks: TasteContribution[]): ScoredTrack[] {
  const byKey = new Map<string, ScoredTrack>();
  for (const track of tracks) {
    if (!track.title.trim() || !track.artist.trim()) continue;
    const key = trackKey(track.title, track.artist);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        title: track.title,
        artist: track.artist,
        ...(track.album ? { album: track.album } : {}),
        ...(track.sourceId ? { sourceId: track.sourceId } : {}),
        ...(track.sourceInput ? { sourceInput: track.sourceInput } : {}),
        ...(track.canonicalUrl ? { canonicalUrl: track.canonicalUrl } : {}),
        ...(track.artwork ? { artwork: track.artwork } : {}),
        ...(track.duration ? { duration: track.duration } : {}),
        score: track.weight,
        userIds: [track.userId],
        sources: [track.source],
      });
      continue;
    }
    existing.score += track.weight;
    if (!existing.userIds.includes(track.userId))
      existing.userIds.push(track.userId);
    if (!existing.sources.includes(track.source))
      existing.sources.push(track.source);
    if (!existing.sourceId && track.sourceId) {
      existing.sourceId = track.sourceId;
      existing.sourceInput = track.sourceInput;
      existing.canonicalUrl = track.canonicalUrl;
      existing.artwork = track.artwork;
      existing.duration = track.duration;
    }
  }
  for (const item of byKey.values())
    item.score *= 1 + 0.8 * (item.userIds.length - 1);
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

export function skipSets(skipped: SkipPenalties = {}) {
  return {
    sourceIds: new Set(
      [...(skipped.sourceIds ?? [])].filter((id): id is string => Boolean(id)),
    ),
    artists: new Set(
      [...(skipped.artists ?? [])].map((artist) =>
        normalizeToken(firstArtist(artist)),
      ),
    ),
    keys: new Set(
      [...(skipped.tracks ?? [])].map((track) =>
        trackKey(track.title, track.artist),
      ),
    ),
  };
}

export function applySkipPenalties(
  tracks: ScoredTrack[],
  skipped: SkipPenalties = {},
) {
  const penalties = skipSets(skipped);
  return tracks
    .map((track) => {
      let { score } = track;
      if (track.sourceId && penalties.sourceIds.has(track.sourceId))
        score *= 0.05;
      if (penalties.keys.has(trackKey(track.title, track.artist))) score *= 0.1;
      if (penalties.artists.has(normalizeToken(firstArtist(track.artist))))
        score *= 0.35;
      return { ...track, score };
    })
    .sort((a, b) => b.score - a.score);
}

export class RecommendationCatalog {
  private taste = new Map<string, CacheEntry<TasteContribution[]>>();
  private userRecs = new Map<string, CacheEntry<PlayableRecommendation[]>>();
  private playable = new Map<string, TrackMetadata>();

  constructor(
    private store: Store,
    private tracks: RecommendationTracks,
    private config: { lastFmApiKey?: string } = {},
    private request = fetch,
  ) {}

  huddleMixOptedIn(userId: string) {
    return this.store.getUserScrobbling(userId).huddleMixOptIn !== false;
  }

  prefetchUsers(userIds: Iterable<string>) {
    for (const userId of userIds) void this.prefetchUser(userId);
  }

  prefetchUser(userId: string) {
    return this.cached(
      this.userRecs,
      userId,
      userRecTtlMs,
      () => this.buildUserRecommendations(userId),
      [],
    );
  }

  userRecommendations(
    userId: string,
    exclude: Iterable<string | undefined> = [],
  ) {
    const excluded = new Set(
      [...exclude].filter((id): id is string => Boolean(id)),
    );
    const cached = this.userRecs.get(userId);
    if (!cached || cached.expires <= Date.now()) return [];
    return cached.value.filter((track) => !excluded.has(track.sourceId));
  }

  recommendation(id: string) {
    const track = this.playable.get(id);
    return track ? { ...track } : undefined;
  }

  async autoplayCandidates(options: {
    userIds: string[];
    nowPlaying?: { title: string; artist: string; sourceId?: string };
    recent?: { title: string; artist: string }[];
    exclude?: Iterable<string | undefined>;
    skipped?: SkipPenalties;
  }) {
    const excluded = new Set(
      [...(options.exclude ?? [])].filter((id): id is string => Boolean(id)),
    );
    const listeners = options.userIds.filter((userId) =>
      this.huddleMixOptedIn(userId),
    );
    const [contributions, similar, related] = await Promise.all([
      this.huddleContributions(listeners),
      options.nowPlaying
        ? this.similarTracks(
            options.nowPlaying.title,
            options.nowPlaying.artist,
          )
        : Promise.resolve([] as TasteContribution[]),
      options.nowPlaying?.sourceId &&
      isYoutubeVideoId(options.nowPlaying.sourceId)
        ? this.tracks
            .upNextTracks(options.nowPlaying.sourceId)
            .catch(() => [] as TrackMetadata[])
        : Promise.resolve([] as TrackMetadata[]),
    ]);
    const relatedNudge: TasteContribution[] = related
      .slice(0, 8)
      .map((track, index) => ({
        userId: "related",
        weight: 0.9 / (index + 1),
        source: "related",
        title: track.title,
        artist: track.artist,
        ...(track.album ? { album: track.album } : {}),
        sourceId: track.sourceId,
        sourceInput: track.sourceInput,
        canonicalUrl: track.canonicalUrl,
        ...(track.artwork ? { artwork: track.artwork } : {}),
        ...(track.duration ? { duration: track.duration } : {}),
      }));
    const ranked = applySkipPenalties(
      mergeTaste([...contributions, ...similar, ...relatedNudge]),
      options.skipped,
    ).filter(
      (track) =>
        !options.nowPlaying ||
        trackKey(track.title, track.artist) !==
          trackKey(options.nowPlaying.title, options.nowPlaying.artist),
    );
    if (options.nowPlaying) {
      const playingArtist = normalizeToken(
        firstArtist(options.nowPlaying.artist),
      );
      for (const track of ranked)
        if (normalizeToken(firstArtist(track.artist)) === playingArtist)
          track.score *= 1.4;
      ranked.sort((a, b) => b.score - a.score);
    }
    const recentKeys = new Set(
      (options.recent ?? []).map((track) =>
        trackKey(track.title, track.artist),
      ),
    );
    return this.resolvePlayable(
      ranked.filter(
        (track) => !recentKeys.has(trackKey(track.title, track.artist)),
      ),
      excluded,
      mixCandidateLimit,
    );
  }

  private async huddleContributions(userIds: string[]) {
    const groups = await Promise.all(
      userIds.map((userId) => this.userTaste(userId)),
    );
    return groups.flat();
  }

  private userTaste(userId: string) {
    return this.cached(
      this.taste,
      userId,
      tasteTtlMs,
      async () => {
        const settings = this.store.getUserScrobbling(userId);
        const added = this.store.recentTracks(userId, 25).map((track) => ({
          userId,
          weight: 2,
          source: "huddlefm",
          title: track.title,
          artist: track.artist,
          ...(track.album ? { album: track.album } : {}),
          sourceId: track.sourceId,
          sourceInput: track.sourceInput,
          canonicalUrl: track.canonicalUrl,
          ...(track.artwork ? { artwork: track.artwork } : {}),
          ...(track.duration ? { duration: track.duration } : {}),
        }));
        const [lastFm, listenBrainz] = await Promise.all([
          this.lastFmTaste(userId, settings.lastFmUsername).catch((error) => {
            log.warn(
              { event: "lastfm_taste_failed", userId, err: error },
              "Last.fm taste lookup failed",
            );
            return [] as TasteContribution[];
          }),
          this.listenBrainzTaste(
            userId,
            settings.listenBrainzUsername,
            settings.listenBrainzToken,
          ).catch((error) => {
            log.warn(
              { event: "listenbrainz_taste_failed", userId, err: error },
              "ListenBrainz taste lookup failed",
            );
            return [] as TasteContribution[];
          }),
        ]);
        return [...added, ...lastFm, ...listenBrainz];
      },
      [],
    );
  }

  private async buildUserRecommendations(userId: string) {
    const recent = this.store.recentTracks(userId, 25);
    const recentKeys = new Set(
      recent.map((track) => trackKey(track.title, track.artist)),
    );
    const taste = await this.userTaste(userId);
    const seeds = recent
      .filter((track) => isYoutubeVideoId(track.sourceId))
      .slice(0, 2);
    const [similar, upNext] = await Promise.all([
      Promise.all(
        recent
          .slice(0, 2)
          .map((track) =>
            this.similarTracks(track.title, track.artist).catch(() => []),
          ),
      ),
      Promise.all(
        seeds.map((track) =>
          this.tracks.upNextTracks(track.sourceId).catch(() => []),
        ),
      ),
    ]);
    const fromUpNext: TasteContribution[] = upNext.flat().map((track) => ({
      userId,
      weight: 2.2,
      source: "related",
      title: track.title,
      artist: track.artist,
      ...(track.album ? { album: track.album } : {}),
      sourceId: track.sourceId,
      sourceInput: track.sourceInput,
      canonicalUrl: track.canonicalUrl,
      ...(track.artwork ? { artwork: track.artwork } : {}),
      ...(track.duration ? { duration: track.duration } : {}),
    }));
    const ranked = mergeTaste([
      ...taste.filter(
        (track) => !recentKeys.has(trackKey(track.title, track.artist)),
      ),
      ...similar.flat(),
      ...fromUpNext,
    ]).filter((track) => !recentKeys.has(trackKey(track.title, track.artist)));
    const resolved = await this.resolvePlayable(
      ranked,
      new Set(recent.map((track) => track.sourceId)),
      userRecLimit,
    );
    const recs = resolved.map((candidate) => {
      const id = `rec_${crypto.randomUUID()}`;
      this.playable.set(id, candidate.metadata);
      return {
        ...candidate.metadata,
        id,
        sources: rankedSources(ranked, candidate.metadata),
      };
    });
    log.info(
      { event: "user_recommendations_ready", userId, count: recs.length },
      "User recommendations ready",
    );
    return recs;
  }

  private async resolvePlayable(
    ranked: ScoredTrack[],
    excluded: Set<string>,
    limit: number,
  ) {
    const seen = new Set(excluded);
    const seenKeys = new Set<string>();
    const results: AutoplayCandidate[] = [];
    await mapPool(ranked.slice(0, 24), searchConcurrency, async (track) => {
      if (results.length >= limit) return;
      const key = trackKey(track.title, track.artist);
      if (seenKeys.has(key)) return;
      if (track.sourceId && seen.has(track.sourceId)) return;
      let metadata: TrackMetadata | undefined;
      if (
        track.sourceId &&
        track.sourceInput &&
        track.canonicalUrl &&
        isYoutubeVideoId(track.sourceId)
      ) {
        metadata = {
          sourceInput: track.sourceInput,
          canonicalUrl: track.canonicalUrl,
          sourceId: track.sourceId,
          title: track.title,
          artist: track.artist,
          ...(track.album ? { album: track.album } : {}),
          ...(track.duration ? { duration: track.duration } : {}),
          ...(track.artwork ? { artwork: track.artwork } : {}),
        };
      } else {
        try {
          metadata = await this.tracks.searchSong(track.title, track.artist);
        } catch {
          return;
        }
      }
      if (!metadata || seen.has(metadata.sourceId) || results.length >= limit)
        return;
      seen.add(metadata.sourceId);
      seenKeys.add(key);
      seenKeys.add(trackKey(metadata.title, metadata.artist));
      results.push({
        sourceId: metadata.sourceId,
        score: track.score,
        seedCount: Math.max(1, track.userIds.length),
        metadata,
      });
    });
    return results.sort(
      (a, b) => b.seedCount - a.seedCount || b.score - a.score,
    );
  }

  private async lastFmTaste(userId: string, username?: string) {
    if (!this.config.lastFmApiKey || !username) return [];
    const [top, recent] = await Promise.all([
      this.lastFm("user.getTopTracks", {
        user: username,
        period: "3month",
        limit: "30",
      }),
      this.lastFm("user.getRecentTracks", { user: username, limit: "30" }),
    ]);
    const topTracks = asArray(
      (top.toptracks as { track?: unknown })?.track,
    ).flatMap((row) => {
      const track = lastFmTrack(row);
      if (!track) return [];
      const playcount = Number((row as { playcount?: unknown }).playcount ?? 0);
      return [
        {
          userId,
          source: "lastfm",
          weight: 1.5 + Math.log10(Math.max(1, playcount) + 1),
          ...track,
        },
      ];
    });
    const recentTracks = asArray(
      (recent.recenttracks as { track?: unknown })?.track,
    ).flatMap((row) => {
      const track = lastFmTrack(row);
      return track ? [{ userId, source: "lastfm", weight: 1, ...track }] : [];
    });
    return [...topTracks, ...recentTracks];
  }

  private async similarTracks(title: string, artist: string) {
    if (!this.config.lastFmApiKey || !title.trim() || !artist.trim()) return [];
    const result = await this.lastFm("track.getSimilar", {
      track: title,
      artist: firstArtist(artist),
      limit: "20",
    }).catch(() => undefined);
    if (!result) return [];
    return asArray(
      (result.similartracks as { track?: unknown })?.track,
    ).flatMap((row, index) => {
      const track = lastFmTrack(row);
      if (!track) return [];
      return [
        {
          userId: "similar",
          source: "similar",
          weight: 2.5 / (index + 1),
          ...track,
        },
      ];
    });
  }

  private async listenBrainzTaste(
    userId: string,
    username?: string,
    token?: string,
  ) {
    if (!username) return [];
    const headers = token ? { authorization: `Token ${token}` } : undefined;
    const [listens, stats, recommendations] = await Promise.all([
      this.json(
        `${listenBrainzEndpoint}/user/${encodeURIComponent(username)}/listens?count=50`,
        headers,
      ).catch(() => undefined),
      this.json(
        `${listenBrainzEndpoint}/stats/user/${encodeURIComponent(username)}/recordings?range=quarter`,
        headers,
      ).catch(() => undefined),
      this.json(
        `${listenBrainzEndpoint}/cf/recommendation/user/${encodeURIComponent(username)}/recording?count=25`,
        headers,
      ).catch(() => undefined),
    ]);
    const recent = asArray(
      (listens?.payload as { listens?: unknown })?.listens,
    ).flatMap((row) => {
      const track = listenBrainzTrack(
        (row as { track_metadata?: unknown }).track_metadata,
      );
      return track
        ? [{ userId, source: "listenbrainz", weight: 1, ...track }]
        : [];
    });
    const top = asArray(
      (stats?.payload as { recordings?: unknown })?.recordings,
    ).flatMap((row) => {
      const track = listenBrainzTrack(row);
      if (!track) return [];
      const count = Number(
        (row as { listen_count?: unknown }).listen_count ?? 0,
      );
      return [
        {
          userId,
          source: "listenbrainz",
          weight: 1.5 + Math.log10(Math.max(1, count) + 1),
          ...track,
        },
      ];
    });
    const mbids = asArray(
      (recommendations?.payload as { mbids?: unknown })?.mbids,
    )
      .map((row) =>
        String((row as { recording_mbid?: unknown }).recording_mbid ?? ""),
      )
      .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
      .slice(0, 25);
    const cf = mbids.length
      ? await this.listenBrainzRecordings(userId, mbids, headers)
      : [];
    return [...recent, ...top, ...cf];
  }

  private async listenBrainzRecordings(
    userId: string,
    mbids: string[],
    headers?: Record<string, string>,
  ) {
    const result = await this.json(
      `${listenBrainzEndpoint}/metadata/recording/?recording_mbids=${mbids.map(encodeURIComponent).join(",")}`,
      headers,
    ).catch(() => undefined);
    if (!result || typeof result !== "object") return [];
    return Object.values(result as Record<string, unknown>).flatMap(
      (row, index) => {
        const track = listenBrainzMetadata(row);
        return track
          ? [
              {
                userId,
                source: "listenbrainz",
                weight: 2.5 / (index + 1),
                ...track,
              },
            ]
          : [];
      },
    );
  }

  private async lastFm(method: string, params: Record<string, string>) {
    const url = new URL(lastFmEndpoint);
    url.searchParams.set("method", method);
    url.searchParams.set("api_key", this.config.lastFmApiKey!);
    url.searchParams.set("format", "json");
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    const result = await this.json(url.href);
    if (!result || result.error)
      throw new Error(String(result?.message ?? "Last.fm request failed"));
    return result;
  }

  private async json(url: string, headers?: Record<string, string>) {
    const response = await this.request(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.status === 204) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  private cached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
    fallback: T,
  ) {
    const current = cache.get(key);
    if (current?.inflight) return current.inflight;
    if (current && current.expires > Date.now())
      return Promise.resolve(current.value);
    const inflight = load()
      .then((value) => {
        cache.set(key, { value, expires: Date.now() + ttlMs });
        return value;
      })
      .catch((error) => {
        cache.delete(key);
        log.warn(
          { event: "recommendation_cache_failed", key, err: error },
          "Recommendation cache load failed",
        );
        return fallback;
      });
    cache.set(key, {
      value: current?.value ?? fallback,
      expires: 0,
      inflight,
    });
    return inflight;
  }
}

function rankedSources(ranked: ScoredTrack[], metadata: TrackMetadata) {
  const key = trackKey(metadata.title, metadata.artist);
  return (
    ranked.find(
      (track) =>
        trackKey(track.title, track.artist) === key ||
        track.sourceId === metadata.sourceId,
    )?.sources ?? ["huddlefm"]
  );
}

function asArray(value: unknown) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function lastFmArtist(value: unknown) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const row = value as { name?: unknown; "#text"?: unknown };
    return String(row.name ?? row["#text"] ?? "");
  }
  return "";
}

function lastFmTrack(value: unknown): TasteTrack | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as {
    name?: unknown;
    artist?: unknown;
    album?: unknown;
  };
  const title = String(row.name ?? "").trim();
  const artist = lastFmArtist(row.artist).trim();
  if (!title || !artist) return;
  const album = lastFmArtist(row.album).trim();
  return { title, artist, ...(album ? { album } : {}) };
}

function listenBrainzTrack(value: unknown): TasteTrack | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as {
    track_name?: unknown;
    recording_name?: unknown;
    artist_name?: unknown;
    release_name?: unknown;
  };
  const title = String(row.track_name ?? row.recording_name ?? "").trim();
  const artist = String(row.artist_name ?? "").trim();
  if (!title || !artist) return;
  const album = String(row.release_name ?? "").trim();
  return { title, artist, ...(album ? { album } : {}) };
}

function listenBrainzMetadata(value: unknown): TasteTrack | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as {
    recording?: { name?: unknown };
    artist?: { name?: unknown }[] | { name?: unknown };
    release?: { name?: unknown };
  };
  const title = String(row.recording?.name ?? "").trim();
  const artistValue = Array.isArray(row.artist) ? row.artist[0] : row.artist;
  const artist = String(artistValue?.name ?? "").trim();
  if (!title || !artist) return;
  const album = String(row.release?.name ?? "").trim();
  return { title, artist, ...(album ? { album } : {}) };
}

async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
) {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = items[index++]!;
      await fn(current);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) || 0 }, worker),
  );
}
