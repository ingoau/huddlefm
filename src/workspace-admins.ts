import type { RolePermissions } from "./config.ts";
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

// Tracks which users are Slack workspace admins so sessions can grant them
// WORKSPACE_ADMIN_PERMISSIONS. Permission checks are synchronous, so they read
// the cache this fills; resolve() populates it before the checks that matter
// run. Admins granted nothing are never looked up.
export class WorkspaceAdmins {
  private cache = new Map<string, { admin: boolean; fetchedAt: number }>();
  private pending = new Map<string, Promise<boolean>>();

  constructor(
    private lookup: WorkspaceAdminLookup,
    private options: {
      permissions: RolePermissions;
      ttlMs?: number;
      timeoutMs?: number;
      now?: () => number;
    },
  ) {}

  get permissions() {
    return this.options.permissions;
  }

  isAdmin(userId: string) {
    return (
      this.options.permissions !== "none" && this.fresh(userId)?.admin === true
    );
  }

  // Whether isAdmin can answer without asking Slack.
  known(userId: string) {
    return this.options.permissions === "none" || Boolean(this.fresh(userId));
  }

  // Awaiting this before a permission check means an admin's very first action
  // already counts, and that an answer too old to trust is confirmed with Slack
  // rather than extended. A fresh answer keeps every later check synchronous.
  resolve(userId: string) {
    if (this.options.permissions === "none") return Promise.resolve(false);
    const cached = this.fresh(userId);
    return cached ? Promise.resolve(cached.admin) : this.fetch(userId);
  }

  // The cached answer, unless it is older than the TTL.
  private fresh(userId: string) {
    const cached = this.cache.get(userId);
    const ttlMs = this.options.ttlMs ?? adminCacheTtlMs;
    return cached && this.now() - cached.fetchedAt < ttlMs ? cached : undefined;
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
        // A lookup outage must not hand out or extend any powers, so forget
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
