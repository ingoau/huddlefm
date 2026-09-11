import { expect, test } from "bun:test";
import {
  ackEnvelope,
  normalizeInteraction,
  startHeartbeat,
  type HeartbeatSocket,
} from "./slack-app.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSocket() {
  const listeners = new Map<string, (() => void)[]>();
  return {
    pings: 0,
    terminated: false,
    ping() {
      this.pings++;
    },
    terminate() {
      this.terminated = true;
    },
    addEventListener(type: "pong", listener: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    pong() {
      for (const listener of listeners.get("pong") ?? []) listener();
    },
  };
}

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

test("heartbeat keeps pinging while pongs arrive", async () => {
  const socket = fakeSocket();
  const stop = startHeartbeat(socket, { intervalMs: 5, timeoutMs: 40 });
  const pongTimer = setInterval(() => socket.pong(), 5);
  await sleep(100);
  clearInterval(pongTimer);
  stop();
  expect(socket.pings).toBeGreaterThan(5);
  expect(socket.terminated).toBeFalse();
});

test("heartbeat terminates a socket that stops answering pings", async () => {
  const socket = fakeSocket();
  const stale: number[] = [];
  const stop = startHeartbeat(socket, {
    intervalMs: 5,
    timeoutMs: 30,
    onStale: (silentMs) => stale.push(silentMs),
  });
  await sleep(100);
  stop();
  expect(socket.terminated).toBeTrue();
  expect(stale).toHaveLength(1);
  expect(stale[0]).toBeGreaterThan(30);
  // Pinging stops once the socket is terminated.
  const pings = socket.pings;
  await sleep(20);
  expect(socket.pings).toBe(pings);
});

test("heartbeat stops pinging after it is cancelled", async () => {
  const socket = fakeSocket();
  const stop = startHeartbeat(socket, { intervalMs: 5, timeoutMs: 1000 });
  await sleep(20);
  stop();
  const pings = socket.pings;
  await sleep(20);
  expect(socket.pings).toBe(pings);
  expect(socket.terminated).toBeFalse();
});

test("heartbeat closes a real connection whose peer stops responding", async () => {
  // Bun's server answers pings automatically, so stall the client instead:
  // a socket that never receives pongs is indistinguishable from a dead peer.
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("no");
    },
    websocket: { message() {} },
  });
  try {
    const socket = new WebSocket(`ws://localhost:${server.port}`);
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve),
    );
    const real = socket as unknown as HeartbeatSocket;
    const stop = startHeartbeat(
      {
        ping: () => {},
        terminate: () => real.terminate(),
        addEventListener: (type, listener) =>
          real.addEventListener(type, listener),
      },
      { intervalMs: 5, timeoutMs: 30 },
    );
    try {
      expect((await closed).code).toBe(1006);
    } finally {
      stop();
    }
  } finally {
    server.stop(true);
  }
});
