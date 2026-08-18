import { expect, test } from "bun:test";
import { assertPublicUrl } from "./public-proxy.ts";
import { TrackCatalog } from "./tracks.ts";

test("rejects credentials and private destinations", async () => {
  await expect(
    assertPublicUrl(new URL("https://user:pass@example.com")),
  ).rejects.toThrow("Credentials");
  await expect(
    assertPublicUrl(new URL("http://127.0.0.1/test")),
  ).rejects.toThrow("Private");
});

test("uses search metadata without extracting it again", async () => {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
  });
  const track = {
    sourceInput: "https://music.youtube.com/watch?v=test",
    canonicalUrl: "https://music.youtube.com/watch?v=test",
    sourceId: "test",
    title: "Test",
    artist: "Artist",
    duration: 60,
  };
  Reflect.get(catalog, "references").set("reference", track);
  catalog.resolveUrl = async () => {
    throw new Error("unexpected extraction");
  };
  expect(await catalog.resolve("reference")).toBe(track);
});

test("limits track preparation globally and prioritizes queued work", async () => {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
  });
  const gates = new Map(
    ["a", "b", "c", "d"].map((id) => [id, Promise.withResolvers<void>()]),
  );
  const started: string[] = [];
  let active = 0;
  let maximum = 0;
  Reflect.set(
    catalog,
    "download",
    async (_track: unknown, _dir: string, id: string) => {
      started.push(id);
      maximum = Math.max(maximum, ++active);
      await gates.get(id)!.promise;
      active--;
      return id;
    },
  );
  const track = {
    sourceInput: "https://example.com",
    canonicalUrl: "https://example.com",
    sourceId: "test",
    title: "Test",
    artist: "Artist",
  };
  const work = [
    catalog.prepare(track, "data", "a"),
    catalog.prepare(track, "data", "b"),
    catalog.prepare(track, "data", "c"),
    catalog.prepare(track, "data", "d", undefined, 1),
  ];

  expect(started).toEqual(["a", "b"]);
  gates.get("a")!.resolve();
  await Bun.sleep(0);
  expect(started).toEqual(["a", "b", "d"]);
  expect(maximum).toBe(2);
  for (const id of ["b", "c", "d"]) gates.get(id)!.resolve();
  await Promise.all(work);
});

test("requests high-resolution YouTube Music artwork", async () => {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
  });
  Reflect.set(catalog, "music", {
    searchSongs: async () => [
      {
        videoId: "abcdefghijk",
        name: "Song",
        artist: { name: "Artist" },
        thumbnails: [
          {
            url: "https://yt3.googleusercontent.com/cover=w120-h120-l90-rj",
          },
        ],
      },
    ],
  });

  const [suggestion] = await catalog.suggestions("Song");
  expect(await catalog.resolve(suggestion!.value)).toEqual(
    expect.objectContaining({
      artwork: "https://yt3.googleusercontent.com/cover=w1200-h1200-l90-rj",
    }),
  );
});

test("only accepts video IDs from getUpNexts runtime data", async () => {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
  });
  Reflect.set(catalog, "music", {
    getUpNexts: async () => [
      { videoId: "abcdefghijk", title: 42 },
      { videoId: "too-short" },
      { videoId: 123 },
      null,
      { videoId: "ZYXWVUTSRQ-" },
    ],
  });
  expect(await catalog.upNextIds("seedseedsee")).toEqual([
    "abcdefghijk",
    "ZYXWVUTSRQ-",
  ]);
});

test("offers and expands albums only for bulk searches", async () => {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
  });
  Reflect.set(catalog, "music", {
    searchAlbums: async () => [
      {
        albumId: "album",
        name: "Album",
        artist: { name: "Artist" },
      },
    ],
    getAlbum: async () => ({
      songs: [
        {
          videoId: "abcdefghijk",
          name: "Song",
          artist: { name: "Artist" },
          album: { name: "Album" },
          duration: 60,
          thumbnails: [{ url: "art" }],
        },
      ],
    }),
  });

  const options = await catalog.suggestions("Album", {
    songs: false,
    bulk: true,
  });
  expect(options[0]?.text.text).toBe("Add album: Album — Artist");
  expect(await catalog.resolve(options[0]!.value)).toEqual([
    expect.objectContaining({
      sourceId: "abcdefghijk",
      title: "Song",
      album: "Album",
    }),
  ]);
});

test("expands remembered YouTube playlists", async () => {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
  });
  Reflect.set(catalog, "music", {
    getPlaylistVideos: async () => [
      {
        videoId: "abcdefghijk",
        name: "Song",
        artist: { name: "Artist" },
        duration: 60,
        thumbnails: [],
      },
    ],
  });
  Reflect.get(catalog, "references").set("playlist", {
    type: "playlist",
    id: "PL123",
    url: "https://youtube.com/playlist?list=PL123",
  });

  expect(await catalog.resolve("playlist")).toEqual([
    expect.objectContaining({
      sourceInput: "https://youtube.com/playlist?list=PL123",
      canonicalUrl: "https://music.youtube.com/watch?v=abcdefghijk",
    }),
  ]);
});
