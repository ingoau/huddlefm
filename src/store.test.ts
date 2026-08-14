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
  expect(store.db.query("SELECT status, autoplay FROM sessions").get()).toEqual({ status: "ready", autoplay: 0 });
  store.setSession("session", { autoplay: true });
  expect(store.db.query("SELECT autoplay FROM sessions").get()).toEqual({ autoplay: 1 });
  expect(store.db.query("SELECT capability FROM permissions WHERE allowed = 1 ORDER BY capability").all())
    .toEqual([{ capability: "add" }, { capability: "remove-own" }]);
  expect(store.db.query("PRAGMA table_info(tracks)").all().map(row => (row as { name: string }).name))
    .not.toContain("position");
  expect(store.db.query("PRAGMA table_info(tracks)").all().map(row => (row as { name: string }).name))
    .toContain("automatic");
  store.close();
});

test("restores suspended sessions for three minutes", () => {
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
  store.setSession("session", { autoplay: true, playbackSeconds: 42, lyricsEnabled: false, anchorEnabled: false });
  store.suspendSession("session", {
    state: "paused", playbackSeconds: 42, lyricsEnabled: false, anchorEnabled: false, queue: ["track"],
  }, 180_000);
  store.close();
  store = new Store(path);
  const saved = store.resumableSessions(1, 180_000);
  expect(saved.sessions).toHaveLength(1);
  expect(saved.sessions[0]).toEqual(expect.objectContaining({
    id: "session", state: "paused", playbackSeconds: 42, autoplay: true,
    lyricsEnabled: false, anchorEnabled: false, resumeUntil: 180_000,
  }));
  expect(saved.sessions[0]?.tracks).toEqual([expect.objectContaining({ id: "track", queuePosition: 0 })]);
  expect(store.resumableSessions(180_000, 180_000)).toEqual({ sessions: [], expiredIds: ["session"] });
  expect(store.db.query("SELECT count(*) AS count FROM tracks").get()).toEqual({ count: 0 });
  expect(store.db.query("SELECT status FROM sessions").get()).toEqual({ status: "ended" });
  store.close();
  rmSync(directory, { recursive: true });
});
