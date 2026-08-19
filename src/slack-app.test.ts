import { expect, test } from "bun:test";
import { ackEnvelope, normalizeInteraction } from "./slack-app.ts";

test("acknowledges on the socket that received the envelope", () => {
  const sent: string[] = [];
  expect(
    ackEnvelope({ send: (value) => sent.push(String(value)) }, "envelope", {
      options: [],
    }),
  ).toBeTrue();
  expect(sent).toEqual([
    JSON.stringify({ envelope_id: "envelope", payload: { options: [] } }),
  ]);
});

test("normalizes block actions using immutable values", () => {
  expect(
    normalizeInteraction({
      type: "block_actions",
      user: { id: "U123" },
      response_url: "https://hooks.slack.com/actions/test",
      actions: [{ action_id: "next_track", value: "queue_123" }],
      view: { id: "V123", hash: "hash", previous_view_id: "V122" },
    }),
  ).toEqual({
    type: "block_actions",
    userId: "U123",
    actionId: "next_track",
    value: "queue_123",
    channelId: "",
    messageTs: "",
    triggerId: "",
    responseUrl: "https://hooks.slack.com/actions/test",
    viewId: "V123",
    viewHash: "hash",
    previousViewId: "V122",
    metadata: "",
    state: {},
  });
});

test("normalizes suggestion queries", () => {
  expect(
    normalizeInteraction({
      type: "block_suggestion",
      user: { id: "U123" },
      action_id: "selection",
      value: "midnight city",
    }),
  ).toEqual({
    type: "block_suggestion",
    userId: "U123",
    actionId: "selection",
    value: "midnight city",
    channelId: "",
    messageTs: "",
    triggerId: "",
    metadata: "",
    state: {},
  });
});
