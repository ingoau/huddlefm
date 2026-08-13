import { expect, test } from "bun:test";
import { normalizeJoinResponse } from "./slack-huddle.ts";

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
      huddle: { id: "huddle" },
    }),
  ).toEqual({
    huddleCallId: "call",
    huddleId: "huddle",
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
