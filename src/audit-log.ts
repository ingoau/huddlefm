import { appendFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class AuditLog {
  private pending = Promise.resolve();

  constructor(
    private path = "data/audit.jsonl",
    private resolveName: (id: string) => Promise<string> = async (id) => id,
  ) {
    mkdirSync(dirname(path), { recursive: true });
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
      .catch((error) =>
        console.error(
          `[audit] ${error instanceof Error ? error.message : error}`,
        ),
      );
  }

  flush() {
    return this.pending;
  }
}
