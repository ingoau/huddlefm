import { expect, test } from "bun:test";
import { channelAccess, normalizeJoinResponse, normalizeRealtimeEvent } from "./slack-huddle.ts";

test("classifies channel access", () => {
  expect(channelAccess({ is_member: true, is_private: true })).toBe("ready");
  expect(channelAccess({ is_member: false, is_private: false })).toBe("join");
  expect(channelAccess({ is_member: false, is_private: true })).toBe("decline");
  expect(channelAccess()).toBe("decline");
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
    normalizeJoinResponse({ ok: false, error: "invalid_auth", token: "secret" }),
  ).toThrow("rooms.join failed: invalid_auth");
});

test("normalizes a Huddle invitation with its actor", () => {
  expect(
    normalizeRealtimeEvent({
      type: "huddle_invite",
      channel_id: "C123",
      call_id: "R123",
      sender_user_id: "U123",
      free_willy: { secret: "discarded" },
    }),
  ).toEqual({
    type: "HuddleInvited",
    channelId: "C123",
    callId: "R123",
    inviterUserId: "U123",
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

test("ignores partial lifecycle events", () => {
  expect(
    normalizeRealtimeEvent({
      type: "sh_room_leave",
      user: "U123",
      room: { id: "room" },
    }),
  ).toBeUndefined();
});

test("normalizes membership lifecycle events", () => {
  expect(normalizeRealtimeEvent({
    type: "sh_room_join",
    room: { call_id: "R123" },
    user: "U123",
  })).toEqual({ type: "MemberJoined", callId: "R123", userId: "U123" });
  expect(normalizeRealtimeEvent({
    type: "sh_room_leave",
    call_id: "R123",
    user: "U123",
  })).toEqual({ type: "MemberLeft", callId: "R123", userId: "U123" });
});
