import { expect, test } from "bun:test";
import {
  SlackHuddleAdapter,
  activeHuddleRoom,
  channelAccess,
  channelManagerIds,
  huddleHasParticipant,
  normalizeInvitedJoinResponse,
  normalizeJoinResponse,
  normalizeRealtimeEvent,
  roomOwnsThread,
} from "./slack-huddle.ts";

test("reads participants from the room info response envelope", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    Response.json({
      ok: true,
      participants: ["wrong-level"],
      room: { participants: ["U1", { user_id: "U2" }] },
    }),
    Response.json({ ok: false, error: "invalid_auth" }),
    Response.json({ ok: true }),
    Response.json({ ok: true, room: { id: "R123" } }),
  ];
  globalThis.fetch = (() =>
    Promise.resolve(responses.shift()!)) as unknown as typeof fetch;
  const adapter = new SlackHuddleAdapter({
    workspaceUrl: "https://slack.test",
    xoxc: "token",
    xoxd: "cookie",
    mediaRegion: "us-east-1",
  });
  try {
    await expect(adapter.participants("R123")).resolves.toEqual(["U1", "U2"]);
    await expect(adapter.participants("R123")).rejects.toThrow(
      "screenhero.rooms.info failed: invalid_auth",
    );
    await expect(adapter.participants("R123")).rejects.toThrow(
      "Slack response is missing room",
    );
    await expect(adapter.participants("R123")).rejects.toThrow(
      "Slack response is missing room.participants",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns a created companion channel when setting its topic fails", async () => {
  const originalFetch = globalThis.fetch;
  const adapter = new SlackHuddleAdapter({
    workspaceUrl: "https://slack.test",
    xoxc: "token",
    xoxd: "cookie",
    mediaRegion: "us-east-1",
  });
  const topicOutcomes = [
    () => Response.json({ ok: false, error: "not_allowed" }),
    () => Response.json({ ok: false }, { status: 503 }),
    () => {
      throw new Error("network failure");
    },
  ];

  try {
    for (const topicOutcome of topicOutcomes) {
      const requests: string[] = [];
      globalThis.fetch = (async (input) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        if (path === "/api/conversations.create")
          return Response.json({ ok: true, channel: { id: "CCOMP" } });
        return topicOutcome();
      }) as typeof fetch;

      await expect(adapter.createCompanionChannel("CSOURCE")).resolves.toBe(
        "CCOMP",
      );
      expect(requests).toEqual([
        "/api/conversations.create",
        "/api/conversations.setTopic",
      ]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("roomOwnsThread matches the UI thread and the original huddle thread", () => {
  const companionRoom = {
    uiChannelId: "CCOMP",
    uiThreadTs: "",
    sourceChannelId: "CSOURCE",
    huddleThreadTs: "111.222",
  };
  expect(roomOwnsThread(companionRoom, "CSOURCE", "111.222")).toBe(true);
  expect(roomOwnsThread(companionRoom, "CCOMP", "")).toBe(true);
  expect(roomOwnsThread(companionRoom, "CCOMP", "111.222")).toBe(false);
  expect(roomOwnsThread(companionRoom, "CSOURCE", "999.000")).toBe(false);

  const inlineRoom = {
    uiChannelId: "CSOURCE",
    uiThreadTs: "111.222",
    sourceChannelId: "CSOURCE",
    huddleThreadTs: "111.222",
  };
  expect(roomOwnsThread(inlineRoom, "CSOURCE", "111.222")).toBe(true);
  expect(roomOwnsThread(inlineRoom, "COTHER", "111.222")).toBe(false);
});

test("classifies channel access", () => {
  expect(channelAccess({ is_member: true, is_private: true })).toBe("ready");
  expect(channelAccess({ is_member: false, is_private: false })).toBe("join");
  expect(channelAccess({ is_member: false, is_private: true })).toBe("decline");
  expect(channelAccess()).toBe("decline");
  expect(channelAccess({ is_member: true, is_archived: true })).toBe("decline");
});

test("normalizes the private join response without nullable MeetingFeatures", () => {
  expect(
    normalizeJoinResponse({
      ok: true,
      call: {
        call_id: "call",
        free_willy: {
          meeting: { MeetingId: "meeting", MeetingFeatures: null },
          attendee: { AttendeeId: "attendee", JoinToken: "secret" },
        },
      },
      canvas: { thread_channel_id: "channel", root_thread_ts: "123.456" },
      huddle: { id: "huddle", created_by: "creator", participants: ["U1"] },
    }),
  ).toEqual({
    huddleCallId: "call",
    huddleId: "huddle",
    huddleCreatorId: "creator",
    participantIds: ["U1"],
    uiChannelId: "channel",
    uiThreadTs: "123.456",
    chimeMeeting: { MeetingId: "meeting" },
    chimeAttendee: { AttendeeId: "attendee", JoinToken: "secret" },
  });
});

test("does not leak a failed response", () => {
  expect(() =>
    normalizeJoinResponse({
      ok: false,
      error: "invalid_auth",
      token: "secret",
    }),
  ).toThrow("rooms.join failed: invalid_auth");
});

test("normalizes an invited Huddle from room metadata", () => {
  expect(
    normalizeInvitedJoinResponse(
      {
        ok: true,
        room: {
          id: "R123",
          created_by: "U1",
          participants: ["U1"],
          thread_root_ts: "123.456",
        },
      },
      "C123",
      {
        meeting: { MeetingId: "meeting", MeetingFeatures: null },
        attendee: { AttendeeId: "attendee", JoinToken: "secret" },
      },
    ),
  ).toEqual({
    huddleCallId: "R123",
    huddleId: "R123",
    huddleCreatorId: "U1",
    participantIds: ["U1"],
    uiChannelId: "C123",
    uiThreadTs: "123.456",
    chimeMeeting: { MeetingId: "meeting" },
    chimeAttendee: { AttendeeId: "attendee", JoinToken: "secret" },
  });
});

test("normalizes a Huddle invitation with its actor", () => {
  expect(
    normalizeRealtimeEvent({
      type: "huddle_invite",
      channel_id: "C123",
      call_id: "R123",
      sender_user_id: "U123",
      free_willy: { meeting: "kept" },
    }),
  ).toEqual({
    type: "HuddleInvited",
    channelId: "C123",
    callId: "R123",
    inviterUserId: "U123",
    freeWilly: { meeting: "kept" },
  });
});

test("ignores edits when normalizing thread activity", () => {
  expect(
    normalizeRealtimeEvent({
      type: "message",
      subtype: "message_changed",
      channel: "C123",
      thread_ts: "1.0",
      ts: "2.0",
      user: "U123",
    }),
  ).toBeUndefined();
});

test("normalizes thread text for private websocket mentions", () => {
  expect(
    normalizeRealtimeEvent({
      type: "message",
      channel: "C123",
      thread_ts: "1.0",
      ts: "2.0",
      user: "U123",
      text: "<@U999> join",
    }),
  ).toEqual({
    type: "ThreadActivity",
    channelId: "C123",
    threadTs: "1.0",
    messageTs: "2.0",
    userId: "U123",
    text: "<@U999> join",
  });
});

test("normalizes top-level DMs including bot messages", () => {
  expect(
    normalizeRealtimeEvent({
      type: "message",
      channel: "D123",
      channel_type: "im",
      ts: "2.0",
      user: "U123",
      text: '{"v":1,"type":"skip"}',
    }),
  ).toEqual({
    type: "DirectMessage",
    channelId: "D123",
    messageTs: "2.0",
    userId: "U123",
    text: '{"v":1,"type":"skip"}',
  });
  expect(
    normalizeRealtimeEvent({
      type: "message",
      subtype: "bot_message",
      channel: "D456",
      ts: "3.0",
      bot_id: "B123",
      text: '{"v":1,"type":"status"}',
    }),
  ).toEqual({
    type: "DirectMessage",
    channelId: "D456",
    messageTs: "3.0",
    userId: "B123",
    botId: "B123",
    text: '{"v":1,"type":"status"}',
  });
  expect(
    normalizeRealtimeEvent({
      type: "message",
      channel: "D123",
      thread_ts: "1.0",
      ts: "2.0",
      user: "U123",
      text: "reply",
    }),
  ).toBeUndefined();
});

test("normalizes a Huddle starting in a channel", () => {
  const started = {
    type: "message",
    subtype: "huddle_thread",
    channel: "C123",
    ts: "1.0",
    user: "U9",
    room: {
      id: "R123",
      created_by: "U1",
      has_ended: false,
      date_end: 0,
      participants: ["U1"],
    },
  };
  expect(normalizeRealtimeEvent(started)).toEqual({
    type: "HuddleStarted",
    channelId: "C123",
    threadTs: "1.0",
    callId: "R123",
    creatorUserId: "U1",
    participantIds: ["U1"],
  });
  expect(
    normalizeRealtimeEvent({
      ...started,
      room: { ...started.room, has_ended: true },
    }),
  ).toBeUndefined();
  expect(
    normalizeRealtimeEvent({ ...started, thread_ts: "0.5" }),
  ).toBeUndefined();
  expect(
    normalizeRealtimeEvent({ ...started, room: undefined }),
  ).toBeUndefined();
  expect(
    normalizeRealtimeEvent({
      ...started,
      room: { ...started.room, date_end: 2 },
    }),
  ).toBeUndefined();
  // An edit to the thread root is not a Huddle starting.
  expect(
    normalizeRealtimeEvent({
      type: "message",
      subtype: "message_changed",
      channel: "C123",
      ts: "3.0",
      message: started,
    }),
  ).toBeUndefined();
});

test("only accepts active Huddle thread roots", () => {
  const active = {
    ok: true,
    messages: [
      {
        ts: "1.0",
        subtype: "huddle_thread",
        room: {
          id: "R123",
          has_ended: false,
          date_end: 0,
          participants: ["U1", { user_id: "U2" }, 7],
        },
      },
    ],
  };
  expect(activeHuddleRoom(active, "1.0")).toEqual({
    callId: "R123",
    participantIds: ["U1", "U2"],
  });
  expect(activeHuddleRoom(active, "2.0")).toBeUndefined();
  expect(
    activeHuddleRoom(
      { ok: true, messages: [{ ts: "1.0", room: { id: "R123" } }] },
      "1.0",
    ),
  ).toBeUndefined();
  expect(
    activeHuddleRoom(
      {
        ok: true,
        messages: [
          {
            ts: "1.0",
            subtype: "huddle_thread",
            room: { id: "R123", has_ended: true },
          },
        ],
      },
      "1.0",
    ),
  ).toBeUndefined();
});

test("only counts listed Huddle participants as members", () => {
  const room = { callId: "R123", participantIds: ["U1", "U2"] };
  expect(huddleHasParticipant(room, "U1")).toBe(true);
  expect(huddleHasParticipant(room, "U3")).toBe(false);
  // Slack did not list anyone, so membership is unknown rather than empty.
  expect(
    huddleHasParticipant({ callId: "R123", participantIds: [] }, "U3"),
  ).toBe(true);
});

test("ignores partial lifecycle events", () => {
  expect(
    normalizeRealtimeEvent({
      type: "sh_room_leave",
      user: "U123",
      room: { name: "room" },
    }),
  ).toBeUndefined();
});

test("normalizes membership lifecycle events", () => {
  expect(
    normalizeRealtimeEvent({
      type: "sh_room_join",
      room: { call_id: "R123" },
      user: "U123",
    }),
  ).toEqual({ type: "MemberJoined", callId: "R123", userId: "U123" });
  expect(
    normalizeRealtimeEvent({
      type: "sh_room_leave",
      room: { id: "R123" },
      user: "U123",
    }),
  ).toEqual({ type: "MemberLeft", callId: "R123", userId: "U123" });
});

test("normalizes channel membership events", () => {
  expect(
    normalizeRealtimeEvent({ type: "channel_left", channel: "C123" }),
  ).toEqual({ type: "ChannelLeft", channelId: "C123" });
  expect(
    normalizeRealtimeEvent({
      type: "member_joined_channel",
      channel: "C123",
      user: "U123",
    }),
  ).toEqual({
    type: "ChannelMemberJoined",
    channelId: "C123",
    userId: "U123",
  });
});

test("reads channel managers from role assignments", () => {
  expect(
    channelManagerIds({
      ok: true,
      role_assignments: [
        { role_id: "Rl0A", users: ["U1", "U2", 3] },
        { role_id: "Rl01", users: ["U3"] },
        null,
      ],
    }),
  ).toEqual(["U1", "U2"]);
  expect(channelManagerIds({ ok: true })).toEqual([]);
});

test("spends a cached reconnect URL on one retry, then falls back to the gateway", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth.test")
      return Response.json({ ok: true, team_id: "T123", user_id: "U1" });
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;

  const paths: string[] = [];
  let gatewayConnections = 0;
  const server = Bun.serve<{ path: string }>({
    port: 0,
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      return server.upgrade(request, { data: { path: pathname } })
        ? undefined
        : new Response("no");
    },
    websocket: {
      open(socket) {
        paths.push(socket.data.path);
        if (socket.data.path === "/reconnect") {
          // An expired reconnect URL closes without ever saying hello.
          socket.close(1011, "reconnect url expired");
          return;
        }
        gatewayConnections++;
        socket.send(JSON.stringify({ type: "hello" }));
        if (gatewayConnections === 1) {
          socket.send(
            JSON.stringify({
              type: "reconnect_url",
              url: `ws://localhost:${server.port}/reconnect`,
            }),
          );
          setTimeout(() => socket.close(1001, "going away"), 50);
        }
      },
      message() {},
    },
  });

  const adapter = new SlackHuddleAdapter({
    workspaceUrl: "https://slack.test",
    xoxc: "token",
    xoxd: "cookie",
    mediaRegion: "us-east-1",
  });
  // The real Slack gateway is unreachable from a test; serve it locally.
  Reflect.set(
    adapter,
    "gatewayUrl",
    () => new URL(`ws://localhost:${server.port}/gateway`),
  );

  try {
    const reconnected = new Promise<void>((resolve) => {
      let connections = 0;
      adapter.onConnected = () => {
        connections++;
        if (connections === 2) resolve();
      };
    });
    await adapter.start(() => {});
    await reconnected;
    expect(paths).toEqual(["/gateway", "/reconnect", "/gateway"]);
  } finally {
    adapter.stop();
    server.stop(true);
    globalThis.fetch = originalFetch;
  }
}, 20_000);
