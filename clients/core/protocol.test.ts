import { describe, expect, test } from "bun:test";
import { encodeMessages } from "../../src/native-media/data-channel.ts";
import { seal, sealingKeys, sharedKey } from "../../src/plugin-seal.ts";
import { HuddleFMClient, type DataMessage } from "./protocol.ts";

const self = "U0SELF";
const bot = { attendee: "bot-attendee", external: "slack-R1-U0BOT" };

function client() {
  const sent: Record<string, unknown>[] = [];
  const huddlefm = new HuddleFMClient(() => self, undefined, undefined, {
    seal: false,
  });
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
    // the clock's times are fractions, so a few digits along it rounds
    expect(huddlefm.position(at + 5_000)).toBeCloseTo(15, 6);
    expect(huddlefm.position(at + 60_000)).toBe(30);
  });

  test("shows a seek straight away, until the bot's state follows", async () => {
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
    expect(request.command).toEqual({ type: "seek", to: 120 });
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

  test("once it knows the bot, no one else can speak for it", () => {
    const { huddlefm, receive } = client();
    receive(state(1));
    const impostor = { attendee: "someone", external: "slack-R1-U0OTHER" };
    receive({ type: "hello", protocol: 1 }, impostor);
    receive(state(9), impostor);
    expect(huddlefm.state.get()?.seq).toBe(1);
    expect(huddlefm.botUserId).toBe("U0BOT");
    // the bot itself, back as another attendee, is still believed
    receive(state(2), { attendee: "bot-again", external: bot.external });
    expect(huddlefm.state.get()?.seq).toBe(2);
  });

  test("believes only the HuddleFM the client mod knows", () => {
    const sent: unknown[] = [];
    const huddlefm = new HuddleFMClient(
      () => self,
      () => {},
      () => "U0BOT",
    );
    huddlefm.connect((data) => sent.push(data));
    for (const message of encodeMessages(state(1), "x"))
      huddlefm.receive({
        data: message,
        senderAttendeeId: "someone",
        senderExternalUserId: "slack-R1-U0OTHER",
        throttled: false,
      });
    expect(huddlefm.state.get()).toBeUndefined();
  });

  test("a new channel forgets the last huddle's session", () => {
    const { huddlefm, receive } = client();
    receive(state(5));
    huddlefm.connect(() => {});
    expect(huddlefm.state.get()).toBeUndefined();
    expect(huddlefm.botUserId).toBeUndefined();
    expect(huddlefm.presence.get()).toBe("waiting");
  });

  test("says when the bot speaks another protocol", () => {
    const { huddlefm, receive } = client();
    receive({ type: "hello", protocol: 2, features: [] });
    expect(huddlefm.presence.get()).toBe("incompatible");
  });

  test("sends its key with sync, and opens what's sealed for it", async () => {
    const sent: Record<string, any>[] = [];
    const huddlefm = new HuddleFMClient(() => self);
    huddlefm.connect((data) =>
      sent.push(JSON.parse(new TextDecoder().decode(data))),
    );
    for (let i = 0; i < 50 && !sent.length; i++) await Bun.sleep(5);
    // read before matching it, which puts the matcher in its place
    const clientKey = sent[0]?.key;
    expect(sent[0]).toMatchObject({ type: "sync", key: expect.any(String) });
    const bot = await sealingKeys();
    const key = (await sharedKey(bot.privateKey, clientKey)) as CryptoKey;
    const deliver = async (payload: Record<string, unknown>, to = self) => {
      for (const data of encodeMessages(
        {
          type: "sealed",
          to,
          key: bot.publicKey,
          ...(await seal(key, { v: 1, ...payload })),
        },
        String(Math.random()),
      ))
        huddlefm.receive({
          data,
          senderAttendeeId: "bot-attendee",
          senderExternalUserId: "slack-R1-U0BOT",
          throttled: false,
        });
      await Bun.sleep(10);
    };
    const you = { capabilities: ["add"], admin: false, settings: [] };
    // sealed for someone else's user, inside: ignored
    await deliver({ type: "you", to: "U0OTHER", ...you });
    expect(huddlefm.you.get()).toBeUndefined();
    await deliver({ type: "you", to: self, ...you });
    expect(huddlefm.you.get()).toEqual(you);
  });
});
