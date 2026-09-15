import { primaryArtist, trackKey } from "./recommendations.ts";
import type { PlayRecord, RoomPlayRecord, SkipRecord, Store } from "./store.ts";
import { normalizeToken } from "./tracks.ts";

// Listening memory that survives a Huddle ending. Within one Huddle the
// coordinator already keeps the last hundred songs out of the mix; this is
// what stops the same songs coming back the next time the same people are in
// a Huddle together.
//
// Everything here is a soft multiplier rather than an exclusion. Hard
// exclusions do not survive contact with a room: the union of five listeners'
// histories would starve the pool, and a song the whole room loves should come
// back eventually.

// A play stops mattering over a couple of weeks; a skip is a deliberate "not
// this", so it is remembered much longer.
export const playHalfLifeMs = 14 * 24 * 60 * 60_000;
export const skipHalfLifeMs = 45 * 24 * 60 * 60_000;
// Four half-lives, past which a row's weight is not worth the row.
export const playWindowMs = playHalfLifeMs * 4;
export const skipWindowMs = skipHalfLifeMs * 4;

// One fresh play roughly halves a song's score for that listener; hearing the
// artist a lot nudges it down far more gently.
const playWeight = 0.8;
const playArtistWeight = 0.12;
// A skip the listener made themselves is the strongest negative signal the
// mix gets. The artist penalty is deliberately a fraction of the in-session
// one: a single skip should not quietly cut an artist's whole catalogue for
// weeks.
const skipWeight = 1.2;
const skipArtistWeight = 0.1;
// A skip is one person's click, made in front of everyone else. They chose it,
// so they carry it in full; the rest of the room only tolerated the song, so it
// follows them at a fraction and never into Huddles they are not in.
export const skipBystanderShare = 0.25;
// What the room itself remembers, whoever is listening.
const roomWeight = 0.35;
// Nothing is ever suppressed entirely, so a small library still plays.
const fatigueFloor = 0.12;
// A listener who skips a lot would otherwise narrow their own mix to nothing.
const listenerFloor = 0.2;

export type FatigueStore = Pick<
  Store,
  "recentPlays" | "recentRoomPlays" | "recentSkips"
>;

type UserFatigue = {
  tracks: Map<string, number>;
  artists: Map<string, number>;
  skippedTracks: Map<string, number>;
  skippedArtists: Map<string, number>;
};

function emptyUser(): UserFatigue {
  return {
    tracks: new Map(),
    artists: new Map(),
    skippedTracks: new Map(),
    skippedArtists: new Map(),
  };
}

function add(counts: Map<string, number>, key: string, value: number) {
  if (!key) return;
  counts.set(key, (counts.get(key) ?? 0) + value);
}

export function decay(at: number, now: number, halfLifeMs: number) {
  return 0.5 ** (Math.max(0, now - at) / halfLifeMs);
}

export function artistKey(artist: string) {
  return normalizeToken(primaryArtist(artist));
}

// How heavily a song is weighed down for the listeners in the room, given what
// they have already heard and skipped.
export class FatigueIndex {
  private users = new Map<string, UserFatigue>();
  private room = new Map<string, number>();

  constructor(
    plays: readonly PlayRecord[],
    skips: readonly SkipRecord[],
    roomPlays: readonly RoomPlayRecord[],
    private now = Date.now(),
  ) {
    for (const play of plays) {
      const user = this.user(play.userId);
      const weight = decay(play.playedAt, this.now, playHalfLifeMs);
      add(user.tracks, trackKey(play.title, play.artist), weight);
      add(user.artists, artistKey(play.artist), weight);
    }
    for (const skip of skips) {
      const user = this.user(skip.userId);
      const weight =
        skip.weight * decay(skip.skippedAt, this.now, skipHalfLifeMs);
      add(user.skippedTracks, trackKey(skip.title, skip.artist), weight);
      add(user.skippedArtists, artistKey(skip.artist), weight);
    }
    for (const play of roomPlays)
      add(
        this.room,
        trackKey(play.title, play.artist),
        decay(play.playedAt, this.now, playHalfLifeMs),
      );
  }

  private user(userId: string) {
    const existing = this.users.get(userId);
    if (existing) return existing;
    const created = emptyUser();
    this.users.set(userId, created);
    return created;
  }

  // The mean across listeners, not the maximum: one person being sick of a
  // song should tilt the mix, not veto it for everyone else.
  multiplier(
    track: { title: string; artist: string },
    listenerIds: readonly string[],
  ) {
    const key = trackKey(track.title, track.artist);
    const artist = artistKey(track.artist);
    // A listener the mix has never recorded counts as a full 1: as far as it
    // knows, they have not heard this. That is what keeps one listener who is
    // sick of a song from deciding the song for the whole room.
    const scores = listenerIds.map((userId) => {
      const user = this.users.get(userId);
      if (!user) return 1;
      return Math.max(
        listenerFloor,
        1 /
          (1 +
            playWeight * (user.tracks.get(key) ?? 0) +
            playArtistWeight * (user.artists.get(artist) ?? 0) +
            skipWeight * (user.skippedTracks.get(key) ?? 0) +
            skipArtistWeight * (user.skippedArtists.get(artist) ?? 0)),
      );
    });
    const listeners = scores.length
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
      : 1;
    const room = 1 / (1 + roomWeight * (this.room.get(key) ?? 0));
    return Math.max(fatigueFloor, listeners * room);
  }
}

// Reads the window the decay actually cares about. Cheap enough to run per
// pick: it is a local SQLite read bounded by the window, and autoplay picks a
// song every few minutes.
export function loadFatigue(
  store: FatigueStore,
  options: { userIds: readonly string[]; roomId?: string; now?: number },
) {
  const now = options.now ?? Date.now();
  return new FatigueIndex(
    store.recentPlays(options.userIds, now - playWindowMs),
    store.recentSkips(options.userIds, now - skipWindowMs),
    options.roomId
      ? store.recentRoomPlays(options.roomId, now - playWindowMs)
      : [],
    now,
  );
}
