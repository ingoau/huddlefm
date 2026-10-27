// HuddleFM's side of the huddle data channel, as docs/data-channel.md
// describes it, for any client mod. The mod hands it the channel's messages
// and a way to send; this keeps the session's state and runs requests.

import { Store } from "./store.ts";

/** The data channel topic, and the protocol this client speaks. */
export const TOPIC = "huddlefm";
export const VERSION = 1;
export const PROTOCOL = 1;
/** Chime refuses data messages larger than this. */
const MAX_BYTES = 2048;
/** How long a request waits for its result. */
const REQUEST_TIMEOUT_MS = 15_000;
/** How long a chunked message may wait for its missing chunks. */
const CHUNK_TIMEOUT_MS = 5_000;
/** How long to wait for the bot to answer a sync before asking again. */
const SYNC_RETRY_MS = 4_000;
const SYNC_RETRIES = 3;
/** Quiet this long, and the client pings the bot to see it's still there. */
const QUIET_MS = 20_000;
/** Quiet this long, and the bot is taken to have gone. */
const GONE_MS = 45_000;

export type SettingOption = {
  value: string;
  label: string;
  description?: string;
};

export type SettingField = {
  id: string;
  tab: "session" | "host" | "you";
  label: string;
  hint?: string;
  optional?: boolean;
  requires: "volume" | "configure" | "admin" | "self";
  section?: string;
} & (
  | { kind: "select"; options: SettingOption[]; value: string }
  | { kind: "toggle"; text: string; value: boolean }
  | {
      kind: "multi";
      options: SettingOption[];
      value: string[];
      presets?: { value: string; label: string; permissions: string[] }[];
    }
  | { kind: "user"; value: string | null }
);

export type Track = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  artwork?: string;
  duration?: number;
  kind?: string;
  live?: boolean;
  automatic?: boolean;
  addedBy?: string;
  status?: string;
};

export type SessionState = {
  seq: number;
  session: {
    id: string;
    mode: "music" | "video";
    state: string;
    position: number;
    volume: number;
    hostId: string | null;
    allowed: string[];
    loopMode?: string;
    queueLimit?: number;
    player?: { channel: string; ts: string } | null;
  };
  nowPlaying: Track | null;
  queue: Track[];
  /** the whole queue's length; `queue` has only its first 100 */
  queueLength?: number;
  participants: string[];
  settings: SettingField[];
};

export type You = {
  capabilities: string[];
  admin: boolean;
  settings: SettingField[];
  /** whether they've linked a Jellyfin server, when the bot plays from Jellyfin */
  jellyfin?: boolean;
};

export type Result = {
  ok: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
};

/** A data message as Chime delivers it. */
export type DataMessage = {
  data: Uint8Array;
  senderAttendeeId: string;
  senderExternalUserId: string;
  throttled: boolean;
};

/** What the client knows of the bot. */
export type Presence =
  /** not in a huddle */
  | "offline"
  /** in a huddle, and the bot hasn't answered */
  | "waiting"
  /** the bot answered */
  | "connected"
  /** the bot speaks a protocol this client doesn't */
  | "incompatible";

type Payload = { v: number; type: string; [key: string]: unknown };

/** The Slack user behind a Chime external user id, `<prefix>-<call>-<user>` */
export function slackUserId(externalUserId: string | undefined) {
  const parts = (externalUserId ?? "").split("-");
  const userId = parts.length === 3 || parts.length === 4 ? parts[2] : "";
  return userId && /^[UW][A-Z0-9]+$/.test(userId) ? userId : undefined;
}

function requestId() {
  return Math.random().toString(36).slice(2, 10);
}

export class HuddleFMClient {
  readonly presence = new Store<Presence>("offline");
  readonly state = new Store<SessionState | undefined>(undefined);
  readonly you = new Store<You | undefined>(undefined);
  /** when the latest state arrived, by performance.now() */
  receivedAt = 0;
  /** the bot's Slack user, once it has sent state */
  botUserId: string | undefined;

  private send: ((data: Uint8Array) => void) | undefined;
  private pending = new Map<
    string,
    {
      resolve: (result: Result) => void;
      timer: ReturnType<typeof setTimeout>;
      /** the command's type, or the request's */
      type: string;
    }
  >();
  private chunks = new Map<
    string,
    { parts: string[]; timer: ReturnType<typeof setTimeout> }
  >();
  /** the attendee whose state is believed, the bot's */
  private botAttendee: string | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  /** when the bot was last heard, by performance.now() */
  private heardAt = 0;
  private watchTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    /** the user this client runs as, to pick out messages meant for them */
    private selfUserId: () => string | undefined,
    private log: (text: string) => void = () => {},
    /** the HuddleFM user the client mod knows, the only one believed then */
    private knownBot: () => string | undefined = () => undefined,
  ) {}

  /** The huddle's data channel opened, with a way to send on it. */
  connect(send: (data: Uint8Array) => void) {
    // another huddle's channel: nothing of the last session carries over
    this.forget();
    this.send = send;
    this.presence.set("waiting");
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => this.watch(), QUIET_MS / 2);
    this.sync();
  }

  /** The data channel closed. */
  disconnect() {
    this.send = undefined;
    clearInterval(this.watchTimer);
    this.forget();
    this.presence.set("offline");
  }

  private forget() {
    this.botAttendee = undefined;
    this.botUserId = undefined;
    clearTimeout(this.syncTimer);
    for (const { timer } of this.chunks.values()) clearTimeout(timer);
    this.chunks.clear();
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.resolve({ ok: false, error: "disconnected" });
      this.pending.delete(id);
    }
    this.state.set(undefined);
    this.you.set(undefined);
  }

  /**
   * A bot that crashed or was removed says nothing more, so a quiet one is
   * pinged, and one that stays quiet is gone.
   */
  private watch() {
    if (this.presence.get() !== "connected") return;
    const quiet = performance.now() - this.heardAt;
    if (quiet > GONE_MS) {
      this.log("HuddleFM stopped answering");
      this.closeSession();
    } else if (quiet > QUIET_MS) this.post({ type: "ping" });
  }

  /**
   * Whether a message is the bot's. Chime stamps each with its sender's
   * Slack user, so once the bot's user is known only it is believed; before
   * that, whoever sends state first is.
   */
  private fromBot({
    attendeeId,
    userId,
  }: {
    attendeeId: string;
    userId?: string;
  }) {
    const bot = this.botUserId ?? this.knownBot();
    if (bot) return userId === bot;
    return !this.botAttendee || attendeeId === this.botAttendee;
  }

  /** The playback position now, counting time since the state arrived. */
  position(now = performance.now()) {
    const state = this.state.get();
    if (!state) return 0;
    const { position, state: playback } = state.session;
    if (playback !== "playing") return position;
    const elapsed = (now - this.receivedAt) / 1000;
    const duration = state.nowPlaying?.duration;
    const at = position + elapsed;
    return duration ? Math.min(at, duration) : at;
  }

  /**
   * Seeks to `seconds`, showing it straight away rather than once the bot's
   * state follows, and going back if the bot refuses.
   */
  async seek(seconds: number): Promise<Result> {
    const before = this.state.get();
    if (!before) return { ok: false, error: "HuddleFM isn't playing." };
    const receivedAt = this.receivedAt;
    this.receivedAt = performance.now();
    this.state.set({
      ...before,
      session: { ...before.session, position: seconds },
    });
    const result = await this.command({ type: "seek", to: seconds });
    // unless a newer state has come since, the one before is still the truth
    if (!result.ok && this.state.get()?.seq === before.seq) {
      this.receivedAt = receivedAt;
      this.state.set(before);
    }
    return result;
  }

  /** Does what a player button or dialog does, as docs/data-channel.md lists them. */
  command(command: { type: string; [key: string]: unknown }) {
    return this.request({ type: "command", command });
  }

  /** Changes one setting, or applies a permission preset. */
  setting(setting: string, change: { value: unknown } | { preset: string }) {
    return this.request({ type: "setting", setting, ...change });
  }

  receive(message: DataMessage) {
    if (message.throttled) {
      this.log("Chime throttled a message this client sent");
      return;
    }
    let payload: Payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(message.data));
    } catch {
      return;
    }
    if (!payload || payload.v !== VERSION || typeof payload.type !== "string")
      return;
    const sender = {
      attendeeId: message.senderAttendeeId,
      userId: slackUserId(message.senderExternalUserId),
    };
    if (payload.type === "chunk") return this.receiveChunk(sender, payload);
    this.handle(sender, payload);
  }

  private handle(
    { attendeeId, userId }: { attendeeId: string; userId?: string },
    payload: Payload,
  ) {
    if (typeof payload.to === "string" && payload.to !== this.selfUserId())
      return;
    if (!this.fromBot({ attendeeId, userId })) return;
    this.heardAt = performance.now();
    switch (payload.type) {
      case "hello": {
        this.botAttendee = attendeeId;
        this.botUserId = userId;
        if (payload.protocol !== PROTOCOL) {
          this.log(`HuddleFM speaks protocol ${String(payload.protocol)}`);
          this.presence.set("incompatible");
          return;
        }
        // a bot that restarted counts its states from the start again
        this.state.set(undefined);
        this.you.set(undefined);
        this.presence.set("waiting");
        this.sync();
        return;
      }
      case "state": {
        const state = payload as unknown as SessionState;
        if (
          typeof state.seq !== "number" ||
          typeof state.session?.state !== "string"
        )
          return;
        this.botAttendee = attendeeId;
        this.botUserId = userId;
        const current = this.state.get();
        if (current && state.seq < current.seq) return;
        clearTimeout(this.syncTimer);
        // the bot's last word before it stops answering: the session is
        // over, or it's restarting and will say hello again
        if (
          state.session.state === "ended" ||
          state.session.state === "suspended"
        ) {
          this.closeSession();
          return;
        }
        this.receivedAt = performance.now();
        if (this.presence.get() !== "incompatible")
          this.presence.set("connected");
        this.state.set(state);
        return;
      }
      case "you": {
        const { capabilities, admin, settings, jellyfin } =
          payload as unknown as You;
        this.you.set({
          capabilities,
          admin,
          settings,
          ...(typeof jellyfin === "boolean" ? { jellyfin } : {}),
        });
        return;
      }
      case "result": {
        const id = String(payload.id);
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(id);
        const { v: _v, type: _type, to: _to, id: _id, ...result } = payload;
        request.resolve(result as Result);
        return;
      }
    }
  }

  /** Forgets the session the bot has left, and settles what was waiting. */
  private closeSession() {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      // ending it was the last thing the bot did, before it could answer
      request.resolve(
        request.type === "end"
          ? { ok: true }
          : { ok: false, error: "ended", message: "The session ended." },
      );
      this.pending.delete(id);
    }
    this.botAttendee = undefined;
    this.botUserId = undefined;
    this.state.set(undefined);
    this.you.set(undefined);
    if (this.send) this.presence.set("waiting");
  }

  private receiveChunk(
    sender: { attendeeId: string; userId?: string },
    payload: Payload,
  ) {
    const { id, i, n, data } = payload;
    if (
      typeof id !== "string" ||
      typeof i !== "number" ||
      typeof n !== "number" ||
      typeof data !== "string" ||
      i < 0 ||
      i >= n ||
      n > 64
    )
      return;
    // only the bot's are put together, so no one else can make clients wait
    if (!this.fromBot(sender)) return;
    const key = `${sender.attendeeId}/${id}`;
    let entry = this.chunks.get(key);
    if (!entry) {
      entry = {
        parts: new Array(n),
        timer: setTimeout(() => {
          this.chunks.delete(key);
          this.log("A message from HuddleFM arrived incomplete");
          this.sync();
        }, CHUNK_TIMEOUT_MS),
      };
      this.chunks.set(key, entry);
    }
    entry.parts[i] = data;
    for (let index = 0; index < n; index++)
      if (entry.parts[index] === undefined) return;
    clearTimeout(entry.timer);
    this.chunks.delete(key);
    try {
      const whole = JSON.parse(entry.parts.join(""));
      if (whole?.v === VERSION && typeof whole.type === "string")
        this.handle(sender, whole);
    } catch {}
  }

  /** Asks the bot for the session, again a few times while it doesn't answer. */
  private sync(attempt = 0) {
    clearTimeout(this.syncTimer);
    if (!this.post({ type: "sync" })) return;
    if (attempt + 1 >= SYNC_RETRIES) return;
    this.syncTimer = setTimeout(() => {
      if (this.presence.get() === "waiting") this.sync(attempt + 1);
    }, SYNC_RETRY_MS);
  }

  private request(body: Record<string, unknown>): Promise<Result> {
    const id = requestId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: "timeout",
          message: "HuddleFM didn't answer.",
        });
      }, REQUEST_TIMEOUT_MS);
      const command = body.command as { type?: unknown } | undefined;
      this.pending.set(id, {
        resolve,
        timer,
        type: String(command?.type ?? body.type),
      });
      if (!this.post({ ...body, id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          ok: false,
          error: "offline",
          message: "Not connected to the huddle.",
        });
      }
    });
  }

  private post(payload: Record<string, unknown>) {
    if (!this.send) return false;
    const data = new TextEncoder().encode(
      JSON.stringify({ ...payload, v: VERSION }),
    );
    if (data.length > MAX_BYTES) {
      this.log(`Couldn't send ${String(payload.type)}: it's too large`);
      return false;
    }
    try {
      this.send(data);
      return true;
    } catch (err) {
      this.log(`Couldn't send ${String(payload.type)}: ${err}`);
      return false;
    }
  }
}
