import { expect, test } from "bun:test";
import {
  applySkipPenalties,
  mergeTaste,
  RecommendationCatalog,
  type RecommendationTracks,
  trackKey,
  weightedSample,
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

test("mergeTaste keeps artwork when a later contribution adds a source id", () => {
  const ranked = mergeTaste([
    {
      userId: "a",
      weight: 1,
      source: "lastfm",
      title: "Song",
      artist: "Band",
      artwork: "https://example.com/art.jpg",
      duration: 180,
    },
    {
      userId: "b",
      weight: 1,
      source: "huddlefm",
      title: "Song",
      artist: "Band",
      sourceId: "video123456",
      sourceInput: "https://music.youtube.com/watch?v=video123456",
      canonicalUrl: "https://music.youtube.com/watch?v=video123456",
    },
  ]);
  expect(ranked[0]).toMatchObject({
    sourceId: "video123456",
    artwork: "https://example.com/art.jpg",
    duration: 180,
  });
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
  store.connectLastFm("host", "last-user", "session-key");
  const searched: string[] = [];
  const lastFmCalls: string[] = [];
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
      lastFmCalls.push(url);
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
  expect(
    lastFmCalls.some(
      (url) =>
        url.includes("user.getTopTracks") ||
        url.includes("user.getRecentTracks"),
    ),
  ).toBe(true);
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

test("personal recommendations split discover from favourites and exclude recent adds", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Already Added", "Band", "alreadyadde");
  store.connectLastFm("host", "last-user", "session-key");
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) =>
        fakeSong(title, artist),
      upNextTracks: async () => [
        {
          sourceInput: "https://music.youtube.com/watch?v=nextnextnex",
          canonicalUrl: "https://music.youtube.com/watch?v=nextnextnex",
          sourceId: "nextnextnex",
          title: "Fresh Pick",
          artist: "Band",
        },
      ],
    },
    { lastFmApiKey: "key", random: sequence() },
    lastFmStub({
      "user.getTopTracks": {
        toptracks: {
          track: [
            {
              name: "Old Favourite",
              artist: { name: "Band" },
              playcount: "40",
            },
          ],
        },
      },
      "user.getRecentTracks": { recenttracks: { track: [] } },
      "user.getTopArtists": {
        topartists: { artist: [{ name: "Band", playcount: "80" }] },
      },
      "track.getSimilar": {
        similartracks: {
          track: [
            { name: "Old Favourite", artist: { name: "Band" } },
            { name: "New Sound", artist: { name: "Stranger" } },
          ],
        },
      },
      "artist.getSimilar": {
        similarartists: { artist: [{ name: "Neighbour", match: "0.9" }] },
      },
      "artist.getTopTracks": {
        toptracks: {
          track: [{ name: "Neighbour Hit", artist: { name: "Neighbour" } }],
        },
      },
    }),
  );
  await catalog.prefetchUser("host");
  const recs = catalog.userRecommendations("host");
  const titles = (tracks: { title: string }[]) => tracks.map((t) => t.title);
  expect(titles(recs.discover).sort()).toEqual([
    "Fresh Pick",
    "Neighbour Hit",
    "New Sound",
  ]);
  expect(titles(recs.favourites)).toEqual(["Old Favourite"]);
  expect(titles([...recs.discover, ...recs.favourites])).not.toContain(
    "Already Added",
  );
  expect(catalog.recommendation(recs.discover[0]!.id)?.title).toBe(
    recs.discover[0]!.title,
  );
  store.close();
});

test("the pool accumulates across builds and the sample is stable until then", async () => {
  const store = new Store(":memory:");
  store.connectLastFm("host", "last-user", "session-key");
  let round = 0;
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) =>
        fakeSong(title, artist),
      upNextTracks: async () => [],
    },
    { lastFmApiKey: "key", random: sequence() },
    lastFmStub({
      // Refreshing also refreshes taste, so the second build seeds from a
      // different track and asks Last.fm a new question.
      "user.getTopTracks": () => ({
        toptracks: {
          track: [
            {
              name: round === 0 ? "Seed" : "Seed Two",
              artist: { name: "Band" },
              playcount: "10",
            },
          ],
        },
      }),
      "user.getRecentTracks": { recenttracks: { track: [] } },
      "user.getTopArtists": { topartists: { artist: [] } },
      "track.getSimilar": () => ({
        similartracks: {
          track: [
            {
              name: round === 0 ? "First Wave" : "Second Wave",
              artist: { name: "Other" },
            },
          ],
        },
      }),
    }),
  );
  await catalog.prefetchUser("host");
  const first = catalog.userRecommendations("host");
  expect(first.discover.map((t) => t.title)).toEqual(["First Wave"]);
  expect(catalog.userRecommendations("host")).toEqual(first);
  round = 1;
  await catalog.refreshUser("host");
  const second = catalog.userRecommendations("host");
  expect(second.discover.map((t) => t.title).sort()).toEqual([
    "First Wave",
    "Second Wave",
  ]);
  const kept = second.discover.find((t) => t.title === "First Wave");
  expect(kept?.id).toBe(first.discover[0]!.id);
  expect(catalog.recommendation(kept!.id)?.title).toBe("First Wave");
  store.close();
});

test("a stale pool keeps serving while the rebuild is in flight", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Seed", "Band", "seedseedsee");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let builds = 0;
  const catalog = new RecommendationCatalog(store, {
    searchSong: async () => undefined,
    upNextTracks: async () => {
      builds++;
      if (builds > 1) await gate;
      return [
        {
          sourceInput: "https://music.youtube.com/watch?v=nextnextnex",
          canonicalUrl: "https://music.youtube.com/watch?v=nextnextnex",
          sourceId: "nextnextnex",
          title: "Fresh Pick",
          artist: "Other",
        },
      ];
    },
  });
  await catalog.prefetchUser("host");
  expect(catalog.userRecommendations("host").discover).toHaveLength(1);
  const rebuild = catalog.refreshUser("host");
  expect(catalog.userRecommendations("host").discover).toHaveLength(1);
  release();
  await rebuild;
  expect(catalog.userRecommendations("host").discover).toHaveLength(1);
  store.close();
});

test("session exclusions filter the sample and a depleted pool goes stale", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Seed", "Band", "seedseedsee");
  const catalog = new RecommendationCatalog(store, {
    searchSong: async () => undefined,
    upNextTracks: async () => [
      {
        sourceInput: "https://music.youtube.com/watch?v=nextnextnex",
        canonicalUrl: "https://music.youtube.com/watch?v=nextnextnex",
        sourceId: "nextnextnex",
        title: "Fresh Pick",
        artist: "Other",
      },
    ],
  });
  await catalog.prefetchUser("host");
  const pools = Reflect.get(catalog, "pools") as Map<
    string,
    { expires: number }
  >;
  expect(pools.get("host")!.expires).toBeGreaterThan(Date.now());
  expect(
    catalog.userRecommendations("host", ["nextnextnex"]).discover,
  ).toHaveLength(0);
  expect(pools.get("host")!.expires).toBe(0);
  await catalog.prefetchUser("host");
  expect(catalog.userRecommendations("host").discover).toHaveLength(0);
  store.close();
});

test("resolution reuses the memo and tracks this workspace has played", async () => {
  const store = new Store(":memory:");
  store.connectLastFm("host", "last-user", "session-key");
  addPastTrack(
    store,
    "someone",
    "Played Here",
    "Other",
    "playedhere1",
    "played",
  );
  const searched: string[] = [];
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) => {
        searched.push(title);
        return title === "Unfindable" ? undefined : fakeSong(title, artist);
      },
      upNextTracks: async () => [],
    },
    { lastFmApiKey: "key", random: sequence() },
    lastFmStub({
      "user.getTopTracks": {
        toptracks: {
          track: [{ name: "Seed", artist: { name: "Band" }, playcount: "10" }],
        },
      },
      "user.getRecentTracks": { recenttracks: { track: [] } },
      "user.getTopArtists": { topartists: { artist: [] } },
      "track.getSimilar": {
        similartracks: {
          track: [
            { name: "Played Here", artist: { name: "Other" } },
            { name: "Searched", artist: { name: "Other" } },
            { name: "Unfindable", artist: { name: "Other" } },
          ],
        },
      },
    }),
  );
  await catalog.prefetchUser("host");
  expect(searched.sort()).toEqual(["Searched", "Seed", "Unfindable"]);
  const recs = catalog.userRecommendations("host");
  expect(recs.discover.find((t) => t.title === "Played Here")?.sourceId).toBe(
    "playedhere1",
  );
  await catalog.refreshUser("host");
  expect(searched).toHaveLength(3);
  store.close();
});

test("weightedSample favours heavier items and never repeats", () => {
  const items = [
    { name: "heavy", weight: 90 },
    { name: "light", weight: 10 },
  ];
  let heavyFirst = 0;
  for (let i = 0; i < 200; i++) {
    const picked = weightedSample(items, 2, (item) => item.weight);
    expect(picked.map((item) => item.name).sort()).toEqual(["heavy", "light"]);
    if (picked[0]!.name === "heavy") heavyFirst++;
  }
  expect(heavyFirst).toBeGreaterThan(150);
  expect(weightedSample(items, 5, (item) => item.weight)).toHaveLength(2);
  expect(weightedSample([], 3, () => 1)).toEqual([]);
});

test("a discovery turn leads huddle mix with tracks nobody has listened to", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Shared", "Band", "sharedshare");
  addPastTrack(store, "guest", "Shared", "Band", "sharedshare");
  store.connectLastFm("host", "last-user", "session-key");
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) =>
        fakeSong(title, artist),
      upNextTracks: async () => [],
    },
    { lastFmApiKey: "key", random: sequence() },
    lastFmStub({
      "user.getTopTracks": { toptracks: { track: [] } },
      "user.getRecentTracks": { recenttracks: { track: [] } },
      "user.getTopArtists": { topartists: { artist: [] } },
      "track.getSimilar": {
        similartracks: {
          track: [{ name: "Unheard", artist: { name: "Stranger" } }],
        },
      },
      "artist.getSimilar": { similarartists: { artist: [] } },
    }),
  );
  const nowPlaying = { title: "Now", artist: "Band", sourceId: "nownownownow" };
  const usual = await catalog.autoplayCandidates({
    userIds: ["host", "guest"],
    nowPlaying,
  });
  expect(usual[0]?.metadata.title).toBe("Shared");
  expect(usual[0]?.discovery).toBe(false);
  const discovery = await catalog.autoplayCandidates({
    userIds: ["host", "guest"],
    nowPlaying,
    discover: true,
  });
  expect(discovery[0]?.metadata.title).toBe("Unheard");
  expect(discovery[0]?.discovery).toBe(true);
  expect(discovery.some((track) => track.metadata.title === "Shared")).toBe(
    true,
  );
  store.close();
});

test("a refresh during an in-flight build still rebuilds afterwards", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Seed", "Band", "seedseedsee");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let builds = 0;
  const catalog = new RecommendationCatalog(store, {
    searchSong: async () => undefined,
    upNextTracks: async () => {
      builds++;
      if (builds === 1) await gate;
      return [];
    },
  });
  const first = catalog.prefetchUser("host");
  const refreshed = catalog.refreshUser("host");
  release();
  await first;
  await refreshed;
  expect(builds).toBe(2);
  const pools = Reflect.get(catalog, "pools") as Map<
    string,
    { expires: number; dirty?: boolean }
  >;
  expect(pools.get("host")!.expires).toBeGreaterThan(Date.now());
  expect(pools.get("host")!.dirty).toBeFalsy();
  store.close();
});

test("a failed Last.fm lookup is retried soon while not-found sticks", async () => {
  const store = new Store(":memory:");
  store.connectLastFm("host", "last-user", "session-key");
  let similarCalls = 0;
  let topTrackCalls = 0;
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) =>
        fakeSong(title, artist),
      upNextTracks: async () => [],
    },
    { lastFmApiKey: "key", random: sequence() },
    (async (input) => {
      const url = new URL(String(input));
      const method = url.searchParams.get("method");
      if (method === "user.getTopTracks")
        return Response.json({
          toptracks: {
            track: [{ name: "Seed", artist: { name: "Band" }, playcount: "5" }],
          },
        });
      if (method === "user.getTopArtists")
        return Response.json({
          topartists: { artist: [{ name: "Ghost", playcount: "9" }] },
        });
      if (method === "track.getSimilar") {
        similarCalls++;
        if (similarCalls === 1) return new Response("", { status: 503 });
        return Response.json({
          similartracks: {
            track: [{ name: "Recovered", artist: { name: "Other" } }],
          },
        });
      }
      if (method === "artist.getSimilar")
        return Response.json({
          similarartists: { artist: [{ name: "Neighbour", match: "0.8" }] },
        });
      if (method === "artist.getTopTracks") {
        topTrackCalls++;
        return Response.json({
          error: 6,
          message: "The artist you supplied could not be found",
        });
      }
      return Response.json({});
    }) as typeof fetch,
  );
  await catalog.prefetchUser("host");
  expect(catalog.userRecommendations("host").discover).toHaveLength(0);
  expect(similarCalls).toBe(1);
  expect(topTrackCalls).toBe(1);
  // Still within the failure TTL: no retry yet.
  await catalog.refreshUser("host");
  expect(similarCalls).toBe(1);
  // Once the short failure TTL lapses the outage is retried, but the
  // not-found answer is kept for the full TTL.
  const lookups = Reflect.get(catalog, "lookups") as {
    entries: Map<string, { expires: number }>;
  };
  for (const [key, entry] of Reflect.get(lookups, "entries") as Map<
    string,
    { expires: number }
  >)
    if (key.startsWith("similar\0")) entry.expires = 0;
  await catalog.refreshUser("host");
  expect(similarCalls).toBe(2);
  expect(topTrackCalls).toBe(1);
  expect(
    catalog.userRecommendations("host").discover.map((t) => t.title),
  ).toEqual(["Recovered"]);
  store.close();
});

test("an evicted recommendation id stays resolvable for a grace period", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Seed", "Band", "seedseedsee");
  let round = 0;
  const catalog = new RecommendationCatalog(store, {
    searchSong: async () => undefined,
    upNextTracks: async () => [
      round === 0
        ? {
            sourceInput: "https://music.youtube.com/watch?v=firstfirst1",
            canonicalUrl: "https://music.youtube.com/watch?v=firstfirst1",
            sourceId: "firstfirst1",
            title: "First",
            artist: "Other",
          }
        : {
            sourceInput: "https://music.youtube.com/watch?v=secondsecon",
            canonicalUrl: "https://music.youtube.com/watch?v=secondsecon",
            sourceId: "secondsecon",
            title: "Second",
            artist: "Other",
          },
    ],
  });
  await catalog.prefetchUser("host");
  const first = catalog.userRecommendations("host").discover[0]!;
  expect(first.title).toBe("First");
  // The session played it, so the next build drops it from the pool.
  catalog.userRecommendations("host", [first.sourceId]);
  round = 1;
  await catalog.prefetchUser("host");
  expect(
    catalog.userRecommendations("host").discover.map((t) => t.title),
  ).toEqual(["Second"]);
  expect(catalog.recommendation(first.id)?.title).toBe("First");
  const evicted = Reflect.get(catalog, "evicted") as Map<string, number>;
  evicted.set(first.id, Date.now() - 31 * 60_000);
  await catalog.refreshUser("host");
  expect(catalog.recommendation(first.id)).toBeUndefined();
  store.close();
});

test("re-recommended tracks are bumped, not stacked, and newcomers keep a share", async () => {
  const store = new Store(":memory:");
  store.connectLastFm("host", "last-user", "session-key");
  let round = 0;
  const incumbents = Array.from({ length: 35 }, (_, i) => ({
    name: `Incumbent ${i + 1}`,
    artist: { name: "Regular" },
    match: "1.0",
  }));
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) =>
        fakeSong(title, artist),
      upNextTracks: async () => [],
    },
    { lastFmApiKey: "key", random: sequence() },
    lastFmStub({
      // A fresh seed each round so getSimilar is asked again rather than
      // served from the memo.
      "user.getTopTracks": () => ({
        toptracks: {
          track: [
            {
              name: `Seed ${round}`,
              artist: { name: "Band" },
              playcount: "10",
            },
          ],
        },
      }),
      "user.getRecentTracks": { recenttracks: { track: [] } },
      "user.getTopArtists": { topartists: { artist: [] } },
      "track.getSimilar": () => ({
        similartracks: {
          track:
            round < 2
              ? incumbents
              : [
                  ...incumbents,
                  { name: "Newcomer", artist: { name: "Fresh" }, match: "0.1" },
                ],
        },
      }),
    }),
  );
  const pools = Reflect.get(catalog, "pools") as Map<
    string,
    { value: { discover: { score: number; metadata: { title: string } }[] } }
  >;
  await catalog.prefetchUser("host");
  for (round = 1; round < 3; round++) await catalog.refreshUser("host");
  const discover = pools.get("host")!.value.discover;
  expect(discover).toHaveLength(30);
  const incumbent = discover.find(
    (track) => track.metadata.title === "Incumbent 1",
  );
  // Three builds at 2.5 each: stacking would reach 5.5, bumping stays put.
  expect(incumbent!.score).toBeLessThanOrEqual(1.5 * 2.5);
  expect(discover.some((track) => track.metadata.title === "Newcomer")).toBe(
    true,
  );
  store.close();
});

test("a discover track the user has since listened to leaves the pool", async () => {
  const store = new Store(":memory:");
  store.connectLastFm("host", "last-user", "session-key");
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) =>
        fakeSong(title, artist),
      upNextTracks: async () => [],
    },
    { lastFmApiKey: "key", random: sequence() },
    lastFmStub({
      "user.getTopTracks": {
        toptracks: {
          track: [{ name: "Seed", artist: { name: "Band" }, playcount: "10" }],
        },
      },
      "user.getRecentTracks": { recenttracks: { track: [] } },
      "user.getTopArtists": { topartists: { artist: [] } },
      "track.getSimilar": {
        similartracks: {
          track: [{ name: "New Sound", artist: { name: "Stranger" } }],
        },
      },
    }),
  );
  await catalog.prefetchUser("host");
  expect(
    catalog.userRecommendations("host").discover.map((t) => t.title),
  ).toEqual(["New Sound"]);
  addPastTrack(store, "host", "New Sound", "Stranger", "newsoundnew");
  await catalog.refreshUser("host");
  const recs = catalog.userRecommendations("host");
  expect(recs.discover.map((t) => t.title)).not.toContain("New Sound");
  expect(recs.favourites.map((t) => t.title)).not.toContain("New Sound");
  store.close();
});

test("similarity-only tracks do not count as seeds in huddle mix", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Host Song", "Regular", "hostsonghos");
  store.connectLastFm("host", "last-user", "session-key");
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) =>
        fakeSong(title, artist),
      upNextTracks: async () => [
        {
          sourceInput: "https://music.youtube.com/watch?v=everywhere1",
          canonicalUrl: "https://music.youtube.com/watch?v=everywhere1",
          sourceId: "everywhere1",
          title: "Everywhere",
          artist: "Stranger",
        },
      ],
    },
    { lastFmApiKey: "key", random: sequence() },
    lastFmStub({
      "user.getTopTracks": { toptracks: { track: [] } },
      "user.getRecentTracks": { recenttracks: { track: [] } },
      "user.getTopArtists": { topartists: { artist: [] } },
      "track.getSimilar": {
        similartracks: {
          track: [
            { name: "Everywhere", artist: { name: "Stranger" }, match: "0.1" },
          ],
        },
      },
      "artist.getSimilar": { similarartists: { artist: [] } },
    }),
  );
  const candidates = await catalog.autoplayCandidates({
    userIds: ["host"],
    nowPlaying: { title: "Now", artist: "Band", sourceId: "nownownownow" },
  });
  expect(candidates.map((track) => track.metadata.title)).toEqual([
    "Host Song",
    "Everywhere",
  ]);
  expect(candidates[1]?.seedCount).toBe(1);
  store.close();
});

test("similar tracks are weighted by Last.fm match rather than rank", async () => {
  const store = new Store(":memory:");
  store.connectLastFm("host", "last-user", "session-key");
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) =>
        fakeSong(title, artist),
      upNextTracks: async () => [],
    },
    { lastFmApiKey: "key", random: sequence() },
    lastFmStub({
      "user.getTopTracks": {
        toptracks: {
          track: [{ name: "Seed", artist: { name: "Band" }, playcount: "10" }],
        },
      },
      "user.getRecentTracks": { recenttracks: { track: [] } },
      "user.getTopArtists": { topartists: { artist: [] } },
      "track.getSimilar": {
        similartracks: {
          track: [
            { name: "Weak", artist: { name: "Other" }, match: "0.2" },
            { name: "Strong", artist: { name: "Other" }, match: "0.9" },
          ],
        },
      },
    }),
  );
  await catalog.prefetchUser("host");
  const pools = Reflect.get(catalog, "pools") as Map<
    string,
    { value: { discover: { score: number; metadata: { title: string } }[] } }
  >;
  const discover = pools.get("host")!.value.discover;
  expect(discover.map((track) => track.metadata.title)).toEqual([
    "Strong",
    "Weak",
  ]);
  expect(discover[0]!.score).toBeCloseTo(2.25);
  expect(discover[1]!.score).toBeCloseTo(0.5);
  store.close();
});

test("ListenBrainz recommendations ask for artist metadata and route heard ones to favourites", async () => {
  const store = new Store(":memory:");
  store.setListenBrainzToken("host", "", "lb-user");
  const urls: string[] = [];
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) =>
        fakeSong(title, artist),
      upNextTracks: async () => [],
    },
    { random: sequence() },
    (async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/cf/recommendation/"))
        return Response.json({
          payload: {
            mbids: [
              {
                recording_mbid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                score: 1.4,
                latest_listened_at: "2026-09-01T00:00:00.000Z",
              },
              {
                recording_mbid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                score: 1.1,
                latest_listened_at: null,
              },
            ],
          },
        });
      if (url.includes("/metadata/recording/"))
        return Response.json({
          "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": {
            recording: { name: "Heard It" },
            artist: { name: "Band & Friend", artists: [{ name: "Band" }] },
            release: { name: "Album" },
          },
          "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb": {
            recording: { name: "Brand New" },
            artist: { name: "Stranger", artists: [{ name: "Stranger" }] },
          },
        });
      return Response.json({ payload: {} });
    }) as typeof fetch,
  );
  await catalog.prefetchUser("host");
  const metadata = urls.find((url) => url.includes("/metadata/recording/"));
  expect(metadata).toContain("inc=artist%20release");
  const recs = catalog.userRecommendations("host");
  expect(recs.discover.map((t) => t.title)).toEqual(["Brand New"]);
  expect(recs.favourites.map((t) => t.title)).toEqual(["Heard It"]);
  expect(recs.discover[0]?.sources).toEqual(["listenbrainz"]);
  store.close();
});

test("huddle mix lifts an underserved listener's taste", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Host Pick", "Host Band", "hostpick001");
  addPastTrack(store, "guest", "Guest Pick", "Guest Band", "guestpick01");
  const catalog = new RecommendationCatalog(store, {
    searchSong: async () => undefined,
    upNextTracks: async () => [],
  });
  const even = await catalog.autoplayCandidates({
    userIds: ["host", "guest"],
  });
  expect(even.map((c) => c.metadata.title).sort()).toEqual([
    "Guest Pick",
    "Host Pick",
  ]);
  expect(even[0]?.score).toBe(even[1]?.score);
  const skewed = await catalog.autoplayCandidates({
    userIds: ["host", "guest"],
    credited: { host: 4, guest: 0 },
  });
  expect(skewed[0]?.metadata.title).toBe("Guest Pick");
  expect(skewed[0]!.score).toBeGreaterThan(skewed[1]!.score);
  expect(skewed[0]?.listenerIds).toEqual(["guest"]);
  // Being well served never costs anything.
  expect(skewed[1]?.score).toBe(even[1]?.score);
  store.close();
});

test("a discovery turn draws on the listeners' own Discover pools", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Seed", "Band", "seedseedsee");
  addPastTrack(store, "guest", "Seed", "Band", "seedseedsee");
  const catalog = new RecommendationCatalog(store, {
    searchSong: async (title: string, artist: string) =>
      fakeSong(title, artist),
    upNextTracks: async (id: string) =>
      id === "seedseedsee"
        ? [
            {
              sourceInput: "https://music.youtube.com/watch?v=pooledpick1",
              canonicalUrl: "https://music.youtube.com/watch?v=pooledpick1",
              sourceId: "pooledpick1",
              title: "Pooled Pick",
              artist: "Stranger",
            },
          ]
        : [],
  });
  await Promise.all([
    catalog.prefetchUser("host"),
    catalog.prefetchUser("guest"),
  ]);
  const discovery = await catalog.autoplayCandidates({
    userIds: ["host", "guest"],
    nowPlaying: { title: "Now", artist: "Other", sourceId: "nownownownow" },
    discover: true,
  });
  expect(discovery[0]?.metadata.title).toBe("Pooled Pick");
  expect(discovery[0]?.discovery).toBe(true);
  expect(discovery[0]?.listenerIds?.sort()).toEqual(["guest", "host"]);
  // Nobody has played it, so it is a single seed despite two listeners.
  expect(discovery[0]?.seedCount).toBe(1);
  store.close();
});

test("seeds count listeners who played a track, not who were merely recommended it", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Shared", "Band", "sharedshare");
  addPastTrack(store, "guest", "Shared", "Band", "sharedshare");
  addPastTrack(store, "guest", "Guest Only", "Solo", "guestonly01");
  const catalog = new RecommendationCatalog(store, {
    searchSong: async (title: string, artist: string) =>
      fakeSong(title, artist),
    upNextTracks: async () => [],
  });
  const candidates = await catalog.autoplayCandidates({
    userIds: ["host", "guest"],
  });
  const shared = candidates.find((c) => c.metadata.title === "Shared");
  const solo = candidates.find((c) => c.metadata.title === "Guest Only");
  expect(shared?.seedCount).toBe(2);
  expect(solo?.seedCount).toBe(1);
  store.close();
});

test("the same-artist segue boost turns into damping after a run", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "More Band", "Band", "morebandxxx");
  addPastTrack(store, "host", "Something Else", "Other", "somethingel");
  const catalog = new RecommendationCatalog(store, {
    searchSong: async () => undefined,
    upNextTracks: async () => [],
  });
  const nowPlaying = { title: "Now", artist: "Band", sourceId: "nownownownow" };
  const first = await catalog.autoplayCandidates({
    userIds: ["host"],
    nowPlaying,
    artistRun: 1,
  });
  expect(first[0]?.metadata.title).toBe("More Band");
  const run = await catalog.autoplayCandidates({
    userIds: ["host"],
    nowPlaying,
    artistRun: 2,
  });
  expect(run[0]?.metadata.title).toBe("Something Else");
  store.close();
});

test("penalize pushes a skipped track and its artist down in the skipper's pools", async () => {
  const store = new Store(":memory:");
  addPastTrack(store, "host", "Seed", "Band", "seedseedsee");
  const catalog = new RecommendationCatalog(store, {
    searchSong: async () => undefined,
    upNextTracks: async () => [
      {
        sourceInput: "https://music.youtube.com/watch?v=skipmeplzxx",
        canonicalUrl: "https://music.youtube.com/watch?v=skipmeplzxx",
        sourceId: "skipmeplzxx",
        title: "Skip Me",
        artist: "Noisy",
      },
      {
        sourceInput: "https://music.youtube.com/watch?v=samebandxxx",
        canonicalUrl: "https://music.youtube.com/watch?v=samebandxxx",
        sourceId: "samebandxxx",
        title: "Same Band",
        artist: "Noisy",
      },
      {
        sourceInput: "https://music.youtube.com/watch?v=untouchedxx",
        canonicalUrl: "https://music.youtube.com/watch?v=untouchedxx",
        sourceId: "untouchedxx",
        title: "Untouched",
        artist: "Calm",
      },
    ],
  });
  await catalog.prefetchUser("host");
  const pools = Reflect.get(catalog, "pools") as Map<
    string,
    { value: { discover: { metadata: { title: string }; score: number }[] } }
  >;
  const before = Object.fromEntries(
    pools.get("host")!.value.discover.map((t) => [t.metadata.title, t.score]),
  );
  expect(
    catalog.userRecommendations("host").discover.map((t) => t.title),
  ).toContain("Skip Me");
  catalog.penalize("host", { title: "Skip Me", artist: "Noisy" });
  const after = Object.fromEntries(
    pools.get("host")!.value.discover.map((t) => [t.metadata.title, t.score]),
  );
  expect(after["Skip Me"]).toBeCloseTo(before["Skip Me"]! * 0.2);
  expect(after["Same Band"]).toBeCloseTo(before["Same Band"]! * 0.6);
  expect(after["Untouched"]).toBe(before["Untouched"]!);
  expect(
    catalog.userRecommendations("host").discover.map((t) => t.title),
  ).not.toContain("Skip Me");
  catalog.penalize("nobody", { title: "Skip Me", artist: "Noisy" });
  store.close();
});

test("trackKey ignores punctuation and case", () => {
  expect(trackKey("Karma Police!", "Radiohead")).toBe(
    trackKey("karma police", "RADIOHEAD"),
  );
});

test("trackKey matches the same song across featured-artist credit styles", () => {
  const key = trackKey("STAY", "The Kid LAROI");
  expect(trackKey("STAY (with Justin Bieber)", "The Kid LAROI")).toBe(key);
  expect(trackKey("STAY", "The Kid LAROI & Justin Bieber")).toBe(key);
  expect(
    trackKey("STAY feat. Justin Bieber", "The Kid LAROI, Justin Bieber"),
  ).toBe(key);
  expect(trackKey("Tommy Lee [ft. Post Malone]", "Tyla Yaweh")).toBe(
    trackKey("Tommy Lee", "Tyla Yaweh"),
  );
  expect(trackKey("Feat", "Band")).toBe(trackKey("feat", "band"));
  expect(trackKey("Song (Remix)", "Band")).not.toBe(trackKey("Song", "Band"));
});

test("all-time history keeps old favourites out of Discover without scoring them", async () => {
  const store = new Store(":memory:");
  store.connectLastFm("host", "last-user", "session-key");
  const catalog = new RecommendationCatalog(
    store,
    {
      searchSong: async (title: string, artist: string) =>
        fakeSong(title, artist),
      upNextTracks: async () => [],
    },
    { lastFmApiKey: "key", random: sequence() },
    lastFmStub({
      "user.getTopTracks": () => ({
        toptracks: { track: [] },
      }),
      "user.getRecentTracks": { recenttracks: { track: [] } },
      "user.getTopArtists": { topartists: { artist: [] } },
    }),
  );
  // The 3-month call and the all-time call share a method name; answer by
  // period instead.
  Reflect.set(catalog, "request", (async (input: string) => {
    const url = new URL(String(input));
    const method = url.searchParams.get("method");
    const period = url.searchParams.get("period");
    if (method === "user.getTopTracks" && period === "overall")
      return Response.json({
        toptracks: {
          track: [{ name: "Old Flame", artist: { name: "Band" } }],
        },
      });
    if (method === "user.getTopTracks")
      return Response.json({
        toptracks: {
          track: [{ name: "Seed", artist: { name: "Band" }, playcount: "5" }],
        },
      });
    if (method === "track.getSimilar")
      return Response.json({
        similartracks: {
          track: [
            { name: "Old Flame (with Guest)", artist: { name: "Band" } },
            { name: "Truly New", artist: { name: "Other" } },
          ],
        },
      });
    return Response.json({});
  }) as typeof fetch);
  await catalog.prefetchUser("host");
  const recs = catalog.userRecommendations("host");
  expect(recs.discover.map((t) => t.title)).toEqual(["Truly New"]);
  expect(recs.favourites.map((t) => t.title).sort()).toEqual([
    "Old Flame (with Guest)",
    "Seed",
  ]);
  store.close();
});

function fakeSong(title: string, artist: string) {
  const id = title
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 11)
    .padEnd(11, "x");
  return {
    sourceInput: `https://music.youtube.com/watch?v=${id}`,
    canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
    sourceId: id,
    title,
    artist,
  };
}

// A deterministic stand-in for Math.random that walks a fixed cycle, so
// weighted sampling is reproducible.
function sequence(values = [0.1, 0.5, 0.9, 0.3, 0.7]) {
  let index = 0;
  return () => values[index++ % values.length]!;
}

function lastFmStub(
  responses: Record<string, object | (() => object)>,
): typeof fetch {
  return (async (input) => {
    const url = new URL(String(input));
    const method = url.searchParams.get("method") ?? "";
    const response = responses[method];
    if (!response) return new Response("{}", { status: 404 });
    const body = typeof response === "function" ? response() : response;
    return Response.json(body);
  }) as typeof fetch;
}

function addPastTrack(
  store: Store,
  userId: string,
  title: string,
  artist: string,
  sourceId: string,
  status = "played",
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
    status,
  });
}
