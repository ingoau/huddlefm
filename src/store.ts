import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const capabilities = [
  "add",
  "add-bulk",
  "remove-own",
  "manage-queue",
  "skip",
  "pause",
  "volume",
  "configure-settings",
  "clear",
  "end-session",
] as const;

export const permissionPresets = {
  default: ["add", "remove-own"],
  "host-only": [],
  collaborative: capabilities.filter(
    (capability) => capability !== "clear" && capability !== "end-session",
  ),
  communism: capabilities,
};

export const displayModes = ["default", "lyrics", "off"] as const;
export type DisplayMode = (typeof displayModes)[number];

export const scrobblingModes = ["always", "ask", "disabled"] as const;
export type ScrobblingMode = (typeof scrobblingModes)[number];

export const usageLabels = {
  added: "Songs added",
  removed: "Songs removed",
  next: "Next",
  previous: "Previous",
  forward: "Fast-forward",
  back: "Rewind",
  paused: "Pause",
  resumed: "Resume",
  volume: "Volume changes",
  reordered: "Queue moves",
  cleared: "Queue clears",
  settings: "Settings changes",
} as const;
export type UsageKey = keyof typeof usageLabels;
export type UsageCounts = { [key in UsageKey]: number };

type SavedTrack = {
  id: string;
  requesterId: string;
  sourceInput: string;
  canonicalUrl: string;
  sourceId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  artwork?: string;
  automatic?: boolean;
  status: string;
  filePath?: string;
  queuePosition?: number;
};

export type SavedSession = {
  id: string;
  huddleId: string;
  callId: string;
  channelId: string;
  threadTs: string;
  uiTs: string;
  revision: number;
  creatorId: string;
  hostId?: string;
  state: string;
  volume: number;
  autoplay: boolean;
  displayMode: DisplayMode;
  anchorEnabled: boolean;
  playbackSeconds: number;
  listenedSeconds: number;
  resumeUntil: number;
  endText?: string;
  endBlocks?: unknown[];
  permissions: string[];
  tracks: SavedTrack[];
};

export type UserScrobbling = {
  lastFmUsername?: string;
  lastFmSessionKey?: string;
  lastFmEnabled: boolean;
  lastFmPendingToken?: string;
  lastFmPendingAt?: number;
  listenBrainzUsername?: string;
  listenBrainzToken?: string;
  listenBrainzEnabled: boolean;
  mode: ScrobblingMode;
};

export type CanvasStats = ReturnType<Store["canvasStats"]>;

type PendingScrobble = {
  id: string;
  sessionId: string;
  userId: string;
  service: string;
  listenedAt: number;
  attempts: number;
  track: {
    id: string;
    requesterId: string;
    title: string;
    artist: string;
    album?: string;
    duration?: number;
    automatic?: boolean;
  };
};

export class Store {
  db: Database;

  constructor(path = "data/huddlefm.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        huddle_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        ui_ts TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        creator_id TEXT NOT NULL,
        host_id TEXT,
        status TEXT NOT NULL,
        volume REAL NOT NULL DEFAULT 0.6,
        autoplay INTEGER NOT NULL DEFAULT 0,
        resume_state TEXT,
        resume_until INTEGER,
        playback_seconds REAL NOT NULL DEFAULT 0,
        listened_seconds REAL NOT NULL DEFAULT 0,
        lyrics_enabled INTEGER NOT NULL DEFAULT 1,
        display_mode TEXT NOT NULL DEFAULT 'default',
        anchor_enabled INTEGER NOT NULL DEFAULT 0,
        idle_deadline INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        requester_id TEXT NOT NULL,
        source_input TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        duration INTEGER,
        artwork TEXT,
        automatic INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        file_path TEXT,
        queue_position INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS permissions (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        capability TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        PRIMARY KEY (session_id, capability)
      );
      CREATE TABLE IF NOT EXISTS user_scrobbling (
        user_id TEXT PRIMARY KEY,
        lastfm_username TEXT,
        lastfm_session_key TEXT,
        lastfm_enabled INTEGER NOT NULL DEFAULT 0,
        lastfm_pending_token TEXT,
        lastfm_pending_at INTEGER,
        listenbrainz_username TEXT,
        listenbrainz_token TEXT,
        listenbrainz_enabled INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'always',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_scrobbling (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS scrobbles (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        service TEXT NOT NULL,
        listened_at INTEGER NOT NULL,
        track TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (session_id, track_id, user_id, service)
      );
      CREATE TABLE IF NOT EXISTS usage_counters (
        event TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS data_migrations (
        name TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_status_resume
        ON sessions(status, resume_until);
      CREATE INDEX IF NOT EXISTS tracks_session_status
        ON tracks(session_id, status);
      CREATE INDEX IF NOT EXISTS tracks_status_source
        ON tracks(status, source_id);
      CREATE INDEX IF NOT EXISTS scrobbles_pending
        ON scrobbles(status, next_attempt_at, listened_at, created_at);
    `);
    this.ensureColumn("sessions", "autoplay", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "resume_state", "TEXT");
    this.ensureColumn("sessions", "resume_until", "INTEGER");
    this.ensureColumn(
      "sessions",
      "playback_seconds",
      "REAL NOT NULL DEFAULT 0",
    );
    this.ensureColumn(
      "sessions",
      "listened_seconds",
      "REAL NOT NULL DEFAULT 0",
    );
    this.ensureColumn(
      "sessions",
      "lyrics_enabled",
      "INTEGER NOT NULL DEFAULT 1",
    );
    const hadDisplayMode = this.hasColumn("sessions", "display_mode");
    this.ensureColumn(
      "sessions",
      "display_mode",
      "TEXT NOT NULL DEFAULT 'default'",
    );
    if (!hadDisplayMode)
      this.db.run(
        "UPDATE sessions SET display_mode = CASE lyrics_enabled WHEN 1 THEN 'lyrics' ELSE 'off' END",
      );
    this.ensureColumn(
      "sessions",
      "anchor_enabled",
      "INTEGER NOT NULL DEFAULT 0",
    );
    this.ensureColumn("sessions", "end_text", "TEXT");
    this.ensureColumn("sessions", "end_blocks", "TEXT");
    this.ensureColumn("tracks", "automatic", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tracks", "queue_position", "INTEGER");
    this.ensureColumn(
      "user_scrobbling",
      "mode",
      "TEXT NOT NULL DEFAULT 'always'",
    );
  }

  createSession(session: {
    id: string;
    huddleId: string;
    callId: string;
    channelId: string;
    threadTs: string;
    creatorId: string;
    hostId?: string;
    volume: number;
  }) {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO sessions
          (id, huddle_id, call_id, channel_id, thread_ts, creator_id, host_id, status, volume, anchor_enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, 0, ?, ?)`,
        )
        .run(
          session.id,
          session.huddleId,
          session.callId,
          session.channelId,
          session.threadTs,
          session.creatorId,
          session.hostId ?? null,
          session.volume,
          now,
          now,
        );
      const insert = this.db.query(
        "INSERT INTO permissions (session_id, capability, allowed) VALUES (?, ?, ?)",
      );
      for (const capability of capabilities)
        insert.run(
          session.id,
          capability,
          permissionPresets.default.includes(capability) ? 1 : 0,
        );
    });
    transaction();
  }

  setUi(sessionId: string, timestamp: string, revision: number) {
    this.db
      .query(
        "UPDATE sessions SET ui_ts = ?, revision = ?, updated_at = ? WHERE id = ?",
      )
      .run(timestamp, revision, Date.now(), sessionId);
  }

  setSession(
    sessionId: string,
    fields: {
      status?: string;
      hostId?: string | null;
      volume?: number;
      autoplay?: boolean;
      playbackSeconds?: number;
      listenedSeconds?: number;
      displayMode?: DisplayMode;
      anchorEnabled?: boolean;
    },
  ) {
    if (fields.status !== undefined)
      this.db
        .query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
        .run(fields.status, Date.now(), sessionId);
    if (fields.hostId !== undefined)
      this.db
        .query("UPDATE sessions SET host_id = ?, updated_at = ? WHERE id = ?")
        .run(fields.hostId, Date.now(), sessionId);
    if (fields.volume !== undefined)
      this.db
        .query("UPDATE sessions SET volume = ?, updated_at = ? WHERE id = ?")
        .run(fields.volume, Date.now(), sessionId);
    if (fields.autoplay !== undefined)
      this.db
        .query("UPDATE sessions SET autoplay = ?, updated_at = ? WHERE id = ?")
        .run(fields.autoplay ? 1 : 0, Date.now(), sessionId);
    if (fields.playbackSeconds !== undefined)
      this.db
        .query(
          "UPDATE sessions SET playback_seconds = ?, updated_at = ? WHERE id = ?",
        )
        .run(fields.playbackSeconds, Date.now(), sessionId);
    if (fields.listenedSeconds !== undefined)
      this.db
        .query(
          "UPDATE sessions SET listened_seconds = ?, updated_at = ? WHERE id = ?",
        )
        .run(fields.listenedSeconds, Date.now(), sessionId);
    if (fields.displayMode !== undefined)
      this.db
        .query(
          "UPDATE sessions SET display_mode = ?, updated_at = ? WHERE id = ?",
        )
        .run(fields.displayMode, Date.now(), sessionId);
    if (fields.anchorEnabled !== undefined)
      this.db
        .query(
          "UPDATE sessions SET anchor_enabled = ?, updated_at = ? WHERE id = ?",
        )
        .run(fields.anchorEnabled ? 1 : 0, Date.now(), sessionId);
  }

  suspendSession(
    sessionId: string,
    state: {
      state: string;
      playbackSeconds: number;
      displayMode: DisplayMode;
      anchorEnabled: boolean;
      queue: string[];
    },
    resumeUntil: number,
  ) {
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE sessions SET
        status = 'suspended', resume_state = ?, resume_until = ?, playback_seconds = ?,
        display_mode = ?, anchor_enabled = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          state.state,
          resumeUntil,
          state.playbackSeconds,
          state.displayMode,
          state.anchorEnabled ? 1 : 0,
          Date.now(),
          sessionId,
        );
      this.db
        .query("UPDATE tracks SET queue_position = NULL WHERE session_id = ?")
        .run(sessionId);
      const position = this.db.query(
        "UPDATE tracks SET queue_position = ? WHERE id = ? AND session_id = ?",
      );
      state.queue.forEach((id, index) => position.run(index, id, sessionId));
    })();
  }

  endSession(
    sessionId: string,
    state: {
      state: string;
      playbackSeconds: number;
      listenedSeconds: number;
      displayMode: DisplayMode;
      anchorEnabled: boolean;
      queue: string[];
    },
    resumeUntil: number,
  ) {
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE sessions SET
        status = 'ended', resume_state = ?, resume_until = ?, playback_seconds = ?,
        listened_seconds = ?, display_mode = ?, anchor_enabled = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          state.state,
          resumeUntil,
          state.playbackSeconds,
          state.listenedSeconds,
          state.displayMode,
          state.anchorEnabled ? 1 : 0,
          Date.now(),
          sessionId,
        );
      this.db
        .query("UPDATE tracks SET queue_position = NULL WHERE session_id = ?")
        .run(sessionId);
      const position = this.db.query(
        "UPDATE tracks SET queue_position = ? WHERE id = ? AND session_id = ?",
      );
      state.queue.forEach((id, index) => position.run(index, id, sessionId));
    })();
  }

  setEndMessage(
    sessionId: string,
    timestamp: string,
    text: string,
    blocks: unknown[],
  ) {
    this.db
      .query(
        `UPDATE sessions SET ui_ts = ?, end_text = ?, end_blocks = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(timestamp, text, JSON.stringify(blocks), Date.now(), sessionId);
  }

  activateSession(sessionId: string, status: string) {
    this.db
      .query(
        `UPDATE sessions SET
      status = ?, resume_state = NULL, resume_until = NULL, end_text = NULL,
      end_blocks = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(status, Date.now(), sessionId);
  }

  canvasStats() {
    const sessions = this.db
      .query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(listened_seconds), 0) AS listened,
        COALESCE(MAX(listened_seconds), 0) AS longest,
        COALESCE(SUM(CASE WHEN status != 'ended' THEN 1 ELSE 0 END), 0) AS active
        FROM sessions`,
      )
      .get() as {
      count: number;
      listened: number;
      longest: number;
      active: number;
    };
    const tracks = this.db
      .query(
        `SELECT COUNT(*) AS count, COUNT(DISTINCT source_id) AS uniqueTracks,
        COUNT(DISTINCT artist) AS artists,
        COALESCE(SUM(CASE WHEN automatic = 1 THEN 1 ELSE 0 END), 0) AS autoplay
        FROM tracks WHERE status = 'played'`,
      )
      .get() as {
      count: number;
      uniqueTracks: number;
      artists: number;
      autoplay: number;
    };
    const topArtists = this.db
      .query(
        `SELECT artist, COUNT(*) AS count FROM tracks WHERE status = 'played'
        GROUP BY artist COLLATE NOCASE ORDER BY count DESC, artist COLLATE NOCASE LIMIT 5`,
      )
      .all() as { artist: string; count: number }[];
    const topTracks = this.db
      .query(
        `SELECT title, artist, COUNT(*) AS count FROM tracks WHERE status = 'played'
        GROUP BY source_id, title, artist ORDER BY count DESC, title COLLATE NOCASE LIMIT 5`,
      )
      .all() as { title: string; artist: string; count: number }[];
    const topChannels = this.db
      .query(
        `SELECT sessions.channel_id AS channelId, COUNT(*) AS count
        FROM tracks JOIN sessions ON sessions.id = tracks.session_id
        WHERE tracks.status = 'played' GROUP BY sessions.channel_id
        ORDER BY count DESC, channelId LIMIT 5`,
      )
      .all() as { channelId: string; count: number }[];
    return { sessions, tracks, topArtists, topTracks, topChannels };
  }

  incrementUsage(event: UsageKey) {
    this.db
      .query(
        `INSERT INTO usage_counters (event, count) VALUES (?, 1)
        ON CONFLICT (event) DO UPDATE SET count = count + 1`,
      )
      .run(event);
  }

  usageStats() {
    const counts = new Map(
      (
        this.db.query("SELECT event, count FROM usage_counters").all() as {
          event: UsageKey;
          count: number;
        }[]
      ).map(({ event, count }) => [event, count]),
    );
    return Object.entries(usageLabels).map(([event, label]) => ({
      label,
      count: counts.get(event as UsageKey) ?? 0,
    }));
  }

  needsUsageBackfill() {
    return !this.db
      .query("SELECT 1 FROM data_migrations WHERE name = ?")
      .get("audit-usage-v1");
  }

  importUsage(counts: UsageCounts) {
    this.db.transaction(() => {
      if (!this.needsUsageBackfill()) return;
      const insert = this.db.query(
        `INSERT INTO usage_counters (event, count) VALUES (?, ?)
        ON CONFLICT (event) DO UPDATE SET count = count + excluded.count`,
      );
      for (const [event, count] of Object.entries(counts))
        insert.run(event, count);
      this.db
        .query("INSERT INTO data_migrations (name, completed_at) VALUES (?, ?)")
        .run("audit-usage-v1", Date.now());
    })();
  }

  resumableSessions(now: number, ttlMs: number) {
    const rows = this.db
      .query(`SELECT * FROM sessions WHERE status != 'ended'`)
      .all() as Record<string, unknown>[];
    return this.savedSessions(rows, now, ttlMs, true);
  }

  restorableSessions() {
    const rows = this.db
      .query(
        `SELECT * FROM sessions WHERE status = 'ended' AND resume_until IS NOT NULL`,
      )
      .all() as Record<string, unknown>[];
    return this.savedSessions(rows, Number.NEGATIVE_INFINITY, 0, false)
      .sessions;
  }

  private savedSessions(
    rows: Record<string, unknown>[],
    now: number,
    ttlMs: number,
    expire: boolean,
  ) {
    const expiredIds: string[] = [];
    const sessions = rows.flatMap((row) => {
      const deadline = Number(
        row.resume_until ?? Number(row.updated_at) + ttlMs,
      );
      if (expire && deadline <= now) {
        expiredIds.push(String(row.id));
        return [];
      }
      const id = String(row.id);
      const tracks = (
        this.db
          .query(
            `SELECT * FROM tracks
        WHERE session_id = ? AND status IN ('playing', 'ready', 'preparing', 'played')
        ORDER BY CASE WHEN status = 'playing' THEN -1 ELSE COALESCE(queue_position, created_at) END`,
          )
          .all(id) as Record<string, unknown>[]
      ).map((track) => ({
        id: String(track.id),
        requesterId: String(track.requester_id),
        sourceInput: String(track.source_input),
        canonicalUrl: String(track.canonical_url),
        sourceId: String(track.source_id),
        title: String(track.title),
        artist: String(track.artist),
        ...(track.album ? { album: String(track.album) } : {}),
        ...(track.duration === null
          ? {}
          : { duration: Number(track.duration) }),
        ...(track.artwork ? { artwork: String(track.artwork) } : {}),
        ...(track.automatic ? { automatic: true } : {}),
        status: String(track.status),
        ...(track.file_path ? { filePath: String(track.file_path) } : {}),
        ...(track.queue_position === null
          ? {}
          : { queuePosition: Number(track.queue_position) }),
      }));
      return [
        {
          id,
          huddleId: String(row.huddle_id),
          callId: String(row.call_id),
          channelId: String(row.channel_id),
          threadTs: String(row.thread_ts),
          uiTs: String(row.ui_ts ?? ""),
          revision: Number(row.revision),
          creatorId: String(row.creator_id),
          ...(row.host_id ? { hostId: String(row.host_id) } : {}),
          state: String(row.resume_state ?? row.status),
          volume: Number(row.volume),
          autoplay: Boolean(row.autoplay),
          displayMode: displayModes.includes(row.display_mode as DisplayMode)
            ? (row.display_mode as DisplayMode)
            : "default",
          anchorEnabled: Boolean(row.anchor_enabled),
          playbackSeconds: Number(row.playback_seconds),
          listenedSeconds: Number(row.listened_seconds),
          resumeUntil: deadline,
          ...(row.end_text ? { endText: String(row.end_text) } : {}),
          ...(row.end_blocks
            ? { endBlocks: JSON.parse(String(row.end_blocks)) as unknown[] }
            : {}),
          permissions: (
            this.db
              .query(
                "SELECT capability FROM permissions WHERE session_id = ? AND allowed = 1",
              )
              .all(id) as { capability: string }[]
          ).map((value) => value.capability),
          tracks,
        } satisfies SavedSession,
      ];
    });
    if (expiredIds.length)
      this.db.transaction(() => {
        const end = this.db.query(
          "UPDATE sessions SET status = 'ended', resume_state = NULL, resume_until = NULL, updated_at = ? WHERE id = ?",
        );
        const clear = this.db.query(
          "UPDATE tracks SET file_path = NULL, queue_position = NULL WHERE session_id = ?",
        );
        for (const id of expiredIds) {
          clear.run(id);
          end.run(now, id);
        }
      })();
    return { sessions, expiredIds };
  }

  expireSession(sessionId: string) {
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE tracks SET file_path = NULL, queue_position = NULL WHERE session_id = ?",
        )
        .run(sessionId);
      this.db
        .query(
          `UPDATE sessions SET status = 'ended', resume_state = NULL, resume_until = NULL,
          end_text = NULL, end_blocks = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(Date.now(), sessionId);
    })();
  }

  addTrack(track: {
    id: string;
    sessionId: string;
    requesterId: string;
    sourceInput: string;
    canonicalUrl: string;
    sourceId: string;
    title: string;
    artist: string;
    album?: string;
    duration?: number;
    artwork?: string;
    automatic?: boolean;
    status: string;
  }) {
    this.db
      .query(
        `INSERT INTO tracks
        (id, session_id, requester_id, source_input, canonical_url, source_id, title, artist, album, duration, artwork, automatic, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        track.id,
        track.sessionId,
        track.requesterId,
        track.sourceInput,
        track.canonicalUrl,
        track.sourceId,
        track.title,
        track.artist,
        track.album ?? null,
        track.duration ?? null,
        track.artwork ?? null,
        track.automatic ? 1 : 0,
        track.status,
        Date.now(),
      );
  }

  setTrack(id: string, fields: { status?: string; filePath?: string | null }) {
    if (fields.status !== undefined)
      this.db
        .query("UPDATE tracks SET status = ? WHERE id = ?")
        .run(fields.status, id);
    if (fields.filePath !== undefined)
      this.db
        .query("UPDATE tracks SET file_path = ? WHERE id = ?")
        .run(fields.filePath, id);
  }

  removeTrack(id: string) {
    this.db.query("DELETE FROM tracks WHERE id = ?").run(id);
  }

  setPermission(sessionId: string, capability: string, allowed: boolean) {
    this.db
      .query(
        `INSERT INTO permissions (session_id, capability, allowed) VALUES (?, ?, ?)
        ON CONFLICT (session_id, capability) DO UPDATE SET allowed = excluded.allowed`,
      )
      .run(sessionId, capability, allowed ? 1 : 0);
  }

  getUserScrobbling(userId: string): UserScrobbling {
    const row = this.db
      .query("SELECT * FROM user_scrobbling WHERE user_id = ?")
      .get(userId) as Record<string, unknown> | null;
    if (!row)
      return {
        lastFmEnabled: false,
        listenBrainzEnabled: false,
        mode: "always",
      };
    return {
      ...(row.lastfm_username
        ? { lastFmUsername: String(row.lastfm_username) }
        : {}),
      ...(row.lastfm_session_key
        ? { lastFmSessionKey: String(row.lastfm_session_key) }
        : {}),
      lastFmEnabled: Boolean(row.lastfm_enabled),
      ...(row.lastfm_pending_token
        ? { lastFmPendingToken: String(row.lastfm_pending_token) }
        : {}),
      ...(row.lastfm_pending_at
        ? { lastFmPendingAt: Number(row.lastfm_pending_at) }
        : {}),
      ...(row.listenbrainz_username
        ? { listenBrainzUsername: String(row.listenbrainz_username) }
        : {}),
      ...(row.listenbrainz_token
        ? { listenBrainzToken: String(row.listenbrainz_token) }
        : {}),
      listenBrainzEnabled: Boolean(row.listenbrainz_enabled),
      mode: scrobblingModes.includes(row.mode as ScrobblingMode)
        ? (row.mode as ScrobblingMode)
        : "always",
    };
  }

  setScrobblingMode(userId: string, mode: ScrobblingMode) {
    this.ensureUserScrobbling(userId);
    this.db
      .query(
        "UPDATE user_scrobbling SET mode = ?, updated_at = ? WHERE user_id = ?",
      )
      .run(mode, Date.now(), userId);
  }

  getSessionScrobbling(sessionId: string, userId: string) {
    const row = this.db
      .query(
        "SELECT enabled FROM session_scrobbling WHERE session_id = ? AND user_id = ?",
      )
      .get(sessionId, userId) as { enabled: number } | null;
    return row ? Boolean(row.enabled) : undefined;
  }

  setSessionScrobbling(sessionId: string, userId: string, enabled: boolean) {
    this.db
      .query(
        `INSERT INTO session_scrobbling (session_id, user_id, enabled) VALUES (?, ?, ?)
        ON CONFLICT (session_id, user_id) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(sessionId, userId, enabled ? 1 : 0);
  }

  setLastFmPending(userId: string, token: string, startedAt: number) {
    this.ensureUserScrobbling(userId);
    this.db
      .query(
        "UPDATE user_scrobbling SET lastfm_pending_token = ?, lastfm_pending_at = ?, updated_at = ? WHERE user_id = ?",
      )
      .run(token, startedAt, Date.now(), userId);
  }

  connectLastFm(userId: string, username: string, sessionKey: string) {
    this.ensureUserScrobbling(userId);
    this.db
      .query(
        `UPDATE user_scrobbling SET lastfm_username = ?, lastfm_session_key = ?, lastfm_enabled = 1,
      lastfm_pending_token = NULL, lastfm_pending_at = NULL, updated_at = ? WHERE user_id = ?`,
      )
      .run(username, sessionKey, Date.now(), userId);
  }

  disconnectLastFm(userId: string) {
    this.ensureUserScrobbling(userId);
    this.db
      .query(
        `UPDATE user_scrobbling SET lastfm_username = NULL, lastfm_session_key = NULL,
      lastfm_enabled = 0, lastfm_pending_token = NULL, lastfm_pending_at = NULL, updated_at = ? WHERE user_id = ?`,
      )
      .run(Date.now(), userId);
  }

  setLastFmEnabled(userId: string, enabled: boolean) {
    this.ensureUserScrobbling(userId);
    this.db
      .query(
        "UPDATE user_scrobbling SET lastfm_enabled = ?, updated_at = ? WHERE user_id = ?",
      )
      .run(enabled ? 1 : 0, Date.now(), userId);
  }

  setListenBrainzToken(userId: string, token: string, username: string) {
    this.ensureUserScrobbling(userId);
    this.db
      .query(
        "UPDATE user_scrobbling SET listenbrainz_token = ?, listenbrainz_username = ?, updated_at = ? WHERE user_id = ?",
      )
      .run(token, username, Date.now(), userId);
  }

  disconnectListenBrainz(userId: string) {
    this.ensureUserScrobbling(userId);
    this.db
      .query(
        `UPDATE user_scrobbling SET listenbrainz_username = NULL, listenbrainz_token = NULL,
      listenbrainz_enabled = 0, updated_at = ? WHERE user_id = ?`,
      )
      .run(Date.now(), userId);
  }

  setListenBrainzEnabled(userId: string, enabled: boolean) {
    this.ensureUserScrobbling(userId);
    this.db
      .query(
        "UPDATE user_scrobbling SET listenbrainz_enabled = ?, updated_at = ? WHERE user_id = ?",
      )
      .run(enabled ? 1 : 0, Date.now(), userId);
  }

  queueScrobble(
    sessionId: string,
    trackId: string,
    userId: string,
    service: string,
    listenedAt: number,
    track: unknown,
  ) {
    const now = Date.now();
    this.db
      .query(
        `INSERT OR IGNORE INTO scrobbles
      (id, session_id, track_id, user_id, service, listened_at, track, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        sessionId,
        trackId,
        userId,
        service,
        listenedAt,
        JSON.stringify(track),
        now,
        now,
      );
  }

  pendingScrobbles(now: number) {
    return (
      this.db
        .query(
          `SELECT id, session_id, user_id, service, listened_at, attempts, track FROM scrobbles
      WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY listened_at, created_at`,
        )
        .all(now) as Record<string, unknown>[]
    ).map(
      (row) =>
        ({
          id: String(row.id),
          sessionId: String(row.session_id),
          userId: String(row.user_id),
          service: String(row.service),
          listenedAt: Number(row.listened_at),
          attempts: Number(row.attempts),
          track: JSON.parse(String(row.track)),
        }) satisfies PendingScrobble,
    );
  }

  retryScrobble(id: string, attempts: number, nextAttemptAt: number) {
    this.db
      .query(
        "UPDATE scrobbles SET attempts = ?, next_attempt_at = ? WHERE id = ?",
      )
      .run(attempts, nextAttemptAt, id);
  }

  finishScrobble(id: string, status: "sent" | "failed") {
    this.db
      .query("UPDATE scrobbles SET status = ? WHERE id = ?")
      .run(status, id);
  }

  clearPendingScrobbles(userId: string, service: string) {
    this.db
      .query(
        "DELETE FROM scrobbles WHERE user_id = ? AND service = ? AND status = 'pending'",
      )
      .run(userId, service);
  }

  clearPendingSessionScrobbles(sessionId: string, userId: string) {
    this.db
      .query(
        "DELETE FROM scrobbles WHERE session_id = ? AND user_id = ? AND status = 'pending'",
      )
      .run(sessionId, userId);
  }

  clearPendingUserScrobbles(userId: string) {
    this.db
      .query("DELETE FROM scrobbles WHERE user_id = ? AND status = 'pending'")
      .run(userId);
  }

  close() {
    this.db.close();
  }

  private ensureColumn(table: string, column: string, definition: string) {
    if (!this.hasColumn(table, column))
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private hasColumn(table: string, column: string) {
    return (
      this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).some((value) => value.name === column);
  }

  private ensureUserScrobbling(userId: string) {
    this.db
      .query(
        "INSERT OR IGNORE INTO user_scrobbling (user_id, updated_at) VALUES (?, ?)",
      )
      .run(userId, Date.now());
  }
}
