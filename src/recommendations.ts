import { firstArtist } from "./artist.ts";
import { logger } from "./logger.ts";
import type { Store } from "./store.ts";
import {
  isYoutubeVideoId,
  normalizeToken,
  type TrackCatalog,
  type TrackMetadata,
} from "./tracks.ts";

const log = logger.child({ component: "recommendations" });
const lastFmEndpoint = "https://ws.audioscrobbler.com/2.0/";
const listenBrainzEndpoint = "https://api.listenbrainz.org/1";
const tasteTtlMs = 15 * 60_000;
const poolTtlMs = 5 * 60_000;
const lookupTtlMs = 24 * 60 * 60_000;
const lookupFailureTtlMs = 5 * 60_000;
const lookupCap = 5_000;
const evictedGraceMs = 30 * 60_000;
const requestTimeoutMs = 8_000;
const searchConcurrency = 3;

// Personal recommendations: each lane keeps a rolling pool that decays between
// builds, and a sample is drawn once per build so the modal is stable until the
// pool actually changes.
const discoverPoolSize = 30;
const favouritesPoolSize = 15;
const discoverSampleSize = 20;
const favouritesSampleSize = 10;
const depletionThreshold = 10;
const discoverResolveAttempts = 20;
const favouritesResolveAttempts = 10;
const poolDecay = 0.7;
const newcomerShare = 1 / 3;
const trackSeedCount = 5;
const trackSeedWindow = 30;
const artistSeedCount = 3;
const artistSeedWindow = 15;
const similarArtistsPerSeed = 4;
const tracksPerSimilarArtist = 3;
const listenBrainzFetchCount = 100;
const listenBrainzSampleCount = 25;
const recentAddLimit = 25;
const knownHistoryLimit = 1000;

// Huddle mix autoplay.
const mixCandidateLimit = 12;
const mixResolveAttempts = 24;
const mixDiscoveryLimit = 6;
const mixPoolDiscoveryWeight = 3;
const mixSameArtistBoost = 1.4;
const mixArtistRunLimit = 2;
const mixArtistRunDamping = 0.5;
const mixFairnessWeight = 1;
const skipTrackPenalty = 0.2;
const skipArtistPenalty = 0.6;
// Contributions from similarity lookups carry these ids instead of a real
// listener, so they must not count as a seed.
const syntheticUsers = new Set(["similar", "related"]);

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

export type UserRecommendations = {
  discover: PlayableRecommendation[];
  favourites: PlayableRecommendation[];
};

export type AutoplayCandidate = {
  sourceId: string;
  score: number;
  seedCount: number;
  discovery: boolean;
  // Listeners whose taste put this track forward.
  listenerIds: string[];
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

export type RecommendationStore = Pick<
  Store,
  "getUserScrobbling" | "recentTracks" | "findPlayedTrack"
>;

type TasteArtist = { name: string; score: number };

type TasteProfile = {
  contributions: TasteContribution[];
  known: Set<string>;
  artists: TasteArtist[];
  listenBrainz: ListenBrainzRecommendation[];
};

// ListenBrainz says whether the listener has already heard a recommended
// recording, which is a stronger "known" signal than our own history.
type ListenBrainzRecommendation = {
  mbid: string;
  score: number;
  listened: boolean;
};

type PoolTrack = {
  id: string;
  key: string;
  score: number;
  sources: string[];
  metadata: TrackMetadata;
};

type UserPool = {
  discover: PoolTrack[];
  favourites: PoolTrack[];
  sample: UserRecommendations;
};

type CacheEntry<T> = {
  value: T;
  expires: number;
  inflight?: Promise<T>;
  // Invalidated while a load was in flight: that load's result is already
  // out of date, so store it expired.
  dirty?: boolean;
};

// Keys match "the same song" across services, so featured-artist credits
// are dropped from both halves: Last.fm's "STAY (with Justin Bieber)" by
// The Kid LAROI is ListenBrainz's "STAY" by The Kid LAROI & Justin Bieber.
export function trackKey(title: string, artist: string) {
  return `${normalizeToken(primaryArtist(artist))}\0${normalizeToken(stripCredits(title))}`;
}

const creditPattern =
  /\s*[([]\s*(?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]|\s+(?:feat|ft|featuring)\.?\s.*$/i;

export function stripCredits(title: string) {
  return title.replace(creditPattern, "").trim() || title;
}

export function primaryArtist(artist: string) {
  return (
    artist
      .split(
        /\s*(?:,|&|\+|\bx\b|\band\b|\bwith\b|\bvs\.?\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i,
      )[0]
      ?.trim() || artist
  );
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
      existing.sourceInput ??= track.sourceInput;
      existing.canonicalUrl ??= track.canonicalUrl;
      existing.artwork ??= track.artwork;
      existing.duration ??= track.duration;
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

// Draws `count` items without replacement, each pick weighted by `weight`.
// Items with no usable weight are treated as barely eligible rather than
// dropped, so a pool of tied zeros still yields a sample.
export function weightedSample<T>(
  items: readonly T[],
  count: number,
  weight: (item: T) => number,
  random: () => number = Math.random,
) {
  const remaining = items.map((item) => ({
    item,
    weight: Math.max(weight(item), 1e-6),
  }));
  const picked: T[] = [];
  while (picked.length < count && remaining.length) {
    const total = remaining.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = random() * total;
    let index = remaining.findIndex((entry) => (roll -= entry.weight) < 0);
    if (index < 0) index = remaining.length - 1;
    picked.push(remaining[index]!.item);
    remaining.splice(index, 1);
  }
  return picked;
}

// A bounded, expiring memo for lookups whose answers barely change: search
// results, similar tracks and artists. Misses are remembered too so an
// unresolvable track does not cost a search on every build, but a failed
// lookup is only remembered briefly so an outage does not blank a seed for
// a day.
class Memo<T> {
  private entries = new Map<string, { value: T; expires: number }>();

  constructor(
    private ttlMs: number,
    private cap: number,
    private failureTtlMs = ttlMs,
  ) {}

  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= Date.now()) {
      this.entries.delete(key);
      return;
    }
    return entry;
  }

  set(key: string, value: T, ttlMs = this.ttlMs) {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async load(key: string, load: () => Promise<T>, fallback: T) {
    const entry = this.get(key);
    if (entry) return entry.value;
    try {
      const value = await load();
      this.set(key, value);
      return value;
    } catch (error) {
      log.warn({ event: "lookup_failed", key, err: error }, "Lookup failed");
      this.set(key, fallback, this.failureTtlMs);
      return fallback;
    }
  }
}

export class RecommendationCatalog {
  private taste = new Map<string, CacheEntry<TasteProfile>>();
  private pools = new Map<string, CacheEntry<UserPool>>();
  private playable = new Map<string, TrackMetadata>();
  // Ids dropped from a pool stay resolvable for a while, since a modal that
  // was open when the rebuild landed may still submit them.
  private evicted = new Map<string, number>();
  private consumed = new Map<string, Set<string>>();
  private searches = new Memo<TrackMetadata | undefined>(
    lookupTtlMs,
    lookupCap,
  );
  private lookups = new Memo<(TasteTrack & { match?: number })[]>(
    lookupTtlMs,
    lookupCap,
    lookupFailureTtlMs,
  );
  private artistLookups = new Memo<{ name: string; match: number }[]>(
    lookupTtlMs,
    lookupCap,
    lookupFailureTtlMs,
  );
  private recordings = new Memo<TasteTrack | undefined>(lookupTtlMs, lookupCap);
  private random: () => number;

  constructor(
    private store: RecommendationStore,
    private tracks: RecommendationTracks,
    private config: { lastFmApiKey?: string; random?: () => number } = {},
    private request = fetch,
  ) {
    this.random = config.random ?? Math.random;
  }

  huddleMixOptedIn(userId: string) {
    return this.store.getUserScrobbling(userId).huddleMixOptIn !== false;
  }

  prefetchUsers(userIds: Iterable<string>) {
    for (const userId of userIds) void this.prefetchUser(userId);
  }

  prefetchUser(userId: string) {
    return this.cached(
      this.pools,
      userId,
      poolTtlMs,
      () => this.buildUserPool(userId),
      emptyPool(),
    );
  }

  // The user's taste just changed (they added a track), so both the profile
  // and the pool are stale; rebuild in the background while the previous
  // version keeps serving.
  refreshUser(userId: string) {
    const taste = this.taste.get(userId);
    if (taste) Object.assign(taste, { expires: 0, dirty: true });
    const pool = this.pools.get(userId);
    if (pool) Object.assign(pool, { expires: 0, dirty: true });
    // A build already in flight started before this change; run another one
    // behind it.
    if (pool?.inflight)
      return pool.inflight.then(() => this.prefetchUser(userId));
    return this.prefetchUser(userId);
  }

  // Returns the current sample minus whatever the session already has. A
  // stale or rebuilding pool still serves its last version. When the session
  // has played through most of the sample, the pool is marked stale so the
  // caller's usual prefetch tops it up.
  userRecommendations(
    userId: string,
    exclude: Iterable<string | undefined> = [],
  ): UserRecommendations {
    const excluded = new Set(
      [...exclude].filter((id): id is string => Boolean(id)),
    );
    const entry = this.pools.get(userId);
    if (!entry) return { discover: [], favourites: [] };
    const keep = (track: PlayableRecommendation) =>
      !excluded.has(track.sourceId);
    const result = {
      discover: entry.value.sample.discover.filter(keep),
      favourites: entry.value.sample.favourites.filter(keep),
    };
    const total = result.discover.length + result.favourites.length;
    const sampled =
      entry.value.sample.discover.length + entry.value.sample.favourites.length;
    if (total < depletionThreshold && sampled > total) {
      this.consumed.set(userId, excluded);
      entry.expires = 0;
    }
    return result;
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
    discover?: boolean;
    // How many recent autoplay picks each listener's taste contributed to,
    // so the mix can favour whoever has been underserved.
    credited?: Record<string, number>;
    // How many tracks in a row the now-playing artist has had, including
    // the current one.
    artistRun?: number;
  }) {
    const excluded = new Set(
      [...(options.exclude ?? [])].filter((id): id is string => Boolean(id)),
    );
    const listeners = options.userIds.filter((userId) =>
      this.huddleMixOptedIn(userId),
    );
    const { nowPlaying } = options;
    const [profiles, similar, similarArtists, related] = await Promise.all([
      Promise.all(listeners.map((userId) => this.userTaste(userId))),
      nowPlaying
        ? this.similarTracks(nowPlaying.title, nowPlaying.artist)
        : Promise.resolve([] as TasteContribution[]),
      nowPlaying
        ? this.similarArtistTracks(nowPlaying.artist, 1)
        : Promise.resolve([] as TasteContribution[]),
      nowPlaying?.sourceId && isYoutubeVideoId(nowPlaying.sourceId)
        ? this.tracks
            .upNextTracks(nowPlaying.sourceId)
            .catch(() => [] as TrackMetadata[])
        : Promise.resolve([] as TrackMetadata[]),
    ]);
    const knownBy = new Map<string, TasteProfile>();
    listeners.forEach((userId, index) => knownBy.set(userId, profiles[index]!));
    const known = new Set<string>();
    for (const profile of profiles)
      for (const key of profile.known) known.add(key);
    const contributions = profiles.flatMap((profile) => profile.contributions);
    const relatedNudge = related
      .slice(0, 8)
      .map((track, index) =>
        contributionFromMetadata(
          track,
          "related",
          "related",
          0.9 / (index + 1),
        ),
      );
    // On a discovery turn, each listener's already-resolved Discover pool is
    // the most personal source there is, and costs nothing to use.
    const poolDiscoveries = options.discover
      ? listeners.flatMap((userId) => {
          const pool = this.pools.get(userId)?.value.discover ?? [];
          const best = pool[0]?.score || 1;
          return pool.map((track) => ({
            ...contributionFromMetadata(
              track.metadata,
              userId,
              "discover",
              (mixPoolDiscoveryWeight * track.score) / best,
            ),
            listened: false,
          }));
        })
      : [];
    const ranked = applySkipPenalties(
      mergeTaste([
        ...contributions,
        ...poolDiscoveries,
        ...similar,
        ...similarArtists,
        ...relatedNudge,
      ]),
      options.skipped,
    ).filter(
      (track) =>
        !nowPlaying ||
        trackKey(track.title, track.artist) !==
          trackKey(nowPlaying.title, nowPlaying.artist),
    );
    if (nowPlaying) {
      // Following the same artist makes a nice segue once; after a run it
      // gets samey.
      const playingArtist = normalizeToken(primaryArtist(nowPlaying.artist));
      const sameArtist =
        (options.artistRun ?? 1) < mixArtistRunLimit
          ? mixSameArtistBoost
          : mixArtistRunDamping;
      for (const track of ranked)
        if (normalizeToken(primaryArtist(track.artist)) === playingArtist)
          track.score *= sameArtist;
    }
    // Lift tracks from listeners whose taste has had fewer recent picks
    // than the room average. Nobody is penalised for being well served.
    const credited = options.credited ?? {};
    const credits = listeners.map((userId) => credited[userId] ?? 0);
    const averageCredit = credits.length
      ? credits.reduce((sum, value) => sum + value, 0) / credits.length
      : 0;
    for (const track of ranked) {
      const underserved = Math.max(
        0,
        ...track.userIds
          .filter((userId) => knownBy.has(userId))
          .map(
            (userId) =>
              (averageCredit - (credited[userId] ?? 0)) / (averageCredit + 1),
          ),
      );
      if (underserved > 0) track.score *= 1 + mixFairnessWeight * underserved;
    }
    ranked.sort((a, b) => b.score - a.score);
    const recentKeys = new Set(
      (options.recent ?? []).map((track) =>
        trackKey(track.title, track.artist),
      ),
    );
    const eligible = ranked.filter(
      (track) => !recentKeys.has(trackKey(track.title, track.artist)),
    );
    const isDiscovery = (track: ScoredTrack) =>
      !known.has(trackKey(track.title, track.artist));
    // A track counts as a seed for each listener who has actually played it,
    // which is a stronger signal than merely turning up in their similar
    // tracks or Discover pool.
    const playedBy = (track: ScoredTrack) => {
      const key = trackKey(track.title, track.artist);
      return listeners.filter((userId) => knownBy.get(userId)!.known.has(key));
    };
    const finish = (
      candidate: AutoplayCandidate & { track: ScoredTrack },
      discovery: boolean,
    ): AutoplayCandidate => {
      const { track, ...rest } = candidate;
      const played = playedBy(track);
      return {
        ...rest,
        discovery,
        seedCount: Math.max(1, played.length),
        listenerIds: track.userIds.filter((userId) => knownBy.has(userId)),
      };
    };
    const bySeeds = (a: AutoplayCandidate, b: AutoplayCandidate) =>
      b.seedCount - a.seedCount || b.score - a.score;
    if (!options.discover) {
      const resolved = await this.resolvePlayable(
        eligible,
        excluded,
        mixCandidateLimit,
        mixResolveAttempts,
      );
      return resolved
        .map((candidate) => finish(candidate, isDiscovery(candidate.track)))
        .sort(bySeeds);
    }
    // A discovery turn: lead with tracks nobody in the huddle has listened
    // to, then fall back to the usual ranking.
    const discoveries = await this.resolvePlayable(
      eligible.filter(isDiscovery),
      excluded,
      mixDiscoveryLimit,
      mixResolveAttempts,
    );
    const seen = new Set([
      ...excluded,
      ...discoveries.map((candidate) => candidate.sourceId),
    ]);
    const rest = await this.resolvePlayable(
      eligible.filter((track) => !isDiscovery(track)),
      seen,
      mixCandidateLimit - discoveries.length,
      mixResolveAttempts,
    );
    return [
      ...discoveries
        .map((candidate) => finish(candidate, true))
        .sort((a, b) => b.score - a.score),
      ...rest.map((candidate) => finish(candidate, false)).sort(bySeeds),
    ];
  }

  // A listener skipped a track: push it and, more gently, its artist down
  // in their own pools so it does not come straight back in the modal.
  penalize(userId: string, track: { title: string; artist: string }) {
    const pool = this.pools.get(userId)?.value;
    if (!pool) return;
    const key = trackKey(track.title, track.artist);
    const artist = normalizeToken(primaryArtist(track.artist));
    const punish = (entry: PoolTrack) => {
      if (entry.key === key) entry.score *= skipTrackPenalty;
      else if (normalizeToken(primaryArtist(entry.metadata.artist)) === artist)
        entry.score *= skipArtistPenalty;
    };
    pool.discover.forEach(punish);
    pool.favourites.forEach(punish);
    const keep = (entry: PlayableRecommendation) =>
      trackKey(entry.title, entry.artist) !== key;
    pool.sample.discover = pool.sample.discover.filter(keep);
    pool.sample.favourites = pool.sample.favourites.filter(keep);
  }

  private userTaste(userId: string) {
    return this.cached(
      this.taste,
      userId,
      tasteTtlMs,
      () => this.buildTaste(userId),
      emptyProfile(),
    );
  }

  private async buildTaste(userId: string): Promise<TasteProfile> {
    const settings = this.store.getUserScrobbling(userId);
    const added = this.store
      .recentTracks(userId, recentAddLimit)
      .map((track) => contributionFromMetadata(track, userId, "huddlefm", 2));
    const warn = (event: string, text: string) => (error: unknown) => {
      log.warn({ event, userId, err: error }, text);
      return emptyProfile();
    };
    const [lastFm, listenBrainz] = await Promise.all([
      this.lastFmTaste(userId, settings.lastFmUsername).catch(
        warn("lastfm_taste_failed", "Last.fm taste lookup failed"),
      ),
      this.listenBrainzTaste(
        userId,
        settings.listenBrainzUsername,
        settings.listenBrainzToken,
      ).catch(
        warn("listenbrainz_taste_failed", "ListenBrainz taste lookup failed"),
      ),
    ]);
    const contributions = [
      ...added,
      ...lastFm.contributions,
      ...listenBrainz.contributions,
    ];
    const known = new Set([
      ...contributions.map((track) => trackKey(track.title, track.artist)),
      ...lastFm.known,
      ...listenBrainz.known,
    ]);
    const artists = new Map<string, TasteArtist>();
    for (const artist of [...lastFm.artists, ...listenBrainz.artists]) {
      const key = normalizeToken(artist.name);
      const existing = artists.get(key);
      if (existing) existing.score += artist.score;
      else artists.set(key, { ...artist });
    }
    // Without a scrobbler, the artists someone adds are the best signal.
    if (!artists.size)
      for (const track of added) {
        const name = firstArtist(track.artist);
        const key = normalizeToken(name);
        if (!key) continue;
        const existing = artists.get(key);
        if (existing) existing.score += 1;
        else artists.set(key, { name, score: 1 });
      }
    return {
      contributions,
      known,
      artists: [...artists.values()].sort((a, b) => b.score - a.score),
      listenBrainz: listenBrainz.listenBrainz,
    };
  }

  private async buildUserPool(userId: string): Promise<UserPool> {
    const previous = this.pools.get(userId)?.value ?? emptyPool();
    const consumed = this.consumed.get(userId) ?? new Set<string>();
    this.consumed.delete(userId);
    const recent = this.store.recentTracks(userId, recentAddLimit);
    const recentKeys = new Set(
      recent.map((track) => trackKey(track.title, track.artist)),
    );
    const profile = await this.userTaste(userId);
    const taste = mergeTaste(profile.contributions);
    const trackSeeds = weightedSample(
      taste.slice(0, trackSeedWindow),
      trackSeedCount,
      (track) => track.score,
      this.random,
    );
    const artistSeeds = weightedSample(
      profile.artists.slice(0, artistSeedWindow),
      artistSeedCount,
      (artist) => artist.score,
      this.random,
    );
    const topArtistScore = profile.artists[0]?.score || 1;
    const upNextSeeds = recent
      .filter((track) => isYoutubeVideoId(track.sourceId))
      .slice(0, 2);
    const [similar, similarArtists, listenBrainz, upNext] = await Promise.all([
      Promise.all(
        trackSeeds.map((track) =>
          this.similarTracks(track.title, track.artist).catch(() => []),
        ),
      ),
      Promise.all(
        artistSeeds.map((artist) =>
          this.similarArtistTracks(
            artist.name,
            artist.score / topArtistScore,
          ).catch(() => []),
        ),
      ),
      this.listenBrainzRecommendations(userId, profile.listenBrainz),
      Promise.all(
        upNextSeeds.map((track) =>
          this.tracks.upNextTracks(track.sourceId).catch(() => []),
        ),
      ),
    ]);
    const discovered = [
      ...similar.flat(),
      ...similarArtists.flat(),
      ...listenBrainz,
      ...upNext
        .flat()
        .map((track) =>
          contributionFromMetadata(track, userId, "related", 2.2),
        ),
    ];
    const isKnown = (track: TasteTrack & { listened?: boolean }) =>
      track.listened === true ||
      profile.known.has(trackKey(track.title, track.artist));
    const discoverRanked = mergeTaste(
      discovered.filter((track) => !isKnown(track)),
    );
    const favouritesRanked = mergeTaste([
      ...profile.contributions,
      ...discovered.filter(isKnown),
    ]).filter((track) => !recentKeys.has(trackKey(track.title, track.artist)));
    const excludedIds = new Set([
      ...consumed,
      ...recent.map((track) => track.sourceId),
    ]);
    // A track the user has since listened to no longer belongs in Discover,
    // and a favourite they just added moves to "Recent songs".
    const discover = await this.mergePool(
      previous.discover.filter((track) => !profile.known.has(track.key)),
      discoverRanked,
      discoverPoolSize,
      discoverResolveAttempts,
      excludedIds,
    );
    for (const track of discover) excludedIds.add(track.metadata.sourceId);
    const favourites = await this.mergePool(
      previous.favourites.filter((track) => !recentKeys.has(track.key)),
      favouritesRanked,
      favouritesPoolSize,
      favouritesResolveAttempts,
      excludedIds,
    );
    const now = Date.now();
    for (const [id, evictedAt] of this.evicted)
      if (now - evictedAt > evictedGraceMs) {
        this.evicted.delete(id);
        this.playable.delete(id);
      }
    const kept = new Set([...discover, ...favourites].map((track) => track.id));
    for (const track of [...previous.discover, ...previous.favourites])
      if (!kept.has(track.id)) this.evicted.set(track.id, now);
    for (const track of [...discover, ...favourites]) {
      this.evicted.delete(track.id);
      this.playable.set(track.id, track.metadata);
    }
    const sample = {
      discover: weightedSample(
        discover,
        discoverSampleSize,
        (track) => track.score,
        this.random,
      ).map(playableFromPool),
      favourites: weightedSample(
        favourites,
        favouritesSampleSize,
        (track) => track.score,
        this.random,
      ).map(playableFromPool),
    };
    log.info(
      {
        event: "user_recommendations_ready",
        userId,
        discover: discover.length,
        favourites: favourites.length,
      },
      "User recommendations ready",
    );
    return { discover, favourites, sample };
  }

  // Folds this build's ranking into the previous pool: old entries decay,
  // re-recommended ones are bumped, and a bounded number of newcomers are
  // resolved. The result is the top `size` by score, with a share reserved
  // for this build's newcomers so incumbents cannot lock the pool.
  private async mergePool(
    previous: PoolTrack[],
    ranked: ScoredTrack[],
    size: number,
    attempts: number,
    excluded: Set<string>,
  ) {
    const pool = new Map<string, PoolTrack>();
    for (const track of previous) {
      if (excluded.has(track.metadata.sourceId)) continue;
      pool.set(track.key, { ...track, score: track.score * poolDecay });
    }
    const newcomers: ScoredTrack[] = [];
    for (const track of ranked) {
      const key = trackKey(track.title, track.artist);
      const existing = pool.get(key);
      if (existing) {
        existing.score =
          Math.max(existing.score, track.score) + 0.25 * track.score;
        for (const source of track.sources)
          if (!existing.sources.includes(source)) existing.sources.push(source);
      } else newcomers.push(track);
    }
    const seen = new Set([
      ...excluded,
      ...[...pool.values()].map((track) => track.metadata.sourceId),
    ]);
    const resolved = await this.resolvePlayable(
      newcomers,
      seen,
      size,
      attempts,
    );
    const fresh: PoolTrack[] = [];
    for (const candidate of resolved) {
      const key = trackKey(candidate.track.title, candidate.track.artist);
      const track = {
        id: `rec_${crypto.randomUUID()}`,
        key,
        score: candidate.score,
        sources: candidate.track.sources,
        metadata: candidate.metadata,
      };
      pool.set(key, track);
      fresh.push(track);
    }
    const byScore = (a: PoolTrack, b: PoolTrack) => b.score - a.score;
    const reserved = fresh
      .sort(byScore)
      .slice(0, Math.ceil(size * newcomerShare));
    const keptIds = new Set(reserved.map((track) => track.id));
    const rest = [...pool.values()]
      .filter((track) => !keptIds.has(track.id))
      .sort(byScore)
      .slice(0, Math.max(0, size - reserved.length));
    return [...reserved, ...rest].sort(byScore);
  }

  private async resolvePlayable(
    ranked: ScoredTrack[],
    excluded: Set<string>,
    limit: number,
    attempts: number,
  ) {
    const seen = new Set(excluded);
    const seenKeys = new Set<string>();
    const results: (AutoplayCandidate & { track: ScoredTrack })[] = [];
    await mapPool(
      ranked.slice(0, attempts),
      searchConcurrency,
      async (track) => {
        if (results.length >= limit) return;
        const key = trackKey(track.title, track.artist);
        if (seenKeys.has(key)) return;
        if (track.sourceId && seen.has(track.sourceId)) return;
        const metadata = await this.resolveTrack(track);
        if (!metadata || seen.has(metadata.sourceId) || results.length >= limit)
          return;
        seen.add(metadata.sourceId);
        seenKeys.add(key);
        seenKeys.add(trackKey(metadata.title, metadata.artist));
        results.push({
          sourceId: metadata.sourceId,
          score: track.score,
          seedCount: Math.max(
            1,
            track.userIds.filter((id) => !syntheticUsers.has(id)).length,
          ),
          discovery: false,
          listenerIds: track.userIds.filter((id) => !syntheticUsers.has(id)),
          metadata,
          track,
        });
      },
    );
    return results;
  }

  // Turns a title/artist pair into playable metadata: a track that already
  // carries a YouTube id is used as-is, then the memo, then anything this
  // workspace has played before, and only then a YouTube Music search.
  private async resolveTrack(track: TasteTrack) {
    if (
      track.sourceId &&
      track.sourceInput &&
      track.canonicalUrl &&
      isYoutubeVideoId(track.sourceId)
    )
      return {
        sourceInput: track.sourceInput,
        canonicalUrl: track.canonicalUrl,
        sourceId: track.sourceId,
        title: track.title,
        artist: track.artist,
        ...(track.album ? { album: track.album } : {}),
        ...(track.duration ? { duration: track.duration } : {}),
        ...(track.artwork ? { artwork: track.artwork } : {}),
      } satisfies TrackMetadata;
    const key = trackKey(track.title, track.artist);
    const memo = this.searches.get(key);
    if (memo) return memo.value;
    const played = this.store.findPlayedTrack(track.title, track.artist);
    if (played && isYoutubeVideoId(played.sourceId)) {
      const metadata: TrackMetadata = {
        sourceInput: played.sourceInput,
        canonicalUrl: played.canonicalUrl,
        sourceId: played.sourceId,
        title: played.title,
        artist: played.artist,
        ...(played.album ? { album: played.album } : {}),
        ...(played.duration ? { duration: played.duration } : {}),
        ...(played.artwork ? { artwork: played.artwork } : {}),
      };
      this.searches.set(key, metadata);
      return metadata;
    }
    try {
      const metadata = await this.tracks.searchSong(track.title, track.artist);
      this.searches.set(key, metadata);
      return metadata;
    } catch {
      return;
    }
  }

  private async lastFmTaste(userId: string, username?: string) {
    if (!this.config.lastFmApiKey || !username) return emptyProfile();
    const [top, recent, artists, allTime] = await Promise.all([
      this.lastFm("user.getTopTracks", {
        user: username,
        period: "3month",
        limit: "30",
      }),
      this.lastFm("user.getRecentTracks", { user: username, limit: "30" }),
      this.lastFm("user.getTopArtists", {
        user: username,
        period: "3month",
        limit: String(artistSeedWindow),
      }).catch(() => undefined),
      // Everything the listener has ever played much, so Discover does not
      // suggest it; this only feeds the known set, never the scoring.
      this.lastFm("user.getTopTracks", {
        user: username,
        period: "overall",
        limit: String(knownHistoryLimit),
      }).catch(() => undefined),
    ]);
    const known = asArray(
      (allTime?.toptracks as { track?: unknown })?.track,
    ).flatMap((row) => {
      const track = lastFmTrack(row);
      return track ? [trackKey(track.title, track.artist)] : [];
    });
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
    const topArtists = asArray(
      (artists?.topartists as { artist?: unknown })?.artist,
    ).flatMap((row) => {
      const name = lastFmArtist(row).trim();
      if (!name) return [];
      const playcount = Number((row as { playcount?: unknown }).playcount ?? 0);
      return [{ name, score: 1 + Math.log10(Math.max(1, playcount) + 1) }];
    });
    return {
      ...emptyProfile(),
      contributions: [...topTracks, ...recentTracks],
      known: new Set(known),
      artists: topArtists,
    };
  }

  private similarTracks(title: string, artist: string) {
    if (!this.config.lastFmApiKey || !title.trim() || !artist.trim())
      return Promise.resolve([] as TasteContribution[]);
    const seed = firstArtist(artist);
    return this.lookups
      .load(
        `similar\0${trackKey(title, seed)}`,
        async () => {
          const result = await this.lastFm("track.getSimilar", {
            track: title,
            artist: seed,
            limit: "20",
          }).catch(lastFmNotFound);
          if (!result) return [];
          return asArray(
            (result.similartracks as { track?: unknown })?.track,
          ).flatMap((row) => {
            const track = lastFmTrack(row);
            if (!track) return [];
            const match = Number((row as { match?: unknown }).match ?? 0);
            return [{ ...track, ...(match > 0 ? { match } : {}) }];
          });
        },
        [],
      )
      .then((tracks) =>
        tracks.map(({ match, ...track }, index) => ({
          userId: "similar",
          source: "similar",
          weight: match ? 2.5 * match : 2.5 / (index + 1),
          ...track,
        })),
      );
  }

  // One hop out from an artist: their closest neighbours on Last.fm, and a
  // few of each neighbour's best-known tracks, weighted by how close the
  // neighbour is and how much the seed artist matters to the listener
  // (`seedWeight` is 0..1).
  private async similarArtistTracks(artist: string, seedWeight: number) {
    if (!this.config.lastFmApiKey || !artist.trim()) return [];
    const seed = firstArtist(artist);
    const neighbours = await this.artistLookups.load(
      `similar-artists\0${normalizeToken(seed)}`,
      async () => {
        const result = await this.lastFm("artist.getSimilar", {
          artist: seed,
          limit: String(similarArtistsPerSeed),
        }).catch(lastFmNotFound);
        if (!result) return [];
        return asArray(
          (result.similarartists as { artist?: unknown })?.artist,
        ).flatMap((row) => {
          const name = lastFmArtist(row).trim();
          if (!name) return [];
          const match = Number((row as { match?: unknown }).match ?? 0);
          return [{ name, match: match > 0 ? match : 0.5 }];
        });
      },
      [],
    );
    const perArtist = await Promise.all(
      neighbours.map(async (neighbour) => {
        const tracks = await this.lookups.load(
          `top-tracks\0${normalizeToken(neighbour.name)}`,
          async () => {
            const result = await this.lastFm("artist.getTopTracks", {
              artist: neighbour.name,
              limit: String(tracksPerSimilarArtist),
            }).catch(lastFmNotFound);
            if (!result) return [];
            return asArray(
              (result.toptracks as { track?: unknown })?.track,
            ).flatMap((row) => {
              const track = lastFmTrack(row);
              return track ? [track] : [];
            });
          },
          [],
        );
        return tracks.map(({ match: _, ...track }, index) => ({
          userId: "similar",
          source: "similar",
          weight: (2 * neighbour.match * seedWeight) / (index + 1),
          ...track,
        }));
      }),
    );
    return perArtist.flat();
  }

  private async listenBrainzTaste(
    userId: string,
    username?: string,
    token?: string,
  ) {
    if (!username) return emptyProfile();
    const headers = token ? { authorization: `Token ${token}` } : undefined;
    const user = encodeURIComponent(username);
    const [listens, stats, artists, recommendations, allTime] =
      await Promise.all([
        this.json(
          `${listenBrainzEndpoint}/user/${user}/listens?count=50`,
          headers,
        ).catch(() => undefined),
        this.json(
          `${listenBrainzEndpoint}/stats/user/${user}/recordings?range=quarter`,
          headers,
        ).catch(() => undefined),
        this.json(
          `${listenBrainzEndpoint}/stats/user/${user}/artists?range=quarter&count=${artistSeedWindow}`,
          headers,
        ).catch(() => undefined),
        this.json(
          `${listenBrainzEndpoint}/cf/recommendation/user/${user}/recording?count=${listenBrainzFetchCount}`,
          headers,
        ).catch(() => undefined),
        this.json(
          `${listenBrainzEndpoint}/stats/user/${user}/recordings?range=all_time&count=${knownHistoryLimit}`,
          headers,
        ).catch(() => undefined),
      ]);
    const known = asArray(
      (allTime?.payload as { recordings?: unknown })?.recordings,
    ).flatMap((row) => {
      const track = listenBrainzTrack(row);
      return track ? [trackKey(track.title, track.artist)] : [];
    });
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
    const topArtists = asArray(
      (artists?.payload as { artists?: unknown })?.artists,
    ).flatMap((row) => {
      const name = String(
        (row as { artist_name?: unknown }).artist_name ?? "",
      ).trim();
      if (!name) return [];
      const count = Number(
        (row as { listen_count?: unknown }).listen_count ?? 0,
      );
      return [{ name, score: 1 + Math.log10(Math.max(1, count) + 1) }];
    });
    const mbids = asArray(
      (recommendations?.payload as { mbids?: unknown })?.mbids,
    ).flatMap((row) => {
      const mbid = String(
        (row as { recording_mbid?: unknown }).recording_mbid ?? "",
      );
      if (!/^[0-9a-f-]{36}$/i.test(mbid)) return [];
      const score = Number((row as { score?: unknown }).score ?? 0);
      const listened = Boolean(
        (row as { latest_listened_at?: unknown }).latest_listened_at,
      );
      return [{ mbid, score: Number.isFinite(score) ? score : 0, listened }];
    });
    return {
      contributions: [...recent, ...top],
      known: new Set(known),
      artists: topArtists,
      listenBrainz: mbids,
    };
  }

  // ListenBrainz already did the collaborative filtering; sample a slice of
  // its list each build so the pool keeps moving, and weight by its score.
  private async listenBrainzRecommendations(
    userId: string,
    recommendations: ListenBrainzRecommendation[],
  ): Promise<(TasteContribution & { listened: boolean })[]> {
    if (!recommendations.length) return [];
    const best = Math.max(...recommendations.map((row) => row.score), 0);
    const weightOf = (score: number, index: number) =>
      best > 0 ? 2.5 * (score / best) : 2.5 / (index + 1);
    const picked = weightedSample(
      recommendations.map((row, index) => ({
        ...row,
        weight: weightOf(row.score, index),
      })),
      listenBrainzSampleCount,
      (row) => row.weight,
      this.random,
    );
    const missing = picked
      .map((row) => row.mbid)
      .filter((mbid) => !this.recordings.get(mbid));
    if (missing.length) {
      const settings = this.store.getUserScrobbling(userId);
      const headers = settings.listenBrainzToken
        ? { authorization: `Token ${settings.listenBrainzToken}` }
        : undefined;
      const result = await this.json(
        `${listenBrainzEndpoint}/metadata/recording/?recording_mbids=${missing.map(encodeURIComponent).join(",")}&inc=artist%20release`,
        headers,
      ).catch(() => undefined);
      const rows =
        result && typeof result === "object"
          ? (result as Record<string, unknown>)
          : {};
      for (const mbid of missing)
        this.recordings.set(
          mbid,
          listenBrainzMetadata(rows[mbid] ?? rows[mbid.toLowerCase()]),
        );
    }
    return picked.flatMap((row) => {
      const track = this.recordings.get(row.mbid)?.value;
      return track
        ? [
            {
              userId,
              source: "listenbrainz",
              weight: row.weight,
              listened: row.listened,
              ...track,
            },
          ]
        : [];
    });
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
      throw new LastFmError(
        String(result?.message ?? "Last.fm request failed"),
        Number(result?.error ?? 0),
      );
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

  // Serves the cached value while fresh, otherwise starts one load and keeps
  // handing out the previous value until it lands.
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
        const dirty = cache.get(key)?.dirty ?? false;
        cache.set(key, { value, expires: dirty ? 0 : Date.now() + ttlMs });
        return value;
      })
      .catch((error) => {
        if (current) cache.set(key, { value: current.value, expires: 0 });
        else cache.delete(key);
        log.warn(
          { event: "recommendation_cache_failed", key, err: error },
          "Recommendation cache load failed",
        );
        return current?.value ?? fallback;
      });
    cache.set(key, {
      value: current?.value ?? fallback,
      expires: 0,
      inflight,
    });
    return inflight;
  }
}

class LastFmError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

// "Not found" is a real answer worth remembering for the full memo TTL;
// anything else is an outage and should be retried soon.
function lastFmNotFound(error: unknown) {
  if (error instanceof LastFmError && error.code === 6) return undefined;
  throw error;
}

function emptyProfile(): TasteProfile {
  return { contributions: [], known: new Set(), artists: [], listenBrainz: [] };
}

function emptyPool(): UserPool {
  return {
    discover: [],
    favourites: [],
    sample: { discover: [], favourites: [] },
  };
}

function playableFromPool(track: PoolTrack): PlayableRecommendation {
  return { ...track.metadata, id: track.id, sources: track.sources };
}

function contributionFromMetadata(
  track: TrackMetadata,
  userId: string,
  source: string,
  weight: number,
): TasteContribution {
  return {
    userId,
    weight,
    source,
    title: track.title,
    artist: track.artist,
    ...(track.album ? { album: track.album } : {}),
    sourceId: track.sourceId,
    sourceInput: track.sourceInput,
    canonicalUrl: track.canonicalUrl,
    ...(track.artwork ? { artwork: track.artwork } : {}),
    ...(track.duration ? { duration: track.duration } : {}),
  };
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
