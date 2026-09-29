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
