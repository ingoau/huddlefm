import { expect, test } from "bun:test";
import {
  activeHuddleCallId,
  channelAccess,
  normalizeInvitedJoinResponse,
  normalizeJoinResponse,
  normalizeRealtimeEvent,
  roomOwnsThread,
} from "./slack-huddle.ts";

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

test("only accepts active Huddle thread roots", () => {
  const active = {
    ok: true,
    messages: [
      {
        ts: "1.0",
        subtype: "huddle_thread",
        room: { id: "R123", has_ended: false, date_end: 0 },
      },
    ],
  };
  expect(activeHuddleCallId(active, "1.0")).toBe("R123");
  expect(activeHuddleCallId(active, "2.0")).toBeUndefined();
  expect(
    activeHuddleCallId(
      { ok: true, messages: [{ ts: "1.0", room: { id: "R123" } }] },
      "1.0",
    ),
  ).toBeUndefined();
  expect(
    activeHuddleCallId(
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
