import { Database, type SQLQueryBindings } from "bun:sqlite";
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
export const transitionModes = ["none", "gapless", "adaptive"] as const;
export type TransitionMode = (typeof transitionModes)[number];

export const duckingModes = ["off", "gentle", "strong"] as const;
export type DuckingMode = (typeof duckingModes)[number];

export const duckingModeLabels: Record<DuckingMode, string> = {
  off: "Off",
  gentle: "Gentle",
  strong: "Strong",
};

export const scrobblingModes = ["always", "ask", "disabled"] as const;
export type ScrobblingMode = (typeof scrobblingModes)[number];

// What a listener lets the Huddle mix draw on: the songs they have added or
// liked in HuddleFM, and their listening on each scrobbling service.
export const huddleMixSources = ["added", "lastfm", "listenbrainz"] as const;
export type HuddleMixSource = (typeof huddleMixSources)[number];

// The sources a listener could give the Huddle mix right now: their HuddleFM
// history, and each scrobbling service they have connected.
export function usableHuddleMixSources(
  settings: Pick<UserScrobbling, "lastFmSessionKey" | "listenBrainzToken">,
): HuddleMixSource[] {
  return huddleMixSources.filter(
    (source) =>
      source === "added" ||
      (source === "lastfm" && Boolean(settings.lastFmSessionKey)) ||
      (source === "listenbrainz" && Boolean(settings.listenBrainzToken)),
  );
}

export const autoplayModes = ["off", "related", "huddle"] as const;
export type AutoplayMode = (typeof autoplayModes)[number];

export function modeOf<M extends string>(modes: readonly M[], value: unknown) {
  return modes.includes(value as M) ? (value as M) : undefined;
}

// Autoplay and loop were on/off toggles before they became modes, so a stored
// boolean still reads as the first non-off mode.
function parseMode<M extends string>(modes: readonly M[], value: unknown): M {
  if (value === true || value === 1 || value === "1") return modes[1]!;
  return modeOf(modes, value) ?? modes[0]!;
}

export function parseAutoplayMode(value: unknown) {
  return parseMode(autoplayModes, value);
}

export const autoplayModeLabels: Record<AutoplayMode, string> = {
  off: "Off",
  related: "Related",
  huddle: "Huddle mix",
};

export const loopModes = ["off", "track", "queue"] as const;
export type LoopMode = (typeof loopModes)[number];

export function parseLoopMode(value: unknown) {
  return parseMode(loopModes, value);
}

export const loopModeLabels: Record<LoopMode, string> = {
  off: "Off",
  track: "Track",
  queue: "Queue",
};

export const recentTrackLimit = 100;
// How many distinct autoplayed songs count as "recent" when keeping the
// mix's own output out of listeners' taste profiles.
const recentAutomaticLimit = 500;
// Likes are read newest first, so this is how far back an enthusiastic
// listener's profile reaches. Every other taste source is capped too; without
// one, somebody's own likes can crowd out everything else they have listened
// to. Generous next to the 25 recent adds, since a like is rarer and the tail
// past it has decayed to little in any case.
const recentLikeLimit = 50;

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
  shuffled: "Queue shuffles",
  cleared: "Queue clears",
  settings: "Settings changes",
} as const;
export type UsageKey = keyof typeof usageLabels;
export type UsageCounts = { [key in UsageKey]: number };

export type PlayRecord = {
  userId: string;
  title: string;
  artist: string;
  playedAt: number;
};

export type RoomPlayRecord = {
  title: string;
  artist: string;
  playedAt: number;
};

export type SkipRecord = {
  userId: string;
  title: string;
  artist: string;
  weight: number;
  skippedAt: number;
};

export type LikeRecord = {
  userId: string;
  title: string;
  artist: string;
  likedAt: number;
};

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
  introSeconds?: number;
  outroSeconds?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
  queuePosition?: number;
};

type RecentTrack = Pick<
  SavedTrack,
  | "id"
  | "sourceInput"
  | "canonicalUrl"
  | "sourceId"
  | "title"
  | "artist"
  | "album"
  | "duration"
  | "artwork"
>;

export type SavedSession = {
  id: string;
  huddleId: string;
  callId: string;
  channelId: string;
  threadTs: string;
  sourceChannelId?: string;
  huddleThreadTs?: string;
  companionChannelId?: string;
  uiTs: string;
  revision: number;
  creatorId: string;
  hostId?: string;
  state: string;
  volume: number;
  autoplay: AutoplayMode;
  loopMode: LoopMode;
  transitionMode: TransitionMode;
  // Absent on sessions saved before ducking existed, and on any session that
  // never overrode the configured default.
  duckingMode?: DuckingMode;
  displayMode: DisplayMode;
  anchorEnabled: boolean;
  // Set once native media gave way to the browser, so a restore rejoins with
  // the browser instead of the backend that already failed this Huddle.
  mediaFallback?: boolean;
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
  // Whether the listener takes part in the Huddle mix at all: true while any
  // of their sources is.
  huddleMixOptIn: boolean;
  // The usable sources the listener gives the mix. A service they have not
  // connected is never listed, whatever its saved choice.
  huddleMixSources: HuddleMixSource[];
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

type Row = Record<string, unknown>;

type SessionSnapshot = {
  state: string;
  playbackSeconds: number;
  displayMode: DisplayMode;
  anchorEnabled: boolean;
  queue: string[];
};

const sessionColumns = {
  status: "status",
  hostId: "host_id",
  volume: "volume",
  autoplay: "autoplay",
  loopMode: "loop_mode",
  transitionMode: "transition_mode",
  duckingMode: "ducking_mode",
  playbackSeconds: "playback_seconds",
  listenedSeconds: "listened_seconds",
  displayMode: "display_mode",
  anchorEnabled: "anchor_enabled",
  mediaFallback: "media_fallback",
};

const trackColumns = {
  status: "status",
  filePath: "file_path",
  title: "title",
  artist: "artist",
  album: "album",
  duration: "duration",
  artwork: "artwork",
  introSeconds: "intro_seconds",
  outroSeconds: "outro_seconds",
  fadeInSeconds: "fade_in_seconds",
  fadeOutSeconds: "fade_out_seconds",
};

const addedColumns = [
  ["sessions", "autoplay", "TEXT NOT NULL DEFAULT 'off'"],
  ["sessions", "loop_mode", "TEXT NOT NULL DEFAULT 'off'"],
  ["sessions", "transition_mode", "TEXT NOT NULL DEFAULT 'none'"],
  ["sessions", "ducking_mode", "TEXT"],
  ["sessions", "resume_state", "TEXT"],
  ["sessions", "resume_until", "INTEGER"],
  ["sessions", "playback_seconds", "REAL NOT NULL DEFAULT 0"],
  ["sessions", "listened_seconds", "REAL NOT NULL DEFAULT 0"],
  ["sessions", "lyrics_enabled", "INTEGER NOT NULL DEFAULT 1"],
  ["sessions", "display_mode", "TEXT NOT NULL DEFAULT 'default'"],
  ["sessions", "anchor_enabled", "INTEGER NOT NULL DEFAULT 0"],
  ["sessions", "end_text", "TEXT"],
  ["sessions", "end_blocks", "TEXT"],
  ["sessions", "source_channel_id", "TEXT"],
  ["sessions", "huddle_thread_ts", "TEXT"],
  ["sessions", "companion_channel_id", "TEXT"],
  ["sessions", "message_cleanup_at", "INTEGER"],
  ["sessions", "media_fallback", "INTEGER NOT NULL DEFAULT 0"],
  ["tracks", "automatic", "INTEGER NOT NULL DEFAULT 0"],
  ["tracks", "queue_position", "INTEGER"],
  ["tracks", "intro_seconds", "REAL"],
  ["tracks", "outro_seconds", "REAL"],
  ["tracks", "fade_in_seconds", "REAL"],
  ["tracks", "fade_out_seconds", "REAL"],
  ["user_scrobbling", "mode", "TEXT NOT NULL DEFAULT 'always'"],
  ["user_scrobbling", "huddle_mix_opt_in", "INTEGER NOT NULL DEFAULT 1"],
  ["user_scrobbling", "huddle_mix_added", "INTEGER NOT NULL DEFAULT 1"],
  ["user_scrobbling", "huddle_mix_lastfm", "INTEGER NOT NULL DEFAULT 1"],
  ["user_scrobbling", "huddle_mix_listenbrainz", "INTEGER NOT NULL DEFAULT 1"],
] as const;

// The SET clause and bindings for whichever of `fields` are present.
function assignments(
  columns: Record<string, string>,
  fields: Record<string, unknown>,
) {
  const set = Object.entries(fields).filter(
    ([field, value]) => field in columns && value !== undefined,
  );
  return {
    sql: set.map(([field]) => `${columns[field]} = ?`).join(", "),
    values: set.map(([, value]) =>
      typeof value === "boolean" ? Number(value) : value,
    ) as SQLQueryBindings[],
  };
}

// Optional columns become absent keys rather than undefined ones, so a saved
// record round-trips through JSON and `toHaveProperty` the same way.
function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

// The listener's saved choice for each Huddle mix source, connected or not.
// The opt-in column predates the per-source ones, so an older opt-out still
// turns every source off.
function savedHuddleMixSources(row: Row) {
  return Object.fromEntries(
    huddleMixSources.map((source) => [
      source,
      row.huddle_mix_opt_in !== 0 && row[`huddle_mix_${source}`] !== 0,
    ]),
  ) as Record<HuddleMixSource, boolean>;
}

function slots(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

function text(value: unknown) {
  return value ? String(value) : undefined;
}

function numeric(value: unknown) {
  return value === null ? undefined : Number(value);
}

function savedTrack(track: Row) {
  return compact({
    id: String(track.id),
    requesterId: String(track.requester_id),
    sourceInput: String(track.source_input),
    canonicalUrl: String(track.canonical_url),
    sourceId: String(track.source_id),
    title: String(track.title),
    artist: String(track.artist),
    album: text(track.album),
    duration: numeric(track.duration),
    artwork: text(track.artwork),
    automatic: track.automatic ? true : undefined,
    status: String(track.status),
    filePath: text(track.file_path),
    introSeconds: numeric(track.intro_seconds),
    outroSeconds: numeric(track.outro_seconds),
    fadeInSeconds: numeric(track.fade_in_seconds),
    fadeOutSeconds: numeric(track.fade_out_seconds),
    queuePosition: numeric(track.queue_position),
  } satisfies SavedTrack);
}

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
        autoplay TEXT NOT NULL DEFAULT 'off',
        loop_mode TEXT NOT NULL DEFAULT 'off',
        transition_mode TEXT NOT NULL DEFAULT 'none',
        ducking_mode TEXT,
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
        intro_seconds REAL,
        outro_seconds REAL,
        fade_in_seconds REAL,
        fade_out_seconds REAL,
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
        huddle_mix_opt_in INTEGER NOT NULL DEFAULT 1,
        huddle_mix_added INTEGER NOT NULL DEFAULT 1,
        huddle_mix_lastfm INTEGER NOT NULL DEFAULT 1,
        huddle_mix_listenbrainz INTEGER NOT NULL DEFAULT 1,
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
      CREATE TABLE IF NOT EXISTS companion_channels (
        source_channel_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS companion_removals (
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS session_messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        delete_at INTEGER,
        next_attempt_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, message_ts)
      );
      CREATE TABLE IF NOT EXISTS session_participants (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );
      -- One row per listener who actually heard a song, so the Huddle mix
      -- remembers across Huddles rather than only within one. Deliberately
      -- not tied to sessions(id) by a foreign key: the memory has to outlive
      -- any future session cleanup.
      CREATE TABLE IF NOT EXISTS track_plays (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        played_at INTEGER NOT NULL
      );
      -- Skips of autoplay picks, attributed to the listener who skipped and,
      -- at a fraction of the weight, to everyone else who was in the room.
      CREATE TABLE IF NOT EXISTS autoplay_skips (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        weight REAL NOT NULL,
        skipped_at INTEGER NOT NULL
      );
      -- An explicit "more of this" from one listener. The button is one way
      -- and shows nothing back, so it gets pressed again without meaning any
      -- more than the first time: one row per listener per song, and a repeat
      -- press only moves the date forward.
      CREATE TABLE IF NOT EXISTS track_likes (
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        liked_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, title COLLATE NOCASE, artist COLLATE NOCASE)
      );
      CREATE INDEX IF NOT EXISTS sessions_status_resume
        ON sessions(status, resume_until);
      CREATE INDEX IF NOT EXISTS tracks_session_status
        ON tracks(session_id, status);
      CREATE INDEX IF NOT EXISTS tracks_status_source
        ON tracks(status, source_id);
      CREATE INDEX IF NOT EXISTS scrobbles_pending
        ON scrobbles(status, next_attempt_at, listened_at, created_at);
      CREATE INDEX IF NOT EXISTS companion_removals_due
        ON companion_removals(next_attempt_at);
      CREATE INDEX IF NOT EXISTS session_messages_due
        ON session_messages(next_attempt_at);
      CREATE INDEX IF NOT EXISTS track_plays_user_recent
        ON track_plays(user_id, played_at DESC);
      CREATE INDEX IF NOT EXISTS track_plays_session
        ON track_plays(session_id, played_at DESC);
      CREATE INDEX IF NOT EXISTS autoplay_skips_user_recent
        ON autoplay_skips(user_id, skipped_at DESC);
      CREATE INDEX IF NOT EXISTS track_likes_user_recent
        ON track_likes(user_id, liked_at DESC);
    `);
    // Columns added since the tables were first created, in the order they
    // were added so older databases end up with the same layout.
    const hadDisplayMode = this.hasColumn("sessions", "display_mode");
    for (const [table, column, definition] of addedColumns)
      this.ensureColumn(table, column, definition);
    this.migrateAutoplayModes();
    if (!hadDisplayMode)
      this.db.run(
        "UPDATE sessions SET display_mode = CASE lyrics_enabled WHEN 1 THEN 'lyrics' ELSE 'off' END",
      );
    this.db.run(`CREATE INDEX IF NOT EXISTS tracks_requester_recent
      ON tracks(requester_id, automatic, created_at DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS tracks_played_title_artist
      ON tracks(title COLLATE NOCASE, artist COLLATE NOCASE, created_at DESC)
      WHERE status = 'played'`);
  }

  createSession(session: {
    id: string;
    huddleId: string;
    callId: string;
    channelId: string;
    threadTs: string;
    sourceChannelId?: string;
    huddleThreadTs?: string;
    companionChannelId?: string;
    creatorId: string;
    hostId?: string;
    volume: number;
    duckingMode?: DuckingMode;
  }) {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO sessions
          (id, huddle_id, call_id, channel_id, thread_ts, source_channel_id,
          huddle_thread_ts, companion_channel_id, creator_id, host_id, status,
          volume, ducking_mode, anchor_enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, 0, ?, ?)`,
        )
        .run(
          session.id,
          session.huddleId,
          session.callId,
          session.channelId,
          session.threadTs,
          session.sourceChannelId ?? session.channelId,
          session.huddleThreadTs ?? session.threadTs,
          session.companionChannelId ?? null,
          session.creatorId,
          session.hostId ?? null,
          session.volume,
          session.duckingMode ?? null,
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

  setUiLocation(
    sessionId: string,
    channelId: string,
    threadTs: string,
    companionChannelId?: string,
  ) {
    this.db
      .query(
        `UPDATE sessions SET channel_id = ?, thread_ts = ?, companion_channel_id = ?,
        updated_at = ? WHERE id = ?`,
      )
      .run(
        channelId,
        threadTs,
        companionChannelId ?? null,
        Date.now(),
        sessionId,
      );
  }

  setSessionParticipants(sessionId: string, userIds: string[]) {
    this.db.transaction(() => {
      this.db
        .query("DELETE FROM session_participants WHERE session_id = ?")
        .run(sessionId);
      const insert = this.db.query(
        "INSERT INTO session_participants (session_id, user_id) VALUES (?, ?)",
      );
      for (const userId of new Set(userIds)) insert.run(sessionId, userId);
    })();
  }

  addSessionParticipant(sessionId: string, userId: string) {
    this.db
      .query(
        "INSERT OR IGNORE INTO session_participants (session_id, user_id) VALUES (?, ?)",
      )
      .run(sessionId, userId);
  }

  removeSessionParticipant(sessionId: string, userId: string) {
    this.db
      .query(
        "DELETE FROM session_participants WHERE session_id = ? AND user_id = ?",
      )
      .run(sessionId, userId);
  }

  sessionParticipants(sessionId: string) {
    return (
      this.db
        .query(
          "SELECT user_id AS userId FROM session_participants WHERE session_id = ?",
        )
        .all(sessionId) as { userId: string }[]
    ).map(({ userId }) => userId);
  }

  sessionCompanionChannel(sessionId: string) {
    return this.scalar<string | null>(
      "SELECT companion_channel_id FROM sessions WHERE id = ?",
      sessionId,
    );
  }

  setSession(
    sessionId: string,
    fields: {
      status?: string;
      hostId?: string | null;
      volume?: number;
      autoplay?: AutoplayMode;
      loopMode?: LoopMode;
      transitionMode?: TransitionMode;
      duckingMode?: DuckingMode;
      playbackSeconds?: number;
      listenedSeconds?: number;
      displayMode?: DisplayMode;
      anchorEnabled?: boolean;
      mediaFallback?: boolean;
    },
  ) {
    const { sql, values } = assignments(sessionColumns, fields);
    if (!sql) return;
    this.db
      .query(`UPDATE sessions SET ${sql}, updated_at = ? WHERE id = ?`)
      .run(...values, Date.now(), sessionId);
  }

  suspendSession(
    sessionId: string,
    state: SessionSnapshot,
    resumeUntil: number,
  ) {
    this.saveSnapshot(sessionId, "suspended", state, resumeUntil);
  }

  endSession(
    sessionId: string,
    state: SessionSnapshot & { listenedSeconds: number },
    resumeUntil: number,
  ) {
    this.saveSnapshot(sessionId, "ended", state, resumeUntil);
  }

  private saveSnapshot(
    sessionId: string,
    status: string,
    state: SessionSnapshot & { listenedSeconds?: number },
    resumeUntil: number,
  ) {
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE sessions SET
        status = ?, resume_state = ?, resume_until = ?, playback_seconds = ?,
        listened_seconds = COALESCE(?, listened_seconds), display_mode = ?,
        anchor_enabled = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          status,
          state.state,
          resumeUntil,
          state.playbackSeconds,
          state.listenedSeconds ?? null,
          state.displayMode,
          state.anchorEnabled ? 1 : 0,
          Date.now(),
          sessionId,
        );
      this.writeQueueOrder(sessionId, state.queue);
    })();
  }

  /**
   * Rewrites the queue order of a live session, so a reorder survives a crash
   * that never reached suspendSession.
   */
  setQueueOrder(sessionId: string, queue: string[]) {
    this.db.transaction(() => this.writeQueueOrder(sessionId, queue))();
  }

  private writeQueueOrder(sessionId: string, queue: string[]) {
    this.db
      .query("UPDATE tracks SET queue_position = NULL WHERE session_id = ?")
      .run(sessionId);
    const position = this.db.query(
      "UPDATE tracks SET queue_position = ? WHERE id = ? AND session_id = ?",
    );
    queue.forEach((id, index) => position.run(index, id, sessionId));
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
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE sessions SET
        status = ?, resume_state = NULL, resume_until = NULL, end_text = NULL,
        end_blocks = NULL, message_cleanup_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(status, Date.now(), sessionId);
      // Restored sessions reuse the end-recap message as the live player.
      // Cancel any companion-channel deletions scheduled while the session was ended.
      this.db
        .query(
          `UPDATE session_messages
          SET delete_at = NULL, next_attempt_at = NULL, attempts = 0
          WHERE session_id = ?`,
        )
        .run(sessionId);
    })();
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
        `SELECT COALESCE(sessions.source_channel_id, sessions.channel_id) AS channelId, COUNT(*) AS count
        FROM tracks JOIN sessions ON sessions.id = tracks.session_id
        WHERE tracks.status = 'played'
        GROUP BY COALESCE(sessions.source_channel_id, sessions.channel_id)
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
    return !this.migrated("audit-usage-v1");
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
      this.completeMigration("audit-usage-v1");
    })();
  }

  resumableSessions(now: number, ttlMs: number) {
    const rows = this.db
      .query(`SELECT * FROM sessions WHERE status != 'ended'`)
      .all() as Row[];
    return this.savedSessions(rows, now, ttlMs, true);
  }

  restorableSessions() {
    const rows = this.db
      .query(
        `SELECT * FROM sessions WHERE status = 'ended' AND resume_until IS NOT NULL`,
      )
      .all() as Row[];
    return this.savedSessions(rows, Number.NEGATIVE_INFINITY, 0, false)
      .sessions;
  }

  private savedSessions(
    rows: Row[],
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
          .all(id) as Row[]
      ).map(savedTrack);
      return [
        compact({
          id,
          huddleId: String(row.huddle_id),
          callId: String(row.call_id),
          channelId: String(row.channel_id),
          threadTs: String(row.thread_ts),
          sourceChannelId: String(row.source_channel_id ?? row.channel_id),
          huddleThreadTs: String(row.huddle_thread_ts ?? row.thread_ts),
          companionChannelId: text(row.companion_channel_id),
          uiTs: String(row.ui_ts ?? ""),
          revision: Number(row.revision),
          creatorId: String(row.creator_id),
          hostId: text(row.host_id),
          state: String(row.resume_state ?? row.status),
          volume: Number(row.volume),
          autoplay: parseAutoplayMode(row.autoplay),
          loopMode: parseLoopMode(row.loop_mode),
          transitionMode:
            modeOf(transitionModes, row.transition_mode) ?? "none",
          duckingMode: modeOf(duckingModes, row.ducking_mode),
          displayMode: modeOf(displayModes, row.display_mode) ?? "default",
          anchorEnabled: Boolean(row.anchor_enabled),
          mediaFallback: Boolean(row.media_fallback) || undefined,
          playbackSeconds: Number(row.playback_seconds),
          listenedSeconds: Number(row.listened_seconds),
          resumeUntil: deadline,
          endText: text(row.end_text),
          endBlocks: row.end_blocks
            ? (JSON.parse(String(row.end_blocks)) as unknown[])
            : undefined,
          permissions: (
            this.db
              .query(
                "SELECT capability FROM permissions WHERE session_id = ? AND allowed = 1",
              )
              .all(id) as { capability: string }[]
          ).map((value) => value.capability),
          tracks,
        } satisfies SavedSession),
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

  companionChannel(sourceChannelId: string) {
    return this.scalar<string>(
      "SELECT channel_id FROM companion_channels WHERE source_channel_id = ?",
      sourceChannelId,
    );
  }

  sourceChannelForCompanion(channelId: string) {
    return this.scalar<string>(
      "SELECT source_channel_id FROM companion_channels WHERE channel_id = ?",
      channelId,
    );
  }

  setCompanionChannel(sourceChannelId: string, channelId: string) {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO companion_channels
        (source_channel_id, channel_id, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (source_channel_id) DO UPDATE SET
        channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
      )
      .run(sourceChannelId, channelId, now, now);
  }

  clearCompanionChannel(sourceChannelId: string) {
    this.db
      .query("DELETE FROM companion_channels WHERE source_channel_id = ?")
      .run(sourceChannelId);
  }

  scheduleCompanionRemoval(channelId: string, userId: string, dueAt: number) {
    this.db
      .query(
        `INSERT INTO companion_removals
        (channel_id, user_id, due_at, next_attempt_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (channel_id, user_id) DO UPDATE SET
        due_at = excluded.due_at, next_attempt_at = excluded.next_attempt_at,
        attempts = 0`,
      )
      .run(channelId, userId, dueAt, dueAt);
  }

  cancelCompanionRemoval(channelId: string, userId: string) {
    this.db
      .query(
        "DELETE FROM companion_removals WHERE channel_id = ? AND user_id = ?",
      )
      .run(channelId, userId);
  }

  dueCompanionRemovals(now: number) {
    return this.db
      .query(
        `SELECT channel_id AS channelId, user_id AS userId, due_at AS dueAt, attempts
        FROM companion_removals WHERE next_attempt_at <= ?`,
      )
      .all(now) as {
      channelId: string;
      userId: string;
      dueAt: number;
      attempts: number;
    }[];
  }

  companionRemovalDeadline(channelId: string, userId: string) {
    return this.scalar<number>(
      "SELECT due_at FROM companion_removals WHERE channel_id = ? AND user_id = ?",
      channelId,
      userId,
    );
  }

  completeCompanionRemoval(channelId: string, userId: string, dueAt: number) {
    this.db
      .query(
        "DELETE FROM companion_removals WHERE channel_id = ? AND user_id = ? AND due_at = ?",
      )
      .run(channelId, userId, dueAt);
  }

  retryCompanionRemoval(
    channelId: string,
    userId: string,
    dueAt: number,
    attempts: number,
    nextAttemptAt: number,
  ) {
    this.db
      .query(
        `UPDATE companion_removals SET attempts = ?, next_attempt_at = ?
        WHERE channel_id = ? AND user_id = ? AND due_at = ?`,
      )
      .run(attempts, nextAttemptAt, channelId, userId, dueAt);
  }

  recordSessionMessage(
    sessionId: string,
    channelId: string,
    messageTs: string,
  ) {
    this.db
      .query(
        `INSERT OR IGNORE INTO session_messages
        (session_id, channel_id, message_ts, delete_at, next_attempt_at)
        SELECT id, ?, ?, message_cleanup_at, message_cleanup_at
        FROM sessions WHERE id = ?`,
      )
      .run(channelId, messageTs, sessionId);
  }

  scheduleSessionMessageCleanup(sessionId: string, deleteAt: number) {
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE sessions SET message_cleanup_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(deleteAt, Date.now(), sessionId);
      this.db
        .query(
          `UPDATE session_messages SET delete_at = ?, next_attempt_at = ?, attempts = 0
          WHERE session_id = ?`,
        )
        .run(deleteAt, deleteAt, sessionId);
    })();
  }

  dueSessionMessages(now: number) {
    return this.db
      .query(
        `SELECT session_id AS sessionId, channel_id AS channelId,
        message_ts AS messageTs, attempts FROM session_messages
        WHERE next_attempt_at IS NOT NULL AND next_attempt_at <= ?`,
      )
      .all(now) as {
      sessionId: string;
      channelId: string;
      messageTs: string;
      attempts: number;
    }[];
  }

  /**
   * Revalidate a due session message before deleting it.
   * Returns false when activateSession() cleared delete_at / next_attempt_at
   * after dueSessionMessages() already returned the job.
   */
  claimDueSessionMessage(
    channelId: string,
    messageTs: string,
    now: number,
  ): boolean {
    return Boolean(
      this.db
        .query(
          `SELECT 1 AS ok FROM session_messages
          WHERE channel_id = ? AND message_ts = ?
            AND delete_at IS NOT NULL
            AND next_attempt_at IS NOT NULL
            AND next_attempt_at <= ?`,
        )
        .get(channelId, messageTs, now),
    );
  }

  completeSessionMessage(channelId: string, messageTs: string) {
    this.db
      .query(
        "DELETE FROM session_messages WHERE channel_id = ? AND message_ts = ?",
      )
      .run(channelId, messageTs);
  }

  retrySessionMessage(
    channelId: string,
    messageTs: string,
    attempts: number,
    nextAttemptAt: number,
  ): boolean {
    // Only restore next_attempt_at when cleanup is still active. activateSession
    // clears delete_at; do not resurrect cancelled companion message deletions.
    const result = this.db
      .query(
        `UPDATE session_messages SET attempts = ?, next_attempt_at = ?
        WHERE channel_id = ? AND message_ts = ? AND delete_at IS NOT NULL`,
      )
      .run(attempts, nextAttemptAt, channelId, messageTs);
    return result.changes > 0;
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

  recentTracks(userId: string, limit = recentTrackLimit) {
    return this.db
      .query(
        `SELECT id, sourceInput, canonicalUrl, sourceId, title, artist, album, duration, artwork
        FROM (
          SELECT id, source_input AS sourceInput, canonical_url AS canonicalUrl,
          source_id AS sourceId, title, artist, album, duration, artwork, created_at,
          rowid AS insertionOrder,
          ROW_NUMBER() OVER (
            PARTITION BY source_id ORDER BY created_at DESC, rowid DESC
          ) AS recency
          FROM tracks WHERE requester_id = ? AND automatic = 0
        )
        WHERE recency = 1
        ORDER BY created_at DESC, insertionOrder DESC LIMIT ?`,
      )
      .all(userId, limit) as RecentTrack[];
  }

  // Tracks autoplay has queued recently, across every session. Listeners
  // scrobble these, so a taste profile built from recent scrobbles would
  // otherwise feed the mix's own output straight back into it.
  recentAutomaticTracks(limit = recentAutomaticLimit) {
    return this.db
      .query(
        `SELECT title, artist FROM (
          SELECT title, artist, MAX(created_at) AS created_at,
          MAX(rowid) AS insertionOrder
          FROM tracks WHERE automatic = 1
          GROUP BY title COLLATE NOCASE, artist COLLATE NOCASE
        )
        ORDER BY created_at DESC, insertionOrder DESC LIMIT ?`,
      )
      .all(limit) as { title: string; artist: string }[];
  }

  // The most recent track anyone here has played with this title and artist,
  // so recommendations can reuse a known-good video instead of searching.
  findPlayedTrack(title: string, artist: string) {
    return this.db
      .query(
        `SELECT id, source_input AS sourceInput, canonical_url AS canonicalUrl,
        source_id AS sourceId, title, artist, album, duration, artwork
        FROM tracks
        WHERE title = ? COLLATE NOCASE AND artist = ? COLLATE NOCASE
        AND status = 'played'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(title, artist) as RecentTrack | null;
  }

  // Records that one listener actually heard a song. Called once per listener
  // per play, when they have listened far enough for it to count.
  recordTrackPlay(play: {
    sessionId: string;
    userId: string;
    title: string;
    artist: string;
    playedAt?: number;
  }) {
    this.db
      .query(
        `INSERT INTO track_plays (id, session_id, user_id, title, artist, played_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        play.sessionId,
        play.userId,
        play.title,
        play.artist,
        play.playedAt ?? Date.now(),
      );
  }

  // Records a skipped autoplay pick against one listener. The skipper is
  // recorded at full weight and the rest of the room at a fraction, since
  // whoever pressed the button was acting for everyone present.
  recordAutoplaySkip(skip: {
    sessionId: string;
    userId: string;
    title: string;
    artist: string;
    weight: number;
    skippedAt?: number;
  }) {
    this.db
      .query(
        `INSERT INTO autoplay_skips (id, session_id, user_id, title, artist, weight, skipped_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        skip.sessionId,
        skip.userId,
        skip.title,
        skip.artist,
        skip.weight,
        skip.skippedAt ?? Date.now(),
      );
  }

  // Records that one listener wants more of a song. Pressing the button again
  // is not a stronger opinion, only a fresher one, so the row is replaced
  // rather than added to.
  likeTrack(like: {
    userId: string;
    title: string;
    artist: string;
    likedAt?: number;
  }) {
    this.db
      .query(
        `INSERT INTO track_likes (user_id, title, artist, liked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT DO UPDATE SET liked_at = excluded.liked_at`,
      )
      .run(like.userId, like.title, like.artist, like.likedAt ?? Date.now());
  }

  // Takes a like back. Returns whether there was one to take back, so an undo
  // that arrives twice can say so instead of claiming to have done something.
  unlikeTrack(userId: string, title: string, artist: string) {
    const { changes } = this.db
      .query(
        `DELETE FROM track_likes
        WHERE user_id = ? AND title = ? COLLATE NOCASE
        AND artist = ? COLLATE NOCASE`,
      )
      .run(userId, title, artist);
    return changes > 0;
  }

  // What these listeners have liked since `since`, newest first and capped like
  // every other taste source. The like button is one way, so age is the only
  // thing that softens one: the mix weighs each row by how long ago it was
  // pressed, and past the cap what is left has decayed to little anyway.
  recentLikes(
    userIds: readonly string[],
    since: number,
    limit = recentLikeLimit,
  ): LikeRecord[] {
    if (!userIds.length) return [];
    return this.db
      .query(
        `SELECT user_id AS userId, title, artist, liked_at AS likedAt
        FROM track_likes
        WHERE user_id IN (${slots(userIds)}) AND liked_at >= ?
        ORDER BY liked_at DESC LIMIT ?`,
      )
      .all(...userIds, since, limit) as LikeRecord[];
  }

  // What these listeners have heard since `since`, across every Huddle. Titles
  // and artists come back raw: the mix normalizes them itself, so changing how
  // songs are matched never needs the stored rows rewritten.
  recentPlays(userIds: readonly string[], since: number): PlayRecord[] {
    if (!userIds.length) return [];
    return this.db
      .query(
        `SELECT user_id AS userId, title, artist, played_at AS playedAt
        FROM track_plays
        WHERE user_id IN (${slots(userIds)}) AND played_at >= ?
        ORDER BY played_at DESC`,
      )
      .all(...userIds, since) as PlayRecord[];
  }

  // What has been heard in this room since `since`, whoever was listening, so
  // a Huddle full of listeners the mix knows nothing about still drifts.
  recentRoomPlays(roomId: string, since: number): RoomPlayRecord[] {
    return this.db
      .query(
        `SELECT DISTINCT p.title, p.artist, p.played_at AS playedAt
        FROM track_plays p
        JOIN sessions s ON s.id = p.session_id
        WHERE COALESCE(s.source_channel_id, s.channel_id) = ?
        AND p.played_at >= ?
        ORDER BY p.played_at DESC`,
      )
      .all(roomId, since) as RoomPlayRecord[];
  }

  recentSkips(userIds: readonly string[], since: number): SkipRecord[] {
    if (!userIds.length) return [];
    return this.db
      .query(
        `SELECT user_id AS userId, title, artist, weight, skipped_at AS skippedAt
        FROM autoplay_skips
        WHERE user_id IN (${slots(userIds)}) AND skipped_at >= ?
        ORDER BY skipped_at DESC`,
      )
      .all(...userIds, since) as SkipRecord[];
  }

  // Rows older than the window the mix looks at have decayed to nothing, so
  // they are only taking up space.
  pruneListeningMemory(
    playsBefore: number,
    skipsBefore: number,
    likesBefore: number,
  ) {
    this.db
      .query("DELETE FROM track_plays WHERE played_at < ?")
      .run(playsBefore);
    this.db
      .query("DELETE FROM autoplay_skips WHERE skipped_at < ?")
      .run(skipsBefore);
    this.db
      .query("DELETE FROM track_likes WHERE liked_at < ?")
      .run(likesBefore);
  }

  setTrack(
    id: string,
    fields: {
      status?: string;
      filePath?: string | null;
      title?: string;
      artist?: string;
      album?: string | null;
      duration?: number | null;
      artwork?: string | null;
      introSeconds?: number;
      outroSeconds?: number;
      fadeInSeconds?: number;
      fadeOutSeconds?: number;
    },
  ) {
    const { sql, values } = assignments(trackColumns, fields);
    if (!sql) return;
    this.db.query(`UPDATE tracks SET ${sql} WHERE id = ?`).run(...values, id);
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
      .get(userId) as Row | null;
    if (!row)
      return {
        lastFmEnabled: false,
        listenBrainzEnabled: false,
        huddleMixOptIn: true,
        huddleMixSources: ["added"],
        mode: "always",
      };
    const saved = savedHuddleMixSources(row);
    const sources = usableHuddleMixSources({
      lastFmSessionKey: text(row.lastfm_session_key),
      listenBrainzToken: text(row.listenbrainz_token),
    }).filter((source) => saved[source]);
    return compact({
      lastFmUsername: text(row.lastfm_username),
      lastFmSessionKey: text(row.lastfm_session_key),
      lastFmEnabled: Boolean(row.lastfm_enabled),
      lastFmPendingToken: text(row.lastfm_pending_token),
      lastFmPendingAt: row.lastfm_pending_at
        ? Number(row.lastfm_pending_at)
        : undefined,
      listenBrainzUsername: text(row.listenbrainz_username),
      listenBrainzToken: text(row.listenbrainz_token),
      listenBrainzEnabled: Boolean(row.listenbrainz_enabled),
      huddleMixOptIn: sources.length > 0,
      huddleMixSources: sources,
      mode: modeOf(scrobblingModes, row.mode) ?? "always",
    });
  }

  setScrobblingMode(userId: string, mode: ScrobblingMode) {
    this.updateUserScrobbling(userId, "mode = ?", mode);
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

  setHuddleMixOptIn(userId: string, enabled: boolean) {
    this.setHuddleMixSources(
      userId,
      Object.fromEntries(huddleMixSources.map((source) => [source, enabled])),
    );
  }

  // Saves the listener's choice for each source given; the others keep
  // theirs, so a service they have not connected yet keeps its choice for
  // when they do. Turning off every usable source opts them out entirely,
  // and a service connected later then starts off too.
  setHuddleMixSources(
    userId: string,
    choices: Partial<Record<HuddleMixSource, boolean>>,
  ) {
    const row = this.db
      .query("SELECT * FROM user_scrobbling WHERE user_id = ?")
      .get(userId) as Row | null;
    const previous = savedHuddleMixSources(row ?? {});
    // A save that changes nothing must not opt out, which would also clear
    // the choices kept for services that are not connected.
    if (
      huddleMixSources.every(
        (source) => (choices[source] ?? previous[source]) === previous[source],
      )
    )
      return;
    const saved = { ...previous, ...choices };
    const usable = usableHuddleMixSources({
      lastFmSessionKey: text(row?.lastfm_session_key),
      listenBrainzToken: text(row?.listenbrainz_token),
    });
    const optedIn = usable.some((source) => saved[source]);
    const on = (source: HuddleMixSource) => (optedIn && saved[source] ? 1 : 0);
    this.updateUserScrobbling(
      userId,
      `huddle_mix_opt_in = ?, huddle_mix_added = ?, huddle_mix_lastfm = ?,
      huddle_mix_listenbrainz = ?`,
      optedIn ? 1 : 0,
      on("added"),
      on("lastfm"),
      on("listenbrainz"),
    );
  }

  setLastFmPending(userId: string, token: string, startedAt: number) {
    this.updateUserScrobbling(
      userId,
      "lastfm_pending_token = ?, lastfm_pending_at = ?",
      token,
      startedAt,
    );
  }

  connectLastFm(userId: string, username: string, sessionKey: string) {
    this.updateUserScrobbling(
      userId,
      `lastfm_username = ?, lastfm_session_key = ?, lastfm_enabled = 1,
      lastfm_pending_token = NULL, lastfm_pending_at = NULL`,
      username,
      sessionKey,
    );
  }

  disconnectLastFm(userId: string) {
    this.updateUserScrobbling(
      userId,
      `lastfm_username = NULL, lastfm_session_key = NULL, lastfm_enabled = 0,
      lastfm_pending_token = NULL, lastfm_pending_at = NULL`,
    );
  }

  setLastFmEnabled(userId: string, enabled: boolean) {
    this.updateUserScrobbling(userId, "lastfm_enabled = ?", enabled ? 1 : 0);
  }

  setListenBrainzToken(userId: string, token: string, username: string) {
    this.updateUserScrobbling(
      userId,
      "listenbrainz_token = ?, listenbrainz_username = ?",
      token,
      username,
    );
  }

  disconnectListenBrainz(userId: string) {
    this.updateUserScrobbling(
      userId,
      `listenbrainz_username = NULL, listenbrainz_token = NULL,
      listenbrainz_enabled = 0`,
    );
  }

  setListenBrainzEnabled(userId: string, enabled: boolean) {
    this.updateUserScrobbling(
      userId,
      "listenbrainz_enabled = ?",
      enabled ? 1 : 0,
    );
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
        .all(now) as Row[]
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

  private migrateAutoplayModes() {
    if (this.migrated("autoplay-modes-v1")) return;
    this.db
      .query(
        `UPDATE sessions SET autoplay = CASE
          WHEN autoplay IN (1, '1', 'related') THEN 'related'
          WHEN autoplay = 'huddle' THEN 'huddle'
          ELSE 'off'
        END`,
      )
      .run();
    this.completeMigration("autoplay-modes-v1");
  }

  private migrated(name: string) {
    return Boolean(
      this.db.query("SELECT 1 FROM data_migrations WHERE name = ?").get(name),
    );
  }

  private completeMigration(name: string) {
    this.db
      .query("INSERT INTO data_migrations (name, completed_at) VALUES (?, ?)")
      .run(name, Date.now());
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

  // The first column of the first matching row, or undefined without one.
  private scalar<T>(sql: string, ...params: SQLQueryBindings[]) {
    return this.db.query(sql).values(...params)[0]?.[0] as T | undefined;
  }

  private updateUserScrobbling(
    userId: string,
    assignments: string,
    ...values: SQLQueryBindings[]
  ) {
    this.db
      .query(
        "INSERT OR IGNORE INTO user_scrobbling (user_id, updated_at) VALUES (?, ?)",
      )
      .run(userId, Date.now());
    this.db
      .query(
        `UPDATE user_scrobbling SET ${assignments}, updated_at = ? WHERE user_id = ?`,
      )
      .run(...values, Date.now(), userId);
  }
}
