import { expect, test } from "bun:test";
import {
  ackEnvelope,
  normalizeInteraction,
  SlackAppAdapter,
  slackErrorCode,
} from "./slack-app.ts";

function apiError(code: string) {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    data: { error: code },
  });
}

function adapterWithViews(
  update: (options: Record<string, unknown>) => unknown,
) {
  const adapter = new SlackAppAdapter({ xapp: "xapp-1", xoxp: "xoxp-1" });
  Reflect.set(adapter, "web", { views: { update } });
  return adapter;
}

test("reads the reason out of a Slack API error", () => {
  expect(slackErrorCode(apiError("hash_conflict"))).toBe("hash_conflict");
  expect(slackErrorCode(new Error("hash_conflict"))).toBeUndefined();
  expect(slackErrorCode(undefined)).toBeUndefined();
});

test("updates the current view when a modal hash is stale", async () => {
  const calls: Record<string, unknown>[] = [];
  const adapter = adapterWithViews(async (options) => {
    calls.push(options);
    if (calls.length === 1) throw apiError("hash_conflict");
    return { view: { id: "V123", hash: "fresh" } };
  });

  expect(await adapter.updateModal("V123", "stale", { type: "modal" })).toEqual(
    {
      id: "V123",
      hash: "fresh",
    },
  );
  expect(calls).toEqual([
    { view_id: "V123", hash: "stale", view: { type: "modal" } },
    { view_id: "V123", view: { type: "modal" } },
  ]);
});

test("reports modal update failures other than a stale hash", async () => {
  const calls: Record<string, unknown>[] = [];
  const adapter = adapterWithViews(async (options) => {
    calls.push(options);
    throw apiError("not_found");
  });

  await expect(
    adapter.updateModal("V123", "stale", { type: "modal" }),
  ).rejects.toThrow("not_found");
  expect(calls).toHaveLength(1);
});

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
