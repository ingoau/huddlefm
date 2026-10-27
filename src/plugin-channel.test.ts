import { describe, expect, test } from "bun:test";
import {
  PluginChannel,
  type AgentResult,
  type PluginCommand,
  type PluginHost,
  type PluginSettingChange,
} from "./plugin-channel.ts";

const user = "U0456DEF";

function setup() {
  let now = 1_000;
  const timers: { at: number; run: () => void }[] = [];
  const sent: Record<string, any>[] = [];
  const commands: [string, PluginCommand][] = [];
  const settings: [string, string, PluginSettingChange][] = [];
  let snapshots = 0;
  let commandResult: AgentResult = { ok: true, state: "paused" };
  const host: PluginHost = {
    snapshot: () => ({ session: { id: "s", n: ++snapshots } }),
    you: async (userId) => ({
      capabilities: ["add"],
      admin: false,
      for: userId,
    }),
    command: async (userId, command) => {
      commands.push([userId, command]);
      return commandResult;
    },
    setting: async (userId, setting, change) => {
      settings.push([userId, setting, change]);
      return setting === "nope"
        ? { ok: false, error: "You do not have permission for that." }
        : { ok: true, changed: [setting] };
    },
    send: (payload) => sent.push(payload),
  };
  const channel = new PluginChannel(host, {
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter((timer) => timer.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
    await Bun.sleep(0);
  };
  const receive = async (payload: Record<string, unknown>, from = user) => {
    channel.receive({
      userId: from,
      attendeeId: "a",
      payload: { v: 1, ...payload },
    });
    await Bun.sleep(0);
  };
  return {
    channel,
    sent,
    commands,
    settings,
    advance,
    receive,
    setResult: (result: AgentResult) => (commandResult = result),
  };
}

describe("plugin channel", () => {
  test("sends nothing until a client syncs, then state and its you", async () => {
    const { channel, sent, advance, receive } = setup();
    channel.changed();
    await advance(1_000);
    expect(sent).toEqual([]);
    await receive({ type: "sync" });
    await advance(0);
    expect(sent).toEqual([
      { type: "you", to: user, capabilities: ["add"], admin: false, for: user },
      { type: "state", seq: 1, session: { id: "s", n: 1 } },
    ]);
  });

  test("merges changes into a state at most every 250 ms", async () => {
    const { channel, sent, advance, receive } = setup();
    await receive({ type: "sync" });
    await advance(0);
    sent.length = 0;
    channel.changed();
    channel.changed();
    await advance(100);
    expect(sent).toEqual([]);
    channel.changed();
    await advance(150);
    expect(sent.map((message) => [message.type, message.seq])).toEqual([
      ["state", 2],
    ]);
    channel.changed();
    await advance(250);
    expect(sent.map((message) => message.seq)).toEqual([2, 3]);
  });

  test("runs an allowed command and answers with its result", async () => {
    const { sent, commands, receive } = setup();
    await receive({ type: "command", id: "r1", command: { type: "toggle" } });
    expect(commands).toEqual([[user, { type: "toggle" }]]);
    expect(sent).toEqual([
      {
        type: "result",
        to: user,
        id: "r1",
        command: "toggle",
        ok: true,
        state: "paused",
      },
    ]);
  });

  test("answers a failed command with the bot API's error", async () => {
    const { sent, receive, setResult } = setup();
    setResult({ ok: false, error: "You do not have permission for that." });
    await receive({ type: "command", id: "r1", command: { type: "skip" } });
    expect(sent).toEqual([
      {
        type: "result",
        to: user,
        id: "r1",
        command: "skip",
        ok: false,
        error: "missing_permission",
        message: "You do not have permission for that.",
      },
    ]);
  });

  test("refuses commands outside the list, and drops bad ids", async () => {
    const { sent, commands, receive } = setup();
    await receive({
      type: "command",
      id: "r1",
      command: { type: "request_control" },
    });
    await receive({
      type: "command",
      id: "x".repeat(65),
      command: { type: "skip" },
    });
    await receive({ type: "command", command: { type: "skip" } });
    expect(commands).toEqual([]);
    expect(sent).toEqual([
      {
        type: "result",
        to: user,
        id: "r1",
        ok: false,
        error: "unknown_type",
        message: "That command is not available here.",
      },
    ]);
  });

  test("changes a setting, a preset, and sends you after", async () => {
    const { sent, settings, receive } = setup();
    await receive({
      type: "setting",
      id: "r1",
      setting: "loop",
      value: "queue",
    });
    await receive({
      type: "setting",
      id: "r2",
      setting: "permissions",
      preset: "collaborative",
    });
    expect(settings).toEqual([
      [user, "loop", { value: "queue" }],
      [user, "permissions", { preset: "collaborative" }],
    ]);
    expect(sent.map((message) => [message.type, message.id])).toEqual([
      ["result", "r1"],
      ["you", undefined],
      ["result", "r2"],
      ["you", undefined],
    ]);
    expect(sent[0]).toEqual({
      type: "result",
      to: user,
      id: "r1",
      setting: "loop",
      ok: true,
      changed: ["loop"],
    });
  });

  test("a refused setting sends no you", async () => {
    const { sent, receive } = setup();
    await receive({ type: "setting", id: "r1", setting: "nope", value: 1 });
    await receive({ type: "setting", id: "r2", setting: "loop" });
    expect(
      sent.map((message) => [message.type, message.ok, message.error]),
    ).toEqual([
      ["result", false, "missing_permission"],
      ["result", false, "invalid"],
    ]);
  });

  test("lets each user send 10 messages a second", async () => {
    const { commands, advance, receive } = setup();
    for (let i = 0; i < 12; i++)
      await receive({
        type: "command",
        id: `r${i}`,
        command: { type: "skip" },
      });
    await receive(
      { type: "command", id: "other", command: { type: "skip" } },
      "U999",
    );
    expect(commands.length).toBe(11);
    await advance(1_000);
    await receive({ type: "command", id: "later", command: { type: "skip" } });
    expect(commands.length).toBe(12);
  });

  test("tells every synced user when what they may do changes", async () => {
    const { channel, sent, receive } = setup();
    await receive({ type: "sync" });
    await receive({ type: "sync" }, "U999");
    sent.length = 0;
    channel.refreshYou();
    await Bun.sleep(0);
    expect(
      sent.filter((message) => message.type === "you").map((m) => m.to),
    ).toEqual([user, "U999"]);
  });

  test("tells a synced user what they may do once they join", async () => {
    const { channel, sent, receive } = setup();
    await receive({ type: "sync" });
    sent.length = 0;
    channel.refreshYouFor("U999");
    channel.refreshYouFor(user);
    await Bun.sleep(0);
    expect(
      sent.filter((message) => message.type === "you").map((m) => m.to),
    ).toEqual([user]);
  });

  test("ignores other messages, and finishes with a last state", async () => {
    const { channel, sent, advance, receive } = setup();
    await receive({ type: "hello" });
    await receive({ type: "chunk", id: "1", i: 0, n: 1, data: "{}" });
    channel.receive("not a message");
    expect(sent).toEqual([]);
    await receive({ type: "sync" });
    channel.finish();
    expect(sent.at(-1)).toMatchObject({ type: "state" });
    const count = sent.length;
    channel.changed();
    await receive({ type: "sync" });
    await advance(1_000);
    expect(sent.length).toBe(count);
  });
});
