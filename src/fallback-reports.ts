import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./logger.ts";

const log = logger.child({ component: "fallback-reports" });
const reportIdPattern = /^[0-9a-f-]{36}$/;

/**
 * One JSON file per media fallback, holding everything known about it: why
 * it happened, what was playing, the logs leading up to it, how the switch
 * went, and what the person who pressed the button said. Parts arrive at
 * different times, so each is merged into the file as it comes. Writes are
 * serialized, so a later part never lands before the file exists.
 */
export class FallbackReports {
  private pending = Promise.resolve();
  private pruneTimer?: ReturnType<typeof setInterval>;

  constructor(
    private directory = "data/reports",
    private keep = 200,
    private maxAgeMs = 30 * 24 * 60 * 60_000,
  ) {}

  /** Merges `fields` into the report, creating its file on first use. */
  update(reportId: string, fields: Record<string, unknown>) {
    if (!reportIdPattern.test(reportId)) return Promise.resolve();
    const work = this.pending.then(async () => {
      try {
        await mkdir(this.directory, { recursive: true });
        const existing = await this.find(reportId);
        const path =
          existing ??
          join(
            this.directory,
            `${new Date().toISOString().replaceAll(":", "-")}-${reportId}.json`,
          );
        const current = existing
          ? (JSON.parse(await readFile(existing, "utf8")) as object)
          : { reportId, createdAt: new Date().toISOString() };
        await writeFile(
          path,
          `${JSON.stringify({ ...current, ...fields }, null, 2)}\n`,
        );
        if (!existing) await this.prune();
      } catch (error) {
        log.error(
          { event: "fallback_report_write_failed", reportId, err: error },
          "Could not write media fallback report",
        );
      }
    });
    this.pending = work;
    return work;
  }

  /**
   * Prunes now and then daily, so old reports go even when no new ones are
   * being written.
   */
  start(intervalMs = 24 * 60 * 60_000) {
    void this.cleanUp();
    this.pruneTimer = setInterval(() => void this.cleanUp(), intervalMs);
    this.pruneTimer.unref?.();
  }

  stop() {
    clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
  }

  /** Prunes in line with writes, so it never races one. */
  cleanUp() {
    const work = this.pending.then(async () => {
      try {
        await mkdir(this.directory, { recursive: true });
        await this.prune();
      } catch (error) {
        log.error(
          { event: "fallback_report_prune_failed", err: error },
          "Could not prune media fallback reports",
        );
      }
    });
    this.pending = work;
    return work;
  }

  /** Resolves once every write so far has finished. */
  flush() {
    return this.pending;
  }

  private async find(reportId: string) {
    const name = (await readdir(this.directory)).find((file) =>
      file.endsWith(`-${reportId}.json`),
    );
    return name && join(this.directory, name);
  }

  // Names start with their creation time, so they sort oldest first.
  private async prune() {
    const files = (await readdir(this.directory))
      .filter((file) => file.endsWith(".json"))
      .sort();
    const cutoff = new Date(Date.now() - this.maxAgeMs)
      .toISOString()
      .replaceAll(":", "-");
    const stale = files.filter(
      (file, index) => index < files.length - this.keep || file < cutoff,
    );
    await Promise.all(
      stale.map((file) => rm(join(this.directory, file), { force: true })),
    );
  }
}
