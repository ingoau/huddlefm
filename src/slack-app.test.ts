import { expect, test } from "bun:test";
import { channelAccess, normalizeInteraction } from "./slack-app.ts";

test("classifies channel access", () => {
  expect(channelAccess({ is_member: true, is_private: true })).toBe("ready");
  expect(channelAccess({ is_member: false, is_private: false })).toBe("join");
  expect(channelAccess({ is_member: false, is_private: true })).toBe("decline");
  expect(channelAccess()).toBe("decline");
});

test("normalizes block actions using immutable values", () => {
  expect(
    normalizeInteraction({
      type: "block_actions",
      user: { id: "U123" },
      actions: [{ action_id: "next_track", value: "queue_123" }],
    }),
  ).toEqual({
    type: "block_actions",
    userId: "U123",
    actionId: "next_track",
    value: "queue_123",
    channelId: "",
    messageTs: "",
    triggerId: "",
    metadata: "",
    state: {},
  });
});

test("normalizes suggestion queries", () => {
  expect(
    normalizeInteraction({
      type: "block_suggestion",
      user: { id: "U123" },
      action_id: "add_track_to_queue",
      value: "midnight city",
    }),
  ).toEqual({
    type: "block_suggestion",
    userId: "U123",
    actionId: "add_track_to_queue",
    value: "midnight city",
    channelId: "",
    messageTs: "",
    triggerId: "",
    metadata: "",
    state: {},
  });
});
