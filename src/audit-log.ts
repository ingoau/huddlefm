import { appendFile, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.ts";
import type { UsageCounts } from "./store.ts";

const log = logger.child({ component: "audit" });

export class AuditLog {
  private pending = Promise.resolve();

  constructor(
    private path = "data/audit.jsonl",
    private resolveName: (id: string) => Promise<string> = async (id) => id,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    log.debug({ event: "initialized", path }, "Audit log initialized");
  }

  record(
    event: string,
    actorId: string | undefined,
    details: Record<string, unknown> = {},
  ) {
    this.pending = this.pending
      .then(async () => {
        const id = actorId ?? "system";
        const name = actorId
          ? await this.resolveName(actorId).catch(() => actorId)
          : "HuddleFM";
        await appendFile(
          this.path,
          `${JSON.stringify({
            time: new Date().toISOString(),
            event,
            actor: { id, name },
            ...details,
          })}\n`,
        );
      })
      .catch((err) =>
        log.error({ event: "write_failed", err }, "Audit write failed"),
      );
  }

  flush() {
    return this.pending;
  }

  async historicalUsage() {
    await this.flush();
    let malformed = 0;
    const counts = {
      added: 0,
      removed: 0,
      next: 0,
      previous: 0,
      forward: 0,
      back: 0,
      paused: 0,
      resumed: 0,
      volume: 0,
      reordered: 0,
      cleared: 0,
      settings: 0,
    };
    const contents = await readFile(this.path, "utf8").catch((error) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return "";
      throw error;
    });
    for (const line of contents.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.event === "track.added") counts.added++;
        if (entry.event === "track.removed") counts.removed++;
        if (entry.event === "track.skipped") counts.next++;
        if (entry.event === "track.previous") counts.previous++;
        if (entry.event === "playback.paused") counts.paused++;
        if (entry.event === "playback.resumed") counts.resumed++;
        if (entry.event === "volume.changed") counts.volume++;
        if (entry.event === "queue.reordered") counts.reordered++;
        if (entry.event === "queue.cleared") counts.cleared++;
        if (entry.event === "settings.changed") counts.settings++;
        if (entry.event === "playback.seeked") {
          if (Number(entry.seconds) > Number(entry.previous)) counts.forward++;
          if (Number(entry.seconds) < Number(entry.previous)) counts.back++;
        }
      } catch {
        malformed++;
      }
    }
    log.info(
      {
        event: "usage_loaded",
        malformed,
        entries: contents.split("\n").length - 1,
      },
      "Loaded historical audit usage",
    );
    return counts satisfies UsageCounts;
  }
}
