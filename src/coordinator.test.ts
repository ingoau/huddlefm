import { expect, test } from "bun:test";
import { Coordinator } from "./coordinator.ts";
import type { SlackAppAdapter } from "./slack-app.ts";
import type { Store } from "./store.ts";
import type { TrackCatalog } from "./tracks.ts";

function setup(tracks = {} as TrackCatalog) {
  const posted: unknown[] = [];
  const ephemeral: string[] = [];
  const sessions: unknown[] = [];
  const permissions: unknown[] = [];
  const media: unknown[] = [];
  let post = 0;
  const slack = {
    post: async (...args: unknown[]) => (posted.push(args), String(++post)),
    update: async () => {},
    delete: async () => {},
    ephemeral: async (_channel: string, _user: string, text: string) => { ephemeral.push(text); },
    modal: async () => {},
  } as unknown as SlackAppAdapter;
  const store = {
    createSession: () => {}, setUi: () => {}, setTrack: () => {}, removeTrack: () => {},
    addTrack: () => {},
    setSession: (_id: string, value: unknown) => { sessions.push(value); },
    setPermission: (_id: string, capability: string, allowed: boolean) => { permissions.push({ capability, allowed }); },
  } as unknown as Store;
  const coordinator = new Coordinator({
    huddleCallId: "call", huddleId: "huddle", huddleCreatorId: "creator",
    participantIds: ["host", "guest"], uiChannelId: "channel", uiThreadTs: "1.0",
    chimeMeeting: {}, chimeAttendee: {},
  }, "host", "bot", slack, store, tracks, {
    queueLimit: 50, initialVolume: 0.6, idleMs: 60_000, port: 3210, managerUserId: "manager",
  }, "token", message => media.push(message), async () => {});
  return { coordinator, posted, ephemeral, sessions, permissions, media };
}

test("a Next click during first-track preparation does not skip it", async () => {
  let finish!: (path: string) => void;
  const prepared = new Promise<string>(resolve => { finish = resolve; });
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/track", canonicalUrl: "https://example.com/track",
      sourceId: "track", title: "Track", artist: "Artist",
    }),
    prepare: () => prepared,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  const add = result.coordinator.action({
    type: "block_actions", userId: "host", actionId: "add_track_to_queue", value: "ref",
    channelId: "channel", messageTs: "1", triggerId: "", metadata: "", state: {},
  });
  await Bun.sleep(0);
  const next = result.coordinator.action({
    type: "block_actions", userId: "host", actionId: "next_track", value: "",
    channelId: "channel", messageTs: "1", triggerId: "", metadata: "", state: {},
  });
  finish("track.opus");
  await Promise.all([add, next]);
  expect(result.media).toContainEqual(expect.objectContaining({ type: "play" }));
  expect(result.media).not.toContainEqual({ type: "stop" });
  expect(result.ephemeral).toContain("Nothing was playing when you pressed Next.");
  await result.coordinator.endFromSlack();
});

test("rejects stale player actions", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.action({
    type: "block_actions", userId: "host", actionId: "volume_up", value: "",
    channelId: "channel", messageTs: "stale", triggerId: "", metadata: "", state: {},
  });
  expect(test.ephemeral).toEqual(["That player is stale; use the newest one."]);
  expect(test.media).toEqual([]);
  await test.coordinator.endFromSlack();
});

test("first current participant claims a vacant host role", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.memberLeft("host");
  expect(test.posted).toHaveLength(1);
  await test.coordinator.action({
    type: "block_actions", userId: "guest", actionId: "claim_host", value: "old-session",
    channelId: "channel", messageTs: "1", triggerId: "", metadata: "", state: {},
  });
  expect(test.ephemeral).toContain("That takeover request is stale.");
  await test.coordinator.action({
    type: "block_actions", userId: "guest", actionId: "claim_host", value: test.coordinator.id,
    channelId: "channel", messageTs: "1", triggerId: "", metadata: "", state: {},
  });
  expect(test.sessions).toContainEqual({ hostId: null });
  expect(test.sessions).toContainEqual({ hostId: "guest" });
  await test.coordinator.endFromSlack();
});

test("downloads do not block End and are cancelled", async () => {
  let signal: AbortSignal | undefined;
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/track", canonicalUrl: "https://example.com/track",
      sourceId: "track", title: "Track", artist: "Artist",
    }),
    prepare: (_track: unknown, _directory: string, _id: string, value: AbortSignal) => {
      signal = value;
      return new Promise<string>((_resolve, reject) =>
        value.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      );
    },
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  const add = result.coordinator.action({
    type: "block_actions", userId: "host", actionId: "add_track_to_queue", value: "ref",
    channelId: "channel", messageTs: "1", triggerId: "", metadata: "", state: {},
  });
  while (!signal) await Bun.sleep(0);
  await result.coordinator.action({
    type: "block_actions", userId: "host", actionId: "end_session", value: result.coordinator.id,
    channelId: "channel", messageTs: "1", triggerId: "", metadata: "", state: {},
  });
  await add;
  expect(signal.aborted).toBeTrue();
  expect(result.media).toContainEqual({ type: "leave" });
});

test("late media events cannot advance a newer track", async () => {
  const tracks = {
    resolve: async (value: string) => ({
      sourceInput: `https://example.com/${value}`, canonicalUrl: `https://example.com/${value}`,
      sourceId: value, title: value, artist: "Artist",
    }),
    prepare: async (_track: unknown, _directory: string, id: string) => `${id}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  for (const value of ["a", "b"]) await result.coordinator.action({
    type: "block_actions", userId: "host", actionId: "add_track_to_queue", value,
    channelId: "channel", messageTs: "1", triggerId: "", metadata: "", state: {},
  });
  const plays = () => result.media.filter((message): message is { type: string; entryId: string } =>
    Boolean(message && typeof message === "object" && (message as { type?: string }).type === "play"),
  );
  const first = plays()[0]!.entryId;
  await result.coordinator.mediaEvent("track_ended", { entryId: first });
  const second = plays()[1]!.entryId;
  await result.coordinator.mediaEvent("track_ended", { entryId: first });
  expect(plays()).toHaveLength(2);
  expect(plays().at(-1)?.entryId).toBe(second);
  await result.coordinator.endFromSlack();
});

test("manager overrides permissions and HuddleFM cannot become host", async () => {
  const result = setup();
  await result.coordinator.start();
  await result.coordinator.action({
    type: "block_actions", userId: "manager", actionId: "volume_up", value: "",
    channelId: "channel", messageTs: "1", triggerId: "", metadata: "", state: {},
  });
  await result.coordinator.action({
    type: "view_submission", userId: "manager", actionId: "save_settings", value: "",
    channelId: "channel", messageTs: "", triggerId: "",
    metadata: JSON.stringify({ sessionId: result.coordinator.id, hostId: "host" }),
    state: { host: { user: { selected_user: "bot" } } },
  });
  expect(result.media).toContainEqual({ type: "volume", value: 0.7 });
  expect(result.ephemeral).toContain("HuddleFM cannot be the host.");
  await result.coordinator.endFromSlack();
});

test("HuddleFM leaving ends playback", async () => {
  const result = setup();
  await result.coordinator.start();
  await result.coordinator.memberLeft("bot");
  expect(result.media).toContainEqual({ type: "leave" });
  expect(result.sessions).toContainEqual({ status: "ended" });
});

test("host transfers ownership and global permissions atomically", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.action({
    type: "view_submission", userId: "host", actionId: "save_settings", value: "",
    channelId: "channel", messageTs: "", triggerId: "",
    metadata: JSON.stringify({ sessionId: test.coordinator.id, hostId: "host" }),
    state: {
      host: { user: { selected_user: "guest" } },
      permissions: { selected: { selected_options: [{ value: "add" }, { value: "pause" }] } },
    },
  });
  expect(test.sessions).toContainEqual({ hostId: "guest" });
  expect(test.permissions).toContainEqual({ capability: "pause", allowed: true });
  expect(test.permissions).toContainEqual({ capability: "skip", allowed: false });
  await test.coordinator.endFromSlack();
});
