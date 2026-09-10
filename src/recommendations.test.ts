import { expect, test } from "bun:test";
import {
  applySkipPenalties,
  mergeTaste,
  RecommendationCatalog,
  type RecommendationTracks,
  trackKey,
} from "./recommendations.ts";
import { Store } from "./store.ts";

test("mergeTaste boosts tracks shared by more than one listener", () => {
  const ranked = mergeTaste([
    {
      userId: "a",
      weight: 2,
      source: "huddlefm",
      title: "Shared",
      artist: "Band",
    },
    {
      userId: "b",
      weight: 2,
      source: "lastfm",
      title: "Shared",
      artist: "Band",
    },
    {
      userId: "a",
      weight: 5,
      source: "lastfm",
      title: "Solo",
      artist: "Outlier",
    },
  ]);
  expect(ranked[0]).toMatchObject({ title: "Shared", artist: "Band" });
  expect(ranked[0]?.userIds).toEqual(["a", "b"]);
  expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
});

test("skip penalties lower exact tracks and skipped artists", () => {
  const ranked = applySkipPenalties(
    mergeTaste([
      {
        userId: "a",
        weight: 10,
        source: "lastfm",
        title: "Skip Me",
        artist: "Noisy",
        sourceId: "skipskipski",
      },
      {
        userId: "a",
        weight: 3,
        source: "lastfm",
        title: "Keep",
        artist: "Quiet",
      },
    ]),
    { sourceIds: ["skipskipski"], artists: ["Noisy"] },
  );
  expect(ranked[0]).toMatchObject({ title: "Keep", artist: "Quiet" });
});

test("huddle mix omits opted-out listeners and survives a Last.fm failure", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Host Song", "Host Artist", "hosthosthos");
  addPastTrack(store, "guest", "Guest Song", "Guest Artist", "guestguestg");
  store.setHuddleMixOptIn("guest", false);
  const searched: string[] = [];
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) => {
        searched.push(`${title} ${artist}`);
        return {
          sourceInput: `https://music.youtube.com/watch?v=${title.slice(0, 11).padEnd(11, "x")}`,
          canonicalUrl: `https://music.youtube.com/watch?v=${title.slice(0, 11).padEnd(11, "x")}`,
          sourceId: title.slice(0, 11).padEnd(11, "x"),
          title,
          artist,
        };
      },
      upNextTracks: async () => [],
    } satisfies RecommendationTracks,
    { lastFmApiKey: "key" },
    (async (input) => {
      const url = String(input);
      if (
        url.includes("user.getTopTracks") ||
        url.includes("user.getRecentTracks")
      )
        throw new Error("Last.fm down");
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
  );
  const candidates = await catalog.autoplayCandidates({
    userIds: ["host", "guest"],
  });
  expect(candidates.map((track) => track.metadata.title)).toEqual([
    "Host Song",
  ]);
  expect(searched.join(" ")).not.toContain("Guest Song");
  store.close();
});

test("huddle mix treats YouTube up-next as a light nudge", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Shared", "Band", "sharedshared");
  addPastTrack(store, "guest", "Shared", "Band", "sharedshared");
  const catalog = new RecommendationCatalog(store, {
    searchSong: async (title: string, artist: string) => ({
      sourceInput: `https://music.youtube.com/watch?v=${title.slice(0, 11).padEnd(11, "x")}`,
      canonicalUrl: `https://music.youtube.com/watch?v=${title.slice(0, 11).padEnd(11, "x")}`,
      sourceId: title.slice(0, 11).padEnd(11, "x"),
      title,
      artist,
    }),
    upNextTracks: async () => [
      {
        sourceInput: "https://music.youtube.com/watch?v=upnextnudge",
        canonicalUrl: "https://music.youtube.com/watch?v=upnextnudge",
        sourceId: "upnextnudge",
        title: "Up Next Only",
        artist: "Other",
      },
    ],
  });
  const candidates = await catalog.autoplayCandidates({
    userIds: ["host", "guest"],
    nowPlaying: {
      title: "Now Playing",
      artist: "Band",
      sourceId: "nowplaying0",
    },
  });
  expect(candidates[0]?.metadata).toMatchObject({
    title: "Shared",
    artist: "Band",
  });
  expect(
    candidates.some((track) => track.metadata.title === "Up Next Only"),
  ).toBe(true);
  store.close();
});

test("personal recommendations exclude songs the user already added", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Already Added", "Band", "alreadyadde");
  const catalog = new RecommendationCatalog(store, {
    searchSong: async (title: string, artist: string) => ({
      sourceInput: "https://music.youtube.com/watch?v=recommend1",
      canonicalUrl: "https://music.youtube.com/watch?v=recommend1",
      sourceId: "recommend1",
      title,
      artist,
    }),
    upNextTracks: async () => [
      {
        sourceInput: "https://music.youtube.com/watch?v=nextnextnex",
        canonicalUrl: "https://music.youtube.com/watch?v=nextnextnex",
        sourceId: "nextnextnex",
        title: "Fresh Pick",
        artist: "Band",
      },
    ],
  });
  await catalog.prefetchUser("host");
  const recs = catalog.userRecommendations("host");
  expect(recs.some((track) => track.title === "Already Added")).toBe(false);
  expect(recs.some((track) => track.title === "Fresh Pick")).toBe(true);
  expect(catalog.recommendation(recs[0]!.id)?.title).toBe("Fresh Pick");
  store.close();
});

test("trackKey ignores punctuation and case", () => {
  expect(trackKey("Karma Police!", "Radiohead")).toBe(
    trackKey("karma police", "RADIOHEAD"),
  );
});

function addPastTrack(
  store: Store,
  userId: string,
  title: string,
  artist: string,
  sourceId: string,
) {
  store.createSession({
    id: `session-${userId}-${sourceId}`,
    huddleId: "huddle",
    callId: "call",
    channelId: "channel",
    threadTs: "1.0",
    creatorId: userId,
    hostId: userId,
    volume: 0.6,
  });
  store.addTrack({
    id: `${userId}-${sourceId}`,
    sessionId: `session-${userId}-${sourceId}`,
    requesterId: userId,
    sourceInput: `https://example.com/${sourceId}`,
    canonicalUrl: `https://example.com/${sourceId}`,
    sourceId,
    title,
    artist,
    status: "played",
  });
}
