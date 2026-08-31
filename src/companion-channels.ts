import { logger } from "./logger.ts";
import type { SlackAppAdapter } from "./slack-app.ts";
import type { SlackHuddleAdapter } from "./slack-huddle.ts";
import type { Store } from "./store.ts";

const cleanupDelayMs = 10 * 60_000;
const log = logger.child({ component: "companion-channels" });

export function companionRemovalNotice(channelId: string) {
  return `I automatically removed you from <#${channelId}>. That channel is only for people currently in the Huddle. You’ll be added back if you join again.`;
}

export class CompanionChannels {
  private timer?: ReturnType<typeof setInterval>;
  private cleaning = false;
  private membership = new Map<string, Promise<void>>();

  constructor(
    private store: Store,
    private slack: Pick<
      SlackHuddleAdapter,
      | "ensureChannelAccess"
      | "createCompanionChannel"
      | "restrictCompanionPosting"
      | "inviteToChannel"
      | "removeFromChannel"
    >,
    private app: Pick<SlackAppAdapter, "dm" | "delete" | "channelMembers">,
    private userId: string,
  ) {}

  start() {
    this.timer = setInterval(() => void this.cleanup(), 5_000);
    void this.cleanup();
  }

  stop() {
    clearInterval(this.timer);
  }

  async prepare(sourceChannelId: string, hostId: string, force = false) {
    if (!force && (await this.slack.ensureChannelAccess(sourceChannelId)))
      return;
    let channelId = this.store.companionChannel(sourceChannelId);
    if (channelId && !(await this.slack.ensureChannelAccess(channelId))) {
      this.store.clearCompanionChannel(sourceChannelId);
      channelId = undefined;
    }
    if (!channelId) channelId = await this.create(sourceChannelId);
    await this.restrict(channelId, hostId);
    await this.add(channelId, hostId).catch((error) => {
      this.abortSetup(channelId, [hostId]);
      throw error;
    });
    return channelId;
  }

  async replace(sourceChannelId: string, hostId: string) {
    this.store.clearCompanionChannel(sourceChannelId);
    const channelId = await this.create(sourceChannelId);
    await this.restrict(channelId, hostId);
    await this.add(channelId, hostId).catch((error) => {
      this.abortSetup(channelId, [hostId]);
      throw error;
    });
    return channelId;
  }

  async activate(channelId: string, participantIds: string[]) {
    const allowed = new Set([this.userId, ...participantIds]);
    await Promise.all(
      [...new Set(participantIds)]
        .filter((userId) => userId !== this.userId)
        .map((userId) =>
          this.add(channelId, userId).catch(async (error) => {
            log.warn(
              {
                event: "participant_invite_failed",
                channelId,
                userId,
                err: error,
              },
              "Could not add Huddle participant to companion channel",
            );
            await this.app
              .dm(
                userId,
                "I couldn’t add you to the HuddleFM controls channel. Ask the host to restart the session.",
              )
              .catch(() => {});
          }),
        ),
    );
    await this.app
      .channelMembers(channelId)
      .then((members) =>
        Promise.all(
          members
            .filter((userId) => !allowed.has(userId))
            .map((userId) => this.removeNow(channelId, userId)),
        ),
      )
      .catch((error) =>
        log.warn(
          { event: "membership_reconciliation_failed", channelId, err: error },
          "Could not reconcile companion channel membership",
        ),
      );
  }

  async add(channelId: string, userId: string) {
    this.store.cancelCompanionRemoval(channelId, userId);
    await this.serialize(channelId, userId, () =>
      this.slack.inviteToChannel(channelId, userId),
    );
  }

  removeLater(channelId: string, userId: string, now = Date.now()) {
    if (userId !== this.userId)
      this.store.scheduleCompanionRemoval(
        channelId,
        userId,
        now + cleanupDelayMs,
      );
  }

  removeNow(channelId: string, userId: string) {
    const dueAt = Date.now();
    this.store.scheduleCompanionRemoval(channelId, userId, dueAt);
    return this.remove({ channelId, userId, dueAt, attempts: 0 });
  }

  endSession(sessionId: string, channelId: string, userIds: string[]) {
    const deadline = Date.now() + cleanupDelayMs;
    for (const userId of userIds)
      if (userId !== this.userId)
        this.store.scheduleCompanionRemoval(channelId, userId, deadline);
    this.store.scheduleSessionMessageCleanup(sessionId, deadline);
  }

  abortSetup(channelId: string, userIds: string[]) {
    const deadline = Date.now() + cleanupDelayMs;
    for (const userId of new Set(userIds))
      if (userId !== this.userId)
        this.store.scheduleCompanionRemoval(channelId, userId, deadline);
  }

  abandonSession(sessionId: string) {
    const channelId = this.store.sessionCompanionChannel(sessionId);
    if (channelId)
      this.endSession(
        sessionId,
        channelId,
        this.store.sessionParticipants(sessionId),
      );
  }

  recordMessage(sessionId: string, channelId: string, messageTs: string) {
    this.store.recordSessionMessage(sessionId, channelId, messageTs);
  }

  private remove(job: {
    channelId: string;
    userId: string;
    dueAt: number;
    attempts: number;
  }) {
    return this.serialize(job.channelId, job.userId, async () => {
      if (
        this.store.companionRemovalDeadline(job.channelId, job.userId) !==
        job.dueAt
      )
        return;
      const kicked = await this.slack.removeFromChannel(
        job.channelId,
        job.userId,
      );
      const current = this.store.companionRemovalDeadline(
        job.channelId,
        job.userId,
      );
      if (current === undefined)
        await this.slack.inviteToChannel(job.channelId, job.userId);
      else if (current === job.dueAt) {
        this.store.completeCompanionRemoval(
          job.channelId,
          job.userId,
          job.dueAt,
        );
        if (kicked)
          await this.app
            .dm(job.userId, companionRemovalNotice(job.channelId))
            .catch(() => {});
      }
    });
  }

  private serialize(
    channelId: string,
    userId: string,
    operation: () => Promise<void>,
  ) {
    const key = `${channelId}:${userId}`;
    const pending = (this.membership.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(operation)
      .finally(() => {
        if (this.membership.get(key) === pending) this.membership.delete(key);
      });
    this.membership.set(key, pending);
    return pending;
  }

  private async create(sourceChannelId: string) {
    const channelId = await this.slack.createCompanionChannel(sourceChannelId);
    this.store.setCompanionChannel(sourceChannelId, channelId);
    return channelId;
  }

  private async restrict(channelId: string, hostId: string) {
    await this.slack
      .restrictCompanionPosting(channelId, this.userId)
      .catch(async (error) => {
        log.warn(
          { event: "posting_restriction_failed", channelId, err: error },
          "Could not restrict companion channel posting",
        );
        await this.app
          .dm(
            hostId,
            `I couldn’t restrict posting in <#${channelId}>, so anyone in it can post there. You can change this in the channel’s settings.`,
          )
          .catch(() => {});
      });
  }

  private async cleanup(now = Date.now()) {
    if (this.cleaning) return;
    this.cleaning = true;
    await Promise.all([
      ...this.store.dueCompanionRemovals(now).map(async (job) => {
        try {
          await this.remove(job);
        } catch (error) {
          const attempts = job.attempts + 1;
          this.store.retryCompanionRemoval(
            job.channelId,
            job.userId,
            job.dueAt,
            attempts,
            now + retryDelay(attempts),
          );
          log.warn(
            { event: "member_cleanup_failed", ...job, err: error },
            "Could not remove companion channel member",
          );
        }
      }),
      ...this.store.dueSessionMessages(now).map(async (job) => {
        try {
          await this.app.delete(job.channelId, job.messageTs);
          this.store.completeSessionMessage(job.channelId, job.messageTs);
        } catch (error) {
          const attempts = job.attempts + 1;
          this.store.retrySessionMessage(
            job.channelId,
            job.messageTs,
            attempts,
            now + retryDelay(attempts),
          );
          log.warn(
            { event: "message_cleanup_failed", ...job, err: error },
            "Could not delete companion channel message",
          );
        }
      }),
    ]).finally(() => {
      this.cleaning = false;
    });
  }
}

function retryDelay(attempts: number) {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.min(attempts - 1, 6));
}
