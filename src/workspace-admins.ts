import { logger } from "./logger.ts";

const log = logger.child({ component: "workspace-admins" });

// Admin and owner roles change rarely, so a cached answer stays usable while a
// refresh runs in the background; a promotion or demotion in Slack takes effect
// within this window.
export const adminCacheTtlMs = 600_000;

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
      now?: () => number;
    },
  ) {}

  get enabled() {
    return this.options.enabled;
  }

  isAdmin(userId: string) {
    if (!this.options.enabled) return false;
    const cached = this.cache.get(userId);
    if (!cached) return false;
    if (this.isStale(cached)) void this.fetch(userId);
    return cached.admin;
  }

  // Awaiting this before a permission check means an admin's very first action
  // already counts; a cached answer keeps every later action synchronous.
  resolve(userId: string) {
    if (!this.options.enabled) return Promise.resolve(false);
    const cached = this.cache.get(userId);
    if (!cached) return this.fetch(userId);
    if (this.isStale(cached)) void this.fetch(userId);
    return Promise.resolve(cached.admin);
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
    const request = this.lookup(userId)
      .then((admin) => {
        this.cache.set(userId, { admin, fetchedAt: this.now() });
        return admin;
      })
      .catch((error) => {
        log.warn(
          { event: "admin_lookup_failed", userId, err: error },
          "Slack workspace admin lookup failed",
        );
        // Answering from the last known state, or "not an admin" without one,
        // keeps a lookup outage from handing out host powers. The cache is left
        // untouched so the next check retries instead of trusting the failure.
        return this.cache.get(userId)?.admin ?? false;
      })
      .finally(() => this.pending.delete(userId));
    this.pending.set(userId, request);
    return request;
  }
}
