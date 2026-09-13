import { logger } from "./logger.ts";

const log = logger.child({ component: "workspace-admins" });

// Admin and owner roles change rarely, so an answer is reused for this long; a
// promotion or demotion in Slack takes effect within the window.
export const adminCacheTtlMs = 600_000;

// Permission checks wait on a lookup, so it needs a deadline of its own: the
// Slack client has no timeout by default, and a stalled call would otherwise
// hold up an interaction or an agent command indefinitely.
export const adminLookupTimeoutMs = 5_000;

export type WorkspaceAdminLookup = (userId: string) => Promise<boolean>;

// Tracks which users are Slack workspace admins so sessions can treat them as
// managers. Permission checks are synchronous, so they read the cache this
// fills; resolve() populates it before the checks that matter run.
export class WorkspaceAdmins {
  private cache = new Map<string, { admin: boolean; fetchedAt: number }>();
  private pending = new Map<string, Promise<boolean>>();

  constructor(
    private lookup: WorkspaceAdminLookup,
    private options: {
      enabled: boolean;
      ttlMs?: number;
      timeoutMs?: number;
      now?: () => number;
    },
  ) {}

  get enabled() {
    return this.options.enabled;
  }

  isAdmin(userId: string) {
    if (!this.options.enabled) return false;
    const cached = this.cache.get(userId);
    return cached !== undefined && !this.isStale(cached) && cached.admin;
  }

  // Awaiting this before a permission check means an admin's very first action
  // already counts, and that an answer too old to trust is confirmed with Slack
  // rather than extended. A fresh answer keeps every later check synchronous.
  resolve(userId: string) {
    if (!this.options.enabled) return Promise.resolve(false);
    const cached = this.cache.get(userId);
    if (cached && !this.isStale(cached)) return Promise.resolve(cached.admin);
    return this.fetch(userId);
  }

  private isStale(entry: { fetchedAt: number }) {
    return (
      this.now() - entry.fetchedAt >= (this.options.ttlMs ?? adminCacheTtlMs)
    );
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private fetch(userId: string) {
    const existing = this.pending.get(userId);
    if (existing) return existing;
    const request = this.bounded(userId)
      .then((admin) => {
        this.cache.set(userId, { admin, fetchedAt: this.now() });
        return admin;
      })
      .catch((error) => {
        log.warn(
          { event: "admin_lookup_failed", userId, err: error },
          "Slack workspace admin lookup failed",
        );
        // A lookup outage must not hand out or extend host powers, so forget
        // what Slack last said: this check is denied, and the next one asks
        // again rather than trusting the failure either way.
        this.cache.delete(userId);
        return false;
      })
      .finally(() => this.pending.delete(userId));
    this.pending.set(userId, request);
    return request;
  }

  // Covers the whole lookup, retries inside the Slack client included.
  private bounded(userId: string) {
    const timeoutMs = this.options.timeoutMs ?? adminLookupTimeoutMs;
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Admin lookup timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.lookup(userId)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }
}
