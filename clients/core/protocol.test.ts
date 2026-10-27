import { describe, expect, test } from "bun:test";
import { encodeMessages } from "../../src/native-media/data-channel.ts";
import { HuddleFMClient, type DataMessage } from "./protocol.ts";

const self = "U0SELF";
const bot = { attendee: "bot-attendee", external: "slack-R1-U0BOT" };

function client() {
  const sent: Record<string, unknown>[] = [];
  const huddlefm = new HuddleFMClient(() => self);
  huddlefm.connect((data) =>
    sent.push(JSON.parse(new TextDecoder().decode(data))),
  );
  const from = (
    payload: Record<string, unknown>,
    sender = bot,
  ): DataMessage[] =>
    encodeMessages(payload, String(Math.random())).map((data) => ({
      data,
      senderAttendeeId: sender.attendee,
      senderExternalUserId: sender.external,
      throttled: false,
    }));
  const receive = (payload: Record<string, unknown>, sender = bot) => {
    for (const message of from(payload, sender)) huddlefm.receive(message);
  };
  return { huddlefm, sent, from, receive };
}

const state = (seq: number, extra: Record<string, unknown> = {}) => ({
  type: "state",
  seq,
  session: { id: "s", state: "paused", position: 12, volume: 50 },
  nowPlaying: null,
  queue: [],
  participants: [self],
  settings: [],
  ...extra,
});

describe("HuddleFM client", () => {
  test("syncs on connect and takes the bot's state", () => {
    const { huddlefm, sent, receive } = client();
    expect(sent).toEqual([{ type: "sync", v: 1 }]);
    expect(huddlefm.presence.get()).toBe("waiting");
    receive(state(3));
    expect(huddlefm.presence.get()).toBe("connected");
    expect(huddlefm.state.get()?.seq).toBe(3);
    expect(huddlefm.botUserId).toBe("U0BOT");
    receive(state(2));
    expect(huddlefm.state.get()?.seq).toBe(3);
  });

  test("puts a chunked state back together, in any order", () => {
    const { huddlefm, from } = client();
    const queue = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      title: `Song ${i} ✨`,
      artist: "Someone",
    }));
    const messages = from(state(1, { queue }));
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages.reverse()) huddlefm.receive(message);
    expect(huddlefm.state.get()?.queue).toHaveLength(40);
  });

  test("believes only the bot, and only what's meant for this user", () => {
    const { huddlefm, receive } = client();
    receive(state(1));
    receive(state(9), { attendee: "someone", external: "slack-R1-U0OTHER" });
    expect(huddlefm.state.get()?.seq).toBe(1);
    receive({
      type: "you",
      to: "U0OTHER",
      capabilities: ["skip"],
      admin: true,
      settings: [],
    });
    expect(huddlefm.you.get()).toBeUndefined();
    receive({
      type: "you",
      to: self,
      capabilities: [],
      admin: false,
      settings: [],
    });
    expect(huddlefm.you.get()?.admin).toBe(false);
  });

  test("answers a command with the result for its id", async () => {
    const { huddlefm, sent, receive } = client();
    const pending = huddlefm.command({ type: "skip" });
    const request = sent.at(-1) as { id: string; command: unknown };
    expect(request.command).toEqual({ type: "skip" });
    receive({ type: "result", to: self, id: "other", ok: false });
    receive({
      type: "result",
      to: self,
      id: request.id,
      ok: true,
      command: "skip",
    });
    expect(await pending).toEqual({ ok: true, command: "skip" });
  });

  test("runs the clock on while playing, and stops at the end", () => {
    const { huddlefm, receive } = client();
    receive(
      state(1, {
        session: { id: "s", state: "playing", position: 10, volume: 50 },
        nowPlaying: { id: "t", title: "T", duration: 30 },
      }),
    );
    const at = huddlefm.receivedAt;
    expect(huddlefm.position(at + 5_000)).toBe(15);
    expect(huddlefm.position(at + 60_000)).toBe(30);
  });

  test("shows a seek straight away, by an offset, until the bot's state follows", async () => {
    const { huddlefm, sent, receive } = client();
    receive(
      state(1, {
        session: { id: "s", state: "paused", position: 10, volume: 50 },
        nowPlaying: { id: "t", title: "T", duration: 300 },
      }),
    );
    const seeking = huddlefm.seek(120);
    expect(huddlefm.position()).toBe(120);
    const request = sent.at(-1) as { id: string; command: unknown };
    expect(request.command).toEqual({ type: "seek", seconds: 110 });
    receive(
      state(2, {
        session: { id: "s", state: "paused", position: 121, volume: 50 },
      }),
    );
    receive({ type: "result", to: self, id: request.id, ok: true });
    await seeking;
    expect(huddlefm.position()).toBe(121);
  });

  test("goes back when the bot refuses a seek", async () => {
    const { huddlefm, sent, receive } = client();
    receive(
      state(1, {
        session: { id: "s", state: "paused", position: 10, volume: 50 },
        nowPlaying: { id: "t", title: "T", duration: 300 },
      }),
    );
    const seeking = huddlefm.seek(200);
    expect(huddlefm.position()).toBe(200);
    const request = sent.at(-1) as { id: string };
    receive({
      type: "result",
      to: self,
      id: request.id,
      ok: false,
      error: "No.",
    });
    expect((await seeking).ok).toBe(false);
    expect(huddlefm.position()).toBe(10);
  });

  test("forgets the session when the huddle's channel closes", async () => {
    const { huddlefm, receive } = client();
    receive(state(1));
    const pending = huddlefm.command({ type: "skip" });
    huddlefm.disconnect();
    expect(huddlefm.state.get()).toBeUndefined();
    expect(huddlefm.presence.get()).toBe("offline");
    expect((await pending).ok).toBe(false);
  });

  test("ending the session settles the end, and forgets the session", async () => {
    const { huddlefm, receive } = client();
    receive(state(1));
    const ending = huddlefm.command({ type: "end" });
    const skipping = huddlefm.command({ type: "skip" });
    receive(
      state(2, {
        session: { id: "s", state: "ended", position: 0, volume: 50 },
      }),
    );
    expect(await ending).toEqual({ ok: true });
    expect((await skipping).ok).toBe(false);
    expect(huddlefm.state.get()).toBeUndefined();
    expect(huddlefm.presence.get()).toBe("waiting");
  });

  test("says when the bot speaks another protocol", () => {
    const { huddlefm, receive } = client();
    receive({ type: "hello", protocol: 2, features: [] });
    expect(huddlefm.presence.get()).toBe("incompatible");
  });
});
