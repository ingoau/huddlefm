import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";

test("persists session and permission defaults", () => {
  const store = new Store(":memory:");
  store.createSession({
    id: "session",
    huddleId: "huddle",
    callId: "call",
    channelId: "channel",
    threadTs: "1.0",
    creatorId: "creator",
    hostId: "host",
    volume: 0.6,
  });
  expect(
    store.db
      .query(
        "SELECT status, autoplay, display_mode, anchor_enabled FROM sessions",
      )
      .get(),
  ).toEqual({
    status: "ready",
    autoplay: 0,
    display_mode: "default",
    anchor_enabled: 0,
  });
  store.setSession("session", { autoplay: true });
  expect(store.db.query("SELECT autoplay FROM sessions").get()).toEqual({
    autoplay: 1,
  });
  expect(
    store.db
      .query(
        "SELECT capability FROM permissions WHERE allowed = 1 ORDER BY capability",
      )
      .all(),
  ).toEqual([{ capability: "add" }, { capability: "remove-own" }]);
  expect(
    store.db
      .query("SELECT allowed FROM permissions WHERE capability = 'add-bulk'")
      .get(),
  ).toEqual({ allowed: 0 });
  store.db
    .query("DELETE FROM permissions WHERE capability = 'configure-settings'")
    .run();
  store.setPermission("session", "configure-settings", true);
  expect(
    store.db
      .query(
        "SELECT allowed FROM permissions WHERE capability = 'configure-settings'",
      )
      .get(),
  ).toEqual({ allowed: 1 });
  expect(
    store.db
      .query("PRAGMA table_info(tracks)")
      .all()
      .map((row) => (row as { name: string }).name),
  ).not.toContain("position");
  expect(
    store.db
      .query("PRAGMA table_info(tracks)")
      .all()
      .map((row) => (row as { name: string }).name),
  ).toContain("automatic");
  store.close();
});

test("restores suspended sessions for three minutes", () => {
  const directory = mkdtempSync(join(tmpdir(), "huddlefm-store-"));
  const path = join(directory, "store.sqlite");
  let store = new Store(path);
  store.createSession({
    id: "session",
    huddleId: "huddle",
    callId: "call",
    channelId: "channel",
    threadTs: "1.0",
    creatorId: "creator",
    hostId: "host",
    volume: 0.6,
  });
  store.addTrack({
    id: "track",
    sessionId: "session",
    requesterId: "user",
    sourceInput: "https://example.com",
    canonicalUrl: "https://example.com",
    sourceId: "source",
    title: "Track",
    artist: "Artist",
    status: "ready",
  });
  store.addTrack({
    id: "played",
    sessionId: "session",
    requesterId: "user",
    sourceInput: "https://example.com/played",
    canonicalUrl: "https://example.com/played",
    sourceId: "played",
    title: "Played",
    artist: "Artist",
    status: "played",
  });
  store.setSession("session", {
    autoplay: true,
    playbackSeconds: 42,
    listenedSeconds: 84,
    displayMode: "off",
    anchorEnabled: false,
  });
  store.suspendSession(
    "session",
    {
      state: "paused",
      playbackSeconds: 42,
      displayMode: "lyrics",
      anchorEnabled: false,
      queue: ["track"],
    },
    180_000,
  );
  store.close();
  store = new Store(path);
  const saved = store.resumableSessions(1, 180_000);
  expect(saved.sessions).toHaveLength(1);
  expect(saved.sessions[0]).toEqual(
    expect.objectContaining({
      id: "session",
      state: "paused",
      playbackSeconds: 42,
      listenedSeconds: 84,
      autoplay: true,
      displayMode: "lyrics",
      anchorEnabled: false,
      resumeUntil: 180_000,
    }),
  );
  expect(saved.sessions[0]?.tracks).toEqual([
    expect.objectContaining({ id: "track", queuePosition: 0 }),
    expect.objectContaining({ id: "played", status: "played" }),
  ]);
  expect(store.resumableSessions(180_000, 180_000)).toEqual({
    sessions: [],
    expiredIds: ["session"],
  });
  expect(
    store.db
      .query("SELECT id, file_path, queue_position FROM tracks ORDER BY id")
      .all(),
  ).toEqual([
    { id: "played", file_path: null, queue_position: null },
    { id: "track", file_path: null, queue_position: null },
  ]);
  expect(store.db.query("SELECT status FROM sessions").get()).toEqual({
    status: "ended",
  });
  store.close();
  rmSync(directory, { recursive: true });
});

test("retains ended sessions until their restore window expires", () => {
  const store = new Store(":memory:");
  store.createSession({
    id: "session",
    huddleId: "huddle",
    callId: "call",
    channelId: "channel",
    threadTs: "1.0",
    creatorId: "creator",
    hostId: "host",
    volume: 0.6,
  });
  store.endSession(
    "session",
    {
      state: "paused",
      playbackSeconds: 42,
      listenedSeconds: 84,
      displayMode: "lyrics",
      anchorEnabled: true,
      queue: [],
    },
    120_000,
  );
  const blocks = [{ type: "actions" }];
  store.setEndMessage("session", "2.0", "Session ended", blocks);

  expect(store.resumableSessions(1, 180_000).sessions).toEqual([]);
  expect(store.restorableSessions()).toEqual([
    expect.objectContaining({
      id: "session",
      state: "paused",
      playbackSeconds: 42,
      listenedSeconds: 84,
      resumeUntil: 120_000,
      uiTs: "2.0",
      endText: "Session ended",
      endBlocks: blocks,
    }),
  ]);

  store.expireSession("session");
  expect(store.restorableSessions()).toEqual([]);
  store.close();
});

test("aggregates all-time canvas stats", () => {
  const store = new Store(":memory:");
  for (const [id, listenedSeconds] of [
    ["one", 120],
    ["two", 360],
  ] as const) {
    store.createSession({
      id,
      huddleId: id,
      callId: id,
      channelId: id,
      threadTs: "1.0",
      creatorId: "creator",
      hostId: "host",
      volume: 0.6,
    });
    store.setSession(id, { status: "ended", listenedSeconds });
  }
  const add = (
    id: string,
    sessionId: string,
    title: string,
    artist: string,
    requesterId: string,
    automatic = false,
    status = "played",
  ) =>
    store.addTrack({
      id,
      sessionId,
      requesterId,
      sourceInput: id,
      canonicalUrl: id,
      sourceId: title,
      title,
      artist,
      automatic,
      status,
    });
  add("1", "one", "Song", "Artist", "U1");
  add("2", "two", "Song", "Artist", "U1", true);
  add("3", "two", "Other", "Another", "U2");
  add("4", "two", "Queued", "Ignored", "U2", false, "ready");

  expect(store.canvasStats()).toEqual({
    sessions: { count: 2, listened: 480, longest: 360, active: 0 },
    tracks: { count: 3, uniqueTracks: 2, artists: 2, autoplay: 1 },
    topArtists: [
      { artist: "Artist", count: 2 },
      { artist: "Another", count: 1 },
    ],
    topTracks: [
      { title: "Song", artist: "Artist", count: 2 },
      { title: "Other", artist: "Another", count: 1 },
    ],
    topChannels: [
      { channelId: "two", count: 2 },
      { channelId: "one", count: 1 },
    ],
  });
  store.close();
});

test("stores usage counters and imports audit history once", () => {
  const store = new Store(":memory:");
  const history = {
    added: 3,
    removed: 2,
    next: 4,
    previous: 1,
    forward: 5,
    back: 6,
    paused: 7,
    resumed: 8,
    volume: 9,
    reordered: 10,
    cleared: 11,
    settings: 12,
  };
  expect(store.needsUsageBackfill()).toBeTrue();
  store.importUsage(history);
  store.incrementUsage("next");
  store.importUsage(history);
  expect(store.needsUsageBackfill()).toBeFalse();
  expect(store.usageStats()).toContainEqual({ label: "Next", count: 5 });
  expect(store.usageStats()).toContainEqual({
    label: "Settings changes",
    count: 12,
  });
  store.close();
});

test("migrates the old lyrics toggle to display mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "huddlefm-store-"));
  const path = join(directory, "store.sqlite");
  let store = new Store(path);
  store.createSession({
    id: "session",
    huddleId: "huddle",
    callId: "call",
    channelId: "channel",
    threadTs: "1.0",
    creatorId: "creator",
    hostId: "host",
    volume: 0.6,
  });
  store.close();

  const legacy = new Database(path);
  legacy.run("ALTER TABLE sessions DROP COLUMN display_mode");
  legacy.run("UPDATE sessions SET lyrics_enabled = 0");
  legacy.close();

  store = new Store(path);
  expect(store.db.query("SELECT display_mode FROM sessions").get()).toEqual({
    display_mode: "off",
  });
  store.close();
  rmSync(directory, { recursive: true });
});

test("persists global user scrobbling settings and deduplicates queued submissions", () => {
  const store = new Store(":memory:");
  expect(store.getUserScrobbling("user")).toEqual({
    lastFmEnabled: false,
    listenBrainzEnabled: false,
    mode: "always",
  });
  store.setLastFmPending("user", "pending", 10);
  store.connectLastFm("user", "last-user", "session-key");
  store.setListenBrainzToken("user", "lb-token", "musicbrainz-user");
  store.setListenBrainzEnabled("user", true);
  expect(store.getUserScrobbling("user")).toEqual({
    lastFmUsername: "last-user",
    lastFmSessionKey: "session-key",
    lastFmEnabled: true,
    listenBrainzUsername: "musicbrainz-user",
    listenBrainzToken: "lb-token",
    listenBrainzEnabled: true,
    mode: "always",
  });
  store.disconnectListenBrainz("user");
  expect(store.getUserScrobbling("user")).toEqual({
    lastFmUsername: "last-user",
    lastFmSessionKey: "session-key",
    lastFmEnabled: true,
    listenBrainzEnabled: false,
    mode: "always",
  });
  const track = {
    id: "track",
    requesterId: "requester",
    title: "Title",
    artist: "Artist",
    duration: 120,
  };
  store.queueScrobble("session", "track", "user", "lastfm", 100, track);
  store.queueScrobble("session", "track", "user", "lastfm", 100, track);
  expect(store.pendingScrobbles(Date.now())).toEqual([
    expect.objectContaining({
      userId: "user",
      service: "lastfm",
      listenedAt: 100,
      track,
    }),
  ]);
  store.close();
});

test("persists scrobbling mode and per-session overrides", () => {
  const store = new Store(":memory:");
  store.createSession({
    id: "session",
    huddleId: "huddle",
    callId: "call",
    channelId: "channel",
    threadTs: "1.0",
    creatorId: "creator",
    hostId: "host",
    volume: 0.6,
  });
  store.setScrobblingMode("user", "ask");
  expect(store.getUserScrobbling("user").mode).toBe("ask");
  expect(store.getSessionScrobbling("session", "user")).toBeUndefined();
  store.setSessionScrobbling("session", "user", true);
  expect(store.getSessionScrobbling("session", "user")).toBe(true);
  store.setSessionScrobbling("session", "user", false);
  expect(store.getSessionScrobbling("session", "user")).toBe(false);
  store.close();
});
