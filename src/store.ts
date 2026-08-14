import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const capabilities = [
  "add",
  "remove-own",
  "manage-queue",
  "skip",
  "pause",
  "volume",
  "clear",
  "end-session",
] as const;

export const permissionPresets = {
  default: ["add", "remove-own"],
  "host-only": [],
  collaborative: capabilities.filter(capability => capability !== "clear" && capability !== "end-session"),
  communism: capabilities,
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
        status TEXT NOT NULL,
        file_path TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS permissions (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        capability TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        PRIMARY KEY (session_id, capability)
      );
    `);
    const closeUnfinished = this.db.transaction(() => {
      this.db.run("DELETE FROM tracks WHERE session_id IN (SELECT id FROM sessions WHERE status != 'ended')");
      this.db
        .query("UPDATE sessions SET status = 'ended', updated_at = ? WHERE status != 'ended'")
        .run(Date.now());
    });
    closeUnfinished();
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
          (id, huddle_id, call_id, channel_id, thread_ts, creator_id, host_id, status, volume, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`)
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

  setSession(sessionId: string, fields: { status?: string; hostId?: string | null; volume?: number }) {
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
    status: string;
  }) {
    this.db
      .query(`INSERT INTO tracks
        (id, session_id, requester_id, source_input, canonical_url, source_id, title, artist, album, duration, artwork, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
      .query("UPDATE permissions SET allowed = ? WHERE session_id = ? AND capability = ?")
      .run(allowed ? 1 : 0, sessionId, capability);
  }

  close() {
    this.db.close();
  }
}
