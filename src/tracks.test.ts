import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPublicUrl } from "./public-proxy.ts";
import {
  applyEmbeddedMetadata,
  extractorFailure,
  isExpectedTrackFailure,
  looksLikeFilenameTitle,
  metadataLooksWeak,
  navidromeShare,
  parseNavidromeShareInfo,
  probeEmbeddedMetadata,
  publicArtworkUrl,
  shouldProbeEmbeddedMetadata,
  TrackCatalog,
  trackFailureDetail,
  transitionData,
  type TrackMetadata,
} from "./tracks.ts";

test("detects filename-like titles for direct media links", () => {
  expect(
    looksLikeFilenameTitle(
      "SoundHelix-Song-1",
      "https://example.com/audio/SoundHelix-Song-1.mp3",
      "SoundHelix-Song-1",
    ),
  ).toBe(true);
  expect(
    looksLikeFilenameTitle("track.mp3", "https://example.com/files/track.mp3"),
  ).toBe(true);
  expect(
    looksLikeFilenameTitle(
      "Real Song Title",
      "https://example.com/audio/SoundHelix-Song-1.mp3",
    ),
  ).toBe(false);
  expect(
    shouldProbeEmbeddedMetadata(
      {
        title: "SoundHelix-Song-1",
        artist: "Unknown artist",
        canonicalUrl: "https://example.com/SoundHelix-Song-1.mp3",
        sourceId: "SoundHelix-Song-1",
      },
      "generic",
    ),
  ).toBe(true);
  expect(
    shouldProbeEmbeddedMetadata(
      {
        title: "Real Song Title",
        artist: "Known Artist",
        canonicalUrl: "https://music.youtube.com/watch?v=abcdefghijk",
        sourceId: "abcdefghijk",
      },
      "youtube",
    ),
  ).toBe(false);
  expect(
    metadataLooksWeak({
      title: "Real Song Title",
      artist: "Unknown artist",
      canonicalUrl: "https://example.com/song.mp3",
      sourceId: "song",
    }),
  ).toBe(true);
  expect(
    metadataLooksWeak({
      title: "Real Song Title",
      artist: "Known Artist",
      canonicalUrl: "https://example.com/song.mp3",
      sourceId: "song",
    }),
  ).toBe(false);
});

test("prefers embedded tags over filename metadata", () => {
  const track: TrackMetadata = applyEmbeddedMetadata(
    {
      sourceInput: "https://example.com/SoundHelix-Song-1.mp3",
      canonicalUrl: "https://example.com/SoundHelix-Song-1.mp3",
      sourceId: "SoundHelix-Song-1",
      title: "SoundHelix-Song-1",
      artist: "Unknown artist",
    },
    {
      title: "Helix One",
      artist: "SoundHelix",
      album: "Demos",
      duration: 120,
    },
  );
  expect(track).toMatchObject({
    title: "Helix One",
    artist: "SoundHelix",
    album: "Demos",
    duration: 120,
  });
  applyEmbeddedMetadata(track, {
    title: "Ignored",
    artist: "Also Ignored",
    album: "Also Ignored",
  });
  expect(track.title).toBe("Helix One");
  expect(track.artist).toBe("SoundHelix");
  expect(track.album).toBe("Demos");
});

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "reads embedded tags from local files and proxied remote media",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-tags-"));
    const filePath = join(directory, "fixture.mp3");
    const proxy = createServer();
    try {
      const encoded = Bun.spawnSync([
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        "-metadata",
        "title=Fixture Title",
        "-metadata",
        "artist=Fixture Artist",
        "-metadata",
        "album=Fixture Album",
        filePath,
      ]);
      expect(encoded.exitCode).toBe(0);
      expect(await probeEmbeddedMetadata(filePath)).toMatchObject({
        title: "Fixture Title",
        artist: "Fixture Artist",
        album: "Fixture Album",
      });
      const media = await readFile(filePath);
      const requests: string[] = [];
      proxy.on("request", (request, response) => {
        requests.push(request.url ?? "");
        response.writeHead(200, {
          "content-length": media.byteLength,
          "content-type": "audio/mpeg",
        });
        response.end(media);
      });
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", resolve);
      });
      const address = proxy.address();
      if (!address || typeof address === "string")
        throw new Error("Test proxy is not listening");
      const remote = "http://93.184.216.34/fixture.mp3";
      expect(await probeEmbeddedMetadata(remote)).toEqual({});
      expect(requests).toEqual([]);
      expect(
        await probeEmbeddedMetadata(
          remote,
          undefined,
          `http://127.0.0.1:${address.port}`,
        ),
      ).toMatchObject({
        title: "Fixture Title",
        artist: "Fixture Artist",
        album: "Fixture Album",
      });
      expect(requests.map((request) => new URL(request).href)).toEqual([
        remote,
      ]);
    } finally {
      if (proxy.listening)
        await new Promise<void>((resolve, reject) =>
          proxy.close((error) => (error ? reject(error) : resolve())),
        );
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("gives unplayable media a stable message without the source ID", () => {
  for (const line of [
    "ERROR: [youtube] H1FAwIMz-RQ: This video is not available.",
    "ERROR: [youtube] H1FAwIMz-RQ: Video unavailable. This video has been removed by the uploader",
    "ERROR: [youtube] H1FAwIMz-RQ: Private video. Sign in if you've been granted access to this video",
    "ERROR: [youtube] H1FAwIMz-RQ: The uploader has not made this video available in your country",
  ]) {
    const failure = extractorFailure(`WARNING: falling back\n${line}\n`);
    expect(failure.message).toBe("Track is not available");
    expect(isExpectedTrackFailure(failure)).toBe(true);
    expect(failure.detail).toBe(line);
  }
});

test("separates unreleased and unsupported media from missing media", () => {
  expect(
    extractorFailure(
      "ERROR: [youtube] H1FAwIMz-RQ: This live event will begin in 3 hours.",
    ).message,
  ).toBe("Track has not been released yet");
  expect(
    extractorFailure("ERROR: Unsupported URL: https://example.com/song")
      .message,
  ).toBe("That link is not supported");
});

test("still reports unexpected extractor faults, without the source ID", () => {
  const failure = extractorFailure(
    "ERROR: [youtube] H1FAwIMz-RQ: Sign in to confirm you're not a bot",
  );
  expect(failure.message).toBe("[youtube] Sign in to confirm you're not a bot");
  expect(isExpectedTrackFailure(failure)).toBe(false);
  expect(trackFailureDetail(failure)).toContain("H1FAwIMz-RQ");
});

test("keeps the retry hint on forbidden downloads", () => {
  const failure = extractorFailure(
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
  );
  expect(isExpectedTrackFailure(failure)).toBe(false);
  expect(trackFailureDetail(failure)).toContain("HTTP Error 403");
});

test("rejects credentials and private destinations", async () => {
  await expect(
    assertPublicUrl(new URL("https://user:pass@example.com")),
  ).rejects.toThrow("Credentials");
  await expect(
    assertPublicUrl(new URL("http://127.0.0.1/test")),
  ).rejects.toThrow("Private");
});

test("drops artwork that points at private destinations", async () => {
  expect(await publicArtworkUrl("http://169.254.169.254/meta.png")).toBe(
    undefined,
  );
  expect(await publicArtworkUrl("file:///etc/passwd")).toBe(undefined);
  expect(await publicArtworkUrl("not a url")).toBe(undefined);
  expect(await publicArtworkUrl("https://93.184.216.34/art.png")).toBe(
    "https://93.184.216.34/art.png",
  );
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

test("recognizes Navidrome share links including base paths", () => {
  const root = navidromeShare(
    new URL("https://music.example.com/share/AbCdEfGhIj"),
  );
  expect(root?.id).toBe("AbCdEfGhIj");
  expect(root?.pageUrl.href).toBe("https://music.example.com/share/AbCdEfGhIj");
  expect(root?.streamUrl("token").href).toBe(
    "https://music.example.com/share/s/token",
  );
  expect(root?.coverUrl("token").href).toBe(
    "https://music.example.com/share/img/token?size=300&square=true",
  );

  const nested = navidromeShare(
    new URL("https://music.example.com/nd/share/AbCdEfGhIj/m3u"),
  );
  expect(nested?.pageUrl.href).toBe(
    "https://music.example.com/nd/share/AbCdEfGhIj",
  );
  expect(nested?.streamUrl("tok").pathname).toBe("/nd/share/s/tok");

  expect(
    navidromeShare(new URL("https://music.example.com/share/s/notashareid")),
  ).toBeUndefined();
  expect(
    navidromeShare(new URL("https://music.example.com/share/short")),
  ).toBeUndefined();
});

test("parses Navidrome share info from injected page state", () => {
  const info = {
    id: "AbCdEfGhIj",
    description: "Late night",
    tracks: [
      {
        id: "jwt.token.one",
        title: "Song",
        artist: "Artist",
        album: "Album",
        duration: 201.5,
      },
      {
        id: "jwt.token.two",
        title: "Other",
        artist: "Someone",
        album: undefined,
        duration: 90,
      },
    ],
  };
  expect(
    parseNavidromeShareInfo(
      `<script>window.__SHARE_INFO__ = ${JSON.stringify(JSON.stringify(info))}</script>`,
    ),
  ).toEqual(info);
  expect(
    parseNavidromeShareInfo(
      `<script>window.__SHARE_INFO__ = ${JSON.stringify(info)};</script>`,
    ),
  ).toEqual(info);
  expect(
    parseNavidromeShareInfo(`<script>window.__SHARE_INFO__ = null</script>`),
  ).toBeUndefined();
});

test("offers and expands Navidrome shares", async () => {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
  });
  Reflect.set(catalog, "proxy", { url: "http://127.0.0.1:9" });
  Reflect.set(catalog, "resolveNavidromeShare", async (input: string) => [
    {
      sourceInput: input,
      canonicalUrl: "https://93.184.216.34/share/s/token-a",
      sourceId: "navidrome:AbCdEfGhIj:token-a",
      title: "Song A",
      artist: "Artist",
      album: "Album",
      duration: 120,
      artwork: "https://93.184.216.34/share/img/token-a?size=300&square=true",
    },
    {
      sourceInput: input,
      canonicalUrl: "https://93.184.216.34/share/s/token-b",
      sourceId: "navidrome:AbCdEfGhIj:token-b",
      title: "Song B",
      artist: "Artist",
      album: "Album",
      duration: 130,
    },
  ]);

  const options = await catalog.suggestions(
    "https://93.184.216.34/share/AbCdEfGhIj",
    { songs: true, bulk: true },
  );
  expect(options.map((option) => option.text.text)).toEqual([
    "Link: https://93.184.216.34/share/AbCdEfGhIj",
    "Add share: https://93.184.216.34/share/AbCdEfGhIj",
  ]);
  expect(options[1]!.value.startsWith("bulkref_")).toBe(true);
  expect(await catalog.resolve(options[1]!.value)).toEqual([
    expect.objectContaining({ title: "Song A", album: "Album" }),
    expect.objectContaining({ title: "Song B" }),
  ]);

  Reflect.get(catalog, "references").set(
    "link",
    "https://93.184.216.34/share/AbCdEfGhIj",
  );
  expect(await catalog.resolve("link")).toEqual([
    expect.objectContaining({ title: "Song A" }),
    expect.objectContaining({ title: "Song B" }),
  ]);
});

test("resolves single-track Navidrome shares through resolveUrl", async () => {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
  });
  Reflect.set(catalog, "proxy", { url: "http://127.0.0.1:9" });
  Reflect.set(catalog, "resolveNavidromeShare", async (input: string) => [
    {
      sourceInput: input,
      canonicalUrl: "https://93.184.216.34/share/s/token",
      sourceId: "navidrome:AbCdEfGhIj:token",
      title: "Solo",
      artist: "Artist",
      duration: 90,
    },
  ]);
  expect(
    await catalog.resolveUrl("https://93.184.216.34/share/AbCdEfGhIj"),
  ).toEqual(
    expect.objectContaining({
      title: "Solo",
      canonicalUrl: "https://93.184.216.34/share/s/token",
    }),
  );
});

test("finds the audible bounds from FFmpeg silence analysis", () => {
  expect(
    transitionData(
      "silence_start: 0\nsilence_end: 1.25\nsilence_start: 58.4\nsilence_end: 60",
      60,
    ),
  ).toEqual({
    introSeconds: 1.25,
    outroSeconds: 58.4,
    fadeInSeconds: 0,
    fadeOutSeconds: 0,
  });
  expect(transitionData("", 60)).toEqual({
    introSeconds: 0,
    outroSeconds: 60,
    fadeInSeconds: 0,
    fadeOutSeconds: 0,
  });
});

test("finds conservative fade lengths from track loudness", () => {
  const output = [
    [0, -40],
    [1, -25],
    [2, -10],
    [10, -10],
    [14, -10],
    [15, -12],
    [16, -16],
    [17, -22],
    [18, -30],
    [19, -40],
  ]
    .map(
      ([seconds, db]) =>
        `frame:0 pts_time:${seconds}\nlavfi.astats.Overall.RMS_level=${db}`,
    )
    .join("\n");
  expect(transitionData(output, 20)).toEqual({
    introSeconds: 0,
    outroSeconds: 20,
    fadeInSeconds: 2,
    fadeOutSeconds: 3.75,
  });
});
