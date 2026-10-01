import { logger } from "./logger.ts";
import { adminCacheTtlMs, adminLookupTimeoutMs } from "./workspace-admins.ts";

const log = logger.child({ component: "channel-managers" });

export type ChannelManagerLookup = (channelId: string) => Promise<string[]>;

// Tracks who manages each channel so a session's channel managers can always
// end it. Permission checks are synchronous, so they read the cache this fills;
// resolve() populates it before the checks that matter run. Answers are reused
// for as long as workspace admin answers, and a lookup gets the same deadline.
export class ChannelManagers {
  private cache = new Map<
    string,
    { managers: Set<string>; fetchedAt: number }
  >();
  private pending = new Map<string, Promise<Set<string>>>();

  constructor(
    private lookup: ChannelManagerLookup,
    private options: {
      ttlMs?: number;
      timeoutMs?: number;
      now?: () => number;
    } = {},
  ) {}

  isManager(channelId: string, userId: string) {
    return this.fresh(channelId)?.managers.has(userId) === true;
  }

  // A fresh answer keeps every later check synchronous; one too old to trust
  // is confirmed with Slack rather than extended.
  async resolve(channelId: string, userId: string) {
    // Direct messages have no channel managers to ask about.
    if (channelId.startsWith("D")) return false;
    const cached = this.fresh(channelId);
    const managers = cached ? cached.managers : await this.fetch(channelId);
    return managers.has(userId);
  }

  // The cached answer, unless it is older than the TTL.
  private fresh(channelId: string) {
    const cached = this.cache.get(channelId);
    const ttlMs = this.options.ttlMs ?? adminCacheTtlMs;
    return cached && this.now() - cached.fetchedAt < ttlMs ? cached : undefined;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private fetch(channelId: string) {
    const existing = this.pending.get(channelId);
    if (existing) return existing;
    const request = this.bounded(channelId)
      .then((ids) => {
        const managers = new Set(ids);
        this.cache.set(channelId, { managers, fetchedAt: this.now() });
        return managers;
      })
      .catch((error) => {
        log.warn(
          { event: "channel_manager_lookup_failed", channelId, err: error },
          "Slack channel manager lookup failed",
        );
        // A lookup outage must not hand out or extend the power to end a
        // session, so forget what Slack last said and ask again next time.
        this.cache.delete(channelId);
        return new Set<string>();
      })
      .finally(() => this.pending.delete(channelId));
    this.pending.set(channelId, request);
    return request;
  }

  // Covers the whole lookup, so a stalled call cannot hold up an interaction.
  private bounded(channelId: string) {
    const timeoutMs = this.options.timeoutMs ?? adminLookupTimeoutMs;
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`Channel manager lookup timed out after ${timeoutMs}ms`),
          ),
        timeoutMs,
      );
      this.lookup(channelId)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }
}
