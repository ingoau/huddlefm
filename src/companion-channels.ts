import { logger } from "./logger.ts";
import type { SlackAppAdapter } from "./slack-app.ts";
import type { SlackHuddleAdapter } from "./slack-huddle.ts";
import type { Store } from "./store.ts";

const cleanupDelayMs = 10 * 60_000;
const log = logger.child({ component: "companion-channels" });

export class CompanionChannels {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private store: Store,
    private slack: Pick<
      SlackHuddleAdapter,
      | "ensureChannelAccess"
      | "createCompanionChannel"
      | "restrictCompanionPosting"
      | "inviteToChannel"
      | "removeFromChannel"
      | "channelMembers"
    >,
    private messages: Pick<SlackAppAdapter, "dm" | "delete">,
    private userId: string,
  ) {}

  start() {
    this.timer = setInterval(() => void this.cleanup(), 5_000);
    void this.cleanup();
  }

  stop() {
    clearInterval(this.timer);
  }

  async prepare(sourceChannelId: string, hostId: string) {
    if (await this.slack.ensureChannelAccess(sourceChannelId)) return;
    let channelId = this.store.companionChannel(sourceChannelId);
    if (channelId && !(await this.slack.ensureChannelAccess(channelId))) {
      this.store.clearCompanionChannel(sourceChannelId);
      channelId = undefined;
    }
    if (!channelId) {
      channelId = await this.slack.createCompanionChannel(sourceChannelId);
      this.store.setCompanionChannel(sourceChannelId, channelId);
      await this.slack.restrictCompanionPosting(channelId).catch((error) =>
        log.warn(
          { event: "posting_restriction_failed", channelId, err: error },
          "Could not restrict companion channel posting",
        ),
      );
    }
    await this.add(channelId, hostId);
    return channelId;
  }

  async activate(channelId: string, participantIds: string[]) {
    const allowed = new Set([this.userId, ...participantIds]);
    await Promise.all(
      participantIds.map((userId) =>
        this.add(channelId, userId).catch(async (error) => {
          log.warn(
            { event: "participant_invite_failed", channelId, userId, err: error },
            "Could not add Huddle participant to companion channel",
          );
          await this.messages
            .dm(
              userId,
              "I couldn’t add you to the HuddleFM controls channel. Ask the host to restart the session.",
            )
            .catch(() => {});
        }),
      ),
    );
    const members = await this.slack.channelMembers(channelId);
    await Promise.all(
      members
        .filter((userId) => !allowed.has(userId))
        .map((userId) => this.remove(channelId, userId)),
    );
  }

  async add(channelId: string, userId: string) {
    this.store.cancelCompanionRemoval(channelId, userId);
    await this.slack.inviteToChannel(channelId, userId);
  }

  removeLater(channelId: string, userId: string, now = Date.now()) {
    if (userId !== this.userId)
      this.store.scheduleCompanionRemoval(
        channelId,
        userId,
        now + cleanupDelayMs,
      );
  }

  endSession(sessionId: string, channelId: string, userIds: string[]) {
    const deadline = Date.now() + cleanupDelayMs;
    for (const userId of userIds)
      if (userId !== this.userId)
        this.store.scheduleCompanionRemoval(channelId, userId, deadline);
    this.store.scheduleSessionMessageCleanup(sessionId, deadline);
  }

  recordMessage(sessionId: string, channelId: string, messageTs: string) {
    this.store.recordSessionMessage(sessionId, channelId, messageTs);
  }

  private async remove(channelId: string, userId: string) {
    await this.slack.removeFromChannel(channelId, userId);
    this.store.completeCompanionRemoval(channelId, userId);
  }

  private async cleanup(now = Date.now()) {
    await Promise.all([
      ...this.store.dueCompanionRemovals(now).map(async (job) => {
        try {
          await this.remove(job.channelId, job.userId);
        } catch (error) {
          const attempts = job.attempts + 1;
          this.store.retryCompanionRemoval(
            job.channelId,
            job.userId,
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
          await this.messages.delete(job.channelId, job.messageTs);
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
    ]);
  }
}

function retryDelay(attempts: number) {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.min(attempts - 1, 6));
}
