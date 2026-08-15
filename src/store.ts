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
  collaborative: capabilities.filter(capability => capability !== "clear" && capability !== "end-session"),
  communism: capabilities,
};

export const displayModes = ["default", "lyrics", "off"] as const;
export type DisplayMode = typeof displayModes[number];

export type SavedTrack = {
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
  permissions: string[];
  tracks: SavedTrack[];
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
    `);
    this.ensureColumn("sessions", "autoplay", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "resume_state", "TEXT");
    this.ensureColumn("sessions", "resume_until", "INTEGER");
    this.ensureColumn("sessions", "playback_seconds", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "listened_seconds", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "lyrics_enabled", "INTEGER NOT NULL DEFAULT 1");
    const hadDisplayMode = this.hasColumn("sessions", "display_mode");
    this.ensureColumn("sessions", "display_mode", "TEXT NOT NULL DEFAULT 'default'");
    if (!hadDisplayMode)
      this.db.run("UPDATE sessions SET display_mode = CASE lyrics_enabled WHEN 1 THEN 'lyrics' ELSE 'off' END");
    this.ensureColumn("sessions", "anchor_enabled", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tracks", "automatic", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tracks", "queue_position", "INTEGER");
  }

  createSession(session: {
    id: string;
    huddleId: string;
    callId: string;
    channelId: string;
    threadTs: string;
    creatorId: string;
    hostId: string;
    volume: number;
  }) {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      this.db
        .query(`INSERT INTO sessions
          (id, huddle_id, call_id, channel_id, thread_ts, creator_id, host_id, status, volume, anchor_enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, 0, ?, ?)`)
        .run(
          session.id,
          session.huddleId,
          session.callId,
          session.channelId,
          session.threadTs,
          session.creatorId,
          session.hostId,
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

  setSession(sessionId: string, fields: {
    status?: string;
    hostId?: string | null;
    volume?: number;
    autoplay?: boolean;
    playbackSeconds?: number;
    listenedSeconds?: number;
    displayMode?: DisplayMode;
    anchorEnabled?: boolean;
  }) {
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
        .query("UPDATE sessions SET playback_seconds = ?, updated_at = ? WHERE id = ?")
        .run(fields.playbackSeconds, Date.now(), sessionId);
    if (fields.listenedSeconds !== undefined)
      this.db
        .query("UPDATE sessions SET listened_seconds = ?, updated_at = ? WHERE id = ?")
        .run(fields.listenedSeconds, Date.now(), sessionId);
    if (fields.displayMode !== undefined)
      this.db
        .query("UPDATE sessions SET display_mode = ?, updated_at = ? WHERE id = ?")
        .run(fields.displayMode, Date.now(), sessionId);
    if (fields.anchorEnabled !== undefined)
      this.db
        .query("UPDATE sessions SET anchor_enabled = ?, updated_at = ? WHERE id = ?")
        .run(fields.anchorEnabled ? 1 : 0, Date.now(), sessionId);
  }

  suspendSession(sessionId: string, state: {
    state: string;
    playbackSeconds: number;
    displayMode: DisplayMode;
    anchorEnabled: boolean;
    queue: string[];
  }, resumeUntil: number) {
    this.db.transaction(() => {
      this.db.query(`UPDATE sessions SET
        status = 'suspended', resume_state = ?, resume_until = ?, playback_seconds = ?,
        display_mode = ?, anchor_enabled = ?, updated_at = ? WHERE id = ?`)
        .run(state.state, resumeUntil, state.playbackSeconds, state.displayMode,
          state.anchorEnabled ? 1 : 0, Date.now(), sessionId);
      this.db.query("UPDATE tracks SET queue_position = NULL WHERE session_id = ?").run(sessionId);
      const position = this.db.query("UPDATE tracks SET queue_position = ? WHERE id = ? AND session_id = ?");
      state.queue.forEach((id, index) => position.run(index, id, sessionId));
    })();
  }

  activateSession(sessionId: string, status: string) {
    this.db.query(`UPDATE sessions SET
      status = ?, resume_state = NULL, resume_until = NULL, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), sessionId);
  }

  resumableSessions(now: number, ttlMs: number) {
    const rows = this.db.query(`SELECT * FROM sessions WHERE status != 'ended'`).all() as Record<string, unknown>[];
    const expiredIds: string[] = [];
    const sessions = rows.flatMap(row => {
      const deadline = Number(row.resume_until ?? Number(row.updated_at) + ttlMs);
      if (deadline <= now) {
        expiredIds.push(String(row.id));
        return [];
      }
      const id = String(row.id);
      const tracks = (this.db.query(`SELECT * FROM tracks
        WHERE session_id = ? AND status IN ('playing', 'ready', 'preparing', 'played')
        ORDER BY CASE WHEN status = 'playing' THEN -1 ELSE COALESCE(queue_position, created_at) END`).all(id) as Record<string, unknown>[])
        .map(track => ({
          id: String(track.id),
          requesterId: String(track.requester_id),
          sourceInput: String(track.source_input),
          canonicalUrl: String(track.canonical_url),
          sourceId: String(track.source_id),
          title: String(track.title),
          artist: String(track.artist),
          ...(track.album ? { album: String(track.album) } : {}),
          ...(track.duration === null ? {} : { duration: Number(track.duration) }),
          ...(track.artwork ? { artwork: String(track.artwork) } : {}),
          ...(track.automatic ? { automatic: true } : {}),
          status: String(track.status),
          ...(track.file_path ? { filePath: String(track.file_path) } : {}),
          ...(track.queue_position === null ? {} : { queuePosition: Number(track.queue_position) }),
        }));
      return [{
        id,
        huddleId: String(row.huddle_id),
        callId: String(row.call_id),
        channelId: String(row.channel_id),
        threadTs: String(row.thread_ts),
        uiTs: String(row.ui_ts ?? ""),
        revision: Number(row.revision),
        creatorId: String(row.creator_id),
        ...(row.host_id ? { hostId: String(row.host_id) } : {}),
        state: String(row.status === "suspended" ? row.resume_state ?? "ready" : row.status),
        volume: Number(row.volume),
        autoplay: Boolean(row.autoplay),
        displayMode: displayModes.includes(row.display_mode as DisplayMode)
          ? row.display_mode as DisplayMode
          : "default",
        anchorEnabled: Boolean(row.anchor_enabled),
        playbackSeconds: Number(row.playback_seconds),
        listenedSeconds: Number(row.listened_seconds),
        resumeUntil: deadline,
        permissions: (this.db.query("SELECT capability FROM permissions WHERE session_id = ? AND allowed = 1").all(id) as { capability: string }[])
          .map(value => value.capability),
        tracks,
      } satisfies SavedSession];
    });
    if (expiredIds.length) this.db.transaction(() => {
      const end = this.db.query("UPDATE sessions SET status = 'ended', resume_state = NULL, resume_until = NULL, updated_at = ? WHERE id = ?");
      const clear = this.db.query("DELETE FROM tracks WHERE session_id = ?");
      for (const id of expiredIds) {
        clear.run(id);
        end.run(now, id);
      }
    })();
    return { sessions, expiredIds };
  }

  expireSession(sessionId: string) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM tracks WHERE session_id = ?").run(sessionId);
      this.db.query("UPDATE sessions SET status = 'ended', resume_state = NULL, resume_until = NULL, updated_at = ? WHERE id = ?")
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
      .query(`INSERT INTO tracks
        (id, session_id, requester_id, source_input, canonical_url, source_id, title, artist, album, duration, artwork, automatic, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
      this.db.query("UPDATE tracks SET status = ? WHERE id = ?").run(fields.status, id);
    if (fields.filePath !== undefined)
      this.db.query("UPDATE tracks SET file_path = ? WHERE id = ?").run(fields.filePath, id);
  }

  removeTrack(id: string) {
    this.db.query("DELETE FROM tracks WHERE id = ?").run(id);
  }

  setPermission(sessionId: string, capability: string, allowed: boolean) {
    this.db
      .query(`INSERT INTO permissions (session_id, capability, allowed) VALUES (?, ?, ?)
        ON CONFLICT (session_id, capability) DO UPDATE SET allowed = excluded.allowed`)
      .run(sessionId, capability, allowed ? 1 : 0);
  }

  close() {
    this.db.close();
  }

  private ensureColumn(table: string, column: string, definition: string) {
    if (!this.hasColumn(table, column))
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private hasColumn(table: string, column: string) {
    return (this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .some(value => value.name === column);
  }
}
