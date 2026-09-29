import { redactSecrets, safeError } from "./error-message.ts";

export type RecentLogLine = Record<string, unknown> & {
  time: string;
  level: string;
};

// Mirrors the logger's redact paths: these never leave the process.
const secretKeys = new Set([
  "authorization",
  "cookie",
  "token",
  "bridgeToken",
  "xapp",
  "xoxp",
  "xoxc",
  "xoxd",
  "lastFmApiKey",
  "lastFmSharedSecret",
  "lastFmSessionKey",
  "listenBrainzToken",
]);
// Every line carries these, so they say nothing about the session.
const skippedKeys = new Set(["service", "pid", "hostname"]);

/**
 * The last lines logged about each session, kept in memory so a fallback
 * report can include what led up to it after the log files have rotated.
 * Lines are filed under every session and media session ID they carry, and
 * only the most recently active sessions are kept.
 */
export class RecentLogs {
  private lines = new Map<string, RecentLogLine[]>();
  // Orders lines logged within the same millisecond.
  private order = new WeakMap<RecentLogLine, number>();
  private sequence = 0;

  constructor(
    private perSession = 200,
    private sessions = 50,
  ) {}

  record(
    level: string,
    fields: Record<string, unknown>,
    message: string | undefined,
  ) {
    const keys = [fields.sessionId, fields.mediaSessionId].filter(
      (value, index, all): value is string =>
        typeof value === "string" && all.indexOf(value) === index,
    );
    if (!keys.length) return;
    const line: RecentLogLine = { time: new Date().toISOString(), level };
    for (const [key, value] of Object.entries(fields)) {
      if (secretKeys.has(key) || skippedKeys.has(key)) continue;
      if (key === "err") line.error = safeError(value);
      else if (typeof value === "string")
        line[key] = redactSecrets(value).slice(0, 1_000);
      else if (typeof value === "number" || typeof value === "boolean")
        line[key] = value;
    }
    if (message) line.msg = redactSecrets(message).slice(0, 1_000);
    this.order.set(line, ++this.sequence);
    for (const key of keys) {
      const lines = this.lines.get(key) ?? [];
      // Re-inserting moves the session to the back of the eviction order.
      this.lines.delete(key);
      this.lines.set(key, lines);
      lines.push(line);
      if (lines.length > this.perSession) lines.shift();
    }
    while (this.lines.size > this.sessions)
      this.lines.delete(this.lines.keys().next().value!);
  }

  /** The lines filed under any of `keys`, oldest first, each once. */
  take(...keys: (string | undefined)[]) {
    const lines = new Set<RecentLogLine>();
    for (const key of keys)
      for (const line of (key && this.lines.get(key)) || []) lines.add(line);
    return [...lines].sort((a, b) => this.order.get(a)! - this.order.get(b)!);
  }
}

export const recentLogs = new RecentLogs();
