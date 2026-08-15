import { expect, test } from "bun:test";
import { assertPublicUrl, TrackCatalog } from "./tracks.ts";

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
