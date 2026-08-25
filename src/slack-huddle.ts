import { logger } from "./logger.ts";

const log = logger.child({ component: "slack-huddle" });

export type ChimeBootstrap = {
  sessionId: string;
  meeting: Record<string, unknown>;
  attendee: Record<string, unknown>;
  initialVolume: number;
  bridgeToken: string;
};

export type JoinedHuddle = {
  huddleCallId: string;
  huddleId: string;
  huddleCreatorId: string;
  participantIds: string[];
  uiChannelId: string;
  uiThreadTs: string;
  sourceChannelId?: string;
  huddleThreadTs?: string;
  companionChannelId?: string;
  chimeMeeting: Record<string, unknown>;
  chimeAttendee: Record<string, unknown>;
};

export type HuddleEvent =
  | {
      type: "HuddleInvited";
      channelId: string;
      callId: string;
      inviterUserId: string;
    }
  | {
      type: "ThreadActivity";
      channelId: string;
      threadTs: string;
      messageTs: string;
      userId: string;
      text: string;
    }
  | { type: "MemberLeft"; callId: string; userId: string }
  | { type: "MemberJoined"; callId: string; userId: string }
  | { type: "ChannelLeft"; channelId: string }
  | { type: "ChannelMemberJoined"; channelId: string; userId: string }
  | { type: "ChannelMemberLeft"; channelId: string; userId: string }
  | { type: "HuddleEnded"; callId: string };

function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Slack response is missing ${name}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value)
    throw new Error(`Slack response is missing ${name}`);
  return value;
}

export function normalizeJoinResponse(raw: unknown): JoinedHuddle {
  const root = object(raw, "response");
  if (root.ok !== true)
    throw new Error(
      `rooms.join failed: ${String(root.error ?? "unknown_error")}`,
    );

  const call = object(root.call, "call");
  const freeWilly = object(call.free_willy, "call.free_willy");
  const canvas = object(root.canvas, "canvas");
  const huddle = object(root.huddle, "huddle");
  const meeting = { ...object(freeWilly.meeting, "call.free_willy.meeting") };
  if (meeting.MeetingFeatures === null) delete meeting.MeetingFeatures;

  return {
    huddleCallId: text(call.call_id, "call.call_id"),
    huddleId: text(huddle.id, "huddle.id"),
    huddleCreatorId: text(huddle.created_by, "huddle.created_by"),
    participantIds: Array.isArray(huddle.participants)
      ? huddle.participants.flatMap((value) => {
          if (typeof value === "string") return [value];
          if (
            value &&
            typeof value === "object" &&
            typeof (value as { user_id?: unknown }).user_id === "string"
          )
            return [(value as { user_id: string }).user_id];
          return [];
        })
      : [],
    uiChannelId: text(canvas.thread_channel_id, "canvas.thread_channel_id"),
    uiThreadTs: text(canvas.root_thread_ts, "canvas.root_thread_ts"),
    chimeMeeting: meeting,
    chimeAttendee: object(freeWilly.attendee, "call.free_willy.attendee"),
  };
}

export function channelAccess(channel?: {
  is_member?: boolean;
  is_private?: boolean;
}) {
  if (channel?.is_member) return "ready";
  return !channel || channel.is_private ? "decline" : "join";
}

export function companionChannelName(channelId: string, suffix?: string) {
  return `huddlefm-${channelId.toLowerCase()}${suffix ? `-${suffix}` : ""}`;
}

export class SlackHuddleAdapter {
  private socket?: WebSocket;
  private pingTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private stopping = false;
  private reconnectUrl?: string;
  private onEvent?: (event: HuddleEvent) => void;

  constructor(
    private config: {
      workspaceUrl: string;
      xoxc: string;
      xoxd: string;
      mediaRegion: string;
    },
  ) {}

  async start(onEvent: (event: HuddleEvent) => void) {
    this.stopping = false;
    this.onEvent = onEvent;
    await this.connect();
    log.info({ event: "started" }, "Slack Huddle connection started");
  }

  stop() {
    this.stopping = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    log.info({ event: "stopped" }, "Slack Huddle connection stopped");
  }

  private async connect() {
    const startedAt = Date.now();
    log.info(
      { event: "connection_started", attempt: this.reconnectAttempts + 1 },
      "Connecting Slack Huddle realtime API",
    );
    const response = await fetch(
      new URL("/api/auth.test", this.config.workspaceUrl),
      {
        method: "POST",
        headers: { cookie: `d=${this.config.xoxd}` },
        body: new URLSearchParams({ token: this.config.xoxc }),
      },
    );
    const auth = (await response.json()) as {
      ok?: boolean;
      error?: string;
      team_id?: string;
    };
    if (!auth.ok || !auth.team_id)
      throw new Error(`Selfbot auth failed: ${auth.error ?? response.status}`);

    const url = this.reconnectUrl
      ? new URL(this.reconnectUrl)
      : this.gatewayUrl(auth.team_id);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { cookie: `d=${this.config.xoxd}` },
      } as never);
      this.socket = socket;
      let ready = false;
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "hello") {
          ready = true;
          this.reconnectAttempts = 0;
          clearInterval(this.pingTimer);
          this.pingTimer = setInterval(
            () => socket.send(JSON.stringify({ type: "ping", id: Date.now() })),
            5_000,
          );
          log.info(
            { event: "connected", durationMs: Date.now() - startedAt },
            "Slack Huddle realtime API connected",
          );
          resolve();
          return;
        }
        if (message.type === "reconnect_url" && typeof message.url === "string")
          this.reconnectUrl = message.url;
        try {
          const normalized = normalizeRealtimeEvent(message);
          if (normalized) this.onEvent?.(normalized);
        } catch (err) {
          log.warn(
            {
              event: "invalid_event_ignored",
              realtimeType: String(message.type),
              err,
            },
            "Ignored invalid Slack Huddle event",
          );
        }
      });
      socket.addEventListener("error", () => {
        log.warn(
          { event: "connection_error", ready },
          "Slack Huddle connection error",
        );
        if (!ready)
          reject(new Error("Private Slack realtime connection failed"));
      });
      socket.addEventListener("close", (event) => {
        if (!this.stopping)
          log.warn(
            { event: "connection_closed", code: event.code },
            "Slack Huddle connection closed",
          );
        this.scheduleReconnect();
      });
    });
  }

  private gatewayUrl(enterpriseId: string) {
    const url = new URL("wss://wss-primary.slack.com/");
    const params = {
      token: this.config.xoxc,
      sync_desync: "1",
      slack_client: "desktop",
      start_args:
        "?agent=client&org_wide_aware=true&eac_cache_ts=true&cache_ts=0&name_tagging=true&only_self_subteams=true&connect_only=true&ms_latest=true",
      no_query_on_subscribe: "1",
      flannel: "3",
      lazy_channels: "1",
      gateway_server: `T${enterpriseId.slice(1)}-1`,
      enterprise_id: enterpriseId,
      batch_presence_aware: "1",
    };
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    return url;
  }

  private scheduleReconnect() {
    clearInterval(this.pingTimer);
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts++);
    log.warn(
      { event: "reconnect_scheduled", delayMs: delay },
      "Slack Huddle reconnect scheduled",
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error) => {
        log.error(
          { event: "reconnect_failed", err: error },
          "Slack Huddle reconnect failed",
        );
        this.scheduleReconnect();
      });
    }, delay);
  }

  async ensureChannelAccess(channelId: string) {
    const info = await this.api("conversations.info", { channel: channelId });
    if (info.ok !== true) {
      if (info.error === "channel_not_found") return false;
      throw new Error(
        `conversations.info failed: ${String(info.error ?? "unknown_error")}`,
      );
    }
    const access = channelAccess(object(info.channel, "channel"));
    if (access === "ready") {
      log.debug(
        { event: "channel_access_ready", channelId },
        "Channel accessible",
      );
      return true;
    }
    if (access === "decline") {
      log.info(
        { event: "channel_access_declined", channelId },
        "Private channel is inaccessible",
      );
      return false;
    }
    const joined = await this.api("conversations.join", { channel: channelId });
    if (joined.ok !== true)
      throw new Error(
        `conversations.join failed: ${String(joined.error ?? "unknown_error")}`,
      );
    log.info({ event: "channel_joined", channelId }, "Joined Slack channel");
    return true;
  }

  async createCompanionChannel(sourceChannelId: string) {
    let suffix: string | undefined;
    for (;;) {
      const name = companionChannelName(sourceChannelId, suffix);
      const result = await this.api("conversations.create", {
        name,
        is_private: "true",
      });
      if (result.ok === true) {
        const channelId = text(
          object(result.channel, "conversations.create.channel").id,
          "conversations.create.channel.id",
        );
        await this.api("conversations.setTopic", {
          channel: channelId,
          topic: `HuddleFM controls for <#${sourceChannelId}>. Membership and messages are managed automatically.`,
        });
        return channelId;
      }
      if (result.error !== "name_taken")
        throw new Error(
          `conversations.create failed: ${String(result.error ?? "unknown_error")}`,
        );
      suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
    }
  }

  async restrictCompanionPosting(channelId: string) {
    const result = await this.api("channel.perfs.set", {
      channel: channelId,
      prefs: JSON.stringify({
        who_can_post: "type:admin",
        can_thread: "type:admin",
        enable_at_here: "true",
        enable_at_channel: "true",
      }),
    });
    if (result.ok !== true)
      throw new Error(
        `channel.perfs.set failed: ${String(result.error ?? "unknown_error")}`,
      );
  }

  async inviteToChannel(channelId: string, userId: string) {
    const result = await this.api("conversations.invite", {
      channel: channelId,
      users: userId,
    });
    if (result.ok !== true && result.error !== "already_in_channel")
      throw new Error(
        `conversations.invite failed: ${String(result.error ?? "unknown_error")}`,
      );
  }

  async removeFromChannel(channelId: string, userId: string) {
    const result = await this.api("conversations.kick", {
      channel: channelId,
      user: userId,
    });
    if (
      result.ok !== true &&
      result.error !== "not_in_channel" &&
      result.error !== "user_not_in_channel"
    )
      throw new Error(
        `conversations.kick failed: ${String(result.error ?? "unknown_error")}`,
      );
  }

  async channelMembers(channelId: string) {
    const members: string[] = [];
    let cursor = "";
    do {
      const result = await this.api("conversations.members", {
        channel: channelId,
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      if (result.ok !== true)
        throw new Error(
          `conversations.members failed: ${String(result.error ?? "unknown_error")}`,
        );
      if (Array.isArray(result.members))
        members.push(
          ...result.members.filter(
            (member): member is string => typeof member === "string",
          ),
        );
      const metadata = result.response_metadata;
      cursor =
        metadata &&
        typeof metadata === "object" &&
        typeof (metadata as { next_cursor?: unknown }).next_cursor === "string"
          ? (metadata as { next_cursor: string }).next_cursor
          : "";
    } while (cursor);
    return members;
  }

  async activeHuddleCall(channelId: string, threadTs: string) {
    const replies = await this.api("conversations.replies", {
      channel: channelId,
      ts: threadTs,
      limit: "1",
      inclusive: "true",
    });
    if (replies.ok !== true)
      throw new Error(
        `conversations.replies failed: ${String(replies.error ?? "unknown_error")}`,
      );
    return activeHuddleCallId(replies, threadTs);
  }

  async react(channelId: string, messageTs: string) {
    const result = await this.api("reactions.add", {
      channel: channelId,
      timestamp: messageTs,
      name: "thumbup",
    });
    if (result.ok !== true && result.error !== "already_reacted")
      throw new Error(
        `reactions.add failed: ${String(result.error ?? "unknown_error")}`,
      );
  }

  private async api(method: string, fields: Record<string, string>) {
    const startedAt = Date.now();
    const response = await fetch(
      new URL(`/api/${method}`, this.config.workspaceUrl),
      {
        method: "POST",
        headers: { cookie: `d=${this.config.xoxd}` },
        body: new URLSearchParams({ token: this.config.xoxc, ...fields }),
      },
    );
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
    log.debug(
      { event: "api_completed", method, durationMs: Date.now() - startedAt },
      "Slack private API call completed",
    );
    return object(await response.json(), method);
  }

  async join(channelId: string) {
    const startedAt = Date.now();
    log.info({ event: "join_started", channelId }, "Joining Slack Huddle");
    const form = new FormData();
    form.set("channel_id", channelId);
    form.set("regions", this.config.mediaRegion);
    form.set("token", this.config.xoxc);
    form.set("multidevice", "true");

    const response = await fetch(
      new URL("/api/rooms.join", this.config.workspaceUrl),
      {
        method: "POST",
        headers: { cookie: `d=${this.config.xoxd}` },
        body: form,
      },
    );
    if (!response.ok) throw new Error(`rooms.join HTTP ${response.status}`);
    const joined = normalizeJoinResponse(await response.json());
    log.info(
      {
        event: "join_completed",
        channelId,
        callId: joined.huddleCallId,
        huddleId: joined.huddleId,
        participants: joined.participantIds.length,
        durationMs: Date.now() - startedAt,
      },
      "Joined Slack Huddle",
    );
    return joined;
  }

  async decline(channelId: string, callId: string) {
    const form = new FormData();
    form.set("token", this.config.xoxc);
    form.set("response", "decline");
    form.set("channel_id", channelId);
    form.set("room_id", callId);
    form.set("_x_reason", "respond-to-huddle-invite");

    const response = await fetch(
      new URL("/api/rooms.inviteResponse", this.config.workspaceUrl),
      {
        method: "POST",
        headers: { cookie: `d=${this.config.xoxd}` },
        body: form,
      },
    );
    const result = object(await response.json(), "invite response");
    if (!response.ok || result.ok !== true)
      throw new Error(
        `rooms.inviteResponse failed: ${String(result.error ?? response.status)}`,
      );
    log.info(
      { event: "invite_declined", channelId, callId },
      "Declined inaccessible Huddle invitation",
    );
  }
}

export function normalizeRealtimeEvent(raw: unknown): HuddleEvent | undefined {
  const event = object(raw, "realtime event");
  if (event.type === "channel_left" && typeof event.channel === "string")
    return { type: "ChannelLeft", channelId: event.channel };
  if (
    (event.type === "member_joined_channel" ||
      event.type === "member_left_channel") &&
    typeof event.channel === "string" &&
    typeof event.user === "string"
  )
    return {
      type:
        event.type === "member_joined_channel"
          ? "ChannelMemberJoined"
          : "ChannelMemberLeft",
      channelId: event.channel,
      userId: event.user,
    };
  if (event.type === "huddle_invite") {
    return {
      type: "HuddleInvited",
      channelId: text(event.channel_id, "huddle_invite.channel_id"),
      callId: text(event.call_id, "huddle_invite.call_id"),
      inviterUserId: text(event.sender_user_id, "huddle_invite.sender_user_id"),
    };
  }
  if (
    event.type === "message" &&
    !event.subtype &&
    event.thread_ts &&
    event.user
  ) {
    return {
      type: "ThreadActivity",
      channelId: text(event.channel, "message.channel"),
      threadTs: text(event.thread_ts, "message.thread_ts"),
      messageTs: text(event.ts, "message.ts"),
      userId: text(event.user, "message.user"),
      text: typeof event.text === "string" ? event.text : "",
    };
  }
  if (event.type === "sh_room_leave") {
    const room = event.room as Record<string, unknown> | undefined;
    const huddle = event.huddle as Record<string, unknown> | undefined;
    const callId = event.call_id ?? room?.call_id ?? room?.id ?? huddle?.id;
    if (typeof callId !== "string" || typeof event.user !== "string") return;
    return {
      type: "MemberLeft",
      callId,
      userId: event.user,
    };
  }
  if (event.type === "sh_room_join") {
    const room = event.room as Record<string, unknown> | undefined;
    const huddle = event.huddle as Record<string, unknown> | undefined;
    const callId = event.call_id ?? room?.call_id ?? room?.id ?? huddle?.id;
    if (typeof callId !== "string" || typeof event.user !== "string") return;
    return { type: "MemberJoined", callId, userId: event.user };
  }
  if (event.type === "sh_room_update") {
    const huddle = event.huddle as Record<string, unknown> | undefined;
    const room = event.room as Record<string, unknown> | undefined;
    const callId = room?.call_id ?? huddle?.id;
    if ((huddle?.has_ended || huddle?.date_end) && typeof callId === "string")
      return {
        type: "HuddleEnded",
        callId,
      };
  }
}

export function activeHuddleCallId(raw: unknown, threadTs: string) {
  const messages = object(raw, "replies").messages;
  if (!Array.isArray(messages)) return;
  const root = messages.find(
    (message) =>
      message &&
      typeof message === "object" &&
      (message as { ts?: unknown }).ts === threadTs,
  ) as Record<string, unknown> | undefined;
  if (
    root?.subtype !== "huddle_thread" ||
    !root.room ||
    typeof root.room !== "object"
  )
    return;
  const room = root.room as Record<string, unknown>;
  const endedAt = Number(room.date_end ?? 0);
  if (room.has_ended === true || (Number.isFinite(endedAt) && endedAt > 0))
    return;
  return typeof room.id === "string" && room.id ? room.id : undefined;
}

export async function verifySlackIdentity(config: {
  workspaceUrl: string;
  xoxp: string;
  xoxc: string;
  xoxd: string;
}) {
  log.info(
    { event: "identity_verification_started" },
    "Verifying Slack credentials",
  );
  const auth = async (token: string, cookie?: string) => {
    const response = await fetch(
      new URL("/api/auth.test", config.workspaceUrl),
      {
        method: "POST",
        headers: cookie ? { cookie: `d=${cookie}` } : undefined,
        body: new URLSearchParams({ token }),
      },
    );
    const result = (await response.json()) as {
      ok?: boolean;
      error?: string;
      user_id?: string;
    };
    if (!result.ok || !result.user_id)
      throw new Error(`auth.test failed: ${result.error ?? response.status}`);
    return result.user_id;
  };

  const [appUserId, huddleUserId] = await Promise.all([
    auth(config.xoxp),
    auth(config.xoxc, config.xoxd),
  ]);
  if (appUserId !== huddleUserId)
    throw new Error(
      "Slack app and Huddle credentials belong to different users",
    );
  log.info(
    { event: "identity_verified", botUserId: appUserId },
    "Slack credentials verified",
  );
  return appUserId;
}
