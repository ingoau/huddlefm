import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  expect(store.db.query("PRAGMA table_info(tracks)").all().map(row => (row as { name: string }).name))
    .not.toContain("position");
  store.close();
});

test("drops unfinished queue records on restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "huddlefm-store-"));
  const path = join(directory, "store.sqlite");
  let store = new Store(path);
  store.createSession({
    id: "session", huddleId: "huddle", callId: "call", channelId: "channel",
    threadTs: "1.0", creatorId: "creator", hostId: "host", volume: 0.6,
  });
  store.addTrack({
    id: "track", sessionId: "session", requesterId: "user",
    sourceInput: "https://example.com", canonicalUrl: "https://example.com",
    sourceId: "source", title: "Track", artist: "Artist", status: "ready",
  });
  store.close();
  store = new Store(path);
  expect(store.db.query("SELECT count(*) AS count FROM tracks").get()).toEqual({ count: 0 });
  expect(store.db.query("SELECT status FROM sessions").get()).toEqual({ status: "ended" });
  store.close();
  rmSync(directory, { recursive: true });
});
