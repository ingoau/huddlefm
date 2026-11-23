import { trackKey } from "./recommendations.ts";
import type { RoomAdd, RoomSkip } from "./store.ts";

// Which songs a room's skips keep out of its autoplay. Everything in
// fatigue.ts is a soft weight across huddles; this is the hard part, and it
// is decided per room from what the room actually did, every time autoplay
// picks, so a new add or skip changes the answer straight away.
//
// A song at most one person ever chose here, once someone skips it, is
// blocked: nobody else wanted it, so it is not the room's. A second person
// adding it lifts the block, and one person adding it again does not.
//
// A song several people chose is the room's own, so a skip only rests it: it
// is out of autoplay for a while after the latest skip, longer the more it
// has been skipped lately, and after that only fatigue weighs it down. Once as
// many people have skipped it as chose it, it is blocked like any other.

const day = 24 * 60 * 60_000;
export const cooldownMs = 7 * day;
export const cooldownCapMs = 56 * day;
// Skips older than this no longer lengthen the cooldown.
export const cooldownWindowMs = 180 * day;

// Whether a title and artist say which song this is, so another upload of a
// skipped song can be told by them. A missing title, or the placeholder for
// an unknown artist, would match every song that shares the rest.
export function namesSong(track: { title: string; artist: string }) {
  return (
    Boolean(track.title.trim()) &&
    Boolean(track.artist.trim()) &&
    track.artist !== "Unknown artist"
  );
}

export type AutoplayBlocks = {
  // One of each blocked song's names, for the mix to drop by name.
  tracks: { sourceId?: string; title: string; artist: string }[];
  sourceIds: Set<string>;
  keys: Set<string>;
};

// The names a row goes by: its source, and its title and artist when they
// say which song it is.
function namesOf(track: { sourceId?: string; title: string; artist: string }) {
  return [
    ...(track.sourceId ? [`source:${track.sourceId}`] : []),
    ...(namesSong(track) ? [`key:${trackKey(track.title, track.artist)}`] : []),
  ];
}

export function roomBlocks(
  skips: readonly RoomSkip[],
  adds: readonly RoomAdd[],
  options: { botUserId?: string; now?: number },
): AutoplayBlocks {
  const now = options.now ?? Date.now();
  // Rows that share a source or a name are the same song, so an upload
  // skipped under one name and added under another still adds up.
  const parent = new Map<string, string>();
  const find = (name: string): string => {
    const up = parent.get(name) ?? name;
    if (up === name) return name;
    const root = find(up);
    parent.set(name, root);
    return root;
  };
  const join = (names: string[]) => {
    for (const name of names) if (!parent.has(name)) parent.set(name, name);
    for (const name of names.slice(1)) {
      const [a, b] = [find(names[0]!), find(name)];
      if (a !== b) parent.set(b, a);
    }
  };
  for (const skip of skips) join(namesOf(skip));
  // Only adds of a skipped song matter, including adds that only share a name
  // with another add of it.
  const relevant: RoomAdd[] = [];
  let rest = [...adds];
  for (let grew = true; grew;) {
    grew = false;
    rest = rest.filter((add) => {
      const names = namesOf(add);
      if (!names.some((name) => parent.has(name))) return true;
      join(names);
      relevant.push(add);
      grew = true;
      return false;
    });
  }

  type Song = {
    names: Set<string>;
    tracks: AutoplayBlocks["tracks"];
    skippers: Set<string>;
    adders: Set<string>;
    skippedAt: number[];
  };
  const songs = new Map<string, Song>();
  const songOf = (names: string[]) => {
    const root = find(names[0]!);
    let song = songs.get(root);
    if (!song) {
      song = {
        names: new Set(),
        tracks: [],
        skippers: new Set(),
        adders: new Set(),
        skippedAt: [],
      };
      songs.set(root, song);
    }
    for (const name of names) song.names.add(name);
    return song;
  };
  for (const skip of skips) {
    const names = namesOf(skip);
    if (!names.length) continue;
    const song = songOf(names);
    // Skips whose skipper is unknown count as one more person.
    song.skippers.add(skip.userId ?? "");
    song.skippedAt.push(skip.skippedAt);
    if (
      !song.tracks.some(
        (track) =>
          track.sourceId === skip.sourceId &&
          track.title === skip.title &&
          track.artist === skip.artist,
      )
    )
      song.tracks.push({
        title: skip.title,
        artist: skip.artist,
        ...(skip.sourceId ? { sourceId: skip.sourceId } : {}),
      });
  }
  for (const add of relevant) {
    if (add.requesterId && add.requesterId === options.botUserId) continue;
    const names = namesOf(add);
    if (!names.length) continue;
    // Adders who asked to be forgotten count as one more person.
    songOf(names).adders.add(add.requesterId);
  }

  const blocks: AutoplayBlocks = {
    tracks: [],
    sourceIds: new Set(),
    keys: new Set(),
  };
  for (const song of songs.values()) {
    if (!song.skippedAt.length) continue;
    if (!isBlocked(song, now)) continue;
    blocks.tracks.push(...song.tracks);
    for (const name of song.names) {
      if (name.startsWith("source:"))
        blocks.sourceIds.add(name.slice("source:".length));
      else blocks.keys.add(name.slice("key:".length));
    }
  }
  return blocks;
}

function isBlocked(
  song: { adders: Set<string>; skippers: Set<string>; skippedAt: number[] },
  now: number,
) {
  if (song.adders.size <= 1 || song.skippers.size >= song.adders.size)
    return true;
  const recent = song.skippedAt.filter((at) => now - at < cooldownWindowMs);
  if (!recent.length) return false;
  const cooldown = Math.min(
    cooldownCapMs,
    cooldownMs * 2 ** (recent.length - 1),
  );
  return now - Math.max(...recent) < cooldown;
}
