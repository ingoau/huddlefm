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
    queueLimit: 50, initialVolume: 0.6, idleMs: 60_000, port: 3210,
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
  await test.coordinator.action({
    type: "block_actions", userId: "guest", actionId: "claim_host", value: "",
    channelId: "channel", messageTs: "2", triggerId: "", metadata: "", state: {},
  });
  expect(test.sessions).toContainEqual({ hostId: null });
  expect(test.sessions).toContainEqual({ hostId: "guest" });
  await test.coordinator.endFromSlack();
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
