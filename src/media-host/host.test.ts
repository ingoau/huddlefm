import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChimeBootstrap } from "../slack-huddle.ts";
import {
  NativeMediaSession,
  type MediaMessage,
} from "../native-media/session.ts";
import { MediaHostClient } from "./client.ts";
import { MediaHost, type HostedChild } from "./host.ts";
import { mediaHostProtocol } from "./protocol.ts";

type FakeChild = HostedChild & {
  written: string[];
  ended: boolean;
  say(message: unknown): void;
};

function fakeChild(): FakeChild {
  const exited = Promise.withResolvers<number | null>();
  let onLine: (line: string) => void = () => {};
  const child: FakeChild = {
    written: [],
    ended: false,
    write(line) {
      child.written.push(line);
      return true;
    },
    async end() {
      child.ended = true;
      exited.resolve(0);
    },
    exited: exited.promise,
    read(line) {
      onLine = line;
    },
    say(message) {
      onLine(JSON.stringify(message));
    },
  };
  return child;
}

function bootstrap(sessionId = "media-1"): ChimeBootstrap {
  return {
    sessionId,
    meeting: {},
    attendee: {},
    initialVolume: 0.5,
    duckingMode: "off",
    lyricsOffsetMs: 0,
    bridgeToken: "token",
  };
}

async function until(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await Bun.sleep(5);
  }
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

async function setup(orphanMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), "huddlefm-host-"));
  const children: FakeChild[] = [];
  const host = new MediaHost(directory, {
    proxy: false,
    orphanMs,
    spawn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  await host.listen();
  cleanup.push(async () => {
    await host.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const client = new MediaHostClient(directory, 3210);
  const session = (messages: MediaMessage[]) =>
    new NativeMediaSession(
      (message) => messages.push(message),
      () => undefined,
      client,
    );
  return { host, client, children, session };
}

describe("media host", () => {
  test("runs a media process for the app, both ways", async () => {
    const { client, children, session } = await setup();
    const messages: MediaMessage[] = [];
    const media = session(messages);
    await media.start(bootstrap());
    await until(() => children[0]?.written.length === 1);
    const child = children[0]!;
    expect(JSON.parse(child.written[0]!)).toEqual({
      type: "bootstrap",
      payload: bootstrap(),
    });
    media.send({ type: "pause" });
    await until(() => child.written.length === 2);
    expect(JSON.parse(child.written[1]!)).toEqual({ type: "pause" });
    child.say({ type: "joined", sessionId: "media-1" });
    await until(() => messages.length === 1);
    expect(messages[0]).toMatchObject({ type: "joined" });
    expect(media.tag({ owner: "session-1" })).toBe(true);
    await Bun.sleep(20);
    const listed = await client.list();
    expect(listed.sessions).toEqual([
      {
        sessionId: "media-1",
        bootstrap: bootstrap(),
        tag: { owner: "session-1" },
        attached: true,
      },
    ]);
    await media.close();
    expect(child.ended).toBe(true);
  });

  test("keeps the media playing while the app is away, and replays what it said", async () => {
    const { client, children, session } = await setup();
    const first = session([]);
    await first.start(bootstrap());
    await until(() => children.length === 1);
    const child = children[0]!;
    expect(await first.detach()).toBe(true);
    expect(child.ended).toBe(false);
    await Bun.sleep(20);
    expect((await client.list()).sessions[0]?.attached).toBe(false);
    const position = (seconds: number) => ({
      type: "playback_position",
      details: { entryId: "a", seconds },
      sessionId: "media-1",
    });
    child.say(position(1));
    child.say(position(2));
    child.say({
      type: "track_ended",
      details: { entryId: "a" },
      sessionId: "media-1",
    });
    child.say(position(3));
    child.say({ log: { level: "info", event: "x", message: "logged here" } });

    const messages: MediaMessage[] = [];
    const second = session(messages);
    expect(await second.attach("media-1")).toBe(true);
    await until(() => messages.length === 2);
    expect(messages.map((message) => message.type)).toEqual([
      "track_ended",
      "playback_position",
    ]);
    expect(messages[1]?.details).toEqual({ entryId: "a", seconds: 3 });
    second.send({ type: "status" });
    await until(() => child.written.length === 2);
    expect(JSON.parse(child.written[1]!)).toEqual({ type: "status" });
    await second.close();
  });

  test("holds what the media says from a hold on, for the next app", async () => {
    const { children, session } = await setup();
    const messages: MediaMessage[] = [];
    const first = session(messages);
    await first.start(bootstrap());
    await until(() => children.length === 1);
    const child = children[0]!;
    first.hold();
    await Bun.sleep(20);
    child.say({ type: "track_ended", details: { entryId: "a" } });
    // Messages still reach the media while held.
    first.send({ type: "pause" });
    await until(() => child.written.length === 2);
    await first.detach();
    expect(messages).toEqual([]);
    const replayed: MediaMessage[] = [];
    expect(await session(replayed).attach("media-1")).toBe(true);
    await until(() => replayed.length === 1);
    expect(replayed[0]).toMatchObject({ type: "track_ended" });
  });

  test("answers missing for media that ended while the app was away", async () => {
    const { children, session } = await setup();
    const first = session([]);
    await first.start(bootstrap());
    await until(() => children.length === 1);
    await first.detach();
    await children[0]!.end();
    await Bun.sleep(20);
    expect(await session([]).attach("media-1")).toBe(false);
  });

  test("leaves the huddle when no app attaches in time", async () => {
    const { children, session } = await setup(50);
    const first = session([]);
    await first.start(bootstrap());
    await until(() => children.length === 1);
    await first.detach();
    await until(() => children[0]!.ended);
  });

  test("reports a lost media process as the session ending", async () => {
    const { children, session } = await setup();
    const messages: MediaMessage[] = [];
    const media = session(messages);
    await media.start(bootstrap());
    await until(() => children.length === 1);
    await children[0]!.end();
    await until(() => messages.length === 1);
    expect(messages[0]).toMatchObject({ type: "ended", sessionId: "media-1" });
  });

  test("closes a media process for a control connection", async () => {
    const { client, children, session } = await setup();
    const media = session([]);
    await media.start(bootstrap());
    await until(() => children.length === 1);
    await media.detach();
    await client.closeSession("media-1");
    expect(children[0]!.ended).toBe(true);
  });

  test("refuses another protocol", async () => {
    const { client } = await setup();
    await expect(
      client.request({ host: "list", protocol: mediaHostProtocol + 1 }),
    ).rejects.toThrow(/protocol/);
  });
});
