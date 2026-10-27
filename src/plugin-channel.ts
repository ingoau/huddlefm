import { mapAgentError } from "./integration.ts";

/*
 * The bot's half of the data channel protocol in docs/data-channel.md, which
 * client mods like the Taut plugin speak: it answers each user's requests and
 * keeps everyone's copy of the session up to date. The session itself is the
 * host's, behind a small interface, so this stays testable.
 */

/**
 * The bot API commands a client may run, as docs/data-channel.md lists, and
 * `claim_host`, which only clients have.
 */
export const pluginCommandTypes = [
  "search",
  "add",
  "remove",
  "move",
  "shuffle",
  "clear",
  "skip",
  "previous",
  "toggle",
  "pause",
  "resume",
  "seek",
  "volume",
  "end",
  "claim_host",
] as const;

export type PluginCommand = {
  type: (typeof pluginCommandTypes)[number];
  [field: string]: unknown;
};

/** A setting change: a field's new value, or a preset for `permissions`. */
export type PluginSettingChange = { value?: unknown; preset?: string };

/** What an `agent*` method returns. */
export type AgentResult = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

export interface PluginHost {
  /** The session as `state` carries it, without `seq`. */
  snapshot(): Record<string, unknown>;
  /** What a user may do, and their own settings, as `you` carries them. */
  you(userId: string): Promise<Record<string, unknown>>;
  command(userId: string, command: PluginCommand): Promise<AgentResult>;
  setting(
    userId: string,
    setting: string,
    change: PluginSettingChange,
  ): Promise<AgentResult>;
  /** Broadcasts a message on the data channel. */
  send(payload: Record<string, unknown>): void;
}

export type PluginChannelOptions = {
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

/** The least time between two `state` broadcasts. */
const stateIntervalMs = 250;
/** How many messages each user may send in `rateWindowMs`. */
const rateLimit = 10;
const rateWindowMs = 1_000;
const maxIdLength = 64;
const commandTypes = new Set<string>(pluginCommandTypes);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= maxIdLength;
}

/** An `agent*` result as a `result` message's body, like the bot API's. */
export function resultBody(result: AgentResult) {
  if (!result.ok) {
    const message = String(result.error ?? "failed");
    return { ok: false, error: mapAgentError(message), message };
  }
  const { ok: _ok, ...rest } = result;
  return { ok: true, ...rest };
}

export class PluginChannel {
  private seq = 0;
  private lastState = -Infinity;
  private stateTimer: unknown;
  // Users who have synced, so the ones to tell when what they may do changes.
  private users = new Set<string>();
  private recent = new Map<string, number[]>();
  private closed = false;
  private now: () => number;
  private setTimer: (run: () => void, ms: number) => unknown;
  private clearTimer: (timer: unknown) => void;
  private log: (event: string, fields: Record<string, unknown>) => void;

  constructor(
    private host: PluginHost,
    options: PluginChannelOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer =
      options.clearTimer ??
      ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.log = options.log ?? (() => {});
  }

  /** Whether any client has synced, so whether `state` is worth sending. */
  get active() {
    return this.users.size > 0;
  }

  /** A message from the media process: `{ userId, attendeeId, payload }`. */
  receive(details: unknown) {
    if (this.closed || !isRecord(details)) return;
    const { userId, payload } = details;
    if (typeof userId !== "string" || !isRecord(payload)) return;
    const type = payload.type;
    if (type !== "sync" && type !== "command" && type !== "setting") return;
    if (!this.allow(userId)) {
      this.log("plugin_message_dropped", { userId, messageType: type });
      return;
    }
    if (type === "sync") return this.sync(userId);
    if (!validId(payload.id)) return;
    if (type === "command") return this.command(userId, payload.id, payload);
    return this.setting(userId, payload.id, payload);
  }

  /** Schedules a `state` broadcast, merging changes close together. */
  changed() {
    if (this.closed || !this.active || this.stateTimer !== undefined) return;
    const wait = Math.max(0, this.lastState + stateIntervalMs - this.now());
    this.stateTimer = this.setTimer(() => {
      this.stateTimer = undefined;
      this.sendState();
    }, wait);
  }

  /** Tells every synced user what they may do now, after a change to it. */
  refreshYou() {
    for (const userId of this.users) void this.sendYou(userId);
  }

  /**
   * Tells one user what they may do now, if they synced: joining or leaving
   * the huddle changes it, and a client often syncs before the bot sees it
   * join.
   */
  refreshYouFor(userId: string) {
    if (this.users.has(userId)) void this.sendYou(userId);
  }

  /** Sends the last `state` now, if anyone is listening, and stops. */
  finish() {
    if (this.closed) return;
    if (this.stateTimer !== undefined) this.clearTimer(this.stateTimer);
    this.stateTimer = undefined;
    if (this.active) this.sendState();
    this.close();
  }

  /** Stops answering, as when the session ends. */
  close() {
    this.closed = true;
    if (this.stateTimer !== undefined) this.clearTimer(this.stateTimer);
    this.stateTimer = undefined;
  }

  private allow(userId: string) {
    const now = this.now();
    const times = (this.recent.get(userId) ?? []).filter(
      (at) => now - at < rateWindowMs,
    );
    if (times.length >= rateLimit) {
      this.recent.set(userId, times);
      return false;
    }
    times.push(now);
    this.recent.set(userId, times);
    return true;
  }

  private sync(userId: string) {
    this.users.add(userId);
    this.changed();
    void this.sendYou(userId);
  }

  private sendState() {
    if (this.closed) return;
    this.lastState = this.now();
    try {
      this.host.send({
        type: "state",
        seq: ++this.seq,
        ...this.host.snapshot(),
      });
    } catch (error) {
      this.log("plugin_state_failed", { err: error });
    }
  }

  private async sendYou(userId: string) {
    try {
      const you = await this.host.you(userId);
      if (!this.closed) this.host.send({ type: "you", to: userId, ...you });
    } catch (error) {
      this.log("plugin_you_failed", { userId, err: error });
    }
  }

  private async command(
    userId: string,
    id: string,
    payload: Record<string, unknown>,
  ) {
    const command = payload.command;
    if (
      !isRecord(command) ||
      typeof command.type !== "string" ||
      !commandTypes.has(command.type)
    )
      return this.reply(userId, id, {
        ok: false,
        error: "unknown_type",
        message: "That command is not available here.",
      });
    await this.answer(userId, id, { command: command.type }, () =>
      this.host.command(userId, command as PluginCommand),
    );
  }

  private async setting(
    userId: string,
    id: string,
    payload: Record<string, unknown>,
  ) {
    const { setting, value, preset } = payload;
    if (
      typeof setting !== "string" ||
      (value === undefined && typeof preset !== "string")
    )
      return this.reply(userId, id, {
        ok: false,
        error: "invalid",
        message: "Name a setting and its new value.",
      });
    const ok = await this.answer(userId, id, { setting }, () =>
      this.host.setting(
        userId,
        setting,
        typeof preset === "string" ? { preset } : { value },
      ),
    );
    // Their own settings are only in `you`.
    if (ok) await this.sendYou(userId);
  }

  private async answer(
    userId: string,
    id: string,
    about: Record<string, unknown>,
    run: () => Promise<AgentResult>,
  ) {
    let result: AgentResult;
    try {
      result = await run();
    } catch (error) {
      this.log("plugin_request_failed", { userId, err: error });
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.reply(userId, id, { ...about, ...resultBody(result) });
    return result.ok;
  }

  private reply(userId: string, id: string, body: Record<string, unknown>) {
    if (this.closed) return;
    this.host.send({ type: "result", to: userId, id, ...body });
  }
}
