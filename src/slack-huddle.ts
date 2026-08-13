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
  uiChannelId: string;
  uiThreadTs: string;
  chimeMeeting: Record<string, unknown>;
  chimeAttendee: Record<string, unknown>;
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

export function normalizeJoinResponse(raw: unknown): JoinedHuddle {
  const root = object(raw, "response");
  if (root.ok !== true)
    throw new Error(`rooms.join failed: ${String(root.error ?? "unknown_error")}`);

  const call = object(root.call, "call");
  const freeWilly = object(call.free_willy, "call.free_willy");
  const canvas = object(root.canvas, "canvas");
  const huddle = object(root.huddle, "huddle");
  const meeting = { ...object(freeWilly.meeting, "call.free_willy.meeting") };
  if (meeting.MeetingFeatures === null) delete meeting.MeetingFeatures;

  return {
    huddleCallId: text(call.call_id, "call.call_id"),
    huddleId: text(huddle.id, "huddle.id"),
    uiChannelId: text(canvas.thread_channel_id, "canvas.thread_channel_id"),
    uiThreadTs: text(canvas.root_thread_ts, "canvas.root_thread_ts"),
    chimeMeeting: meeting,
    chimeAttendee: object(freeWilly.attendee, "call.free_willy.attendee"),
  };
}

export class SlackHuddleAdapter {
  constructor(
    private config: {
      workspaceUrl: string;
      xoxc: string;
      xoxd: string;
      mediaRegion: string;
    },
  ) {}

  async join(channelId: string) {
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
    return normalizeJoinResponse(await response.json());
  }
}

export async function verifySlackIdentity(config: {
  workspaceUrl: string;
  xoxp: string;
  xoxc: string;
  xoxd: string;
}) {
  const auth = async (token: string, cookie?: string) => {
    const response = await fetch(new URL("/api/auth.test", config.workspaceUrl), {
      method: "POST",
      headers: cookie ? { cookie: `d=${cookie}` } : undefined,
      body: new URLSearchParams({ token }),
    });
    const result = (await response.json()) as { ok?: boolean; error?: string; user_id?: string };
    if (!result.ok || !result.user_id)
      throw new Error(`auth.test failed: ${result.error ?? response.status}`);
    return result.user_id;
  };

  const [appUserId, huddleUserId] = await Promise.all([
    auth(config.xoxp),
    auth(config.xoxc, config.xoxd),
  ]);
  if (appUserId !== huddleUserId)
    throw new Error("Slack app and Huddle credentials belong to different users");
  return appUserId;
}
