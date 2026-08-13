import { expect, test } from "bun:test";
import { Store } from "./store.ts";

test("persists session and permission defaults", () => {
  const store = new Store(":memory:");
  store.createSession({
    id: "session", huddleId: "huddle", callId: "call", channelId: "channel",
    threadTs: "1.0", creatorId: "creator", hostId: "host", volume: 0.6,
  });
  expect(store.db.query("SELECT status FROM sessions").get()).toEqual({ status: "ready" });
  expect(store.db.query("SELECT capability FROM permissions WHERE allowed = 1 ORDER BY capability").all())
    .toEqual([{ capability: "add" }, { capability: "remove-own" }]);
  store.close();
});
