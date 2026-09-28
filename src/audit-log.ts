import { appendFile, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.ts";
import { usageLabels, type UsageCounts, type UsageKey } from "./store.ts";

const log = logger.child({ component: "audit" });

const usageEvents: Record<string, UsageKey> = {
  "track.added": "added",
  "track.removed": "removed",
  "track.skipped": "next",
  "track.previous": "previous",
  "playback.paused": "paused",
  "playback.resumed": "resumed",
  "volume.changed": "volume",
  "queue.reordered": "reordered",
  "queue.shuffled": "shuffled",
  "queue.cleared": "cleared",
  "settings.changed": "settings",
};

export class AuditLog {
  private pending = Promise.resolve();

  constructor(
    private path = "data/audit.jsonl",
    private resolveName: (id: string) => Promise<string> = async (id) => id,
    private capture: (
      event: string,
      actorId: string | undefined,
      details: Record<string, unknown>,
    ) => void = () => {},
  ) {
    mkdirSync(dirname(path), { recursive: true });
    log.debug({ event: "initialized", path }, "Audit log initialized");
  }

  record(
    event: string,
    actorId: string | undefined,
    details: Record<string, unknown> = {},
  ) {
    this.capture(event, actorId, details);
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
    const counts = Object.fromEntries(
      Object.keys(usageLabels).map((key) => [key, 0]),
    ) as UsageCounts;
    const contents = await readFile(this.path, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      },
    );
    const lines = contents.split("\n");
    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        const key = usageEvents[entry.event];
        if (key) counts[key]++;
        if (entry.event === "playback.seeked") {
          if (Number(entry.seconds) > Number(entry.previous)) counts.forward++;
          if (Number(entry.seconds) < Number(entry.previous)) counts.back++;
        }
      } catch {
        malformed++;
      }
    }
    log.info(
      { event: "usage_loaded", malformed, entries: lines.length - 1 },
      "Loaded historical audit usage",
    );
    return counts;
  }
}
