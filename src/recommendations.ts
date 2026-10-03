import { firstArtist } from "./artist.ts";
import { logger } from "./logger.ts";
import {
  usableHuddleMixSources,
  type HuddleMixSource,
  type Store,
} from "./store.ts";
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
const poolSize = 45;
const sampleSize = 30;
// A lane whose visible sample has dropped to half is topped up, but not
// more often than this, so a thin lane does not rebuild on every play.
const laneDepletionThreshold = 15;
const depletionRebuildIntervalMs = 60_000;
const poolResolveAttempts = 25;
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
// A listener's top tracks are read deep, and each autoplay pick draws a fresh
// score-weighted slice of their songs, so their best-known songs lead often
// but the same handful does not lead every pick.
const topTrackWindow = 150;
const mixTasteSampleSize = 40;
const recentAddLimit = 25;
// An explicit like is the rarest and most deliberate signal the mix gets, and
// the button is one way, so time is the only thing that takes one back. It
// outlasts a play (14 days) and a skip (45) several times over, which is what
// makes it hold: fatigue from the extra airtime a like earns still outweighs
// it in the moment — a few fresh plays push a liked song well down — but that
// fades in a fortnight, and the like is still there when it does.
export const likeHalfLifeMs = 90 * 24 * 60 * 60_000;
export const likeWindowMs = likeHalfLifeMs * 4;
// Above the weight an added track carries: someone went out of their way to
// say so, about a song they were already being played.
const likeWeight = 3;
// What queueing a song says about someone's taste, and the unit the artist
// fallback below counts in.
const addedWeight = 2;
const knownHistoryLimit = 1000;
const upNextPerSeed = 10;

// Huddle mix autoplay.
const mixCandidateLimit = 12;
const mixResolveAttempts = 24;
const mixDiscoveryLimit = 6;
const mixPoolDiscoveryWeight = 3;
const mixSameArtistBoost = 1.4;
const mixArtistRunLimit = 2;
const mixArtistRunDamping = 0.5;
// Each listener's taste is scaled to the room's average total, so a deep
// scrobble history does not drown out a few added songs; but by no more than
// this either way, so one added song does not become an overwhelming favourite.
const mixTasteScaleLimit = 4;
const skipTrackPenalty = 0.2;
const skipArtistPenalty = 0.6;
const lanes = ["discover", "favourites"] as const;

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
  | "getUserScrobbling"
  | "recentTracks"
  | "recentAutomaticTracks"
  | "recentLikes"
  | "findPlayedTrack"
>;

type TasteArtist = { name: string; score: number };

type TasteProfile = {
  contributions: TasteContribution[];
  known: Set<string>;
  // The known set split by where it came from, so the Huddle mix can leave
  // out the sources a listener has not given it.
  knownFrom: Record<HuddleMixSource, Set<string>>;
  artists: TasteArtist[];
  listenBrainz: ListenBrainzRecommendation[];
};

// The part of a listener's taste the Huddle mix may use.
type MixTaste = Pick<TasteProfile, "contributions" | "known">;

// Which Huddle mix source each kind of taste contribution belongs to.
const mixSourceOf: Record<string, HuddleMixSource> = {
  huddlefm: "added",
  liked: "added",
  lastfm: "lastfm",
  listenbrainz: "listenbrainz",
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
  builtAt: number;
};

type Resolved = { track: ScoredTrack; metadata: TrackMetadata };

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

const keyOf = (track: { title: string; artist: string }) =>
  trackKey(track.title, track.artist);

const creditPattern =
  /\s*[([]\s*(?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]|\s+(?:feat|ft|featuring)\.?\s.*$/i;
// YouTube titles carry labels that no scrobbler includes.
const videoLabelPattern =
  /\s*[([](?:official\s+)?(?:music\s+|lyric\s+)?(?:video|audio|visuali[sz]er|lyrics|hd|4k)[)\]]/gi;

export function stripCredits(title: string) {
  return (
    title.replace(videoLabelPattern, "").replace(creditPattern, "").trim() ||
    title
  );
}

export function primaryArtist(artist: string) {
  return (
    artist
      .split(
        /\s*(?:,|&|\+|\bvs\.?\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i,
      )[0]
      ?.trim() || artist
  );
}

export function mergeTaste(tracks: TasteContribution[]): ScoredTrack[] {
  const byKey = new Map<string, ScoredTrack>();
  for (const track of tracks) {
    if (!track.title.trim() || !track.artist.trim()) continue;
    const key = keyOf(track);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        title: track.title,
        artist: track.artist,
        ...(track.sourceId ? { sourceId: track.sourceId } : {}),
        ...(track.sourceInput ? { sourceInput: track.sourceInput } : {}),
        ...(track.canonicalUrl ? { canonicalUrl: track.canonicalUrl } : {}),
        ...details(track),
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

// Scales each listener's contributions to the same total weight, the mean of
// the room's, within `mixTasteScaleLimit`. A listener alone is left as is.
export function balanceTaste(
  perListener: readonly (readonly TasteContribution[])[],
): TasteContribution[] {
  const totals = perListener.map((contributions) =>
    contributions.reduce((sum, track) => sum + track.weight, 0),
  );
  const present = totals.filter((total) => total > 0);
  const target = present.length
    ? present.reduce((sum, total) => sum + total, 0) / present.length
    : 0;
  return perListener.flatMap((contributions, index) => {
    const total = totals[index]!;
    if (total <= 0) return [...contributions];
    const scale = Math.min(
      mixTasteScaleLimit,
      Math.max(1 / mixTasteScaleLimit, target / total),
    );
    return contributions.map((track) => ({
      ...track,
      weight: track.weight * scale,
    }));
  });
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
    keys: new Set([...(skipped.tracks ?? [])].map(keyOf)),
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
      if (penalties.keys.has(keyOf(track))) score *= 0.1;
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

  // A score-weighted draw with this catalog's random source.
  private draw<T extends { score: number }>(
    items: readonly T[],
    count: number,
  ) {
    return weightedSample(items, count, (item) => item.score, this.random);
  }

  huddleMixOptedIn(userId: string) {
    return this.store.getUserScrobbling(userId).huddleMixOptIn !== false;
  }

  // A listener's taste, narrowed to the sources they let the mix use.
  private mixTaste(userId: string, profile: TasteProfile): MixTaste {
    const sources = new Set(
      this.store.getUserScrobbling(userId).huddleMixSources,
    );
    const known = new Set<string>();
    for (const source of sources)
      for (const key of profile.knownFrom[source]) known.add(key);
    return {
      contributions: profile.contributions.filter((track) => {
        const source = mixSourceOf[track.source];
        return source !== undefined && sources.has(source);
      }),
      known,
    };
  }

  // Whether the listener lets the mix use everything their recommendations
  // are built from.
  private mixesEverySource(userId: string) {
    const settings = this.store.getUserScrobbling(userId);
    return usableHuddleMixSources(settings).every((source) =>
      settings.huddleMixSources.includes(source),
    );
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
  // stale or rebuilding pool still serves its last version.
  userRecommendations(
    userId: string,
    exclude?: Iterable<string | undefined>,
  ): UserRecommendations {
    const entry = this.pools.get(userId);
    if (!entry) return { discover: [], favourites: [] };
    if (exclude) return this.noteSession(userId, exclude);
    return { ...entry.value.sample };
  }

  // Tells the catalog what a session has already played or queued for these
  // listeners, so the next build drops it from their pools, and marks a pool
  // stale when either lane's visible sample has run low. Callers prefetch
  // afterwards to top up in the background.
  noteSessions(
    userIds: Iterable<string>,
    exclude: Iterable<string | undefined>,
  ) {
    const excluded = [...exclude];
    for (const userId of userIds)
      if (this.pools.has(userId)) this.noteSession(userId, excluded);
  }

  private noteSession(
    userId: string,
    exclude: Iterable<string | undefined>,
  ): UserRecommendations {
    const excluded = new Set(
      [...exclude].filter((id): id is string => Boolean(id)),
    );
    const entry = this.pools.get(userId)!;
    this.consumed.set(userId, excluded);
    const keep = (track: PlayableRecommendation) =>
      !excluded.has(track.sourceId);
    const { sample } = entry.value;
    const result = {
      discover: sample.discover.filter(keep),
      favourites: sample.favourites.filter(keep),
    };
    const depleted = (lane: keyof UserRecommendations) =>
      result[lane].length < laneDepletionThreshold &&
      sample[lane].length > result[lane].length;
    if (
      lanes.some(depleted) &&
      Date.now() - entry.value.builtAt > depletionRebuildIntervalMs
    )
      entry.expires = 0;
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
    // The listeners the previous autoplay pick was credited to.
    lastCredited?: readonly string[];
    // The listeners whose song is now playing: what follows on from it is
    // credited to them.
    nowPlayingListenerIds?: readonly string[];
    // How many tracks in a row the now-playing artist has had, including
    // the current one.
    artistRun?: number;
    // Cross-Huddle listening memory. Structural so the catalog does not have
    // to know how fatigue is built or stored.
    fatigue?: {
      multiplier(
        track: { title: string; artist: string },
        listenerIds: readonly string[],
      ): number;
    };
  }) {
    const excluded = new Set(
      [...(options.exclude ?? [])].filter((id): id is string => Boolean(id)),
    );
    const listeners = options.userIds.filter((userId) =>
      this.huddleMixOptedIn(userId),
    );
    const { nowPlaying } = options;
    const [tastes, similar, similarArtists, related] = await Promise.all([
      Promise.all(listeners.map((userId) => this.userTaste(userId))),
      nowPlaying ? this.similarTracks(nowPlaying.title, nowPlaying.artist) : [],
      nowPlaying ? this.similarArtistTracks(nowPlaying.artist, 1) : [],
      nowPlaying?.sourceId && isYoutubeVideoId(nowPlaying.sourceId)
        ? this.tracks.upNextTracks(nowPlaying.sourceId).catch(() => [])
        : [],
    ]);
    const profiles = tastes.map((taste, index) =>
      this.mixTaste(listeners[index]!, taste),
    );
    const knownBy = new Map<string, MixTaste>();
    listeners.forEach((userId, index) => knownBy.set(userId, profiles[index]!));
    const known = new Set<string>();
    for (const profile of profiles)
      for (const key of profile.known) known.add(key);
    const contributions = balanceTaste(
      profiles.map((profile) => this.tasteSample(profile.contributions)),
    );
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
    // the most personal source there is, and costs nothing to use. It is
    // seeded from all of their taste, so it is only used for listeners who
    // let the mix use every source.
    const poolDiscoveries = options.discover
      ? listeners
          .filter((userId) => this.mixesEverySource(userId))
          .flatMap((userId) => {
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
    ).filter((track) => !nowPlaying || keyOf(track) !== keyOf(nowPlaying));
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
    // Push down whatever these listeners have already heard, or skipped, in
    // earlier Huddles. Applied last so it weighs the finished score.
    if (options.fatigue)
      for (const track of ranked)
        track.score *= options.fatigue.multiplier(track, listeners);
    ranked.sort((a, b) => b.score - a.score);
    const recentKeys = new Set((options.recent ?? []).map(keyOf));
    const eligible = ranked.filter((track) => !recentKeys.has(keyOf(track)));
    const isDiscovery = (track: ScoredTrack) => !known.has(keyOf(track));
    // A track is credited to the listeners whose taste put it forward, or,
    // when it only follows on from the song playing, to whoever that song
    // was for.
    const seedOwners = (options.nowPlayingListenerIds ?? []).filter((userId) =>
      knownBy.has(userId),
    );
    const creditsOf = (track: ScoredTrack) => {
      const own = track.userIds.filter((userId) => knownBy.has(userId));
      return own.length ? own : seedOwners;
    };
    // A track counts as a seed for each listener who has actually played it,
    // which is a stronger signal than merely turning up in their similar
    // tracks or Discover pool.
    const finish = ({ track, metadata }: Resolved): AutoplayCandidate => {
      const key = keyOf(track);
      const played = listeners.filter((userId) =>
        knownBy.get(userId)!.known.has(key),
      );
      return {
        sourceId: metadata.sourceId,
        score: track.score,
        seedCount: Math.max(1, played.length),
        discovery: isDiscovery(track),
        listenerIds: creditsOf(track),
        metadata,
      };
    };
    // Candidates come back in the sampled order, which the caller keeps:
    // re-sorting by score here would put the same track first every pick.
    const results: AutoplayCandidate[] = [];
    const taken = new Set<string>();
    const resolveLane = async (tracks: ScoredTrack[], limit: number) => {
      if (limit <= 0) return;
      const resolved = await this.resolvePlayable(
        this.sampleByScore(tracks.filter((track) => !taken.has(keyOf(track)))),
        excluded,
        limit,
        mixResolveAttempts,
      );
      for (const candidate of resolved) {
        excluded.add(candidate.metadata.sourceId);
        taken.add(keyOf(candidate.track));
        results.push(finish(candidate));
      }
    };
    // With more than one listener, the pick goes to whoever's turn it is:
    // their own lane leads, and only if it has nothing playable does the
    // turn pass on. The room's ranking fills in behind.
    const turns =
      listeners.length > 1
        ? this.turnOrder(listeners, options.credited, options.lastCredited)
        : [];
    const resolveTurn = async (tracks: ScoredTrack[], limit: number) => {
      const start = results.length;
      for (const userId of turns) {
        const lane = tracks.filter((track) =>
          creditsOf(track).includes(userId),
        );
        if (!lane.length) continue;
        await resolveLane(lane, Math.ceil(limit / 2));
        if (results.length > start) break;
      }
      await resolveLane(tracks, limit - (results.length - start));
    };
    if (!options.discover) await resolveTurn(eligible, mixCandidateLimit);
    else {
      // A discovery turn: lead with tracks nobody in the huddle has listened
      // to, then fall back to the usual ranking.
      await resolveTurn(eligible.filter(isDiscovery), mixDiscoveryLimit);
      await resolveTurn(
        eligible.filter((track) => !isDiscovery(track)),
        mixCandidateLimit - results.length,
      );
    }
    return results;
  }

  // A score-weighted draw of one listener's songs, each song's contributions
  // merged first so a song every service agrees on is drawn as one.
  private tasteSample(contributions: TasteContribution[]) {
    const songs = mergeTaste(contributions);
    if (songs.length <= mixTasteSampleSize) return contributions;
    const drawn = new Set(
      this.draw(songs, mixTasteSampleSize).map((song) => keyOf(song)),
    );
    return contributions.filter((track) => drawn.has(keyOf(track)));
  }

  // Whose turn it is: fewest recent picks first, ties drawn at random. Whoever
  // the last pick served waits behind everyone else, so a newcomer catching
  // up alternates with the room rather than taking several picks in a row.
  private turnOrder(
    listeners: readonly string[],
    credited: Record<string, number> = {},
    lastCredited: readonly string[] = [],
  ) {
    const last = new Set(lastCredited);
    const tiebreak = new Map(
      listeners.map((userId) => [userId, this.random()]),
    );
    return [...listeners].sort(
      (a, b) =>
        Number(last.has(a)) - Number(last.has(b)) ||
        (credited[a] ?? 0) - (credited[b] ?? 0) ||
        tiebreak.get(a)! - tiebreak.get(b)!,
    );
  }

  // Reorders the strongest candidates with a score-weighted draw, so the
  // best track is the most likely lead but not the only one. Anything past
  // the resolve window keeps its ranked order.
  private sampleByScore(ranked: ScoredTrack[]) {
    const window = ranked.slice(0, mixResolveAttempts);
    return [
      ...this.draw(window, window.length),
      ...ranked.slice(mixResolveAttempts),
    ];
  }

  // A listener skipped a track: push it and, more gently, its artist down
  // in their own pools so it does not come straight back in the modal.
  penalize(userId: string, track: { title: string; artist: string }) {
    const pool = this.pools.get(userId)?.value;
    if (!pool) return;
    const key = keyOf(track);
    const artist = normalizeToken(primaryArtist(track.artist));
    const punish = (entry: PoolTrack) => {
      if (entry.key === key) entry.score *= skipTrackPenalty;
      else if (normalizeToken(primaryArtist(entry.metadata.artist)) === artist)
        entry.score *= skipArtistPenalty;
    };
    const keep = (entry: PlayableRecommendation) => keyOf(entry) !== key;
    for (const lane of lanes) {
      pool[lane].forEach(punish);
      pool.sample[lane] = pool.sample[lane].filter(keep);
    }
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
      .map((track) =>
        contributionFromMetadata(track, userId, "huddlefm", addedWeight),
      );
    // Liking a song is the only way to say "more of this" about something the
    // mix chose rather than something you queued, so it is the one positive
    // signal nothing else here can stand in for. A like fades with age instead
    // of being taken back, and carries no metadata: the track has been played
    // in a Huddle by definition, so resolving it finds the same video again.
    const now = Date.now();
    // Rows are deduplicated the way the mix matches songs, not the way SQLite
    // stores them: liking "Alpha (Official Video)" and later plain "Alpha" is
    // two rows but one song, and pressing the button twice is not meant to be
    // worth twice as much. Newest first, so the freshest press is the one kept.
    const likedKeys = new Set<string>();
    const liked: TasteContribution[] = this.store
      .recentLikes([userId], now - likeWindowMs)
      .filter((like) => {
        const key = keyOf(like);
        if (likedKeys.has(key)) return false;
        likedKeys.add(key);
        return true;
      })
      .map((like) => ({
        userId,
        // Clamped like every other decay here: a clock that steps backwards
        // must not make a like worth more than a fresh one.
        weight:
          likeWeight *
          0.5 ** (Math.max(0, now - like.likedAt) / likeHalfLifeMs),
        source: "liked",
        title: like.title,
        artist: like.artist,
      }));
    // Autoplay picks get scrobbled for everyone in the room, so they would
    // otherwise turn up in every listener's recent listens and top tracks
    // and, boosted as a shared taste, come straight back into the mix: each
    // play would make the next more likely.
    const autoplayed = new Set(this.store.recentAutomaticTracks().map(keyOf));
    const warn = (event: string, text: string) => (error: unknown) => {
      log.warn({ event, userId, err: error }, text);
      return emptyProfile();
    };
    const [lastFm, listenBrainz] = await Promise.all([
      this.lastFmTaste(userId, settings.lastFmUsername, autoplayed).catch(
        warn("lastfm_taste_failed", "Last.fm taste lookup failed"),
      ),
      this.listenBrainzTaste(
        userId,
        settings.listenBrainzUsername,
        settings.listenBrainzToken,
        autoplayed,
      ).catch(
        warn("listenbrainz_taste_failed", "ListenBrainz taste lookup failed"),
      ),
    ]);
    const contributions = [
      ...added,
      ...liked,
      ...lastFm.contributions,
      ...listenBrainz.contributions,
    ];
    const knownFrom = {
      added: new Set([...added, ...liked].map(keyOf)),
      lastfm: new Set([...lastFm.contributions.map(keyOf), ...lastFm.known]),
      listenbrainz: new Set([
        ...listenBrainz.contributions.map(keyOf),
        ...listenBrainz.known,
      ]),
    };
    const known = new Set(
      Object.values(knownFrom).flatMap((keys) => [...keys]),
    );
    const artists = new Map<string, TasteArtist>();
    const addArtist = (name: string, score: number) => {
      const key = normalizeToken(name);
      const existing = artists.get(key);
      if (existing) existing.score += score;
      else artists.set(key, { name, score });
    };
    for (const artist of [...lastFm.artists, ...listenBrainz.artists])
      addArtist(artist.name, artist.score);
    // Without a scrobbler, the artists someone adds or likes are the best
    // signal. Counted on the same scale as the track weights, so an added song
    // is worth one artist point and a like is worth what it is still worth:
    // one that has nearly aged out seeds an artist as weakly as it seeds the
    // song itself, rather than as strongly as a fresh one.
    if (!artists.size)
      for (const track of [...added, ...liked]) {
        const name = firstArtist(track.artist);
        if (normalizeToken(name)) addArtist(name, track.weight / addedWeight);
      }
    return {
      contributions,
      known,
      knownFrom,
      artists: [...artists.values()].sort((a, b) => b.score - a.score),
      listenBrainz: listenBrainz.listenBrainz,
    };
  }

  private async buildUserPool(userId: string): Promise<UserPool> {
    const previous = this.pools.get(userId)?.value ?? emptyPool();
    const consumed = this.consumed.get(userId) ?? new Set<string>();
    const recent = this.store.recentTracks(userId, recentAddLimit);
    const recentKeys = new Set(recent.map(keyOf));
    const profile = await this.userTaste(userId);
    const taste = mergeTaste(profile.contributions);
    const trackSeeds = this.draw(
      taste.slice(0, trackSeedWindow),
      trackSeedCount,
    );
    const artistSeeds = this.draw(
      profile.artists.slice(0, artistSeedWindow),
      artistSeedCount,
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
      // YouTube returns ~50 up-next rows per seed in relevance order; keep
      // the head so it seasons the mix rather than swamping it.
      ...upNext.flatMap((tracks) =>
        tracks
          .slice(0, upNextPerSeed)
          .map((track, index) =>
            contributionFromMetadata(
              track,
              userId,
              "related",
              2.2 / (1 + index / 5),
            ),
          ),
      ),
    ];
    const isKnown = (track: TasteTrack & { listened?: boolean }) =>
      track.listened === true || profile.known.has(keyOf(track));
    const discoverRanked = mergeTaste(
      discovered.filter((track) => !isKnown(track)),
    );
    const favouritesRanked = mergeTaste([
      ...profile.contributions,
      ...discovered.filter(isKnown),
    ]).filter((track) => !recentKeys.has(keyOf(track)));
    const excludedIds = new Set([
      ...consumed,
      ...recent.map((track) => track.sourceId),
    ]);
    // A track the user has since listened to no longer belongs in Discover,
    // and a favourite they just added moves to "Recent songs".
    const discover = await this.mergePool(
      previous.discover.filter((track) => !profile.known.has(track.key)),
      discoverRanked,
      excludedIds,
    );
    for (const track of discover) excludedIds.add(track.metadata.sourceId);
    const favourites = await this.mergePool(
      previous.favourites.filter((track) => !recentKeys.has(track.key)),
      favouritesRanked,
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
      discover: this.draw(discover, sampleSize).map(playableFromPool),
      favourites: this.draw(favourites, sampleSize).map(playableFromPool),
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
    return { discover, favourites, sample, builtAt: Date.now() };
  }

  // Folds this build's ranking into the previous pool: old entries decay,
  // re-recommended ones are bumped, and a bounded number of newcomers are
  // resolved. The result is the top `poolSize` by score, with a share
  // reserved for this build's newcomers so incumbents cannot lock the pool.
  private async mergePool(
    previous: PoolTrack[],
    ranked: ScoredTrack[],
    excluded: Set<string>,
  ) {
    const pool = new Map<string, PoolTrack>();
    for (const track of previous) {
      if (excluded.has(track.metadata.sourceId)) continue;
      pool.set(track.key, { ...track, score: track.score * poolDecay });
    }
    const newcomers: ScoredTrack[] = [];
    for (const track of ranked) {
      const key = keyOf(track);
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
      poolSize,
      poolResolveAttempts,
    );
    const fresh: PoolTrack[] = [];
    for (const { track, metadata } of resolved) {
      const entry = {
        id: `rec_${crypto.randomUUID()}`,
        key: keyOf(track),
        score: track.score,
        sources: track.sources,
        metadata,
      };
      pool.set(entry.key, entry);
      fresh.push(entry);
    }
    const byScore = (a: PoolTrack, b: PoolTrack) => b.score - a.score;
    const reserved = fresh
      .sort(byScore)
      .slice(0, Math.ceil(poolSize * newcomerShare));
    const keptIds = new Set(reserved.map((track) => track.id));
    const rest = [...pool.values()]
      .filter((track) => !keptIds.has(track.id))
      .sort(byScore)
      .slice(0, Math.max(0, poolSize - reserved.length));
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
    const results: (Resolved & { rank: number })[] = [];
    await mapPool(
      ranked.slice(0, attempts).map((track, rank) => ({ track, rank })),
      searchConcurrency,
      async ({ track, rank }) => {
        if (results.length >= limit) return;
        const key = keyOf(track);
        if (seenKeys.has(key)) return;
        if (track.sourceId && seen.has(track.sourceId)) return;
        const metadata = await this.resolveTrack(track);
        if (!metadata || seen.has(metadata.sourceId) || results.length >= limit)
          return;
        seen.add(metadata.sourceId);
        seenKeys.add(key);
        seenKeys.add(keyOf(metadata));
        results.push({ track, metadata, rank });
      },
    );
    // Lookups finish out of order; hand back the caller's order.
    return results.sort((a, b) => a.rank - b.rank);
  }

  // Turns a title/artist pair into playable metadata: a track that already
  // carries a YouTube id is used as-is, then the memo, then anything this
  // workspace has played before, and only then a YouTube Music search.
  private async resolveTrack(track: TasteTrack) {
    const { sourceId, sourceInput, canonicalUrl } = track;
    if (sourceId && sourceInput && canonicalUrl && isYoutubeVideoId(sourceId))
      return playableMetadata({
        ...track,
        sourceId,
        sourceInput,
        canonicalUrl,
      });
    const key = keyOf(track);
    const memo = this.searches.get(key);
    if (memo) return memo.value;
    const played = this.store.findPlayedTrack(track.title, track.artist);
    if (played && isYoutubeVideoId(played.sourceId)) {
      const metadata = playableMetadata(played);
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

  private async lastFmTaste(
    userId: string,
    username?: string,
    autoplayed = new Set<string>(),
  ) {
    if (!this.config.lastFmApiKey || !username) return emptyProfile();
    const [top, recent, artists, allTime] = await Promise.all([
      this.lastFm("user.getTopTracks", {
        user: username,
        period: "3month",
        limit: String(topTrackWindow),
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
    const listener = { userId, source: "lastfm" };
    return {
      ...emptyProfile(),
      contributions: [
        ...contributionsFrom(
          rows(top, "toptracks", "track"),
          lastFmTrack,
          listener,
          (row) => 1.5 + logCount(row.playcount),
          autoplayed,
        ),
        ...contributionsFrom(
          rows(recent, "recenttracks", "track"),
          lastFmTrack,
          listener,
          () => 1,
          autoplayed,
        ),
      ],
      known: new Set(
        parsed(rows(allTime, "toptracks", "track"), lastFmTrack).map(keyOf),
      ),
      artists: artistsFrom(
        rows(artists, "topartists", "artist"),
        lastFmArtist,
        (row) => row.playcount,
      ),
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
          const similar = await this.lastFmRows(
            "track.getSimilar",
            { track: title, artist: seed, limit: "20" },
            "similartracks",
            "track",
          );
          return similar.flatMap((row) => {
            const track = lastFmTrack(row);
            if (!track) return [];
            const match = Number(row.match ?? 0);
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
        const similar = await this.lastFmRows(
          "artist.getSimilar",
          { artist: seed, limit: String(similarArtistsPerSeed) },
          "similarartists",
          "artist",
        );
        return similar.flatMap((row) => {
          const name = lastFmArtist(row).trim();
          if (!name) return [];
          const match = Number(row.match ?? 0);
          return [{ name, match: match > 0 ? match : 0.5 }];
        });
      },
      [],
    );
    const perArtist = await Promise.all(
      neighbours.map(async (neighbour) => {
        const tracks = await this.lookups.load(
          `top-tracks\0${normalizeToken(neighbour.name)}`,
          async () =>
            parsed(
              await this.lastFmRows(
                "artist.getTopTracks",
                {
                  artist: neighbour.name,
                  limit: String(tracksPerSimilarArtist),
                },
                "toptracks",
                "track",
              ),
              lastFmTrack,
            ),
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
    autoplayed = new Set<string>(),
  ) {
    if (!username) return emptyProfile();
    const headers = tokenHeaders(token);
    const user = encodeURIComponent(username);
    const get = (path: string) =>
      this.json(`${listenBrainzEndpoint}${path}`, headers).catch(
        () => undefined,
      );
    const [listens, stats, artists, recommendations, allTime] =
      await Promise.all([
        get(`/user/${user}/listens?count=50`),
        get(
          `/stats/user/${user}/recordings?range=quarter&count=${topTrackWindow}`,
        ),
        get(
          `/stats/user/${user}/artists?range=quarter&count=${artistSeedWindow}`,
        ),
        get(
          `/cf/recommendation/user/${user}/recording?count=${listenBrainzFetchCount}`,
        ),
        get(
          `/stats/user/${user}/recordings?range=all_time&count=${knownHistoryLimit}`,
        ),
      ]);
    const listener = { userId, source: "listenbrainz" };
    const mbids = rows(recommendations, "payload", "mbids").flatMap((row) => {
      const mbid = String(row.recording_mbid ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(mbid)) return [];
      const score = Number(row.score ?? 0);
      const listened = Boolean(row.latest_listened_at);
      return [{ mbid, score: Number.isFinite(score) ? score : 0, listened }];
    });
    return {
      contributions: [
        ...contributionsFrom(
          rows(listens, "payload", "listens"),
          (row) => listenBrainzTrack(row.track_metadata),
          listener,
          () => 1,
          autoplayed,
        ),
        ...contributionsFrom(
          rows(stats, "payload", "recordings"),
          listenBrainzTrack,
          listener,
          (row) => 1.5 + logCount(row.listen_count),
          autoplayed,
        ),
      ],
      known: new Set(
        parsed(rows(allTime, "payload", "recordings"), listenBrainzTrack).map(
          keyOf,
        ),
      ),
      artists: artistsFrom(
        rows(artists, "payload", "artists"),
        (row) => row.artist_name,
        (row) => row.listen_count,
      ),
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
      const result = await this.json(
        `${listenBrainzEndpoint}/metadata/recording/?recording_mbids=${missing.map(encodeURIComponent).join(",")}&inc=artist%20release`,
        tokenHeaders(this.store.getUserScrobbling(userId).listenBrainzToken),
      ).catch(() => undefined);
      const found =
        result && typeof result === "object"
          ? (result as Record<string, unknown>)
          : {};
      for (const mbid of missing)
        this.recordings.set(
          mbid,
          listenBrainzMetadata(found[mbid] ?? found[mbid.toLowerCase()]),
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

  // A Last.fm list lookup where "not found" is simply an empty answer.
  private async lastFmRows(
    method: string,
    params: Record<string, string>,
    outer: string,
    inner: string,
  ) {
    const result = await this.lastFm(method, params).catch(lastFmNotFound);
    return result ? rows(result, outer, inner) : [];
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
// anything else is an outage and should be retried soon. Last.fm reports
// both a missing track and an invalid request as code 6, so go by the
// message.
function lastFmNotFound(error: unknown) {
  if (
    error instanceof LastFmError &&
    error.code === 6 &&
    /not (?:be )?found/i.test(error.message)
  )
    return undefined;
  throw error;
}

function emptyProfile(): TasteProfile {
  return {
    contributions: [],
    known: new Set(),
    knownFrom: {
      added: new Set(),
      lastfm: new Set(),
      listenbrainz: new Set(),
    },
    artists: [],
    listenBrainz: [],
  };
}

function emptyPool(): UserPool {
  return {
    discover: [],
    favourites: [],
    sample: { discover: [], favourites: [] },
    builtAt: 0,
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
    sourceId: track.sourceId,
    sourceInput: track.sourceInput,
    canonicalUrl: track.canonicalUrl,
    ...details(track),
  };
}

// The optional track fields, carried only when set so a later merge can fill
// them in.
function details(track: Pick<TrackMetadata, "album" | "duration" | "artwork">) {
  return {
    ...(track.album ? { album: track.album } : {}),
    ...(track.duration ? { duration: track.duration } : {}),
    ...(track.artwork ? { artwork: track.artwork } : {}),
  };
}

function playableMetadata(track: TrackMetadata): TrackMetadata {
  return {
    sourceInput: track.sourceInput,
    canonicalUrl: track.canonicalUrl,
    sourceId: track.sourceId,
    title: track.title,
    artist: track.artist,
    ...details(track),
  };
}

type Row = Record<string, unknown>;
type RowParser = (row: Row) => TasteTrack | undefined;

// Digs a list out of a provider response; a single item comes back bare.
function rows(value: unknown, outer: string, inner: string): Row[] {
  const list = (value as Record<string, Row> | undefined)?.[outer]?.[inner];
  return Array.isArray(list) ? list : list ? [list as Row] : [];
}

function parsed(rows: Row[], parse: RowParser) {
  return rows.flatMap((row) => {
    const track = parse(row);
    return track ? [track] : [];
  });
}

// One listener's rows as contributions, minus what does not parse and, when
// given, the songs the mix itself chose for them.
function contributionsFrom(
  rows: Row[],
  parse: RowParser,
  listener: { userId: string; source: string },
  weight: (row: Row) => number,
  skip?: Set<string>,
): TasteContribution[] {
  return rows.flatMap((row) => {
    const track = parse(row);
    if (!track || skip?.has(keyOf(track))) return [];
    return [{ ...listener, weight: weight(row), ...track }];
  });
}

function artistsFrom(
  rows: Row[],
  name: (row: Row) => unknown,
  count: (row: Row) => unknown,
): TasteArtist[] {
  return rows.flatMap((row) => {
    const artist = String(name(row) ?? "").trim();
    return artist ? [{ name: artist, score: 1 + logCount(count(row)) }] : [];
  });
}

function tokenHeaders(token?: string) {
  return token ? { authorization: `Token ${token}` } : undefined;
}

function logCount(value: unknown) {
  return Math.log10(Math.max(1, Number(value ?? 0)) + 1);
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

function tasteTrack(
  title: unknown,
  artist: unknown,
  album: unknown,
): TasteTrack | undefined {
  const name = String(title ?? "").trim();
  const credit = String(artist ?? "").trim();
  if (!name || !credit) return;
  const release = String(album ?? "").trim();
  return {
    title: name,
    artist: credit,
    ...(release ? { album: release } : {}),
  };
}

function lastFmTrack(value: unknown) {
  if (!value || typeof value !== "object") return;
  const row = value as { name?: unknown; artist?: unknown; album?: unknown };
  return tasteTrack(
    row.name,
    lastFmArtist(row.artist),
    lastFmArtist(row.album),
  );
}

function listenBrainzTrack(value: unknown) {
  if (!value || typeof value !== "object") return;
  const row = value as {
    track_name?: unknown;
    recording_name?: unknown;
    artist_name?: unknown;
    release_name?: unknown;
  };
  return tasteTrack(
    row.track_name ?? row.recording_name,
    row.artist_name,
    row.release_name,
  );
}

function listenBrainzMetadata(value: unknown) {
  if (!value || typeof value !== "object") return;
  const row = value as {
    recording?: { name?: unknown };
    artist?: { name?: unknown }[] | { name?: unknown };
    release?: { name?: unknown };
  };
  const artist = Array.isArray(row.artist) ? row.artist[0] : row.artist;
  return tasteTrack(row.recording?.name, artist?.name, row.release?.name);
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
