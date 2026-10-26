import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CachedMedia, MediaCache } from "./media-cache.ts";

const media: CachedMedia = {
  duration: 180,
  transition: {
    introSeconds: 1,
    outroSeconds: 178,
    fadeInSeconds: 0,
    fadeOutSeconds: 2,
  },
  cover: false,
};
const key = (index: number) => index.toString(16).padStart(32, "0");

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "huddlefm-media-cache-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("restores a stored track and its cover into a session", () =>
  withDirectory(async (directory) => {
    const cache = new MediaCache(join(directory, "cache"), {
      maxBytes: 1_000,
      maxAgeMs: 0,
    });
    await cache.initialize();
    const session = join(directory, "session");
    await mkdir(session);
    await writeFile(join(session, "a.opus"), "audio");
    await writeFile(join(session, "a.cover.jpg"), "cover");
    const embedded = { title: "Tagged" };
    await cache.store(
      key(1),
      join(session, "a.opus"),
      join(session, "a.cover.jpg"),
      { ...media, embedded, cover: true },
    );
    // The session's own copy goes away without taking the cached one with it.
    await rm(session, { recursive: true });
    await mkdir(session);

    expect(
      await cache.restore(
        key(1),
        join(session, "b.opus"),
        join(session, "b.cover.jpg"),
      ),
    ).toEqual({ ...media, embedded, cover: true });
    expect(await readFile(join(session, "b.opus"), "utf8")).toBe("audio");
    expect(await readFile(join(session, "b.cover.jpg"), "utf8")).toBe("cover");
    expect(
      await cache.restore(
        key(2),
        join(session, "c.opus"),
        join(session, "c.cover.jpg"),
      ),
    ).toBeUndefined();
    expect((await readdir(session)).sort()).toEqual(["b.cover.jpg", "b.opus"]);
  }));

test("evicts the least recently used tracks past the size limit", () =>
  withDirectory(async (directory) => {
    const cache = new MediaCache(join(directory, "cache"), {
      maxBytes: 20,
      maxAgeMs: 0,
    });
    await cache.initialize();
    const store = async (index: number) => {
      const path = join(directory, `${index}.opus`);
      await writeFile(path, "0123456789");
      await cache.store(key(index), path, join(directory, "none.jpg"), media);
      await Bun.sleep(2);
    };
    const restored = async (index: number) =>
      Boolean(
        await cache.restore(
          key(index),
          join(directory, `restored-${index}-${crypto.randomUUID()}.opus`),
          join(directory, "none.jpg"),
        ),
      );
    await store(1);
    await store(2);
    // Playing the first track again makes the second the oldest.
    expect(await restored(1)).toBe(true);
    await Bun.sleep(2);
    await store(3);

    expect(await restored(1)).toBe(true);
    expect(await restored(2)).toBe(false);
    expect(await restored(3)).toBe(true);
    // A track larger than the whole cache is not kept at all.
    const large = join(directory, "large.opus");
    await writeFile(large, "x".repeat(21));
    await cache.store(key(4), large, join(directory, "none.jpg"), media);
    expect(await restored(4)).toBe(false);
    expect(await restored(1)).toBe(true);
  }));

test("reloads its index after a restart and drops expired or partial files", () =>
  withDirectory(async (directory) => {
    const cacheDirectory = join(directory, "cache");
    const limits = { maxBytes: 1_000, maxAgeMs: 60_000 };
    const first = new MediaCache(cacheDirectory, limits);
    await first.initialize();
    for (const index of [1, 2]) {
      const path = join(directory, `${index}.opus`);
      await writeFile(path, "audio");
      await first.store(key(index), path, join(directory, "none.jpg"), media);
    }
    // The second entry was cached long ago; the rest is left by crashes.
    const description = join(cacheDirectory, `${key(2)}.json`);
    await writeFile(
      description,
      JSON.stringify({ ...media, version: 1, createdAt: 0 }),
    );
    await writeFile(join(cacheDirectory, `${key(3)}.opus`), "orphan");
    await writeFile(join(cacheDirectory, `${key(1)}.partial.opus`), "partial");
    await writeFile(join(cacheDirectory, `${key(5)}.json`), "not json");
    const old = new Date(0);
    await utimes(description, old, old);

    const second = new MediaCache(cacheDirectory, limits);
    await second.initialize();
    expect((await readdir(cacheDirectory)).sort()).toEqual([
      `${key(1)}.json`,
      `${key(1)}.opus`,
    ]);
    expect(
      await second.restore(
        key(1),
        join(directory, "restored.opus"),
        join(directory, "restored.jpg"),
      ),
    ).toEqual(media);
  }));

test("keeps songs in Matroska with their gain beside ones cached normalized in Opus", () =>
  withDirectory(async (directory) => {
    const cacheDirectory = join(directory, "cache");
    const limits = { maxBytes: 1_000, maxAgeMs: 0 };
    const first = new MediaCache(cacheDirectory, limits);
    await first.initialize();
    const legacy = join(directory, "legacy.opus");
    const levelled = join(directory, "levelled.mka");
    await writeFile(legacy, "normalized");
    await writeFile(levelled, "as it came");
    await first.store(key(1), legacy, join(directory, "none.jpg"), media);
    await first.store(key(2), levelled, join(directory, "none.jpg"), {
      ...media,
      format: "mka",
      gainDb: -4.5,
    });

    const second = new MediaCache(cacheDirectory, limits);
    await second.initialize();
    expect((await readdir(cacheDirectory)).sort()).toEqual([
      `${key(1)}.json`,
      `${key(1)}.opus`,
      `${key(2)}.json`,
      `${key(2)}.mka`,
    ]);
    const named = (stem: string) => (extension: string) =>
      join(directory, `${stem}.${extension}`);
    // One cached before levelling plays as it is, with no gain.
    expect(
      await second.restore(key(1), named("a"), join(directory, "a.jpg")),
    ).toEqual(media);
    expect(await readFile(join(directory, "a.opus"), "utf8")).toBe(
      "normalized",
    );
    expect(
      await second.restore(key(2), named("b"), join(directory, "b.jpg")),
    ).toEqual({ ...media, format: "mka", gainDb: -4.5 });
    expect(await readFile(join(directory, "b.mka"), "utf8")).toBe("as it came");
    // Prepared again, the old Opus file makes way for the new one.
    await second.store(key(1), levelled, join(directory, "none.jpg"), {
      ...media,
      format: "mka",
      gainDb: 2,
    });
    expect((await readdir(cacheDirectory)).sort()).toEqual([
      `${key(1)}.json`,
      `${key(1)}.mka`,
      `${key(2)}.json`,
      `${key(2)}.mka`,
    ]);
  }));

test("reads a cache larger than one batch of descriptions", () =>
  withDirectory(async (directory) => {
    const cacheDirectory = join(directory, "cache");
    await mkdir(cacheDirectory);
    const count = 75;
    for (let index = 1; index <= count; index++) {
      await writeFile(join(cacheDirectory, `${key(index)}.opus`), "audio");
      await writeFile(
        join(cacheDirectory, `${key(index)}.json`),
        JSON.stringify({ ...media, version: 1, createdAt: Date.now() }),
      );
    }
    const cache = new MediaCache(cacheDirectory, {
      maxBytes: 1_000,
      maxAgeMs: 0,
    });
    await cache.initialize();
    expect(await readdir(cacheDirectory)).toHaveLength(count * 2);
    for (const index of [1, 33, count])
      expect(
        await cache.restore(
          key(index),
          join(directory, `${index}.opus`),
          join(directory, `${index}.jpg`),
        ),
      ).toEqual(media);
  }));

test("a disabled cache keeps nothing", () =>
  withDirectory(async (directory) => {
    const cacheDirectory = join(directory, "cache");
    await mkdir(cacheDirectory);
    await writeFile(join(cacheDirectory, `${key(1)}.opus`), "audio");
    const cache = new MediaCache(cacheDirectory, { maxBytes: 0, maxAgeMs: 0 });
    await cache.initialize();
    expect(cache.enabled).toBe(false);
    expect(
      await Bun.file(join(cacheDirectory, `${key(1)}.opus`)).exists(),
    ).toBe(false);
    const path = join(directory, "a.opus");
    await writeFile(path, "audio");
    await cache.store(key(1), path, join(directory, "none.jpg"), media);
    expect(
      await cache.restore(
        key(1),
        join(directory, "b.opus"),
        join(directory, "b.jpg"),
      ),
    ).toBeUndefined();
  }));

test("forgets a track whose replacement failed partway", () =>
  withDirectory(async (directory) => {
    const cacheDirectory = join(directory, "cache");
    const cache = new MediaCache(cacheDirectory, {
      maxBytes: 1_000,
      maxAgeMs: 0,
    });
    await cache.initialize();
    const audio = join(directory, "a.opus");
    const cover = join(directory, "a.cover.jpg");
    await writeFile(audio, "audio");
    await writeFile(cover, "cover");
    await cache.store(key(1), audio, cover, media);
    // Something in the way of the cover makes the replacement fail after the
    // audio has already moved into place.
    await mkdir(join(cacheDirectory, `${key(1)}.cover.jpg`, "blocked"), {
      recursive: true,
    });
    await cache.store(key(1), audio, cover, { ...media, cover: true });

    expect(
      await cache.restore(
        key(1),
        join(directory, "b.opus"),
        join(directory, "b.cover.jpg"),
      ),
    ).toBeUndefined();
    expect(await readdir(cacheDirectory)).toEqual([`${key(1)}.cover.jpg`]);
  }));

test("ignores cached descriptions with malformed transitions", () =>
  withDirectory(async (directory) => {
    const cacheDirectory = join(directory, "cache");
    await mkdir(cacheDirectory);
    await writeFile(join(cacheDirectory, `${key(1)}.opus`), "audio");
    await writeFile(
      join(cacheDirectory, `${key(1)}.json`),
      JSON.stringify({
        ...media,
        transition: { introSeconds: "soon" },
        version: 1,
        createdAt: Date.now(),
      }),
    );
    const cache = new MediaCache(cacheDirectory, {
      maxBytes: 1_000,
      maxAgeMs: 0,
    });
    await cache.initialize();
    expect(await readdir(cacheDirectory)).toEqual([]);
  }));
