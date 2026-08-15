import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  expect(store.db.query("SELECT status, autoplay, display_mode, anchor_enabled FROM sessions").get())
    .toEqual({ status: "ready", autoplay: 0, display_mode: "default", anchor_enabled: 0 });
  store.setSession("session", { autoplay: true });
  expect(store.db.query("SELECT autoplay FROM sessions").get()).toEqual({ autoplay: 1 });
  expect(store.db.query("SELECT capability FROM permissions WHERE allowed = 1 ORDER BY capability").all())
    .toEqual([{ capability: "add" }, { capability: "remove-own" }]);
  store.db.query("DELETE FROM permissions WHERE capability = 'configure-settings'").run();
  store.setPermission("session", "configure-settings", true);
  expect(store.db.query("SELECT allowed FROM permissions WHERE capability = 'configure-settings'").get())
    .toEqual({ allowed: 1 });
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
  store.setSession("session", { autoplay: true, playbackSeconds: 42, displayMode: "off", anchorEnabled: false });
  store.suspendSession("session", {
    state: "paused", playbackSeconds: 42, displayMode: "lyrics", anchorEnabled: false, queue: ["track"],
  }, 180_000);
  store.close();
  store = new Store(path);
  const saved = store.resumableSessions(1, 180_000);
  expect(saved.sessions).toHaveLength(1);
  expect(saved.sessions[0]).toEqual(expect.objectContaining({
    id: "session", state: "paused", playbackSeconds: 42, autoplay: true,
    displayMode: "lyrics", anchorEnabled: false, resumeUntil: 180_000,
  }));
  expect(saved.sessions[0]?.tracks).toEqual([expect.objectContaining({ id: "track", queuePosition: 0 })]);
  expect(store.resumableSessions(180_000, 180_000)).toEqual({ sessions: [], expiredIds: ["session"] });
  expect(store.db.query("SELECT count(*) AS count FROM tracks").get()).toEqual({ count: 0 });
  expect(store.db.query("SELECT status FROM sessions").get()).toEqual({ status: "ended" });
  store.close();
  rmSync(directory, { recursive: true });
});

test("migrates the old lyrics toggle to display mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "huddlefm-store-"));
  const path = join(directory, "store.sqlite");
  let store = new Store(path);
  store.createSession({
    id: "session", huddleId: "huddle", callId: "call", channelId: "channel",
    threadTs: "1.0", creatorId: "creator", hostId: "host", volume: 0.6,
  });
  store.close();

  const legacy = new Database(path);
  legacy.run("ALTER TABLE sessions DROP COLUMN display_mode");
  legacy.run("UPDATE sessions SET lyrics_enabled = 0");
  legacy.close();

  store = new Store(path);
  expect(store.db.query("SELECT display_mode FROM sessions").get()).toEqual({ display_mode: "off" });
  store.close();
  rmSync(directory, { recursive: true });
});
