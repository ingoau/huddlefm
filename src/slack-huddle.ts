import { logger } from "./logger.ts";
import type { DuckingMode } from "./store.ts";

const log = logger.child({ component: "slack-huddle" });

export type ChimeBootstrap = {
  sessionId: string;
  meeting: Record<string, unknown>;
  attendee: Record<string, unknown>;
  initialVolume: number;
  duckingMode: DuckingMode;
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

export type ActiveHuddleRoom = {
  callId: string;
  participantIds: string[];
};

/** Slack reports Huddle participants as user IDs or as membership objects. */
function participantIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const userId = (entry as { user_id?: unknown } | null)?.user_id;
    return typeof userId === "string" ? [userId] : [];
  });
}

/** True when activity belongs to the session UI thread or the original huddle thread. */
export function roomOwnsThread(
  room: Pick<
    JoinedHuddle,
    "uiChannelId" | "uiThreadTs" | "sourceChannelId" | "huddleThreadTs"
  >,
  channelId: string,
  threadTs: string,
) {
  if (channelId === room.uiChannelId && threadTs === room.uiThreadTs)
    return true;
  return Boolean(
    room.sourceChannelId &&
    room.huddleThreadTs &&
    channelId === room.sourceChannelId &&
    threadTs === room.huddleThreadTs,
  );
}

export type HuddleEvent =
  | {
      type: "HuddleInvited";
      channelId: string;
      callId: string;
      inviterUserId: string;
      freeWilly?: Record<string, unknown>;
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
  | { type: "HuddleEnded"; callId: string }
  | {
      type: "DirectMessage";
      channelId: string;
      messageTs: string;
      userId: string;
      text: string;
      botId?: string;
    };

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

// Throws unless Slack answered ok, or with an error after which retrying
// could never change the outcome.
function checked(
  method: string,
  result: Record<string, unknown>,
  settled: readonly string[] = [],
) {
  if (result.ok !== true && !settled.includes(String(result.error)))
    throw new Error(
      `${method} failed: ${String(result.error ?? "unknown_error")}`,
    );
  return result;
}

function formData(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

// Fields the Slack desktop client sends alongside its own API calls.
function clientFields(reason: string) {
  return {
    _x_reason: reason,
    _x_mode: "online",
    _x_sonic: "true",
    _x_app_name: "client",
  };
}

function chimeMeeting(value: unknown, name: string) {
  const meeting = { ...object(value, name) };
  if (meeting.MeetingFeatures === null) delete meeting.MeetingFeatures;
  return meeting;
}

async function authTest(workspaceUrl: string, token: string, cookie?: string) {
  const response = await fetch(new URL("/api/auth.test", workspaceUrl), {
    method: "POST",
    headers: cookie ? { cookie: `d=${cookie}` } : undefined,
    body: new URLSearchParams({ token }),
  });
  const result = (await response.json()) as {
    ok?: boolean;
    error?: string;
    user_id?: string;
    team_id?: string;
  };
  return { ...result, status: response.status };
}

export function normalizeJoinResponse(raw: unknown): JoinedHuddle {
  const root = checked("rooms.join", object(raw, "response"));
  const call = object(root.call, "call");
  const freeWilly = object(call.free_willy, "call.free_willy");
  const canvas = object(root.canvas, "canvas");
  const huddle = object(root.huddle, "huddle");

  return {
    huddleCallId: text(call.call_id, "call.call_id"),
    huddleId: text(huddle.id, "huddle.id"),
    huddleCreatorId: text(huddle.created_by, "huddle.created_by"),
    participantIds: participantIds(huddle.participants),
    uiChannelId: text(canvas.thread_channel_id, "canvas.thread_channel_id"),
    uiThreadTs: text(canvas.root_thread_ts, "canvas.root_thread_ts"),
    chimeMeeting: chimeMeeting(freeWilly.meeting, "call.free_willy.meeting"),
    chimeAttendee: object(freeWilly.attendee, "call.free_willy.attendee"),
  };
}

export function normalizeInvitedJoinResponse(
  raw: unknown,
  channelId: string,
  freeWilly: Record<string, unknown>,
): JoinedHuddle {
  const root = checked(
    "screenhero.rooms.info",
    object(raw, "screenhero.rooms.info response"),
  );
  const room = object(root.room, "room");
  const callId = text(room.id, "room.id");

  return {
    huddleCallId: callId,
    huddleId: callId,
    huddleCreatorId: text(room.created_by, "room.created_by"),
    participantIds: participantIds(room.participants),
    uiChannelId: channelId,
    uiThreadTs: text(
      room.thread_root_ts ?? room.canvas_thread_ts,
      "room.thread_root_ts",
    ),
    chimeMeeting: chimeMeeting(freeWilly.meeting, "free_willy.meeting"),
    chimeAttendee: object(freeWilly.attendee, "free_willy.attendee"),
  };
}

export function channelAccess(channel?: {
  is_member?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
}) {
  if (channel?.is_archived) return "decline";
  if (channel?.is_member) return "ready";
  return !channel || channel.is_private ? "decline" : "join";
}

// Kick outcomes after which the member can never be removed by retrying.
const kickSettledErrors = [
  "not_in_channel",
  "user_not_in_channel",
  "channel_not_found",
  "is_archived",
];

// Reaction removal outcomes that already leave the reaction off the message.
const unreactSettledErrors = [
  "no_reaction",
  "message_not_found",
  "channel_not_found",
];

export function companionChannelName(channelId: string, suffix?: string) {
  return `huddlefm-${channelId.toLowerCase()}${suffix ? `-${suffix}` : ""}`;
}

export function companionChannelRequest(name: string, teamId?: string) {
  return { name, is_private: "true", ...(teamId ? { team_id: teamId } : {}) };
}

export function companionPostingPrefs(userId: string) {
  return {
    who_can_post: `type:admin,user:${userId}`,
    can_thread: `type:admin,user:${userId}`,
    enable_at_here: "true",
    enable_at_channel: "true",
  };
}

export class SlackHuddleAdapter {
  private socket?: WebSocket;
  private pingTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private stopping = false;
  private reconnectUrl?: string;
  private onEvent?: (event: HuddleEvent) => void;
  // Fired after every successful (re)connect, so consumers can resync state
  // for events the previous socket may have dropped.
  onConnected?: () => void;

  constructor(
    private config: {
      workspaceUrl: string;
      xoxc: string;
      xoxd: string;
      teamId?: string;
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
    const auth = await authTest(
      this.config.workspaceUrl,
      this.config.xoxc,
      this.config.xoxd,
    );
    if (!auth.ok || !auth.team_id)
      throw new Error(`Selfbot auth failed: ${auth.error ?? auth.status}`);

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
    this.onConnected?.();
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
    const info = await this.api("conversations.info", { channel: channelId }, [
      "channel_not_found",
    ]);
    if (info.ok !== true) return false;
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
    await this.api("conversations.join", { channel: channelId });
    log.info({ event: "channel_joined", channelId }, "Joined Slack channel");
    return true;
  }

  async createCompanionChannel(sourceChannelId: string) {
    let suffix: string | undefined;
    for (;;) {
      const name = companionChannelName(sourceChannelId, suffix);
      const result = await this.api(
        "conversations.create",
        companionChannelRequest(name, this.config.teamId),
        ["name_taken"],
      );
      if (result.ok === true) {
        const channelId = text(
          object(result.channel, "conversations.create.channel").id,
          "conversations.create.channel.id",
        );
        // The channel is usable without its topic, so a failed update is
        // logged rather than thrown, which would orphan the new channel.
        const topic = await this.call("conversations.setTopic", {
          channel: channelId,
          topic: `HuddleFM controls for <#${sourceChannelId}>. Membership and messages are managed automatically.`,
        });
        if (topic.ok !== true)
          log.warn(
            { event: "topic_failed", channelId, error: topic.error },
            "Could not set companion channel topic",
          );
        return channelId;
      }
      suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
    }
  }

  async restrictCompanionPosting(channelId: string, userId: string) {
    const form = formData({
      token: this.config.xoxc,
      channel_id: channelId,
      prefs: JSON.stringify(companionPostingPrefs(userId)),
      ...clientFields("channel-options-ia-posting-permission-modal-contents"),
    });
    let error = "unknown_error";
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await this.post("/api/channels.prefs.set", form);
      let result: Record<string, unknown> | undefined;
      try {
        if (response.ok)
          result = object(await response.json(), "channels.prefs.set");
      } catch {
        result = { error: "invalid_response" };
      }
      if (result?.ok === true) return;
      error = String(result?.error ?? response.status);
      if (attempt < 4) await Bun.sleep(250 * 2 ** attempt);
    }
    throw new Error(`channels.prefs.set failed: ${error}`);
  }

  async inviteToChannel(channelId: string, userId: string) {
    const result = await this.api(
      "conversations.invite",
      { channel: channelId, users: userId },
      ["already_in_channel"],
    );
    return result.ok === true;
  }

  async removeFromChannel(channelId: string, userId: string) {
    await this.api(
      "conversations.kick",
      { channel: channelId, user: userId },
      kickSettledErrors,
    );
  }

  async activeHuddleRoom(channelId: string, threadTs: string) {
    const replies = await this.api("conversations.replies", {
      channel: channelId,
      ts: threadTs,
      limit: "1",
      inclusive: "true",
    });
    return activeHuddleRoom(replies, threadTs);
  }

  async react(channelId: string, messageTs: string, name: string) {
    await this.api(
      "reactions.add",
      { channel: channelId, timestamp: messageTs, name },
      ["already_reacted"],
    );
  }

  async unreact(channelId: string, messageTs: string, name: string) {
    await this.api(
      "reactions.remove",
      { channel: channelId, timestamp: messageTs, name },
      unreactSettledErrors,
    );
  }

  private async api(
    method: string,
    fields: Record<string, string>,
    settled?: readonly string[],
  ) {
    return checked(method, await this.call(method, fields), settled);
  }

  private async call(method: string, fields: Record<string, string>) {
    const startedAt = Date.now();
    const response = await this.post(
      `/api/${method}`,
      new URLSearchParams({ token: this.config.xoxc, ...fields }),
    );
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
    log.debug(
      { event: "api_completed", method, durationMs: Date.now() - startedAt },
      "Slack private API call completed",
    );
    return object(await response.json(), method);
  }

  private post(
    path: string,
    body: FormData | URLSearchParams,
    signal?: AbortSignal,
  ) {
    return fetch(new URL(path, this.config.workspaceUrl), {
      method: "POST",
      headers: { cookie: `d=${this.config.xoxd}` },
      body,
      signal,
    });
  }

  async join(channelId: string) {
    const startedAt = Date.now();
    log.info({ event: "join_started", channelId }, "Joining Slack Huddle");
    const response = await this.post(
      "/api/rooms.join",
      formData({
        channel_id: channelId,
        regions: this.config.mediaRegion,
        token: this.config.xoxc,
        multidevice: "true",
      }),
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

  async joinInvited(
    channelId: string,
    callId: string,
    freeWilly: Record<string, unknown>,
  ) {
    const startedAt = Date.now();
    log.info(
      { event: "invite_join_started", channelId, callId },
      "Joining invited Slack Huddle",
    );
    const joined = normalizeInvitedJoinResponse(
      await this.roomInfo(callId),
      channelId,
      freeWilly,
    );
    if (joined.huddleCallId !== callId)
      throw new Error("screenhero.rooms.info returned the wrong Huddle");
    log.info(
      {
        event: "invite_join_completed",
        channelId,
        callId,
        participants: joined.participantIds.length,
        durationMs: Date.now() - startedAt,
      },
      "Joined invited Slack Huddle",
    );
    return joined;
  }

  // The actual participants of a Huddle, straight from Slack. Realtime member
  // events can miss joins and leaves, so this is the source of truth for
  // reconciling tracked participants.
  async participants(callId: string) {
    const response = checked(
      "screenhero.rooms.info",
      await this.roomInfo(callId),
    );
    const room = object(response.room, "room");
    // Reconciliation acts on this list, so a shape it cannot read has to
    // fail rather than pass for an empty Huddle and evict everyone. A real
    // Huddle is never empty while the bot is in it.
    if (!Array.isArray(room.participants))
      throw new Error("Slack response is missing room.participants");
    return participantIds(room.participants);
  }

  private async roomInfo(callId: string) {
    const response = await this.post(
      "/api/screenhero.rooms.info",
      formData({
        token: this.config.xoxc,
        room: callId,
        ...clientFields("all-calls-store/conditional-fetch"),
      }),
      // Reconciliation calls this on a timer, so a socket that dies without
      // closing has to surface as a failed pass rather than a hung one.
      AbortSignal.timeout(10_000),
    );
    if (!response.ok)
      throw new Error(`screenhero.rooms.info HTTP ${response.status}`);
    return object(await response.json(), "screenhero.rooms.info response");
  }

  async decline(channelId: string, callId: string) {
    const response = await this.post(
      "/api/rooms.inviteResponse",
      formData({
        token: this.config.xoxc,
        response: "decline",
        channel_id: channelId,
        room_id: callId,
        _x_reason: "respond-to-huddle-invite",
      }),
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
    const freeWilly =
      event.free_willy &&
      typeof event.free_willy === "object" &&
      !Array.isArray(event.free_willy)
        ? (event.free_willy as Record<string, unknown>)
        : undefined;
    return {
      type: "HuddleInvited",
      channelId: text(event.channel_id, "huddle_invite.channel_id"),
      callId: text(event.call_id, "huddle_invite.call_id"),
      inviterUserId: text(event.sender_user_id, "huddle_invite.sender_user_id"),
      ...(freeWilly ? { freeWilly } : {}),
    };
  }
  if (event.type === "message") {
    const subtype =
      typeof event.subtype === "string" ? event.subtype : undefined;
    const channelId =
      typeof event.channel === "string" ? event.channel : undefined;
    const im =
      event.channel_type === "im" ||
      (typeof channelId === "string" && channelId.startsWith("D"));
    if (im) {
      if (event.thread_ts) return;
      if (subtype && subtype !== "bot_message") return;
      const userId =
        typeof event.user === "string"
          ? event.user
          : typeof event.bot_id === "string"
            ? event.bot_id
            : undefined;
      if (userId && channelId && typeof event.ts === "string")
        return {
          type: "DirectMessage",
          channelId,
          messageTs: event.ts,
          userId,
          text: typeof event.text === "string" ? event.text : "",
          ...(typeof event.bot_id === "string" ? { botId: event.bot_id } : {}),
        };
      return;
    }
    if (!subtype && event.thread_ts && event.user) {
      return {
        type: "ThreadActivity",
        channelId: text(event.channel, "message.channel"),
        threadTs: text(event.thread_ts, "message.thread_ts"),
        messageTs: text(event.ts, "message.ts"),
        userId: text(event.user, "message.user"),
        text: typeof event.text === "string" ? event.text : "",
      };
    }
  }
  if (event.type === "sh_room_leave" || event.type === "sh_room_join") {
    const room = event.room as Record<string, unknown> | undefined;
    const huddle = event.huddle as Record<string, unknown> | undefined;
    const callId = event.call_id ?? room?.call_id ?? room?.id ?? huddle?.id;
    if (typeof callId !== "string" || typeof event.user !== "string") return;
    return {
      type: event.type === "sh_room_join" ? "MemberJoined" : "MemberLeft",
      callId,
      userId: event.user,
    };
  }
  if (event.type === "sh_room_update") {
    const huddle = event.huddle as Record<string, unknown> | undefined;
    const room = event.room as Record<string, unknown> | undefined;
    const callId = room?.call_id ?? huddle?.id;
    if ((huddle?.has_ended || huddle?.date_end) && typeof callId === "string")
      return { type: "HuddleEnded", callId };
  }
}

export function activeHuddleRoom(
  raw: unknown,
  threadTs: string,
): ActiveHuddleRoom | undefined {
  const messages = object(raw, "replies").messages;
  if (!Array.isArray(messages)) return;
  const root = messages.find(
    (message) => (message as { ts?: unknown } | null)?.ts === threadTs,
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
  if (typeof room.id !== "string" || !room.id) return;
  return { callId: room.id, participantIds: participantIds(room.participants) };
}

/**
 * True when the user is one of the Huddle's current participants. Slack only
 * lists participants it knows about, so an empty list means we cannot tell and
 * the user gets the benefit of the doubt rather than a false rejection.
 */
export function huddleHasParticipant(room: ActiveHuddleRoom, userId: string) {
  return !room.participantIds.length || room.participantIds.includes(userId);
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
    const result = await authTest(config.workspaceUrl, token, cookie);
    if (!result.ok || !result.user_id)
      throw new Error(`auth.test failed: ${result.error ?? result.status}`);
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
