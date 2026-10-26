import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPublicUrl } from "./public-proxy.ts";
import { StreamRelay } from "./stream-relay.ts";
import {
  analyzeAudio,
  applyEmbeddedMetadata,
  embeddedArtworkPath,
  forgetPreparedMedia,
  removePreparedMedia,
  songGain,
  truePeak,
  extractEmbeddedArtwork,
  extractorFailure,
  isBotCheck,
  integratedLoudness as summaryLoudness,
  isExpectedTrackFailure,
  levelingGain,
  looksLikeFilenameTitle,
  metadataKind,
  metadataLooksWeak,
  navidromeShare,
  normalizeLoudness,
  normalizeToken,
  parseBulkLinkList,
  parseNavidromeShareInfo,
  probeEmbeddedMetadata,
  publicArtworkUrl,
  restrictedVideo,
  shouldProbeEmbeddedMetadata,
  shouldRetainSourceForMetadata,
  TrackCatalog,
  trackFailureDetail,
  trackKind,
  transitionData,
  type TrackMetadata,
} from "./tracks.ts";

const testCatalog = () =>
  new TrackCatalog({ durationSeconds: 1_200, downloadBytes: 100_000_000 });

test("parses bulk link lists with comments and blank lines", () => {
  expect(
    parseBulkLinkList(`
# weekend mix
https://music.example.com/a.mp3

https://music.example.com/b.flac
not a url
ftp://music.example.com/c.mp3
`),
  ).toEqual({
    links: [
      "https://music.example.com/a.mp3",
      "https://music.example.com/b.flac",
    ],
    invalid: ["not a url", "ftp://music.example.com/c.mp3"],
  });
});

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
  expect(
    shouldRetainSourceForMetadata({
      title: "Volcano Mines",
      artist: "ConcernedApe",
      canonicalUrl: "https://example.com/volcano.mp3",
      sourceId: "volcano",
    }),
  ).toBe(true);
  expect(
    shouldRetainSourceForMetadata({
      title: "Volcano Mines",
      artist: "ConcernedApe",
      canonicalUrl: "https://example.com/volcano.mp3",
      sourceId: "volcano",
      artwork: "https://example.com/cover.jpg",
    }),
  ).toBe(false);
  expect(embeddedArtworkPath("data/media/session/track.opus")).toBe(
    "data/media/session/track.cover.jpg",
  );
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

const integratedLoudness = (filePath: string) => {
  const analysis = Bun.spawnSync([
    "ffmpeg",
    "-hide_banner",
    "-i",
    filePath,
    "-af",
    "ebur128",
    "-f",
    "null",
    "-",
  ]);
  const matches = [
    ...analysis.stderr.toString().matchAll(/^\s+I:\s+(-?[\d.]+) LUFS/gm),
  ];
  return Number(matches.at(-1)?.[1]);
};

test.skipIf(!Bun.which("ffmpeg"))(
  "normalizes quiet tracks in place, including ones already in Opus",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-loudness-"));
    const filePath = join(directory, "entry.opus");
    try {
      const encoded = Bun.spawnSync([
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=5",
        "-af",
        "volume=-30dB",
        "-c:a",
        "libopus",
        filePath,
      ]);
      expect(encoded.exitCode).toBe(0);
      expect(integratedLoudness(filePath)).toBeLessThan(-40);
      expect(await normalizeLoudness(filePath, "entry", 100_000_000)).toBe(
        true,
      );
      expect(integratedLoudness(filePath)).toBeCloseTo(-14, 0);
      expect(await readdir(directory)).toEqual(["entry.opus"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "keeps the original audio when normalizing would exceed the download limit",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-loudness-"));
    const filePath = join(directory, "entry.opus");
    try {
      const encoded = Bun.spawnSync([
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=5",
        "-c:a",
        "libopus",
        "-b:a",
        "16k",
        filePath,
      ]);
      expect(encoded.exitCode).toBe(0);
      const original = await readFile(filePath);
      expect(
        await normalizeLoudness(filePath, "entry", original.byteLength),
      ).toBe(false);
      expect(await readFile(filePath)).toEqual(original);
      expect(await readdir(directory)).toEqual(["entry.opus"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "keeps the original audio when normalization fails",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-loudness-"));
    const filePath = join(directory, "entry.opus");
    try {
      await writeFile(filePath, "not audio");
      expect(await normalizeLoudness(filePath, "entry", 100_000_000)).toBe(
        false,
      );
      expect(await readFile(filePath, "utf8")).toBe("not audio");
      expect(await readdir(directory)).toEqual(["entry.opus"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "extracts embedded album artwork from local audio files",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-cover-"));
    const coverPath = join(directory, "cover.png");
    const songPath = join(directory, "song.mp3");
    const outputPath = join(directory, "song.cover.jpg");
    try {
      const cover = Bun.spawnSync([
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=64x64:d=1",
        "-frames:v",
        "1",
        coverPath,
      ]);
      expect(cover.exitCode).toBe(0);
      const encoded = Bun.spawnSync([
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-i",
        coverPath,
        "-map",
        "0:a",
        "-map",
        "1:v",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        "-c:v",
        "copy",
        "-disposition:v",
        "attached_pic",
        "-metadata",
        "title=Cover Song",
        songPath,
      ]);
      expect(encoded.exitCode).toBe(0);
      expect(await extractEmbeddedArtwork(songPath, outputPath)).toBe(
        outputPath,
      );
      expect(await Bun.file(outputPath).exists()).toBe(true);
      expect((await Bun.file(outputPath).size) > 0).toBe(true);
      // Files without an attached picture should fail quietly.
      const plain = join(directory, "plain.mp3");
      const plainEncoded = Bun.spawnSync([
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
        plain,
      ]);
      expect(plainEncoded.exitCode).toBe(0);
      expect(
        await extractEmbeddedArtwork(plain, join(directory, "none.jpg")),
      ).toBeUndefined();
      expect(await Bun.file(join(directory, "none.jpg")).exists()).toBe(false);
    } finally {
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

test("says a video needs a login, but not for YouTube's bot check", () => {
  for (const line of [
    "ERROR: [vimeo] 12345: This video requires login. Use --cookies, --cookies-from-browser, --username and --password",
    "ERROR: [instagram] abc: Requested content is not available, rate-limit reached or login required. Use --cookies",
    "ERROR: [twitter] 1: Sign in to view this post",
    "ERROR: [niconico] sm9: This video is only available to registered users",
  ])
    expect(extractorFailure(line).message).toBe("That video needs a login");
  const bot = extractorFailure(
    "ERROR: [youtube] H1FAwIMz-RQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.",
  );
  expect(bot.message).not.toBe("That video needs a login");
  expect(isExpectedTrackFailure(bot)).toBe(false);
});

test("knows YouTube's bot check, to retry it", () => {
  expect(
    isBotCheck(
      extractorFailure(
        "ERROR: [youtube] xD-IQaxHcE4: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.",
      ),
    ),
  ).toBe(true);
  expect(
    isBotCheck(extractorFailure("ERROR: [youtube] abc: Video unavailable")),
  ).toBe(false);
  expect(isBotCheck(new Error("not a bot"))).toBe(false);
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
  const catalog = testCatalog();
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
  const catalog = testCatalog();
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

test("runs as many preparations at once as configured", async () => {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
    preparationConcurrency: 3,
  });
  const gate = Promise.withResolvers<void>();
  const started: string[] = [];
  Reflect.set(
    catalog,
    "download",
    async (_track: unknown, _dir: string, id: string) => {
      started.push(id);
      await gate.promise;
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
  const work = ["a", "b", "c", "d"].map((id) =>
    catalog.prepare(track, "data", id),
  );
  expect(started).toEqual(["a", "b", "c"]);
  gate.resolve();
  await Promise.all(work);
  expect(started).toEqual(["a", "b", "c", "d"]);
});

/** A catalog with one preparation slot whose downloads wait to be let go. */
function gatedCatalog() {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
    preparationConcurrency: 1,
  });
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  Reflect.set(
    catalog,
    "download",
    async (_track: unknown, _dir: string, id: string) => {
      started.push(id);
      await new Promise<void>((resolve) => gates.set(id, resolve));
      return id;
    },
  );
  const finish = async (id: string) => {
    gates.get(id)!();
    await Bun.sleep(0);
  };
  return { catalog, started, finish };
}

const queuedTrack = {
  sourceInput: "https://example.com",
  canonicalUrl: "https://example.com",
  sourceId: "test",
  title: "Test",
  artist: "Artist",
};

test("a long playlist in one session does not hold up another's next track", async () => {
  const { catalog, started, finish } = gatedCatalog();
  // A playlist: each track is wanted later than the one before it.
  const playlist = Array.from({ length: 5 }, (_, index) =>
    catalog.prepare(queuedTrack, "media/a", `a${index}`, undefined, -index),
  );
  const next = catalog.prepare(queuedTrack, "media/b", "b0", undefined, 0);
  expect(started).toEqual(["a0"]);
  await finish("a0");
  // The other session's next track goes before the rest of the playlist.
  expect(started).toEqual(["a0", "b0"]);
  for (const id of ["b0", "a1", "a2", "a3", "a4"]) await finish(id);
  await Promise.all([...playlist, next]);
  expect(started).toEqual(["a0", "b0", "a1", "a2", "a3", "a4"]);
});

test("sessions whose tracks are as urgent take turns", async () => {
  const { catalog, started, finish } = gatedCatalog();
  const work = [
    ...["a0", "a1", "a2"].map((id) =>
      catalog.prepare(queuedTrack, "media/a", id),
    ),
    ...["b0", "b1"].map((id) => catalog.prepare(queuedTrack, "media/b", id)),
  ];
  for (const id of ["a0", "b0", "a1", "b1"]) await finish(id);
  await finish("a2");
  await Promise.all(work);
  expect(started).toEqual(["a0", "b0", "a1", "b1", "a2"]);
});

test("a track moved up the queue is prepared sooner", async () => {
  const { catalog, started, finish } = gatedCatalog();
  const positions = new Map([
    ["a0", 0],
    ["a1", 1],
    ["a2", 2],
  ]);
  const work = [...positions.keys()].map((id) =>
    catalog.prepare(
      queuedTrack,
      "media/a",
      id,
      undefined,
      () => -positions.get(id)!,
    ),
  );
  expect(started).toEqual(["a0"]);
  // "Play next" on the last one, after it was queued.
  positions.set("a2", 1).set("a1", 2);
  await finish("a0");
  await finish("a2");
  await finish("a1");
  await Promise.all(work);
  expect(started).toEqual(["a0", "a2", "a1"]);
});

test("a cancelled preparation leaves the queue without running", async () => {
  const { catalog, started, finish } = gatedCatalog();
  const first = catalog.prepare(queuedTrack, "media/a", "a0");
  const removed = new AbortController();
  const cancelled = catalog.prepare(
    queuedTrack,
    "media/a",
    "a1",
    removed.signal,
  );
  const kept = catalog.prepare(queuedTrack, "media/a", "a2");
  removed.abort();
  await expect(cancelled).rejects.toThrow("Track preparation cancelled");
  expect(Reflect.get(catalog, "preparationQueue")).toHaveLength(1);
  // Cancelled before it was queued, it never is.
  await expect(
    catalog.prepare(queuedTrack, "media/a", "a3", removed.signal),
  ).rejects.toThrow("Track preparation cancelled");
  await finish("a0");
  await finish("a2");
  await Promise.all([first, kept]);
  expect(started).toEqual(["a0", "a2"]);
});

// Stands in for yt-dlp: logs its arguments, fails a reused extraction when
// told the stream URLs have gone stale, and otherwise "downloads" the fixture.
async function fakeExtractor(directory: string, audio: string, stale = false) {
  const script = join(directory, "yt-dlp");
  const calls = join(directory, "calls.log");
  await writeFile(
    script,
    `#!/bin/sh
echo "$*" >> '${calls}'
case "$*" in *--load-info-json*)
  ${stale ? `echo "ERROR: unable to download video data: HTTP Error 403: Forbidden" >&2; exit 1` : `:`};;
esac
while [ $# -gt 0 ]; do
  case "$1" in --load-info-json) cp "$2" '${directory}/loaded.json';; --output) output="$2";; esac
  shift
done
path=$(printf '%s' "$output" | sed 's/%(ext)s/opus/')
cp '${audio}' "$path"
echo "$path"
`,
  );
  await chmod(script, 0o755);
  return {
    command: () => [script],
    calls: async () =>
      (await readFile(calls, "utf8").catch(() => "")).trim().split("\n"),
  };
}

async function audioFixture(directory: string) {
  const audio = join(directory, "fixture.opus");
  const encoded = Bun.spawnSync([
    "ffmpeg",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-c:a",
    "libopus",
    audio,
  ]);
  expect(encoded.exitCode).toBe(0);
  return audio;
}

const youtubeTrack = (canonicalUrl: string): TrackMetadata => ({
  sourceInput: canonicalUrl,
  canonicalUrl,
  sourceId: "dQw4w9WgXcQ",
  title: "Never Gonna Give You Up",
  artist: "Rick Astley",
  artwork: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
});

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "downloads from the resolving extraction, then serves repeats from the cache",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-prepare-"));
    try {
      const catalog = new TrackCatalog({
        durationSeconds: 1_200,
        downloadBytes: 100_000_000,
        mediaCacheBytes: 100_000_000,
        mediaCacheDirectory: join(directory, "cache"),
      });
      await Reflect.get(catalog, "cache").initialize();
      const extractor = await fakeExtractor(
        directory,
        await audioFixture(directory),
      );
      Reflect.set(catalog, "extractor", extractor.command);
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      Reflect.get(catalog, "rememberExtraction").call(catalog, url, {
        id: "dQw4w9WgXcQ",
        formats: [{ format_id: "251" }],
        automatic_captions: { en: [{ url: "https://example.com/captions" }] },
      });

      const first = await catalog.prepare(
        youtubeTrack(url),
        join(directory, "first"),
        "a",
      );
      expect(await extractor.calls()).toHaveLength(1);
      expect((await extractor.calls())[0]).toContain("--load-info-json");
      expect(
        JSON.parse(await readFile(join(directory, "loaded.json"), "utf8")),
      ).toEqual({ id: "dQw4w9WgXcQ", formats: [{ format_id: "251" }] });
      expect(await readdir(join(directory, "first"))).toEqual(["a.mka"]);

      // The same video from YouTube Music, in another session.
      const repeat = youtubeTrack(
        "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      );
      const second = await catalog.prepare(
        repeat,
        join(directory, "second"),
        "b",
      );
      expect(await extractor.calls()).toHaveLength(1);
      expect(await readFile(second)).toEqual(await readFile(first));
      expect(catalog.transition(second)).toEqual(catalog.transition(first));
      expect(repeat.duration).toBeCloseTo(3, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "extracts again when a reused extraction has gone stale",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-prepare-"));
    try {
      const catalog = testCatalog();
      const extractor = await fakeExtractor(
        directory,
        await audioFixture(directory),
        true,
      );
      Reflect.set(catalog, "extractor", extractor.command);
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      Reflect.get(catalog, "rememberExtraction").call(catalog, url, {
        id: "dQw4w9WgXcQ",
      });

      const filePath = await catalog.prepare(
        youtubeTrack(url),
        join(directory, "session"),
        "a",
      );
      const calls = await extractor.calls();
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain("--load-info-json");
      expect(calls[1]).not.toContain("--load-info-json");
      expect(calls[1]).toEndWith(`-- ${url}`);
      expect(await readdir(join(directory, "session"))).toEqual(["a.mka"]);
      expect(await Bun.file(filePath).exists()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

/** Encodes `source`, a lavfi graph, into `name` in `directory`. */
function encode(
  directory: string,
  name: string,
  source: string,
  codec: string[],
) {
  const path = join(directory, name);
  const encoded = Bun.spawnSync([
    "ffmpeg",
    "-y",
    "-f",
    "lavfi",
    "-i",
    source,
    "-t",
    "6",
    "-ac",
    "2",
    ...codec,
    path,
  ]);
  expect(encoded.exitCode).toBe(0);
  return path;
}

const codecOf = (filePath: string) =>
  Bun.spawnSync([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name",
    "-of",
    "default=nw=1:nk=1",
    filePath,
  ])
    .stdout.toString()
    .trim();

const ebur128Summary = (filePath: string, filter = "") =>
  Bun.spawnSync([
    "ffmpeg",
    "-hide_banner",
    "-nostats",
    "-i",
    filePath,
    "-af",
    `${filter}ebur128=framelog=quiet:peak=true`,
    "-f",
    "null",
    "-",
  ]).stderr.toString();

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "copies a download's sound and reads its length, bounds and loudness in one pass",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-analyze-"));
    try {
      // AAC, as YouTube's m4a is, after a second of silence.
      const source = encode(
        directory,
        "source.m4a",
        "anoisesrc=color=pink:amplitude=0.2:seed=1,volume='if(lt(t\\,1)\\,0\\,1)':eval=frame",
        ["-c:a", "aac", "-b:a", "128k"],
      );
      const output = join(directory, "entry.mka");
      const analysis = await analyzeAudio(source, output, true);
      // Kept as it came, in a container that holds it.
      expect(codecOf(output)).toBe("aac");
      expect(analysis.analyzed).toBe(true);
      expect(analysis.duration).toBeCloseTo(6, 1);
      expect(analysis.transition.introSeconds).toBeCloseTo(1, 1);
      expect(analysis.transition.outroSeconds).toBeCloseTo(6, 1);
      // The same loudness ebur128 reads on its own.
      const summary = ebur128Summary(source);
      expect(analysis.lufs).toBe(summaryLoudness(summary)!);
      expect(analysis.truePeak).toBe(truePeak(summary)!);
      // Without loudness asked for, none is measured.
      const plain = await analyzeAudio(source, output, false);
      expect(plain.lufs).toBeUndefined();
      expect(plain.transition).toEqual(analysis.transition);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("levels songs by a gain unless only loudnorm keeps their peaks down", () => {
  expect(songGain(-8.4, -0.2)).toBe(-5.6);
  // Lifted as far as loudnorm lifted it, not a video's 6 dB.
  expect(songGain(-30, -18)).toBe(16);
  expect(songGain(-20, -7)).toBe(6);
  // Lifting it would push its peaks past -1 dBTP.
  expect(songGain(-20, -6.5)).toBeUndefined();
  expect(songGain(-20, undefined)).toBeUndefined();
  // Turning it down never does.
  expect(songGain(-10, 1.5)).toBe(-4);
  expect(truePeak("  True peak:\n    Peak:        -3.2 dBFS")).toBe(-3.2);
  expect(truePeak("  True peak:\n    Peak:        -inf dBFS")).toBeUndefined();
});

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "levels a song as it plays instead of re-encoding it, and keeps the gain in the cache",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-level-"));
    try {
      const catalog = new TrackCatalog({
        durationSeconds: 1_200,
        downloadBytes: 100_000_000,
        loudnessNormalization: true,
        mediaCacheBytes: 100_000_000,
        mediaCacheDirectory: join(directory, "cache"),
      });
      await Reflect.get(catalog, "cache").initialize();
      // Quiet, with plenty of headroom.
      const fixture = encode(
        directory,
        "fixture.opus",
        "sine=frequency=440,volume=-30dB",
        ["-c:a", "libopus", "-b:a", "96k"],
      );
      const extractor = await fakeExtractor(directory, fixture);
      Reflect.set(catalog, "extractor", extractor.command);
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const first = await catalog.prepare(
        youtubeTrack(url),
        join(directory, "first"),
        "a",
      );
      expect(await readdir(join(directory, "first"))).toEqual(["a.mka"]);
      // Not re-encoded: the sound is the download's own.
      expect(codecOf(first)).toBe("opus");
      const source = summaryLoudness(ebur128Summary(fixture))!;
      expect(summaryLoudness(ebur128Summary(first))).toBe(source);
      const gainDb = catalog.gain(first)!;
      expect(gainDb).toBeCloseTo(-14 - source, 0);
      // Played at its gain, it is as loud as loudnorm made it.
      expect(
        summaryLoudness(ebur128Summary(first, `volume=${gainDb}dB,`))!,
      ).toBeCloseTo(-14, 0);
      // From the cache, in another session, with the same gain and bounds.
      const second = await catalog.prepare(
        youtubeTrack(url),
        join(directory, "second"),
        "b",
      );
      expect(await extractor.calls()).toHaveLength(1);
      expect(second).toEndWith("b.mka");
      expect(catalog.gain(second)).toBe(gainDb);
      expect(catalog.transition(second)).toEqual(catalog.transition(first)!);
      // Forgotten once the files go.
      await removePreparedMedia(first);
      expect(catalog.transition(first)).toBeUndefined();
      forgetPreparedMedia(join(directory, "second"));
      expect(catalog.gain(second)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "normalizes a quiet song with loud peaks as before, and plays it as it is",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-level-"));
    try {
      const catalog = new TrackCatalog({
        durationSeconds: 1_200,
        downloadBytes: 100_000_000,
        loudnessNormalization: true,
      });
      const fixture = encode(
        directory,
        "fixture.opus",
        "aevalsrc='0.03*sin(2*PI*220*t)+if(lt(mod(t\\,2)\\,0.01)\\,0.95*sin(2*PI*1000*t)\\,0)':s=48000",
        ["-c:a", "libopus", "-b:a", "96k"],
      );
      const extractor = await fakeExtractor(directory, fixture);
      Reflect.set(catalog, "extractor", extractor.command);
      const filePath = await catalog.prepare(
        youtubeTrack("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
        join(directory, "session"),
        "a",
      );
      expect(await readdir(join(directory, "session"))).toEqual(["a.mka"]);
      expect(catalog.gain(filePath)).toBeUndefined();
      // Loudnorm turned it up, holding its peaks under -1 dBTP.
      const before = summaryLoudness(ebur128Summary(fixture))!;
      const after = ebur128Summary(filePath);
      expect(summaryLoudness(after)!).toBeGreaterThan(before + 2);
      expect(truePeak(after)!).toBeLessThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "plays a song cached normalized in Opus as it is",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-legacy-"));
    try {
      const catalog = new TrackCatalog({
        durationSeconds: 1_200,
        downloadBytes: 100_000_000,
        loudnessNormalization: true,
        mediaCacheBytes: 100_000_000,
        mediaCacheDirectory: join(directory, "cache"),
      });
      const cache = Reflect.get(catalog, "cache");
      await cache.initialize();
      const track = youtubeTrack("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      const legacy = await audioFixture(directory);
      // As the cache kept songs before they were levelled as they play.
      await cache.store(
        Reflect.get(catalog, "cacheKey").call(catalog, track),
        legacy,
        join(directory, "none.jpg"),
        {
          duration: 3,
          transition: {
            introSeconds: 0,
            outroSeconds: 3,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
          },
          cover: false,
        },
      );
      const filePath = await catalog.prepare(
        track,
        join(directory, "session"),
        "a",
      );
      expect(filePath).toEndWith("a.opus");
      expect(catalog.gain(filePath)).toBeUndefined();
      expect(await readFile(filePath)).toEqual(await readFile(legacy));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("runs yt-dlp with its cache on the data volume", () => {
  const catalog = testCatalog();
  Reflect.set(catalog, "proxy", { url: "http://127.0.0.1:1" });
  const command = Reflect.get(catalog, "extractor").call(catalog) as string[];
  expect(command[command.indexOf("--cache-dir") + 1]).toBe("data/cache/yt-dlp");
});

test("requests high-resolution YouTube Music artwork", async () => {
  const catalog = testCatalog();
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
  const catalog = testCatalog();
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

test("upNextTracks reads the shapes ytmusic-api actually returns", async () => {
  const catalog = testCatalog();
  Reflect.set(catalog, "music", {
    getUpNexts: async () => [
      // What the library returns at runtime, despite its types.
      {
        type: "SONG",
        videoId: "euCqAq6BRa4",
        title: "Let Me Love You (feat. Justin Bieber)",
        artists: "DJ Snake",
        duration: "3:26",
        thumbnail: "https://i.ytimg.com/vi/euCqAq6BRa4/hq720.jpg",
      },
      // What its types promise.
      {
        videoId: "typedtypedt",
        title: "Typed",
        artists: { name: "Typed Artist", artistId: null },
        duration: 200,
        thumbnails: [{ url: "https://i.ytimg.com/vi/typedtypedt/small.jpg" }],
      },
      {
        videoId: "arrayarraya",
        title: "Array",
        artists: [{ name: "One" }, { name: "Two" }],
        duration: "1:02:03",
      },
      { videoId: "nothingnoth", title: "Nothing" },
    ],
  });
  expect(await catalog.upNextTracks("seedseedsee")).toEqual([
    expect.objectContaining({
      sourceId: "euCqAq6BRa4",
      artist: "DJ Snake",
      duration: 206,
      artwork: "https://i.ytimg.com/vi/euCqAq6BRa4/hq720.jpg",
    }),
    expect.objectContaining({
      sourceId: "typedtypedt",
      artist: "Typed Artist",
      duration: 200,
      artwork: "https://i.ytimg.com/vi/typedtypedt/small.jpg",
    }),
    expect.objectContaining({
      sourceId: "arrayarraya",
      artist: "One, Two",
      duration: 3723,
    }),
    expect.objectContaining({
      sourceId: "nothingnoth",
      artist: "Unknown artist",
      duration: undefined,
    }),
  ]);
});

test("searchSong prefers an artist match from YouTube Music results", async () => {
  const catalog = testCatalog();
  Reflect.set(catalog, "music", {
    searchSongs: async (query: string) => {
      expect(query).toBe("Karma Police Radiohead");
      return [
        {
          videoId: "otherothero",
          name: "Karma Police",
          artist: { name: "Cover Band" },
          thumbnails: [],
        },
        {
          videoId: "abcdefghijk",
          name: "Karma Police",
          artist: { name: "Radiohead" },
          album: { name: "OK Computer" },
          duration: 261,
          thumbnails: [{ url: "art" }],
        },
      ];
    },
  });
  expect(await catalog.searchSong("Karma Police", "Radiohead")).toEqual({
    sourceInput: "https://music.youtube.com/watch?v=abcdefghijk",
    canonicalUrl: "https://music.youtube.com/watch?v=abcdefghijk",
    sourceId: "abcdefghijk",
    title: "Karma Police",
    artist: "Radiohead",
    album: "OK Computer",
    duration: 261,
    artwork: "art",
    kind: "song",
  });
});

test("offers and expands albums only for bulk searches", async () => {
  const catalog = testCatalog();
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
  const catalog = testCatalog();
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
  const catalog = testCatalog();
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
  const catalog = testCatalog();
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

test("popularTracks combines home quick picks with a featured hits playlist", async () => {
  const catalog = testCatalog();
  const browsed: string[] = [];
  Reflect.set(catalog, "music", {
    getHomeSections: async () => [
      {
        title: "Quick picks",
        contents: [
          {
            type: "SONG",
            videoId: "OZNOBP0B3_I",
            name: "Somewhere Only We Know",
            artist: { name: "Keane", artistId: "x" },
            album: { name: "Hopes and Fears", albumId: "y" },
            duration: null,
            thumbnails: [{ url: "https://i.ytimg.com/vi/OZNOBP0B3_I/a.jpg" }],
          },
          { type: "SONG", videoId: "bad", name: "Broken" },
        ],
      },
      {
        title: "New & trending",
        contents: [
          { type: "PLAYLIST", name: "phonk 2026", playlistId: "RDCLAK5uy_a" },
          {
            type: "PLAYLIST",
            name: "Top 100 Music Videos Global",
            playlistId: "PL4fGSI1pDJn5kI81J1fYWK5eZRl1zJ5kM",
          },
        ],
      },
      {
        title: "All-time hits",
        contents: [
          {
            type: "PLAYLIST",
            name: "Pop's Biggest Hits",
            playlistId: "RDCLAK5uy_b",
          },
          { type: "ALBUM", name: "Not a playlist", albumId: "z" },
        ],
      },
    ],
    getPlaylistVideos: async (id: string) => {
      browsed.push(id);
      return [
        {
          type: "VIDEO",
          videoId: "ic8j13piAhQ",
          name: "Cruel Summer",
          artist: { name: "Taylor Swift", artistId: "t" },
          duration: 180,
          thumbnails: [{ url: "https://i.ytimg.com/vi/ic8j13piAhQ/hq.jpg" }],
        },
        // Already in the quick picks.
        {
          type: "VIDEO",
          videoId: "OZNOBP0B3_I",
          name: "Somewhere Only We Know",
          artist: { name: "Keane", artistId: "x" },
          duration: 237,
          thumbnails: [],
        },
      ];
    },
  });
  const tracks = await catalog.popularTracks();
  // The hits playlist wins over the genre one, and needs the browse prefix.
  expect(browsed).toEqual(["VLRDCLAK5uy_b"]);
  expect(tracks).toEqual([
    {
      sourceInput: "https://music.youtube.com/watch?v=OZNOBP0B3_I",
      canonicalUrl: "https://music.youtube.com/watch?v=OZNOBP0B3_I",
      sourceId: "OZNOBP0B3_I",
      title: "Somewhere Only We Know",
      artist: "Keane",
      album: "Hopes and Fears",
      duration: undefined,
      artwork: "https://i.ytimg.com/vi/OZNOBP0B3_I/a.jpg",
      kind: "song",
    },
    {
      sourceInput: "https://music.youtube.com/watch?v=ic8j13piAhQ",
      canonicalUrl: "https://music.youtube.com/watch?v=ic8j13piAhQ",
      sourceId: "ic8j13piAhQ",
      title: "Cruel Summer",
      artist: "Taylor Swift",
      album: undefined,
      duration: 180,
      artwork: "https://i.ytimg.com/vi/ic8j13piAhQ/hq.jpg",
      kind: "song",
    },
  ]);
});

test("popularTracks still returns quick picks when the playlist fails", async () => {
  const catalog = testCatalog();
  Reflect.set(catalog, "music", {
    getHomeSections: async () => [
      {
        title: "Quick picks",
        contents: [
          {
            type: "SONG",
            videoId: "OZNOBP0B3_I",
            name: "Somewhere Only We Know",
            artist: { name: "Keane", artistId: "x" },
            thumbnails: [],
          },
          {
            type: "PLAYLIST",
            name: "Dance Pop Bangers",
            playlistId: "RDCLAK5uy_c",
          },
        ],
      },
    ],
    getPlaylistVideos: async () => {
      throw new Error("400");
    },
  });
  expect(
    (await catalog.popularTracks()).map((track) => track.sourceId),
  ).toEqual(["OZNOBP0B3_I"]);
});

test("normalizeToken keeps every script but folds accents away", () => {
  // Latin text still folds its accents, so the same name spelled either way
  // matches, and the accent does not break the word in two.
  expect(normalizeToken("Beyoncé")).toBe("beyonce");
  expect(normalizeToken("Sigur Rós")).toBe(normalizeToken("Sigur Ros"));
  expect(normalizeToken("Café Tacvba")).toBe("cafe tacvba");
  expect(normalizeToken("AC/DC")).toBe("ac dc");
  expect(normalizeToken("21 Savage")).toBe("21 savage");
  // Non-Latin titles used to normalize to nothing at all, which made every
  // one of them the same token as every other.
  expect(normalizeToken("夜に駆ける")).not.toBe("");
  expect(normalizeToken("夜に駆ける")).not.toBe(normalizeToken("群青"));
  expect(normalizeToken("Кукушка")).toBe("кукушка");
  expect(normalizeToken("Кукушка")).not.toBe(normalizeToken("Звезда"));
  // Punctuation and spacing are still separators.
  expect(normalizeToken("  P!nk  ")).toBe("p nk");
});

test("normalizeToken keeps marks that are part of the letter", () => {
  // Only a mark that came off a Latin letter is an accent to fold away. In
  // other scripts the mark carries meaning, so folding it merges real words.
  expect(normalizeToken("काल")).not.toBe(normalizeToken("कल"));
  expect(normalizeToken("मोरनी")).not.toBe(normalizeToken("मरनी"));
  // Cyrillic "й" decomposes to "и" plus a breve in the same Unicode block as
  // Latin accents, so a block-based rule would wrongly merge these.
  expect(normalizeToken("мой")).not.toBe(normalizeToken("мои"));
  // A dakuten is what separates ド from ト.
  expect(normalizeToken("ドライフラワー")).not.toBe(
    normalizeToken("トライフラワー"),
  );
  expect(normalizeToken("สวัสดี")).not.toBe(normalizeToken("สวสด"));
  // The marks survive rather than being dropped along with the separators.
  expect(normalizeToken("काल")).toBe("काल");
  // NFKD leaves the dakuten as its own character, so recomposing the result
  // is what shows it was kept.
  expect(normalizeToken("ドライフラワー").normalize("NFC")).toBe(
    "ドライフラワー",
  );
  // Latin accents still fold, including mid-word ones.
  expect(normalizeToken("Motörhead")).toBe(normalizeToken("Motorhead"));
  expect(normalizeToken("Mylène Farmer")).toBe("mylene farmer");
});

test("tells a song from a video by its channel and its picture", () => {
  expect(
    metadataKind({
      channel: "Radiohead - Topic",
      formats: [{ vcodec: "avc1", height: 1080 }],
    }),
  ).toBe("song");
  expect(
    metadataKind({ channel: "Radiohead", formats: [{ vcodec: "vp9" }] }),
  ).toBe("video");
  // A direct file does not name its codecs, only its extension.
  expect(metadataKind({ formats: [{ vcodec: null, video_ext: "mp4" }] })).toBe(
    "video",
  );
  expect(
    metadataKind({ formats: [{ vcodec: "none", video_ext: "none" }] }),
  ).toBe("song");
  // Tracks saved before kinds were kept.
  expect(
    trackKind({ canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk" }),
  ).toBe("video");
  expect(
    trackKind({
      canonicalUrl: "https://music.youtube.com/watch?v=abcdefghijk",
    }),
  ).toBe("song");
  expect(trackKind({ canonicalUrl: "https://example.com/a.mp3" })).toBe("song");
});

test("refuses age-restricted and members-only videos by name", () => {
  expect(() => restrictedVideo({ age_limit: 18 })).toThrow(
    "That video is age-restricted",
  );
  expect(() => restrictedVideo({ availability: "subscriber_only" })).toThrow(
    "That video is for channel members only",
  );
  expect(() => restrictedVideo({ availability: "public" })).not.toThrow();
  expect(
    extractorFailure(
      "ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.",
    ).message,
  ).toBe("That video is age-restricted");
  expect(
    extractorFailure(
      "ERROR: [youtube] abc: Join this channel to get access to members-only content like this video.",
    ).message,
  ).toBe("That video is for channel members only");
});

test("video mode allows longer videos and says how long is too long", async () => {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
    video: {
      durationSeconds: 3_600,
      downloadBytes: 1_500_000_000,
      maxHeight: 720,
      maxFps: 30,
      cacheBytes: 0,
    },
  });
  const long = { ...trackFixture, duration: 2_400 };
  const remember = (track: TrackMetadata) =>
    Reflect.apply(Reflect.get(catalog, "remember"), catalog, [track]) as string;
  await expect(catalog.resolve(remember(long))).rejects.toThrow(
    "Track exceeds the duration limit",
  );
  expect(await catalog.resolve(remember(long), true)).toEqual(long);
  await expect(
    catalog.resolve(remember({ ...long, duration: 5_400 }), true),
  ).rejects.toThrow(
    "That video is longer than 1 hour, the limit on this server",
  );
});

test("names search results' links and titles before resolving them", () => {
  const catalog = testCatalog();
  const remember = (value: TrackMetadata | string) =>
    Reflect.apply(Reflect.get(catalog, "remember"), catalog, [value]) as string;
  const link = remember("https://youtu.be/abcdefghijk");
  const track = remember(trackFixture);
  expect(catalog.referencedUrl(link)).toBe("https://youtu.be/abcdefghijk");
  expect(catalog.referencedTitle(link)).toBeUndefined();
  expect(catalog.referencedUrl(track)).toBeUndefined();
  expect(catalog.referencedTitle(track)).toBe(trackFixture.title);
});

const trackFixture: TrackMetadata = {
  sourceInput: "https://www.youtube.com/watch?v=abcdefghijk",
  canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk",
  sourceId: "abcdefghijk",
  title: "A long video",
  artist: "Channel",
  kind: "video",
};

test("video mode prepares a video as audio when its picture will not come", async () => {
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
    video: {
      durationSeconds: 3_600,
      downloadBytes: 1_500_000_000,
      maxHeight: 720,
      maxFps: 30,
      cacheBytes: 0,
    },
  });
  const audioFor: string[] = [];
  Reflect.set(
    catalog,
    "prepare",
    async (_track: TrackMetadata, directory: string, id: string) => {
      audioFor.push(id);
      return `${directory}/${id}.opus`;
    },
  );
  let failure: Error = new Error("network went away");
  // YouTube streams; anything else downloads. Both fail alike.
  for (const method of ["streamVideo", "downloadVideo"])
    Reflect.set(catalog, method, async () => {
      throw failure;
    });
  // A video that will not download plays as audio, and says so.
  expect(await catalog.prepareVideo(trackFixture, "media", "a")).toEqual({
    filePath: "media/a.opus",
    form: "audio",
    fellBack: true,
  });
  // What video mode refuses stays refused.
  failure = extractorFailure("ERROR: [youtube] x: Sign in to confirm your age");
  await expect(
    catalog.prepareVideo(trackFixture, "media", "b"),
  ).rejects.toThrow("That video is age-restricted");
  // A song with no official video is simply its audio, kept as it was.
  Reflect.set(catalog, "findMusicVideo", async () => undefined);
  const song = {
    ...trackFixture,
    canonicalUrl: "https://music.youtube.com/watch?v=abcdefghijk",
    kind: "song" as const,
  };
  expect(
    await catalog.prepareVideo(song, "media", "c", undefined, 0, {
      filePath: "package.json",
    }),
  ).toEqual({ filePath: "package.json", form: "audio" });
  // Kept with the gain it was levelled by.
  expect(
    await catalog.prepareVideo(song, "media", "c", undefined, 0, {
      filePath: "package.json",
      gainDb: -3.5,
    }),
  ).toEqual({ filePath: "package.json", form: "audio", gainDb: -3.5 });
  // A song's video that will not download leaves the song, quietly.
  Reflect.set(catalog, "findMusicVideo", async () => ({
    videoId: "zzzzzzzzzzz",
    title: "Song",
    artist: "Artist",
  }));
  expect(await catalog.prepareVideo(song, "media", "d")).toEqual({
    filePath: "media/d.opus",
    form: "audio",
  });
  expect(audioFor).toEqual(["a", "d"]);
});

test("reads integrated loudness and turns it into a bounded gain", () => {
  const summary = `[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -20.3 LUFS
    Threshold: -30.4 LUFS`;
  expect(summaryLoudness(summary)).toBe(-20.3);
  expect(
    summaryLoudness("  Integrated loudness:\n    I:  -70.0 LUFS"),
  ).toBeUndefined();
  expect(summaryLoudness("no summary")).toBeUndefined();
  expect(levelingGain(-20.3)).toBe(6);
  expect(levelingGain(-17)).toBe(3);
  expect(levelingGain(-8.4)).toBe(-5.6);
  expect(levelingGain(-50)).toBe(6);
});

/** A catalog whose extractor prints `metadata`, writing its arguments down. */
async function extracting(
  metadata: Record<string, unknown>,
  options: {
    loudnessNormalization?: boolean;
    preparationConcurrency?: number;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "huddlefm-extract-"));
  await writeFile(join(directory, "info.json"), JSON.stringify(metadata));
  const catalog = new TrackCatalog({
    durationSeconds: 1_200,
    downloadBytes: 100_000_000,
    ...options,
    video: {
      durationSeconds: 3_600,
      downloadBytes: 1_500_000_000,
      maxHeight: 720,
      maxFps: 30,
      cacheBytes: 0,
    },
    videoCacheDirectory: join(directory, "video"),
  });
  Reflect.set(catalog, "extractor", () => [
    "sh",
    "-c",
    `printf '%s\\n' "$@" > '${directory}/args'; cat '${directory}/info.json'`,
  ]);
  return {
    catalog,
    directory,
    args: async () => (await readFile(join(directory, "args"), "utf8")).trim(),
  };
}

const sound = {
  format_id: "234",
  vcodec: "none",
  acodec: "mp4a.40.2",
  url: "https://93.184.216.34/sound",
  http_headers: { "User-Agent": "yt-dlp" },
};
const picture = {
  format_id: "232",
  vcodec: "avc1.4D401F",
  acodec: "none",
  url: "https://93.184.216.34/picture",
  http_headers: { "User-Agent": "yt-dlp" },
};
const radio: TrackMetadata = {
  sourceInput: "https://www.youtube.com/watch?v=tRsQsTMvPNg",
  canonicalUrl: "https://www.youtube.com/watch?v=tRsQsTMvPNg",
  sourceId: "tRsQsTMvPNg",
  title: "Radio",
  artist: "Channel",
  kind: "video",
  live: true,
};

test("video mode plays a live stream YouTube serves as separate sound and picture", async () => {
  const { catalog, directory, args } = await extracting({
    is_live: true,
    requested_formats: [picture, sound],
  });
  try {
    expect(await catalog.prepareLive(radio, true)).toEqual({
      stream: {
        url: "https://93.184.216.34/sound",
        videoUrl: "https://93.184.216.34/picture",
        live: true,
        headers: { "User-Agent": "yt-dlp" },
      },
      form: "video",
    });
    // A picture and sound apart are asked for, and sound alone at last.
    expect(await args()).toContain("+ba");
    expect(
      (await args()).split("\n").find((arg) => arg.includes("+ba")),
    ).toEndWith("/w/ba");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a live stream with only its sound to play shows the card", async () => {
  const { catalog, directory } = await extracting({
    is_live: true,
    vcodec: "none",
    url: "https://93.184.216.34/sound",
  });
  try {
    expect(await catalog.prepareLive(radio, true)).toMatchObject({
      stream: { url: "https://93.184.216.34/sound", live: true },
      form: "audio",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a YouTube video streams in video mode instead of downloading first", async () => {
  const { catalog, directory } = await extracting({
    duration: 1_873,
    requested_formats: [picture, sound],
    chapters: [
      { start_time: 0, end_time: 60, title: "Intro" },
      { start_time: 60, end_time: 1_873, title: "Talk" },
    ],
  });
  Reflect.set(catalog, "downloadVideo", async () => {
    throw new Error("downloaded");
  });
  try {
    const prepared = await catalog.prepareVideo(
      { ...trackFixture, duration: 1_873 },
      join(directory, "media"),
      "entry",
    );
    expect(prepared).toEqual({
      stream: {
        url: "https://93.184.216.34/sound",
        videoUrl: "https://93.184.216.34/picture",
        headers: { "User-Agent": "yt-dlp" },
      },
      form: "video",
      chapters: [
        { start: 0, title: "Intro" },
        { start: 60, title: "Talk" },
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("video mode streams a link from the extraction that resolved it, once", async () => {
  const resolved = {
    duration: 1_873,
    requested_formats: [picture, sound],
    chapters: [
      { start_time: 0, end_time: 60, title: "Intro" },
      { start_time: 60, end_time: 1_873, title: "Talk" },
    ],
  };
  const { catalog, directory } = await extracting({
    duration: 1_873,
    requested_formats: [picture, sound],
  });
  const extracted = () => Bun.file(join(directory, "args")).exists();
  try {
    // Resolved for music: its format is the audio's, so it is not reused.
    Reflect.get(catalog, "rememberExtraction").call(
      catalog,
      trackFixture.canonicalUrl,
      resolved,
    );
    await catalog.prepareVideo(trackFixture, join(directory, "media"), "a");
    expect(await extracted()).toBeTrue();
    await rm(join(directory, "args"));
    // Resolved in video mode: streamed from that extraction, chapters and all.
    Reflect.get(catalog, "rememberExtraction").call(
      catalog,
      trackFixture.canonicalUrl,
      resolved,
      true,
    );
    const prepared = await catalog.prepareVideo(
      trackFixture,
      join(directory, "media"),
      "b",
    );
    expect(await extracted()).toBeFalse();
    expect(prepared.chapters).toEqual([
      { start: 0, title: "Intro" },
      { start: 60, title: "Talk" },
    ]);
    // Prepared again, as after a stream fails, it is extracted afresh.
    await catalog.prepareVideo(trackFixture, join(directory, "media"), "c");
    expect(await extracted()).toBeTrue();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a video's loudness is measured once, kept, and waited on only briefly", async () => {
  const kept = new Map<string, number>();
  const catalog = new TrackCatalog(
    {
      durationSeconds: 1_200,
      downloadBytes: 100_000_000,
      loudnessNormalization: true,
    },
    {
      loudness: (source) => kept.get(source),
      setLoudness: (source, lufs) => kept.set(source, lufs),
    },
  );
  Reflect.set(catalog, "levelingWait", 20);
  const level = (
    sourceId: string,
    measure: () => Promise<number | undefined>,
  ) =>
    Reflect.apply(Reflect.get(catalog, "level"), catalog, [
      { url: `https://www.youtube.com/watch?v=${sourceId}`, sourceId },
      measure,
    ]) as Promise<{ gainDb?: number; leveling?: Promise<number | undefined> }>;
  // Measured in time: it plays levelled from the start, and is kept.
  expect(await level("abcdefghijk", async () => -20)).toEqual({ gainDb: 6 });
  expect(kept.get("youtube:abcdefghijk")).toBe(-20);
  // Known: never measured again.
  let measured = 0;
  expect(await level("abcdefghijk", async () => (measured++, -5))).toEqual({
    gainDb: 6,
  });
  expect(measured).toBe(0);
  // Too slow: it plays at once, and the gain follows.
  let finish = (_lufs: number) => {};
  const slow = await level(
    "zzzzzzzzzzz",
    () => new Promise<number>((resolve) => (finish = resolve)),
  );
  expect(slow.gainDb).toBeUndefined();
  finish(-11);
  expect(await slow.leveling).toBe(-3);
  expect(kept.get("youtube:zzzzzzzzzzz")).toBe(-11);
  // Nothing to measure, or a failure: no gain, and nothing kept.
  expect(await level("yyyyyyyyyyy", async () => undefined)).toEqual({});
  expect(
    await level("xxxxxxxxxxx", async () => {
      throw new Error("no sound");
    }),
  ).toEqual({});
  expect(kept.has("youtube:xxxxxxxxxxx")).toBeFalse();
});

test("videos are not levelled when loudness normalization is off", async () => {
  const catalog = testCatalog();
  let measured = 0;
  expect(
    (await Reflect.apply(Reflect.get(catalog, "level"), catalog, [
      trackFixture,
      async () => (measured++, -20),
    ])) as object,
  ).toEqual({});
  expect(measured).toBe(0);
});

test("a streamed video is extracted and measured in turn with other preparations", async () => {
  const { catalog, directory } = await extracting(
    { duration: 1_873, requested_formats: [picture, sound] },
    { loudnessNormalization: true, preparationConcurrency: 1 },
  );
  let measuring: number | undefined;
  Reflect.set(catalog, "measureStreamed", async () => {
    measuring = Reflect.get(catalog, "activePreparations") as number;
    return -20;
  });
  // Something else is preparing, and holds the only slot.
  let release = () => {};
  const busy = Reflect.apply(
    Reflect.get(catalog, "queuePreparation"),
    catalog,
    [0, "other", trackFixture, () => new Promise<void>((r) => (release = r))],
  ) as Promise<void>;
  try {
    const preparing = catalog.prepareVideo(
      { ...trackFixture, duration: 1_873 },
      join(directory, "media"),
      "entry",
    );
    await Bun.sleep(50);
    // Not even extracted while the slot is taken.
    expect(await Bun.file(join(directory, "args")).exists()).toBeFalse();
    release();
    await busy;
    const prepared = await preparing;
    expect(prepared.stream).toBeDefined();
    expect(prepared.gainDb).toBe(6);
    // Measured in a slot of its own.
    expect(measuring).toBe(1);
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("caching a streamed video measures nothing when normalization is off", async () => {
  const { catalog, directory } = await extracting({});
  let measured = 0;
  Reflect.set(catalog, "measured", async () => (measured++, -20));
  let cached = 0;
  Reflect.set(catalog, "downloadVideo", async () => (cached++, "video.mkv"));
  try {
    Reflect.apply(Reflect.get(catalog, "cacheStreamed"), catalog, [
      trackFixture,
      "key",
    ]);
    await (Reflect.get(catalog, "caching") as Map<string, Promise<void>>).get(
      "key",
    );
    expect(cached).toBe(1);
    expect(measured).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a streamed video goes through the relay when its length is known", async () => {
  const withLength = (format: Record<string, unknown>, size: number) => ({
    ...format,
    url: `${format.url}?clen=${size}`,
  });
  const { catalog, directory } = await extracting({
    duration: 1_873,
    requested_formats: [withLength(picture, 78), withLength(sound, 32)],
  });
  const registered: string[] = [];
  Reflect.set(
    catalog,
    "relay",
    new StreamRelay({
      origin: () => "http://127.0.0.1:3210",
      proxy: () => undefined,
    }),
  );
  const relay = Reflect.get(catalog, "relay") as StreamRelay;
  const register = relay.register.bind(relay);
  relay.register = (url, headers) => (
    registered.push(url),
    register(url, headers)
  );
  try {
    const { stream } = await catalog.prepareVideo(
      { ...trackFixture, duration: 1_873 },
      join(directory, "media"),
      "entry",
    );
    expect(registered).toEqual([
      "https://93.184.216.34/sound?clen=32",
      "https://93.184.216.34/picture?clen=78",
    ]);
    expect(stream).toMatchObject({ local: true });
    expect(stream!.url).toStartWith("http://127.0.0.1:3210/stream/");
    expect(stream!.videoUrl).toStartWith("http://127.0.0.1:3210/stream/");
    // The relay sends YouTube's headers itself.
    expect(stream!.headers).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a streamed video without a known length is read directly", async () => {
  const { catalog, directory } = await extracting({
    duration: 1_873,
    requested_formats: [picture, sound],
  });
  Reflect.set(
    catalog,
    "relay",
    new StreamRelay({
      origin: () => "http://127.0.0.1:3210",
      proxy: () => undefined,
    }),
  );
  try {
    const { stream } = await catalog.prepareVideo(
      { ...trackFixture, duration: 1_873 },
      join(directory, "media"),
      "entry",
    );
    expect(stream).toMatchObject({
      url: "https://93.184.216.34/sound",
      videoUrl: "https://93.184.216.34/picture",
    });
    expect(stream!.local).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
