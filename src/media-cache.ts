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
import type { Chapter } from "./videos.ts";

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
  /** A video's chapters. */
  chapters?: Chapter[];
  /** A video's captions, as SRT. */
  captions?: string;
  /**
   * The media file's extension, when not the cache's own: songs are kept in
   * Matroska now, and in Opus before.
   */
  format?: string;
  /**
   * What the song is turned by as it plays to reach the loudness target.
   * Absent for one normalized as it was prepared, as every song cached
   * before levelling was, which plays as it is.
   */
  gainDb?: number;
};

/** Descriptions read at once while the cache is first read. */
const readConcurrency = 32;

type Stored = CachedMedia & { version: 1; createdAt: number };

type Indexed = { media: Stored; bytes: number; usedAt: number };

// Prepared tracks, kept across sessions and restarts so a song that is
// played again is linked into place instead of downloaded and analysed.
// Videos have a cache of their own, with files of their own extension.
// Entries are keyed by source and evicted least recently used first once
// the cache outgrows its limit. Caching is best-effort: any failure here is
// logged and the track is prepared as if the cache were empty.
export class MediaCache {
  private entries = new Map<string, Indexed>();
  private work: Promise<unknown> = Promise.resolve();

  constructor(
    private directory: string,
    private limits: { maxBytes: number; maxAgeMs: number },
    /** The extension of the media files it keeps. */
    private extension = "opus",
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
      const keys = names.flatMap(
        (name) => name.match(/^([0-9a-f]{32})\.json$/)?.[1] ?? [],
      );
      // A few at a time: a large cache reads in a fraction of the time it
      // took one by one, without opening thousands of files at once.
      for (let start = 0; start < keys.length; start += readConcurrency) {
        const batch = keys.slice(start, start + readConcurrency);
        const read = await Promise.all(batch.map((key) => this.read(key)));
        for (const [index, entry] of read.entries()) {
          const key = batch[index]!;
          if (!entry) continue;
          this.entries.set(key, entry);
          kept.add(`${key}.json`).add(this.fileName(key, entry.media));
          if (entry.media.cover) kept.add(`${key}.cover.jpg`);
        }
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
   * is one, and describes it. Returns nothing on a miss. `audioPath` can be
   * given the file's extension, to name the link for what it holds.
   */
  restore(
    key: string,
    audioPath: string | ((extension: string) => string),
    coverPath: string,
  ) {
    if (!this.enabled) return Promise.resolve(undefined);
    return this.serialized(async (): Promise<CachedMedia | undefined> => {
      const entry = this.entries.get(key);
      if (!entry) return;
      if (this.expired(entry)) {
        await this.remove(key);
        return;
      }
      const format = entry.media.format ?? this.extension;
      const target =
        typeof audioPath === "string" ? audioPath : audioPath(format);
      try {
        await linkOrCopy(this.path(this.fileName(key, entry.media)), target);
        if (entry.media.cover)
          await linkOrCopy(this.path(`${key}.cover.jpg`), coverPath);
      } catch (error) {
        await Promise.all([
          rm(target, { force: true }),
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
      const {
        duration,
        transition,
        embedded,
        cover,
        chapters,
        captions,
        gainDb,
      } = entry.media;
      return {
        duration,
        transition,
        embedded,
        cover,
        chapters,
        captions,
        ...(entry.media.format ? { format } : {}),
        ...(gainDb === undefined ? {} : { gainDb }),
      };
    });
  }

  /** Keeps a copy of a prepared track, linking it where the disk allows. */
  store(key: string, audioPath: string, coverPath: string, media: CachedMedia) {
    if (!this.enabled) return Promise.resolve();
    return this.serialized(async () => {
      const suffix = crypto.randomUUID();
      const temporary = (name: string) => this.path(`${key}.${suffix}.${name}`);
      const extension = media.format ?? this.extension;
      const previous = this.entries.get(key);
      let replacing = false;
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
        await linkOrCopy(audioPath, temporary(extension));
        if (cover) await linkOrCopy(cover, temporary("cover.jpg"));
        await writeFile(temporary("json"), JSON.stringify(stored));
        // An entry exists once its description does, so that goes last.
        replacing = true;
        await rm(this.path(`${key}.json`), { force: true });
        // What it replaces may have been kept in another format.
        if (
          previous &&
          this.fileName(key, previous.media) !== `${key}.${extension}`
        )
          await rm(this.path(this.fileName(key, previous.media)), {
            force: true,
          });
        await rename(temporary(extension), this.path(`${key}.${extension}`));
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
          [extension, "cover.jpg", "json"].map((name) =>
            rm(temporary(name), { force: true }),
          ),
        );
        // A replacement that stopped partway leaves neither entry intact, and
        // what it did move would otherwise sit outside the size limit.
        if (replacing) await this.remove(key).catch(() => undefined);
        await rm(this.path(`${key}.${extension}`), { force: true });
      }
    });
  }

  private async read(key: string): Promise<Indexed | undefined> {
    try {
      const description = this.path(`${key}.json`);
      const media = JSON.parse(await readFile(description, "utf8")) as Stored;
      if (!validStored(media)) return;
      const [audio, cover, used] = await Promise.all([
        stat(this.path(this.fileName(key, media))),
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
    const media = this.entries.get(key)?.media;
    this.entries.delete(key);
    // The description goes first so a partial removal reads as no entry.
    await rm(this.path(`${key}.json`), { force: true });
    // All go before a failure is reported, so it never leaves another
    // half-removed behind it.
    const files = new Set([
      `${key}.${this.extension}`,
      ...(media ? [this.fileName(key, media)] : []),
      `${key}.cover.jpg`,
    ]);
    const failed = (
      await Promise.allSettled(
        [...files].map((name) => rm(this.path(name), { force: true })),
      )
    ).find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  /** The name of an entry's media file, in the format it was kept in. */
  private fileName(key: string, media: Pick<CachedMedia, "format">) {
    return `${key}.${media.format ?? this.extension}`;
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

function validStored(media: Stored) {
  const { transition, embedded, format, gainDb } = media ?? {};
  return (
    media?.version === 1 &&
    media.duration > 0 &&
    typeof media.createdAt === "number" &&
    typeof media.cover === "boolean" &&
    (format === undefined ||
      (typeof format === "string" && /^[a-z0-9]{1,8}$/.test(format))) &&
    (gainDb === undefined || Number.isFinite(gainDb)) &&
    (embedded === undefined ||
      (typeof embedded === "object" && embedded !== null)) &&
    typeof transition === "object" &&
    transition !== null &&
    [
      transition.introSeconds,
      transition.outroSeconds,
      transition.fadeInSeconds,
      transition.fadeOutSeconds,
    ].every(Number.isFinite)
  );
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
