import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recentTrackLimit, Store } from "./store.ts";

function createSession(
  store: Store,
  overrides: Partial<Parameters<Store["createSession"]>[0]> = {},
) {
  store.createSession({
    id: "session",
    huddleId: "huddle",
    callId: "call",
    channelId: "channel",
    threadTs: "1.0",
    creatorId: "creator",
    hostId: "host",
    volume: 0.6,
    ...overrides,
  });
}

test("persists session and permission defaults", () => {
  const store = new Store(":memory:");
  createSession(store);
  expect(
    store.db
      .query(
        "SELECT status, autoplay, loop_mode, transition_mode, ducking_mode, display_mode, anchor_enabled FROM sessions",
      )
      .get(),
  ).toEqual({
    status: "ready",
    autoplay: "off",
    loop_mode: "off",
    transition_mode: "none",
    // Left unset so restores fall back to the configured default.
    ducking_mode: null,
    display_mode: "default",
    anchor_enabled: 0,
  });
  store.setSession("session", { autoplay: "related" });
  expect(store.db.query("SELECT autoplay FROM sessions").get()).toEqual({
    autoplay: "related",
  });
  store.setSession("session", { loopMode: "queue" });
  expect(store.db.query("SELECT loop_mode FROM sessions").get()).toEqual({
    loop_mode: "queue",
  });
  store.setSession("session", { transitionMode: "gapless" });
  expect(store.db.query("SELECT transition_mode FROM sessions").get()).toEqual({
    transition_mode: "gapless",
  });
  store.setSession("session", { duckingMode: "strong" });
  expect(store.db.query("SELECT ducking_mode FROM sessions").get()).toEqual({
    ducking_mode: "strong",
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

test("persists companion channels and cleanup jobs", () => {
  const store = new Store(":memory:");
  store.setCompanionChannel("source", "companion");
  store.setCompanionChannel("source", "replacement");
  expect(store.companionChannel("source")).toBe("replacement");
  expect(store.sourceChannelForCompanion("replacement")).toBe("source");
  expect(store.sourceChannelForCompanion("missing")).toBeUndefined();

  store.scheduleCompanionRemoval("replacement", "user", 100);
  expect(store.dueCompanionRemovals(99)).toEqual([]);
  expect(store.dueCompanionRemovals(100)).toEqual([
    { channelId: "replacement", userId: "user", dueAt: 100, attempts: 0 },
  ]);
  store.cancelCompanionRemoval("replacement", "user");
  expect(store.dueCompanionRemovals(100)).toEqual([]);

  createSession(store, {
    channelId: "replacement",
    threadTs: "",
    sourceChannelId: "source",
    huddleThreadTs: "1.0",
    companionChannelId: "replacement",
    hostId: undefined,
  });
  store.recordSessionMessage("session", "replacement", "2.0");
  store.setSessionParticipants("session", ["host", "guest", "guest"]);
  store.removeSessionParticipant("session", "guest");
  store.addSessionParticipant("session", "listener");
  store.scheduleSessionMessageCleanup("session", 200);
  expect(store.dueSessionMessages(200)).toEqual([
    {
      sessionId: "session",
      channelId: "replacement",
      messageTs: "2.0",
      attempts: 0,
    },
  ]);
  store.activateSession("session", "playing");
  expect(store.dueSessionMessages(200)).toEqual([]);
  expect(store.claimDueSessionMessage("replacement", "2.0", 200)).toBe(false);
  expect(
    store.db
      .query(
        "SELECT message_cleanup_at, delete_at, next_attempt_at FROM sessions JOIN session_messages ON sessions.id = session_messages.session_id WHERE sessions.id = ?",
      )
      .get("session"),
  ).toEqual({
    message_cleanup_at: null,
    delete_at: null,
    next_attempt_at: null,
  });
  expect(store.restorableSessions()).toEqual([]);
  expect(store.sessionParticipants("session")).toEqual(["host", "listener"]);
  expect(store.sessionCompanionChannel("session")).toBe("replacement");
  expect(
    store.db
      .query(
        "SELECT source_channel_id, huddle_thread_ts, companion_channel_id FROM sessions",
      )
      .get(),
  ).toEqual({
    source_channel_id: "source",
    huddle_thread_ts: "1.0",
    companion_channel_id: "replacement",
  });
  store.close();
});

test("claimDueSessionMessage rejects jobs cleared by activateSession", () => {
  const store = new Store(":memory:");
  createSession(store, {
    channelId: "companion",
    threadTs: "",
    hostId: undefined,
  });
  store.recordSessionMessage("session", "companion", "1.0");
  store.scheduleSessionMessageCleanup("session", 100);
  const jobs = store.dueSessionMessages(100);
  expect(jobs).toEqual([
    {
      sessionId: "session",
      channelId: "companion",
      messageTs: "1.0",
      attempts: 0,
    },
  ]);
  // Cleanup already observed the due job; activateSession must still cancel it.
  store.activateSession("session", "playing");
  expect(
    store.claimDueSessionMessage(jobs[0]!.channelId, jobs[0]!.messageTs, 100),
  ).toBe(false);
  store.close();
});

test("retrySessionMessage does not restore jobs cleared by activateSession", () => {
  const store = new Store(":memory:");
  createSession(store, {
    channelId: "companion",
    threadTs: "",
    hostId: undefined,
  });
  store.recordSessionMessage("session", "companion", "1.0");
  store.scheduleSessionMessageCleanup("session", 100);
  expect(store.dueSessionMessages(100)).toHaveLength(1);
  store.activateSession("session", "playing");
  expect(store.retrySessionMessage("companion", "1.0", 1, 200)).toBe(false);
  expect(store.dueSessionMessages(200)).toEqual([]);
  expect(
    store.db
      .query(
        "SELECT delete_at, next_attempt_at FROM session_messages WHERE channel_id = ? AND message_ts = ?",
      )
      .get("companion", "1.0"),
  ).toEqual({ delete_at: null, next_attempt_at: null });
  store.close();
});

test("creates indexes for recurring session, track, and scrobble queries", () => {
  const store = new Store(":memory:");
  const indexes = ["sessions", "tracks", "scrobbles"].flatMap((table) =>
    (
      store.db.query(`PRAGMA index_list(${table})`).all() as { name: string }[]
    ).map(({ name }) => name),
  );

  expect(indexes).toContain("sessions_status_resume");
  expect(indexes).toContain("tracks_session_status");
  expect(indexes).toContain("tracks_status_source");
  expect(indexes).toContain("scrobbles_pending");
  store.close();
});

test("updates track display metadata after embedded tags are read", () => {
  const store = new Store(":memory:");
  createSession(store);
  store.addTrack({
    id: "track",
    sessionId: "session",
    requesterId: "user",
    sourceInput: "https://example.com/song.mp3",
    canonicalUrl: "https://example.com/song.mp3",
    sourceId: "song",
    title: "song",
    artist: "Unknown artist",
    status: "preparing",
  });
  store.setTrack("track", {
    status: "ready",
    title: "Helix One",
    artist: "SoundHelix",
    album: "Demos",
    duration: 120,
    artwork: "https://example.com/art.jpg",
  });
  expect(
    store.db
      .query(
        "SELECT status, title, artist, album, duration, artwork FROM tracks WHERE id = ?",
      )
      .get("track"),
  ).toEqual({
    status: "ready",
    title: "Helix One",
    artist: "SoundHelix",
    album: "Demos",
    duration: 120,
    artwork: "https://example.com/art.jpg",
  });
  store.close();
});

test("creates the recent-track index after migrating legacy databases", () => {
  const directory = mkdtempSync(join(tmpdir(), "huddlefm-store-"));
  const path = join(directory, "store.sqlite");
  const legacy = new Database(path, { create: true });
  legacy.run(`CREATE TABLE tracks (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    requester_id TEXT,
    source_id TEXT,
    title TEXT,
    artist TEXT,
    status TEXT,
    created_at INTEGER
  )`);
  legacy.close();

  const store = new Store(path);
  const indexes = store.db
    .query("PRAGMA index_list(tracks)")
    .all()
    .map((row) => (row as { name: string }).name);
  expect(indexes).toContain("tracks_requester_recent");
  expect(indexes).toContain("tracks_played_title_artist");
  store.close();
  rmSync(directory, { recursive: true });
});

test("restores suspended sessions for three minutes", () => {
  const directory = mkdtempSync(join(tmpdir(), "huddlefm-store-"));
  const path = join(directory, "store.sqlite");
  let store = new Store(path);
  createSession(store);
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
  store.setTrack("track", {
    introSeconds: 1.2,
    outroSeconds: 58.4,
    fadeInSeconds: 2,
    fadeOutSeconds: 4,
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
    autoplay: "related",
    loopMode: "track",
    transitionMode: "gapless",
    duckingMode: "strong",
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
      autoplay: "related",
      loopMode: "track",
      transitionMode: "gapless",
      duckingMode: "strong",
      displayMode: "lyrics",
      anchorEnabled: false,
      resumeUntil: 180_000,
    }),
  );
  expect(saved.sessions[0]?.tracks).toEqual([
    expect.objectContaining({
      id: "track",
      queuePosition: 0,
      introSeconds: 1.2,
      outroSeconds: 58.4,
      fadeInSeconds: 2,
      fadeOutSeconds: 4,
    }),
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
  createSession(store);
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
    sessions: { count: 2, listened: 480, watched: 0, longest: 360, active: 0 },
    tracks: { count: 3, uniqueTracks: 2, artists: 2, autoplay: 1 },
    videos: { count: 0 },
    topArtists: [
      { artist: "Artist", count: 2 },
      { artist: "Another", count: 1 },
    ],
    topTracks: [
      { title: "Song", artist: "Artist", count: 2 },
      { title: "Other", artist: "Another", count: 1 },
    ],
    topVideos: [],
    topVideoChannels: [],
    topChannels: [
      { channelId: "two", count: 2 },
      { channelId: "one", count: 1 },
    ],
  });
  store.close();
});

test("returns each user's latest distinct manual tracks", () => {
  const store = new Store(":memory:");
  createSession(store, { threadTs: "1", hostId: undefined });
  const add = (
    id: string,
    sourceId: string,
    requesterId = "user",
    automatic = false,
  ) =>
    store.addTrack({
      id,
      sessionId: "session",
      requesterId,
      sourceInput: id,
      canonicalUrl: id,
      sourceId,
      title: id,
      artist: "Artist",
      automatic,
      status: "played",
    });
  add("old", "same");
  add("other-user", "other", "other-user");
  add("automatic", "automatic", "user", true);
  add("new", "same");
  add("latest", "latest");

  expect(store.recentTracks("user").map(({ id }) => id)).toEqual([
    "latest",
    "new",
  ]);
  expect(store.recentTracks("user", 1).map(({ id }) => id)).toEqual(["latest"]);
  store.close();
});

test("returns up to one hundred distinct recent tracks by default", () => {
  const store = new Store(":memory:");
  createSession(store, { threadTs: "1", hostId: undefined });
  for (let index = 0; index < recentTrackLimit + 1; index++) {
    store.addTrack({
      id: `song-${index}`,
      sessionId: "session",
      requesterId: "user",
      sourceInput: `song-${index}`,
      canonicalUrl: `song-${index}`,
      sourceId: `source-${index}`,
      title: `Song ${index}`,
      artist: "Artist",
      status: "played",
    });
  }
  const recent = store.recentTracks("user");
  expect(recent).toHaveLength(recentTrackLimit);
  expect(recent[0]?.id).toBe(`song-${recentTrackLimit}`);
  expect(recent.at(-1)?.id).toBe("song-1");
  expect(store.recentTracks("user", 10)).toHaveLength(10);
  store.close();
});

test("groups channel statistics by source after companion replacement", () => {
  const store = new Store(":memory:");
  for (const [id, channelId] of [
    ["one", "companion-one"],
    ["two", "companion-two"],
  ] as const) {
    store.createSession({
      id,
      huddleId: id,
      callId: id,
      channelId,
      threadTs: "",
      sourceChannelId: "source",
      creatorId: "creator",
      volume: 0.6,
    });
    store.addTrack({
      id: `track-${id}`,
      sessionId: id!,
      requesterId: "user",
      sourceInput: id,
      canonicalUrl: id,
      sourceId: id,
      title: id,
      artist: "Artist",
      status: "played",
    });
  }
  expect(store.canvasStats().topChannels).toEqual([
    { channelId: "source", count: 2 },
  ]);
  store.close();
});

test("persists a live queue order without disturbing history", () => {
  const store = new Store(":memory:");
  createSession(store, { threadTs: "1", creatorId: "host" });
  const add = (id: string, status: string) =>
    store.addTrack({
      id,
      sessionId: "session",
      requesterId: "host",
      sourceInput: id,
      canonicalUrl: id,
      sourceId: id,
      title: id,
      artist: "Artist",
      status,
    });
  add("first", "played");
  add("second", "played");
  add("a", "ready");
  add("b", "ready");
  add("c", "ready");

  store.setQueueOrder("session", ["c", "a", "b"]);
  const tracks = store.resumableSessions(Date.now(), 600_000).sessions[0]
    ?.tracks;
  expect(
    tracks?.filter((track) => track.status === "ready").map((t) => t.id),
  ).toEqual(["c", "a", "b"]);
  // Played tracks keep their own chronology; a rewrite clears stale positions.
  expect(
    tracks?.filter((track) => track.status === "played").map((t) => t.id),
  ).toEqual(["first", "second"]);

  store.setQueueOrder("session", ["b"]);
  expect(
    store
      .resumableSessions(Date.now(), 600_000)
      .sessions[0]?.tracks.map((track) => [track.id, track.queuePosition]),
  ).toEqual([
    ["b", 0],
    ["first", undefined],
    ["second", undefined],
    ["a", undefined],
    ["c", undefined],
  ]);
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
    shuffled: 11,
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
  expect(store.usageStats()).toContainEqual({
    label: "Queue shuffles",
    count: 11,
  });
  store.close();
});

test("migrates the old lyrics toggle to display mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "huddlefm-store-"));
  const path = join(directory, "store.sqlite");
  let store = new Store(path);
  createSession(store);
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

test("restores sessions saved before ducking without a stored mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "huddlefm-store-"));
  const path = join(directory, "store.sqlite");
  let store = new Store(path);
  createSession(store);
  store.close();

  const legacy = new Database(path);
  legacy.run("ALTER TABLE sessions DROP COLUMN ducking_mode");
  legacy.close();

  store = new Store(path);
  store.suspendSession(
    "session",
    {
      state: "playing",
      playbackSeconds: 0,
      displayMode: "default",
      anchorEnabled: false,
      queue: [],
    },
    180_000,
  );
  // Left out entirely so the configured default applies on restore.
  const [saved] = store.resumableSessions(1, 180_000).sessions;
  expect(saved).toBeDefined();
  expect(saved).not.toHaveProperty("duckingMode");

  store.db.run("UPDATE sessions SET ducking_mode = 'loud'");
  expect(store.resumableSessions(1, 180_000).sessions[0]).not.toHaveProperty(
    "duckingMode",
  );
  store.db.run("UPDATE sessions SET ducking_mode = 'strong'");
  expect(store.resumableSessions(1, 180_000).sessions[0]).toHaveProperty(
    "duckingMode",
    "strong",
  );
  store.close();
  rmSync(directory, { recursive: true });
});

test("persists global user scrobbling settings and deduplicates queued submissions", () => {
  const store = new Store(":memory:");
  expect(store.getUserScrobbling("user")).toEqual({
    lastFmEnabled: false,
    listenBrainzEnabled: false,
    huddleMixOptIn: true,
    huddleMixSources: ["added"],
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
    huddleMixOptIn: true,
    huddleMixSources: ["added", "lastfm", "listenbrainz"],
    mode: "always",
  });
  store.disconnectListenBrainz("user");
  expect(store.getUserScrobbling("user")).toEqual({
    lastFmUsername: "last-user",
    lastFmSessionKey: "session-key",
    lastFmEnabled: true,
    listenBrainzEnabled: false,
    huddleMixOptIn: true,
    huddleMixSources: ["added", "lastfm"],
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
  createSession(store);
  store.setScrobblingMode("user", "ask");
  expect(store.getUserScrobbling("user").mode).toBe("ask");
  expect(store.getSessionScrobbling("session", "user")).toBeUndefined();
  store.setSessionScrobbling("session", "user", true);
  expect(store.getSessionScrobbling("session", "user")).toBe(true);
  store.setSessionScrobbling("session", "user", false);
  expect(store.getSessionScrobbling("session", "user")).toBe(false);
  store.close();
});

test("migrates integer autoplay flags to off and related", () => {
  const directory = mkdtempSync(join(tmpdir(), "huddlefm-store-"));
  const path = join(directory, "store.sqlite");
  const legacy = new Database(path, { create: true });
  const now = Date.now();
  legacy.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    huddle_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    status TEXT NOT NULL,
    volume REAL NOT NULL DEFAULT 0.6,
    autoplay INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resume_until INTEGER
  )`);
  legacy
    .query(
      `INSERT INTO sessions (id, huddle_id, call_id, channel_id, thread_ts, creator_id, status, autoplay, created_at, updated_at)
      VALUES (?, 'h', 'c', 'ch', '1', 'u', 'ready', ?, ?, ?)`,
    )
    .run("on", 1, now, now);
  legacy
    .query(
      `INSERT INTO sessions (id, huddle_id, call_id, channel_id, thread_ts, creator_id, status, autoplay, created_at, updated_at)
      VALUES (?, 'h', 'c', 'ch', '1', 'u', 'ready', ?, ?, ?)`,
    )
    .run("off", 0, now, now);
  legacy.close();
  const store = new Store(path);
  expect(
    store.db.query("SELECT id, autoplay FROM sessions ORDER BY id").all(),
  ).toEqual([
    { id: "off", autoplay: "off" },
    { id: "on", autoplay: "related" },
  ]);
  store.close();
  rmSync(directory, { recursive: true });
});

test("lists recently autoplayed songs once each, newest first", () => {
  const store = new Store(":memory:");
  createSession(store, { creatorId: "host" });
  const add = (id: string, title: string, automatic: boolean) =>
    store.addTrack({
      id,
      sessionId: "session",
      requesterId: "host",
      sourceInput: id,
      canonicalUrl: id,
      sourceId: id,
      title,
      artist: "Band",
      automatic,
      status: "played",
    });
  add("1", "Manual", false);
  add("2", "Older Pick", true);
  add("3", "Newer Pick", true);
  add("4", "older pick", true);
  expect(store.recentAutomaticTracks().map((track) => track.title)).toEqual([
    "older pick",
    "Newer Pick",
  ]);
  expect(store.recentAutomaticTracks(1).map((track) => track.title)).toEqual([
    "older pick",
  ]);
  store.close();
});

test("persists huddle mix opt-in per Slack user", () => {
  const store = new Store(":memory:");
  expect(store.getUserScrobbling("user").huddleMixOptIn).toBe(true);
  store.setHuddleMixOptIn("user", false);
  expect(store.getUserScrobbling("user").huddleMixOptIn).toBe(false);
  store.setHuddleMixOptIn("user", true);
  expect(store.getUserScrobbling("user").huddleMixOptIn).toBe(true);
  store.close();
});

test("persists which sources each listener gives the Huddle mix", () => {
  const store = new Store(":memory:");
  // Only connected services are usable.
  expect(store.getUserScrobbling("user").huddleMixSources).toEqual(["added"]);
  store.setListenBrainzToken("user", "token", "listener");
  store.setHuddleMixSources("user", { added: false });
  expect(store.getUserScrobbling("user")).toMatchObject({
    huddleMixOptIn: true,
    huddleMixSources: ["listenbrainz"],
  });
  // Last.fm keeps its choice until it is connected.
  store.setHuddleMixSources("user", { lastfm: false });
  store.connectLastFm("user", "last-user", "session-key");
  expect(store.getUserScrobbling("user").huddleMixSources).toEqual([
    "listenbrainz",
  ]);
  store.setHuddleMixSources("user", { listenbrainz: false });
  expect(store.getUserScrobbling("user")).toMatchObject({
    huddleMixOptIn: false,
    huddleMixSources: [],
  });
  store.close();
});

test("turning off every usable source opts out, even of services connected later", () => {
  const store = new Store(":memory:");
  store.setHuddleMixSources("user", { added: false });
  expect(store.getUserScrobbling("user").huddleMixOptIn).toBe(false);
  store.connectLastFm("user", "last-user", "session-key");
  expect(store.getUserScrobbling("user")).toMatchObject({
    huddleMixOptIn: false,
    huddleMixSources: [],
  });
  store.close();
});

test("a Huddle mix save that changes nothing keeps hidden choices", () => {
  const store = new Store(":memory:");
  store.connectLastFm("user", "last-user", "session-key");
  store.setHuddleMixSources("user", { added: false });
  store.disconnectLastFm("user");
  expect(store.getUserScrobbling("user").huddleMixOptIn).toBe(false);
  store.setHuddleMixSources("user", { added: false });
  store.connectLastFm("user", "last-user", "session-key");
  expect(store.getUserScrobbling("user").huddleMixSources).toEqual(["lastfm"]);
  store.close();
});

test("an opt-out saved before per-source settings turns every source off", () => {
  const store = new Store(":memory:");
  store.connectLastFm("user", "last-user", "session-key");
  store.db.run("UPDATE user_scrobbling SET huddle_mix_opt_in = 0");
  expect(store.getUserScrobbling("user")).toMatchObject({
    huddleMixOptIn: false,
    huddleMixSources: [],
  });
  store.close();
});

test("remembers what each listener heard, across Huddles", () => {
  const store = new Store(":memory:");
  const session = (id: string, sourceChannelId?: string) =>
    store.createSession({
      id,
      huddleId: `huddle-${id}`,
      callId: `call-${id}`,
      channelId: "companion",
      threadTs: "1.0",
      ...(sourceChannelId ? { sourceChannelId } : {}),
      creatorId: "creator",
      hostId: "host",
      volume: 0.6,
    });
  session("monday", "general");
  session("tuesday", "general");
  session("elsewhere", "random");

  store.recordTrackPlay({
    sessionId: "monday",
    userId: "host",
    title: "Song",
    artist: "Band",
    playedAt: 1_000,
  });
  store.recordTrackPlay({
    sessionId: "tuesday",
    userId: "guest",
    title: "Other",
    artist: "Band",
    playedAt: 2_000,
  });
  store.recordTrackPlay({
    sessionId: "elsewhere",
    userId: "host",
    title: "Far Away",
    artist: "Band",
    playedAt: 3_000,
  });

  expect(store.recentPlays(["host"], 0)).toEqual([
    { userId: "host", title: "Far Away", artist: "Band", playedAt: 3_000 },
    { userId: "host", title: "Song", artist: "Band", playedAt: 1_000 },
  ]);
  // The window is honoured, and listeners nobody asked about stay out.
  expect(store.recentPlays(["host"], 2_000)).toEqual([
    { userId: "host", title: "Far Away", artist: "Band", playedAt: 3_000 },
  ]);
  expect(store.recentPlays([], 0)).toEqual([]);
  expect(store.recentPlays(["host", "guest"], 0)).toHaveLength(3);

  // A room is the channel, so separate Huddles in it share a memory.
  expect(store.recentRoomPlays("general", 0)).toEqual([
    { title: "Other", artist: "Band", playedAt: 2_000 },
    { title: "Song", artist: "Band", playedAt: 1_000 },
  ]);
  expect(store.recentRoomPlays("random", 0)).toEqual([
    { title: "Far Away", artist: "Band", playedAt: 3_000 },
  ]);
  expect(store.recentRoomPlays("quiet", 0)).toEqual([]);
});

test("falls back to the Huddle's own channel when there is no source channel", () => {
  const store = new Store(":memory:");
  createSession(store);
  store.recordTrackPlay({
    sessionId: "session",
    userId: "host",
    title: "Song",
    artist: "Band",
    playedAt: 1_000,
  });
  expect(store.recentRoomPlays("channel", 0)).toHaveLength(1);
});

test("remembers skipped autoplay picks per listener", () => {
  const store = new Store(":memory:");
  store.recordAutoplaySkip({
    sessionId: "session",
    userId: "host",
    title: "Song",
    artist: "Band",
    weight: 1,
    skippedAt: 5_000,
  });
  store.recordAutoplaySkip({
    sessionId: "session",
    userId: "guest",
    title: "Song",
    artist: "Band",
    weight: 0.25,
    skippedAt: 5_000,
  });
  expect(store.recentSkips(["host"], 0)).toEqual([
    {
      userId: "host",
      title: "Song",
      artist: "Band",
      weight: 1,
      skippedAt: 5_000,
    },
  ]);
  expect(store.recentSkips(["guest"], 0)[0]?.weight).toBe(0.25);
  expect(store.recentSkips(["host"], 6_000)).toEqual([]);
  expect(store.recentSkips([], 0)).toEqual([]);
  // The same song skipped twice is remembered twice, so it keeps adding up.
  store.recordAutoplaySkip({
    sessionId: "later",
    userId: "host",
    title: "Song",
    artist: "Band",
    weight: 1,
    skippedAt: 9_000,
  });
  expect(store.recentSkips(["host"], 0)).toHaveLength(2);
});

test("prunes listening memory that has decayed away", () => {
  const store = new Store(":memory:");
  createSession(store);
  for (const playedAt of [1_000, 9_000])
    store.recordTrackPlay({
      sessionId: "session",
      userId: "host",
      title: `Song ${playedAt}`,
      artist: "Band",
      playedAt,
    });
  for (const skippedAt of [1_000, 9_000])
    store.recordAutoplaySkip({
      sessionId: "session",
      userId: "host",
      title: `Song ${skippedAt}`,
      artist: "Band",
      weight: 1,
      skippedAt,
    });
  for (const likedAt of [1_000, 9_000])
    store.likeTrack({
      userId: "host",
      title: `Song ${likedAt}`,
      artist: "Band",
      likedAt,
    });
  store.pruneListeningMemory(5_000, 500, 500);
  expect(store.recentPlays(["host"], 0)).toHaveLength(1);
  expect(store.recentSkips(["host"], 0)).toHaveLength(2);
  expect(store.recentLikes(["host"], 0)).toHaveLength(2);
  store.pruneListeningMemory(5_000, 5_000, 5_000);
  expect(store.recentSkips(["host"], 0)).toHaveLength(1);
  expect(store.recentLikes(["host"], 0)).toHaveLength(1);
});

test("liking the same song again refreshes it instead of stacking up", () => {
  const store = new Store(":memory:");
  // The button is one way and shows nothing back, so the same person presses
  // it again on the same song. That is not a stronger opinion.
  store.likeTrack({
    userId: "host",
    title: "Song",
    artist: "Band",
    likedAt: 1_000,
  });
  store.likeTrack({
    userId: "host",
    title: "SONG",
    artist: "band",
    likedAt: 9_000,
  });
  expect(store.recentLikes(["host"], 0)).toEqual([
    { userId: "host", title: "Song", artist: "Band", likedAt: 9_000 },
  ]);
  // Somebody else liking it is their own row.
  store.likeTrack({
    userId: "guest",
    title: "Song",
    artist: "Band",
    likedAt: 9_000,
  });
  expect(store.recentLikes(["host", "guest"], 0)).toHaveLength(2);
  expect(store.recentLikes(["host"], 9_001)).toEqual([]);
});

test("recent likes are capped so one listener cannot crowd out their own taste", () => {
  const store = new Store(":memory:");
  for (let index = 0; index < 60; index++)
    store.likeTrack({
      userId: "host",
      title: `Song ${index}`,
      artist: "Band",
      likedAt: 1_000 + index,
    });
  const likes = store.recentLikes(["host"], 0);
  expect(likes).toHaveLength(50);
  // Newest first, so the cap drops the faded tail rather than the fresh end.
  expect(likes[0]).toMatchObject({ title: "Song 59" });
  expect(likes.at(-1)).toMatchObject({ title: "Song 10" });
  expect(store.recentLikes(["host"], 0, 3)).toHaveLength(3);
});

test("a like can be taken back once", () => {
  const store = new Store(":memory:");
  store.likeTrack({ userId: "host", title: "Song", artist: "Band" });
  expect(store.unlikeTrack("host", "song", "BAND")).toBeTrue();
  expect(store.recentLikes(["host"], 0)).toEqual([]);
  // An undo that arrives twice should not claim to have done anything.
  expect(store.unlikeTrack("host", "Song", "Band")).toBeFalse();
});

test("keeps saved sessions per owner, replacing one saved under the same name", () => {
  const store = new Store(":memory:");
  const track = {
    sourceInput: "a",
    canonicalUrl: "a",
    sourceId: "a",
    title: "A",
    artist: "Artist",
  };
  const channel = { type: "channel", id: "C1" } as const;
  const user = { type: "user", id: "U1" } as const;
  store.addSessionSave(channel, "Friday", "host", [track], {
    volume: 0.4,
    loopMode: "queue",
  });
  store.addSessionSave(user, "Mine", "U1", [], { autoplayMode: "huddle" });
  store.addSessionSave(channel, "friday", "guest", [track, track], {});

  const saves = store.sessionSaves([channel]);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({
    name: "friday",
    savedBy: "guest",
    owner: channel,
  });
  expect(saves[0]!.tracks).toHaveLength(2);
  expect(store.sessionSaves([user])[0]).toMatchObject({
    name: "Mine",
    tracks: [],
    settings: { autoplayMode: "huddle" },
  });
  expect(store.sessionSaves([{ type: "user", id: "U2" }])).toEqual([]);
  expect(store.sessionSaves([{ type: "user", id: "U2" }, user])).toHaveLength(
    1,
  );

  store.deleteSessionSave(saves[0]!.id);
  expect(store.sessionSaves([channel])).toEqual([]);
  store.close();
});

test("drops a saved session's invalid settings and caps each owner's saves", () => {
  const store = new Store(":memory:");
  const owner = { type: "channel", id: "C1" } as const;
  store.addSessionSave(owner, "Odd", "host", [], {});
  store.db
    .query("UPDATE session_saves SET settings = ?")
    .run(
      JSON.stringify({ volume: 4, loopMode: "forever", displayMode: "off" }),
    );
  expect(store.sessionSaves([owner])[0]!.settings).toEqual({
    displayMode: "off",
  });
  for (let index = 0; index < 30; index++)
    store.addSessionSave(owner, `Save ${index}`, "host", [], {});
  expect(store.sessionSaves([owner])).toHaveLength(25);
  store.close();
});

test("drops a saved song's details of the wrong type, and songs without a source", () => {
  const store = new Store(":memory:");
  const owner = { type: "user", id: "U1" } as const;
  store.addSessionSave(owner, "Odd", "U1", [], {});
  const track = {
    sourceInput: "a",
    canonicalUrl: "a",
    sourceId: "a",
    title: "A",
    artist: "Artist",
  };
  store.db
    .query("UPDATE session_saves SET tracks = ?")
    .run(
      JSON.stringify([
        { ...track, album: 4, duration: "long", artwork: null },
        { ...track, album: "Album", duration: 180, artwork: "https://art" },
        { ...track, sourceId: undefined },
        "a",
      ]),
    );
  expect(store.sessionSaves([owner])[0]!.tracks).toEqual([
    track,
    { ...track, album: "Album", duration: 180, artwork: "https://art" },
  ]);
  store.close();
});

test("channel defaults keep only settings that are still valid", () => {
  const store = new Store(":memory:");
  expect(store.channelDefaults("C1")).toBeUndefined();
  store.setChannelDefaults(
    "C1",
    { volume: 0.4, autoplay: "huddle", permissions: ["add", "skip"] },
    "U1",
  );
  expect(store.channelDefaults("C1")).toEqual({
    volume: 0.4,
    autoplay: "huddle",
    permissions: ["add", "skip"],
  });
  store.db
    .query("UPDATE channel_defaults SET settings = ? WHERE channel_id = ?")
    .run(
      JSON.stringify({
        volume: 3,
        autoplay: "radio",
        loopMode: "queue",
        anchorEnabled: "yes",
        permissions: ["skip", "fly"],
      }),
      "C1",
    );
  expect(store.channelDefaults("C1")).toEqual({
    loopMode: "queue",
    permissions: ["skip"],
  });
  store.db
    .query("UPDATE channel_defaults SET settings = '{' WHERE channel_id = ?")
    .run("C1");
  expect(store.channelDefaults("C1")).toBeUndefined();
});

test("remembers who saved a channel's defaults", () => {
  const store = new Store(":memory:");
  expect(store.channelDefaultsSaved("C1")).toBeUndefined();
  const before = Date.now();
  store.setChannelDefaults("C1", { volume: 0.4 }, "U1");
  store.setChannelDefaults("C1", { volume: 0.5 }, "U2");
  const saved = store.channelDefaultsSaved("C1")!;
  expect(saved.savedBy).toBe("U2");
  expect(saved.savedAt).toBeGreaterThanOrEqual(before);
  store.clearChannelDefaults("C1");
  expect(store.channelDefaultsSaved("C1")).toBeUndefined();
  store.close();
});

test("clears a channel's defaults", () => {
  const store = new Store(":memory:");
  store.setChannelDefaults("C1", { volume: 0.4 }, "U1");
  store.setChannelDefaults("C2", { volume: 0.5 }, "U1");
  store.clearChannelDefaults("C1");
  expect(store.channelDefaults("C1")).toBeUndefined();
  expect(store.channelDefaults("C2")).toEqual({ volume: 0.5 });
  store.close();
});

test("Your data counts what is kept about a user and forgets it on request", () => {
  const store = new Store(":memory:");
  createSession(store);
  const track = (id: string, requesterId: string, status: string) =>
    store.addTrack({
      id,
      sessionId: "session",
      requesterId,
      sourceInput: id,
      canonicalUrl: id,
      sourceId: id,
      title: id.toUpperCase(),
      artist: "Artist",
      status,
    });
  track("old", "U1", "played");
  track("broken", "U1", "failed");
  track("now", "U1", "playing");
  track("theirs", "U2", "played");
  for (const userId of ["U1", "U2"]) {
    store.recordTrackPlay({
      sessionId: "session",
      userId,
      title: "Heard",
      artist: "Artist",
    });
    store.likeTrack({ userId, title: "Liked", artist: "Artist" });
    store.recordAutoplaySkip({
      sessionId: "session",
      userId,
      title: "Skipped",
      artist: "Artist",
      weight: 1,
    });
    store.queueScrobble("session", "old", userId, "lastfm", 1, {});
  }
  const mine = store.addSessionSave(
    { type: "user", id: "U1" },
    "Mine",
    "U1",
    [],
    {},
  );
  store.addSessionSave({ type: "user", id: "U2" }, "Theirs", "U2", [], {});
  const channel = store.addSessionSave(
    { type: "channel", id: "C1" },
    "Shared",
    "U1",
    [],
    {},
  );
  store.connectLastFm("U1", "last-user", "key");
  store.connectLastFm("U2", "other", "key");

  const data = store.userData("U1");
  expect(data.added.count).toBe(3);
  expect(data.added.recent.map((song) => song.title)).toEqual([
    "NOW",
    "BROKEN",
    "OLD",
  ]);
  expect(data.plays).toEqual({
    count: 1,
    recent: [{ title: "Heard", artist: "Artist" }],
  });
  expect(data.likes.count).toBe(1);
  expect(data.skips.count).toBe(1);
  expect(data.scrobbles).toBe(1);
  expect(data.saves.map((save) => save.id)).toEqual([mine]);
  expect(data.channelSaves.map((save) => save.id)).toEqual([channel]);

  // Songs still playing keep who added them; finished ones let go.
  expect(store.forgetAddedTracks("U1")).toBe(2);
  expect(store.userData("U1").added.count).toBe(1);

  store.forgetUser("U1");
  const forgotten = store.userData("U1");
  expect(forgotten).toMatchObject({
    added: { count: 1 },
    plays: { count: 0 },
    likes: { count: 0 },
    skips: { count: 0 },
    scrobbles: 0,
    saves: [],
  });
  // A channel's saves are the channel's, so they stay.
  expect(forgotten.channelSaves.map((save) => save.id)).toEqual([channel]);
  expect(store.getUserScrobbling("U1").lastFmSessionKey).toBeUndefined();
  // Nobody else's data is touched.
  const theirs = store.userData("U2");
  expect(theirs).toMatchObject({
    added: { count: 1 },
    plays: { count: 1 },
    likes: { count: 1 },
    skips: { count: 1 },
    scrobbles: 1,
  });
  expect(theirs.saves).toHaveLength(1);
  expect(store.getUserScrobbling("U2").lastFmSessionKey).toBe("key");
  store.close();
});

test("songs left queued in a session that ended let go of who added them", () => {
  const store = new Store(":memory:");
  createSession(store, { id: "live" });
  createSession(store, { id: "gone" });
  createSession(store, { id: "restorable" });
  const track = (id: string, sessionId: string) =>
    store.addTrack({
      id,
      sessionId,
      requesterId: "U1",
      sourceInput: id,
      canonicalUrl: id,
      sourceId: id,
      title: id,
      artist: "Artist",
      status: "ready",
    });
  track("queued-live", "live");
  track("queued-gone", "gone");
  track("queued-restorable", "restorable");
  store.expireSession("gone");
  store.endSession(
    "restorable",
    {
      state: "playing",
      playbackSeconds: 0,
      listenedSeconds: 0,
      displayMode: "default",
      anchorEnabled: false,
      queue: [],
    },
    Date.now() + 60_000,
  );
  expect(store.forgetAddedTracks("U1")).toBe(1);
  // The live session and the one that can come back still show who added them.
  expect(store.userData("U1").added.count).toBe(2);
  store.close();
});

test("forgetting a user keeps them out of the Huddle mix if they opted out", () => {
  const store = new Store(":memory:");
  store.setHuddleMixSources("U1", { added: false });
  store.likeTrack({ userId: "U1", title: "Liked", artist: "Artist" });
  store.forgetUser("U1");
  expect(store.getUserScrobbling("U1")).toMatchObject({
    huddleMixOptIn: false,
    huddleMixSources: [],
  });
  // Someone who was in the mix stays in it, with nothing kept about them.
  store.likeTrack({ userId: "U2", title: "Liked", artist: "Artist" });
  store.forgetUser("U2");
  expect(store.getUserScrobbling("U2").huddleMixOptIn).toBe(true);
  expect(store.userData("U2").likes.count).toBe(0);
  store.close();
});

test("keeps a session's mode, captions and watching time, and a track's kind and form", () => {
  const store = new Store(":memory:");
  store.createSession({
    id: "session",
    huddleId: "huddle",
    callId: "call",
    channelId: "channel",
    threadTs: "1.0",
    creatorId: "host",
    volume: 0.5,
  });
  store.setSession("session", {
    mediaMode: "video",
    captions: true,
    watchedSeconds: 75,
  });
  store.addTrack({
    id: "clip",
    sessionId: "session",
    requesterId: "host",
    sourceInput: "https://www.youtube.com/watch?v=abcdefghijk",
    canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    sourceId: "abcdefghijk",
    title: "Clip",
    artist: "Channel",
    kind: "video",
    status: "ready",
    isVideo: true,
  });
  store.setTrack("clip", { filePath: "clip.video.mkv", form: "video" });
  const [saved] = store.resumableSessions(Date.now(), 60_000).sessions;
  expect(saved).toMatchObject({
    mediaMode: "video",
    captions: true,
    watchedSeconds: 75,
  });
  expect(saved!.tracks[0]).toMatchObject({
    kind: "video",
    form: "video",
    filePath: "clip.video.mkv",
  });
  // A video queued to watch is no one's recent song.
  expect(store.recentTracks("host")).toEqual([]);
  store.close();
});

test("keeps that a track is live, in the session and in saves", () => {
  const store = new Store(":memory:");
  store.createSession({
    id: "session",
    huddleId: "huddle",
    callId: "call",
    channelId: "channel",
    threadTs: "1.0",
    creatorId: "host",
    volume: 0.5,
  });
  const radio = {
    sourceInput: "https://www.youtube.com/watch?v=jfKfPfyJRdk",
    canonicalUrl: "https://www.youtube.com/watch?v=jfKfPfyJRdk",
    sourceId: "jfKfPfyJRdk",
    title: "lofi hip hop radio",
    artist: "Lofi Girl",
    kind: "video" as const,
    live: true,
  };
  store.addTrack({
    ...radio,
    id: "radio",
    sessionId: "session",
    requesterId: "host",
    status: "ready",
  });
  const [saved] = store.resumableSessions(Date.now(), 60_000).sessions;
  expect(saved!.tracks[0]).toMatchObject({ live: true, kind: "video" });
  const owner = { type: "user", id: "U1" } as const;
  store.addSessionSave(owner, "Radio", "U1", [radio], {});
  expect(store.sessionSaves([owner])[0]!.tracks).toEqual([radio]);
  store.close();
});

test("keeps each user's linked Jellyfin servers, once per server", () => {
  const store = new Store(":memory:");
  const server = {
    userId: "U1",
    serverId: "8a3e05b08edd4f20987437e9f07c4af8",
    baseUrl: "https://jellyfin.example.com",
    name: "Home",
    accessToken: "first",
    jellyfinUserId: "jf1",
    deviceId: "device1",
    linkedAt: 1,
  };
  store.saveJellyfinServer(server);
  store.saveJellyfinServer({
    ...server,
    serverId: "f".repeat(32),
    linkedAt: 2,
  });
  expect(store.jellyfinServers("U1").map((item) => item.linkedAt)).toEqual([
    1, 2,
  ]);
  expect(store.jellyfinServers("U2")).toEqual([]);
  store.revokeJellyfinServer("U1", server.serverId);
  expect(store.jellyfinServer("U1", server.serverId)?.revoked).toBeTrue();
  // Linking again, at another address, replaces the token and the revocation.
  store.saveJellyfinServer({
    ...server,
    baseUrl: "https://media.example.com",
    accessToken: "second",
    jellyfinUserName: "Ingo",
    linkedAt: 3,
  });
  expect(store.jellyfinServer("U1", server.serverId)).toEqual({
    ...server,
    baseUrl: "https://media.example.com",
    accessToken: "second",
    jellyfinUserName: "Ingo",
    linkedAt: 3,
  });
  expect(store.jellyfinServers("U1")).toHaveLength(2);
  expect(store.removeJellyfinServer("U1", "f".repeat(32))).toBeTrue();
  expect(store.removeJellyfinServer("U1", "f".repeat(32))).toBeFalse();
  store.forgetUser("U1");
  expect(store.jellyfinServers("U1")).toEqual([]);
  store.close();
});
