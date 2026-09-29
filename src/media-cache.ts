import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { logger } from "./logger.ts";
import type { EmbeddedMetadata, TransitionData } from "./tracks.ts";

const log = logger.child({ component: "media-cache" });

/** What a prepared track needs besides its audio to be played again. */
export type CachedMedia = {
  duration: number;
  transition: TransitionData;
  /**
   * Tags read from the source before conversion. Absent when the source was
   * not kept for them, so a request that needs them downloads again.
   */
  embedded?: EmbeddedMetadata;
  cover: boolean;
};

type Stored = CachedMedia & { version: 1; createdAt: number };

type Indexed = { media: Stored; bytes: number; usedAt: number };

// Prepared tracks, kept across sessions and restarts so a song that is
// played again is linked into place instead of downloaded and analysed.
// Entries are keyed by source and evicted least recently used first once
// the cache outgrows its limit. Caching is best-effort: any failure here is
// logged and the track is prepared as if the cache were empty.
export class MediaCache {
  private entries = new Map<string, Indexed>();
  private work: Promise<unknown> = Promise.resolve();

  constructor(
    private directory: string,
    private limits: { maxBytes: number; maxAgeMs: number },
  ) {}

  get enabled() {
    return this.limits.maxBytes > 0;
  }

  async initialize() {
    if (!this.enabled) {
      // A disabled cache keeps nothing, including what an earlier run left.
      await rm(this.directory, { recursive: true, force: true });
      return;
    }
    await this.serialized(async () => {
      await mkdir(this.directory, { recursive: true });
      const names = await readdir(this.directory);
      const kept = new Set<string>();
      for (const name of names) {
        const key = name.match(/^([0-9a-f]{32})\.json$/)?.[1];
        const entry = key && (await this.read(key));
        if (!key || !entry) continue;
        this.entries.set(key, entry);
        kept.add(name).add(`${key}.opus`);
        if (entry.media.cover) kept.add(`${key}.cover.jpg`);
      }
      // Interrupted writes and files whose description is missing or corrupt.
      await Promise.all(
        names
          .filter((name) => !kept.has(name))
          .map((name) => rm(this.path(name), { force: true })),
      );
      await this.evict();
      log.info(
        {
          event: "initialized",
          entries: this.entries.size,
          bytes: this.totalBytes(),
          maxBytes: this.limits.maxBytes,
        },
        "Media cache initialized",
      );
    });
  }

  /**
   * Links a cached track to `audioPath`, and its cover next to it when there
   * is one, and describes it. Returns nothing on a miss.
   */
  restore(key: string, audioPath: string, coverPath: string) {
    if (!this.enabled) return Promise.resolve(undefined);
    return this.serialized(async (): Promise<CachedMedia | undefined> => {
      const entry = this.entries.get(key);
      if (!entry) return;
      if (this.expired(entry)) {
        await this.remove(key);
        return;
      }
      try {
        await linkOrCopy(this.path(`${key}.opus`), audioPath);
        if (entry.media.cover)
          await linkOrCopy(this.path(`${key}.cover.jpg`), coverPath);
      } catch (error) {
        await Promise.all([
          rm(audioPath, { force: true }),
          rm(coverPath, { force: true }),
        ]);
        log.warn(
          { event: "restore_failed", key, err: error },
          "Could not restore cached track",
        );
        await this.remove(key);
        return;
      }
      entry.usedAt = Date.now();
      const usedAt = new Date(entry.usedAt);
      await utimes(this.path(`${key}.json`), usedAt, usedAt).catch(
        () => undefined,
      );
      const { duration, transition, embedded, cover } = entry.media;
      return { duration, transition, embedded, cover };
    });
  }

  /** Keeps a copy of a prepared track, linking it where the disk allows. */
  store(key: string, audioPath: string, coverPath: string, media: CachedMedia) {
    if (!this.enabled) return Promise.resolve();
    return this.serialized(async () => {
      const suffix = crypto.randomUUID();
      const temporary = (name: string) => this.path(`${key}.${suffix}.${name}`);
      try {
        await mkdir(this.directory, { recursive: true });
        const cover =
          media.cover && (await Bun.file(coverPath).exists())
            ? coverPath
            : undefined;
        const bytes =
          (await stat(audioPath)).size + (cover ? (await stat(cover)).size : 0);
        if (bytes > this.limits.maxBytes) return;
        const stored: Stored = {
          ...media,
          cover: Boolean(cover),
          version: 1,
          createdAt: Date.now(),
        };
        await linkOrCopy(audioPath, temporary("opus"));
        if (cover) await linkOrCopy(cover, temporary("cover.jpg"));
        await writeFile(temporary("json"), JSON.stringify(stored));
        // An entry exists once its description does, so that goes last.
        await rm(this.path(`${key}.json`), { force: true });
        await rename(temporary("opus"), this.path(`${key}.opus`));
        if (cover)
          await rename(temporary("cover.jpg"), this.path(`${key}.cover.jpg`));
        else await rm(this.path(`${key}.cover.jpg`), { force: true });
        await rename(temporary("json"), this.path(`${key}.json`));
        this.entries.set(key, { media: stored, bytes, usedAt: Date.now() });
        log.debug({ event: "stored", key, bytes }, "Track cached");
        await this.evict();
      } catch (error) {
        log.warn(
          { event: "store_failed", key, err: error },
          "Could not cache track",
        );
        await Promise.all(
          ["opus", "cover.jpg", "json"].map((name) =>
            rm(temporary(name), { force: true }),
          ),
        );
      }
    });
  }

  private async read(key: string): Promise<Indexed | undefined> {
    try {
      const description = this.path(`${key}.json`);
      const media = JSON.parse(await readFile(description, "utf8")) as Stored;
      if (media.version !== 1 || !(media.duration > 0)) return;
      const [audio, cover, used] = await Promise.all([
        stat(this.path(`${key}.opus`)),
        media.cover ? stat(this.path(`${key}.cover.jpg`)) : undefined,
        stat(description),
      ]);
      return {
        media,
        bytes: audio.size + (cover?.size ?? 0),
        usedAt: used.mtimeMs,
      };
    } catch {
      return;
    }
  }

  private async evict() {
    const byAge = [...this.entries].sort(([, a], [, b]) => a.usedAt - b.usedAt);
    let total = this.totalBytes();
    let evicted = 0;
    for (const [key, entry] of byAge) {
      if (total <= this.limits.maxBytes && !this.expired(entry)) continue;
      await this.remove(key);
      total -= entry.bytes;
      evicted++;
    }
    if (evicted)
      log.info(
        { event: "evicted", evicted, entries: this.entries.size, bytes: total },
        "Media cache evicted tracks",
      );
  }

  private async remove(key: string) {
    this.entries.delete(key);
    // The description goes first so a partial removal reads as no entry.
    await rm(this.path(`${key}.json`), { force: true });
    await Promise.all([
      rm(this.path(`${key}.opus`), { force: true }),
      rm(this.path(`${key}.cover.jpg`), { force: true }),
    ]);
  }

  private expired(entry: Indexed) {
    return (
      this.limits.maxAgeMs > 0 &&
      Date.now() - entry.media.createdAt > this.limits.maxAgeMs
    );
  }

  private totalBytes() {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    return total;
  }

  private path(name: string) {
    return `${this.directory}/${name}`;
  }

  private serialized<T>(task: () => Promise<T>) {
    const result = this.work.then(task);
    this.work = result.catch(() => undefined);
    return result;
  }
}

// A hard link shares the file without copying it. Sessions only ever read
// and remove their media, so the cache and the session can share one file.
async function linkOrCopy(from: string, to: string) {
  try {
    await link(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    await copyFile(from, to);
  }
}
