import { expect, test } from "bun:test";
import type { AuditLog } from "./audit-log.ts";
import { Coordinator } from "./coordinator.ts";
import type { LyricsCatalog } from "./lyrics.ts";
import type { SlackAppAdapter } from "./slack-app.ts";
import type { SavedSession, Store } from "./store.ts";
import type { TrackCatalog } from "./tracks.ts";

function setup(tracks = {} as TrackCatalog, timeouts = { idleMs: 60_000, pausedMs: 600_000 }, restored?: SavedSession) {
  const posted: unknown[] = [];
  const updates: unknown[] = [];
  const modals: unknown[] = [];
  const ephemeral: string[] = [];
  const sessions: unknown[] = [];
  const permissions: unknown[] = [];
  const suspensions: unknown[] = [];
  const media: unknown[] = [];
  const audit: unknown[] = [];
  let post = 0;
  const slack = {
    post: async (...args: unknown[]) => (posted.push(args), String(++post)),
    update: async (...args: unknown[]) => { updates.push(args); },
    delete: async () => {},
    ephemeral: async (_channel: string, _user: string, text: string) => { ephemeral.push(text); },
    modal: async (...args: unknown[]) => { modals.push(args); },
    updateModal: async () => {},
  } as unknown as SlackAppAdapter;
  const store = {
    createSession: () => {}, setUi: () => {}, setTrack: () => {}, removeTrack: () => {},
    addTrack: () => {},
    setSession: (_id: string, value: unknown) => { sessions.push(value); },
    activateSession: (_id: string, status: string) => { sessions.push({ activated: status }); },
    suspendSession: (...args: unknown[]) => { suspensions.push(args); },
    setPermission: (_id: string, capability: string, allowed: boolean) => { permissions.push({ capability, allowed }); },
  } as unknown as Store;
  const lyrics = { get: async () => undefined } as unknown as LyricsCatalog;
  const coordinator = new Coordinator({
    huddleCallId: "call", huddleId: "huddle", huddleCreatorId: "creator",
    participantIds: ["host", "guest"], uiChannelId: "channel", uiThreadTs: "1.0",
    chimeMeeting: {}, chimeAttendee: {},
  }, "host", "bot", slack, store, tracks, lyrics, { record: (...args: unknown[]) => { audit.push(args); } } as AuditLog, {
    queueLimit: 50, initialVolume: 0.6, ...timeouts, port: 3210, managerUserId: "manager",
  }, "token", message => media.push(message), async () => {}, restored);
  return { coordinator, posted, updates, modals, ephemeral, sessions, permissions, suspensions, media, audit };
}

const interaction = (coordinator: Coordinator, actionId: string, value = "", type = "block_actions") => ({
  type, userId: "host", actionId, value, channelId: "channel",
  messageTs: type === "view_submission" ? "" : "1", triggerId: "trigger",
  metadata: type === "view_submission" ? JSON.stringify({ sessionId: coordinator.id, hostId: "host" }) : "",
  state: {},
});

async function until(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++) await Bun.sleep(1);
  expect(predicate()).toBeTrue();
}

test("suspends with a restart notice and restores playback", async () => {
  const first = setup();
  await first.coordinator.start();
  first.coordinator.mediaEvent("playback_position", { seconds: 42 });
  await first.coordinator.suspendForRestart(180_000);
  expect(first.posted.at(-1)).toEqual([
    "channel", "1.0", "HuddleFM is restarting. Playback should resume shortly.",
  ]);
  expect(first.suspensions).toEqual([[first.coordinator.id, expect.objectContaining({ state: "ready" }), 180_000]]);
  expect(first.media).toContainEqual({ type: "leave" });

  const restored: SavedSession = {
    id: "saved", huddleId: "huddle", callId: "call", channelId: "channel", threadTs: "1.0",
    uiTs: "player", revision: 2, creatorId: "creator", hostId: "host", state: "paused",
    volume: 0.4, autoplay: false, lyricsEnabled: true, anchorEnabled: true,
    playbackSeconds: 42, resumeUntil: 180_000, permissions: ["add"], tracks: [{
      id: "track", requesterId: "host", sourceInput: "package.json", canonicalUrl: "package.json",
      sourceId: "source", title: "Track", artist: "Artist", status: "playing", filePath: "package.json",
    }],
  };
  const second = setup(undefined, undefined, restored);
  await second.coordinator.resume();
  expect(second.coordinator.id).toBe("saved");
  expect(second.media).toContainEqual(expect.objectContaining({ type: "play", entryId: "track" }));
  expect(second.media).toContainEqual({ type: "seek", seconds: 42 });
  expect(second.media).toContainEqual({ type: "pause" });
  await second.coordinator.endFromSlack();
});

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
  expect(result.media).toContainEqual(expect.objectContaining({ type: "lyrics_unavailable" }));
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

test("routes message and modal interactions to their session", async () => {
  const test = setup();
  await test.coordinator.start();
  const interaction = {
    type: "block_actions", userId: "host", actionId: "add_track_to_queue", value: "ref",
    channelId: "channel", messageTs: "1", triggerId: "", metadata: "", state: {},
  };
  expect(test.coordinator.handles(interaction)).toBeTrue();
  expect(test.coordinator.handles({ ...interaction, messageTs: "other" })).toBeFalse();
  expect(test.coordinator.handles({
    ...interaction, channelId: "", messageTs: "", metadata: JSON.stringify({ sessionId: test.coordinator.id }),
  })).toBeTrue();
  expect(test.coordinator.handles({ ...interaction, value: test.coordinator.id, channelId: "", messageTs: "" })).toBeTrue();
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

test("Previous restarts after five seconds and seek controls move ten seconds", async () => {
  const tracks = {
    resolve: async (value: string) => ({
      sourceInput: `https://example.com/${value}`, canonicalUrl: `https://example.com/${value}`,
      sourceId: value, title: value, artist: "Artist",
    }),
    prepare: async (_track: unknown, _directory: string, id: string) => `${id}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  const action = (actionId: string, value = "") => result.coordinator.action({
    type: "block_actions", userId: "host", actionId, value,
    channelId: "channel", messageTs: "1", triggerId: "", metadata: "", state: {},
  });
  const plays = () => result.media.filter((message): message is { type: string; entryId: string } =>
    Boolean(message && typeof message === "object" && (message as { type?: string }).type === "play"),
  );

  await result.coordinator.start();
  expect(JSON.stringify(result.posted[0])).toContain('"block_id":"seek_');
  expect(JSON.stringify(result.posted[0])).toContain('"action_id":"seek_back"');
  expect(JSON.stringify(result.posted[0])).toContain('"action_id":"seek_forward"');
  await action("add_track_to_queue", "a");
  await action("add_track_to_queue", "b");
  const first = plays()[0]!.entryId;
  await result.coordinator.mediaEvent("track_ended", { entryId: first });
  const second = plays()[1]!.entryId;

  result.coordinator.mediaEvent("playback_position", { entryId: second, seconds: 6 });
  await action("previous_track");
  expect(result.media).toContainEqual({ type: "seek", seconds: 0 });
  expect(plays()).toHaveLength(2);

  result.coordinator.mediaEvent("playback_position", { entryId: second, seconds: 5 });
  await action("previous_track");
  expect(plays().at(-1)?.entryId).toBe(first);
  await action("seek_back");
  await action("seek_forward");
  expect(result.media).toContainEqual({ type: "seek", offset: -10 });
  expect(result.media).toContainEqual({ type: "seek", offset: 10 });
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
  expect(result.media).toContainEqual({ type: "volume", value: 0.65 });
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

test("announces and leaves two minutes after becoming the only Huddle participant", async () => {
  const result = setup(undefined, { idleMs: 10, pausedMs: 100 });
  await result.coordinator.start();
  await result.coordinator.memberLeft("host");
  await result.coordinator.memberLeft("guest");
  await until(() => result.posted.length === 2);
  expect(result.posted[1]).toEqual([
    "channel", "1.0", "I’m alone in the Huddle, so I’ll leave in 2 minutes.",
  ]);
  await until(() => result.media.some(value => (value as { type?: string }).type === "leave"));
  expect(result.media).toContainEqual({ type: "leave" });
});

test("leaves after two minutes with nothing playing", async () => {
  const result = setup(undefined, { idleMs: 10, pausedMs: 100 });
  await result.coordinator.start();
  await until(() => result.media.some(value => (value as { type?: string }).type === "leave"));
  expect(result.sessions).toContainEqual({ status: "ended" });
});

test("leaves after ten paused minutes and cancels the timer when resumed", async () => {
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/track", canonicalUrl: "https://example.com/track",
      sourceId: "track", title: "Track", artist: "Artist",
    }),
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog;
  const result = setup(tracks, { idleMs: 10, pausedMs: 30 });
  await result.coordinator.start();
  await result.coordinator.action(interaction(result.coordinator, "add_track_to_queue", "track"));
  await result.coordinator.action(interaction(result.coordinator, "toggle_playback"));
  await Bun.sleep(15);
  expect(result.media).not.toContainEqual({ type: "leave" });
  await result.coordinator.action(interaction(result.coordinator, "toggle_playback"));
  await Bun.sleep(20);
  expect(result.media).not.toContainEqual({ type: "leave" });
  await result.coordinator.action(interaction(result.coordinator, "toggle_playback"));
  await until(() => result.media.some(value => (value as { type?: string }).type === "leave"));
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
      volume: { percent: { value: "37.25" } },
      host: { user: { selected_user: "guest" } },
      lyrics: { enabled: { selected_options: [] } },
      permissions: { selected: { selected_options: [{ value: "add" }, { value: "pause" }] } },
    },
  });
  expect(test.sessions).toContainEqual({ hostId: "guest" });
  expect(test.sessions).toContainEqual({ volume: 0.3725 });
  expect(test.media).toContainEqual({ type: "volume", value: 0.3725 });
  expect(test.media).toContainEqual({ type: "lyrics_enabled", enabled: false });
  expect(test.permissions).toContainEqual({ capability: "pause", allowed: true });
  expect(test.permissions).toContainEqual({ capability: "skip", allowed: false });
  await test.coordinator.endFromSlack();
});

test("autoplay defaults off and host settings persist both toggle states", async () => {
  let recommendations = 0;
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/a", canonicalUrl: "https://example.com/a",
      sourceId: "aaaaaaaaaaa", title: "A", artist: "Artist",
    }),
    prepare: async () => "a.opus",
    upNextIds: async () => (recommendations++, []),
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(interaction(result.coordinator, "add_track_to_queue", "a"));
  await Bun.sleep(0);
  expect(recommendations).toBe(0);

  await result.coordinator.action(interaction(result.coordinator, "open_settings"));
  const modal = JSON.stringify(result.modals.at(-1));
  expect(modal).toContain('"block_id":"autoplay"');
  expect(modal).toContain('"initial_options":[]');

  const enable = interaction(result.coordinator, "save_settings", "", "view_submission");
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [{ value: "enabled" }] } },
  };
  await result.coordinator.action(enable);
  await until(() => recommendations === 1);
  expect(result.sessions).toContainEqual({ autoplay: true });

  const disable = interaction(result.coordinator, "save_settings", "", "view_submission");
  disable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [] } },
  };
  await result.coordinator.action(disable);
  expect(result.sessions).toContainEqual({ autoplay: false });
  await result.coordinator.endFromSlack();
});

test("autoplay deduplicates current and recent tracks before resolving metadata", async () => {
  const ids = { a: "aaaaaaaaaaa", b: "bbbbbbbbbbb", c: "ccccccccccc" };
  const seeds: string[] = [];
  const resolved: string[] = [];
  const tracks = {
    resolve: async (value: keyof typeof ids) => ({
      sourceInput: `https://example.com/${value}`, canonicalUrl: `https://example.com/${value}`,
      sourceId: ids[value], title: value.toUpperCase(), artist: "Artist",
    }),
    upNextIds: async (seed: string) => (seeds.push(seed), [ids.b, ids.a, ids.c, ids.c]),
    resolveVideoId: async (id: string) => (resolved.push(id), {
      sourceInput: `https://music.youtube.com/watch?v=${id}`,
      canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
      sourceId: id, title: "C", artist: "Radio",
    }),
    prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(interaction(result.coordinator, "add_track_to_queue", "a"));
  await result.coordinator.action(interaction(result.coordinator, "add_track_to_queue", "b"));
  const enable = interaction(result.coordinator, "save_settings", "", "view_submission");
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [{ value: "enabled" }] } },
  };
  await result.coordinator.action(enable);
  const first = (result.media.find(value => (value as { type?: string }).type === "play") as { entryId: string }).entryId;
  await result.coordinator.mediaEvent("track_ended", { entryId: first });
  await until(() => result.audit.some(value => (value as unknown[])[0] === "track.autoplay_added"));
  expect(seeds).toEqual([ids.b]);
  expect(resolved).toEqual([ids.c]);
  expect(JSON.stringify(result.updates)).toContain("Autoplay recommendation");
  expect(JSON.stringify(result.audit)).toContain('"origin":"autoplay"');
  await result.coordinator.endFromSlack();
});

test("failed recommendation lookup leaves the session running", async () => {
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/a", canonicalUrl: "https://example.com/a",
      sourceId: "aaaaaaaaaaa", title: "A", artist: "Artist",
    }),
    prepare: async () => "a.opus",
    upNextIds: async () => { throw new Error("unavailable"); },
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(interaction(result.coordinator, "add_track_to_queue", "a"));
  const enable = interaction(result.coordinator, "save_settings", "", "view_submission");
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [{ value: "enabled" }] } },
  };
  await result.coordinator.action(enable);
  await until(() => result.audit.some(value => (value as unknown[])[0] === "autoplay.recommendation_failed"));
  expect(result.media).not.toContainEqual({ type: "leave" });
  expect(result.sessions).not.toContainEqual({ status: "ended" });
  await result.coordinator.endFromSlack();
});

test("a manual track replaces a prepared autoplay recommendation", async () => {
  const ids = { a: "aaaaaaaaaaa", b: "bbbbbbbbbbb", c: "ccccccccccc" };
  const tracks = {
    resolve: async (value: keyof typeof ids) => ({
      sourceInput: `https://example.com/${value}`, canonicalUrl: `https://example.com/${value}`,
      sourceId: ids[value], title: value.toUpperCase(), artist: "Artist",
    }),
    upNextIds: async () => [ids.c],
    resolveVideoId: async (id: string) => ({
      sourceInput: `https://music.youtube.com/watch?v=${id}`,
      canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
      sourceId: id, title: "C", artist: "Radio",
    }),
    prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(interaction(result.coordinator, "add_track_to_queue", "a"));
  const enable = interaction(result.coordinator, "save_settings", "", "view_submission");
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [{ value: "enabled" }] } },
  };
  await result.coordinator.action(enable);
  await until(() => JSON.stringify(result.updates).includes("Autoplay recommendation"));
  await result.coordinator.action(interaction(result.coordinator, "add_track_to_queue", "b"));
  const plays = result.media.filter(value => (value as { type?: string }).type === "play") as { entryId: string; sourceId: string }[];
  await result.coordinator.mediaEvent("track_ended", { entryId: plays[0]!.entryId });
  const finalPlays = result.media.filter(value => (value as { type?: string }).type === "play") as { sourceId: string }[];
  expect(finalPlays[1]?.sourceId).toBe(ids.b);
  await result.coordinator.endFromSlack();
});

test("collaborative preset grants everything except destructive permissions", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.action({
    type: "view_submission", userId: "host", actionId: "save_settings", value: "",
    channelId: "channel", messageTs: "", triggerId: "",
    metadata: JSON.stringify({ sessionId: test.coordinator.id, hostId: "host" }),
    state: {
      volume: { percent: { value: "60" } },
      permission_preset: { selected: { selected_option: { value: "collaborative" } } },
      permissions: { selected: { selected_options: [] } },
    },
  });
  expect(test.permissions).toContainEqual({ capability: "manage-queue", allowed: true });
  expect(test.permissions).toContainEqual({ capability: "volume", allowed: true });
  expect(test.permissions).toContainEqual({ capability: "clear", allowed: false });
  expect(test.permissions).toContainEqual({ capability: "end-session", allowed: false });
  await test.coordinator.endFromSlack();
});

test("thread anchoring is enabled by default and can be disabled", async () => {
  const test = setup();
  await test.coordinator.start();
  const action = (type: string, state = {}) => test.coordinator.action({
    type, userId: "host", actionId: type === "view_submission" ? "save_settings" : "open_settings", value: "",
    channelId: "channel", messageTs: type === "view_submission" ? "" : "1", triggerId: "trigger",
    metadata: type === "view_submission" ? JSON.stringify({ sessionId: test.coordinator.id, hostId: "host" }) : "",
    state,
  });

  await action("block_actions");
  expect(JSON.stringify(test.modals[0])).toContain('"block_id":"anchor","optional":true');
  expect(JSON.stringify(test.modals[0])).toContain('"initial_options":[{"text":{"type":"plain_text","text":"Keep player at bottom of thread"}');
  await action("view_submission", {
    volume: { percent: { value: "60" } },
    anchor: { enabled: { selected_options: [] } },
  });
  await action("block_actions");
  const anchor = (test.modals[1] as [string, { blocks: { block_id: string; element: { initial_options: unknown[] } }[] }])[1]
    .blocks.find(block => block.block_id === "anchor");
  expect(anchor?.element.initial_options).toEqual([]);
  await test.coordinator.endFromSlack();
});
