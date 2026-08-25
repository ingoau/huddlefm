import { expect, test } from "bun:test";
import type { AuditLog } from "./audit-log.ts";
import { Coordinator } from "./coordinator.ts";
import type { LyricsCatalog } from "./lyrics.ts";
import type { SlackAppAdapter } from "./slack-app.ts";
import { Store, type SavedSession } from "./store.ts";
import type { TrackCatalog } from "./tracks.ts";
import { ScrobbleDispatcher } from "./scrobbling.ts";

function setup(
  tracks = {} as TrackCatalog,
  timeouts = {
    aloneMs: 60_000,
    idleMs: 600_000,
    pausedMs: 600_000,
    warningMs: 120_000,
  },
  restored?: SavedSession,
  scrobbling?: ScrobbleDispatcher,
  storeOverride?: Store,
  excludedUserIds = new Set<string>(),
  lyricsOverride?: LyricsCatalog,
) {
  const posted: unknown[] = [];
  const updates: unknown[] = [];
  const deleted: unknown[] = [];
  const deletedOriginals: unknown[] = [];
  const modals: unknown[] = [];
  const pushedModals: unknown[] = [];
  const updatedModals: [unknown, unknown, unknown][] = [];
  const ephemeral: string[] = [];
  const ephemeralCalls: unknown[][] = [];
  const sessions: unknown[] = [];
  const permissions: unknown[] = [];
  const suspensions: unknown[] = [];
  const media: unknown[] = [];
  const audit: unknown[] = [];
  const sessionChanges: unknown[] = [];
  const recordedMessages: unknown[] = [];
  let post = 0;
  let modal = 0;
  const slack = {
    post: async (...args: unknown[]) => (posted.push(args), String(++post)),
    update: async (...args: unknown[]) => {
      updates.push(args);
    },
    delete: async (...args: unknown[]) => {
      deleted.push(args);
    },
    deleteOriginal: async (...args: unknown[]) => {
      deletedOriginals.push(args);
    },
    ephemeral: async (...args: unknown[]) => {
      ephemeralCalls.push(args);
      const text = args[2] as string;
      ephemeral.push(text);
    },
    modal: async (...args: unknown[]) => {
      modals.push(args);
      modal++;
      return { id: `view-${modal}`, hash: `hash-${modal}` };
    },
    pushModal: async (...args: unknown[]) => {
      pushedModals.push(args);
    },
    updateModal: async (...args: [unknown, unknown, unknown]) => {
      updatedModals.push(args);
      return {
        id: String(args[0]),
        hash: `updated-${updatedModals.length}`,
      };
    },
  } as unknown as SlackAppAdapter;
  const store =
    storeOverride ??
    ({
      createSession: () => {},
      setUi: () => {},
      setUiLocation: () => {},
      setTrack: () => {},
      removeTrack: () => {},
      addTrack: () => {},
      incrementUsage: () => {},
      setSession: (_id: string, value: unknown) => {
        sessions.push(value);
      },
      activateSession: (_id: string, status: string) => {
        sessions.push({ activated: status });
      },
      suspendSession: (...args: unknown[]) => {
        suspensions.push(args);
      },
      endSession: (...args: unknown[]) => {
        sessions.push({ status: "ended", args });
      },
      setEndMessage: () => {},
      setPermission: (_id: string, capability: string, allowed: boolean) => {
        permissions.push({ capability, allowed });
      },
    } as unknown as Store);
  const lyrics =
    lyricsOverride ??
    ({ get: async () => undefined } as unknown as LyricsCatalog);
  const coordinator = new Coordinator(
    {
      huddleCallId: "call",
      huddleId: "huddle",
      huddleCreatorId: "creator",
      participantIds: ["host", "guest"],
      uiChannelId: "channel",
      uiThreadTs: "1.0",
      chimeMeeting: {},
      chimeAttendee: {},
    },
    "host",
    "bot",
    slack,
    store,
    tracks,
    lyrics,
    {
      record: (...args: unknown[]) => {
        audit.push(args);
      },
    } as AuditLog,
    {
      queueLimit: 50,
      initialVolume: 0.6,
      ...timeouts,
      port: 3210,
      managerUserId: "manager",
      excludedUserIds,
    },
    "token",
    (message) => media.push(message),
    async () => {},
    restored,
    scrobbling,
    () => sessionChanges.push({}),
    () => {},
    (...args) => recordedMessages.push(args),
  );
  return {
    coordinator,
    posted,
    updates,
    deleted,
    deletedOriginals,
    modals,
    pushedModals,
    updatedModals,
    ephemeral,
    ephemeralCalls,
    sessions,
    permissions,
    suspensions,
    media,
    audit,
    sessionChanges,
    recordedMessages,
  };
}

test("announces session lifecycle changes without waiting", async () => {
  const result = setup();
  await result.coordinator.start();
  expect(result.sessionChanges).toHaveLength(1);
  await result.coordinator.endFromSlack();
  expect(result.sessionChanges).toHaveLength(2);
});

test("coalesces queued player renders", async () => {
  const result = setup();
  await result.coordinator.start();
  const queueRender = Reflect.get(result.coordinator, "queueRender").bind(
    result.coordinator,
  );
  queueRender();
  queueRender();
  queueRender();
  await Bun.sleep(110);

  expect(result.updates).toHaveLength(1);
  await result.coordinator.endFromSlack();
});

test("moves controls to a replacement channel", async () => {
  const result = setup();
  await result.coordinator.start();
  await result.coordinator.moveControls("replacement");
  expect(result.coordinator.room.uiChannelId).toBe("replacement");
  expect(result.posted.at(-1)).toEqual([
    "replacement",
    "",
    "HuddleFM player",
    expect.any(Array),
  ]);
  expect(result.deleted).toContainEqual(["channel", "1"]);
  await result.coordinator.endFromSlack();
});

const interaction = (
  coordinator: Coordinator,
  actionId: string,
  value = "",
  type = "block_actions",
) => ({
  type,
  userId: "host",
  actionId,
  value,
  channelId: "channel",
  messageTs: type === "view_submission" ? "" : "1",
  triggerId: "trigger",
  metadata:
    type === "view_submission"
      ? JSON.stringify({ sessionId: coordinator.id, hostId: "host" })
      : "",
  state: {},
});

async function until(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++) await Bun.sleep(1);
  expect(predicate()).toBeTrue();
}

test("keeps open queue modals current until they close", async () => {
  const result = setup();
  await result.coordinator.start();
  Reflect.set(result.coordinator, "queue", [
    {
      id: "track",
      requesterId: "host",
      sourceInput: "track",
      canonicalUrl: "track",
      sourceId: "track",
      title: "Track",
      artist: "Artist",
      status: "ready",
    },
  ]);
  const open = interaction(result.coordinator, "view_full_queue");
  await result.coordinator.action(open);
  await result.coordinator.action({ ...open, userId: "guest" });
  expect(JSON.stringify(result.modals)).toContain('"notify_on_close":true');

  await result.coordinator.action(
    interaction(result.coordinator, "clear_queue"),
  );
  await Bun.sleep(110);
  await until(() => result.updatedModals.length === 2);
  expect(result.updatedModals.map(([viewId]) => viewId)).toEqual([
    "view-1",
    "view-2",
  ]);
  expect(JSON.stringify(result.updatedModals)).toContain("The queue is empty.");

  await result.coordinator.action({
    ...interaction(result.coordinator, "manage_queue"),
    type: "view_closed",
    messageTs: "",
    viewId: "view-1",
    viewHash: "updated-1",
    metadata: JSON.stringify({ sessionId: result.coordinator.id }),
  });
  Reflect.get(result.coordinator, "queueChanged").call(result.coordinator);
  await Bun.sleep(110);
  await until(() => result.updatedModals.length === 3);
  expect(result.updatedModals.at(-1)?.[0]).toBe("view-2");
  await result.coordinator.endFromSlack();
});

test("suspends with a restart notice and restores playback", async () => {
  const first = setup();
  await first.coordinator.start();
  first.coordinator.mediaEvent("playback_position", { seconds: 42 });
  await first.coordinator.suspendForRestart(180_000);
  expect(first.posted.at(-1)).toEqual([
    "channel",
    "1.0",
    "HuddleFM is restarting. Playback should resume shortly.",
  ]);
  expect(first.suspensions).toEqual([
    [
      first.coordinator.id,
      expect.objectContaining({ state: "ready" }),
      180_000,
    ],
  ]);
  expect(first.media).toContainEqual({ type: "leave" });

  const restored: SavedSession = {
    id: "saved",
    huddleId: "huddle",
    callId: "call",
    channelId: "channel",
    threadTs: "1.0",
    uiTs: "player",
    revision: 2,
    creatorId: "creator",
    hostId: "host",
    state: "paused",
    volume: 0.4,
    autoplay: false,
    transitionMode: "none",
    displayMode: "lyrics",
    anchorEnabled: true,
    playbackSeconds: 42,
    listenedSeconds: 84,
    resumeUntil: 180_000,
    permissions: ["add"],
    tracks: [
      {
        id: "track",
        requesterId: "host",
        sourceInput: "package.json",
        canonicalUrl: "package.json",
        sourceId: "source",
        title: "Track",
        artist: "Artist",
        status: "playing",
        filePath: "package.json",
      },
    ],
  };
  const second = setup(undefined, undefined, restored);
  await second.coordinator.resume("restorer");
  expect(second.coordinator.id).toBe("saved");
  expect(second.media).toContainEqual(
    expect.objectContaining({ type: "play", entryId: "track" }),
  );
  expect(second.media).toContainEqual({ type: "seek", seconds: 42 });
  expect(second.media).toContainEqual({ type: "pause" });
  expect(second.media).toContainEqual({ type: "display_mode", mode: "lyrics" });
  expect(second.audit).toContainEqual([
    "session.resumed",
    "restorer",
    { sessionId: "saved", huddleId: "huddle" },
  ]);
  await second.coordinator.endFromSlack();
});

test("a Next click during first-track preparation does not skip it", async () => {
  let finish!: (path: string) => void;
  const prepared = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/track",
      canonicalUrl: "https://example.com/track",
      sourceId: "track",
      title: "Track",
      artist: "Artist",
    }),
    prepare: () => prepared,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  const add = result.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "add_track_to_queue",
    value: "ref",
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  });
  await Bun.sleep(0);
  const next = result.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "next_track",
    value: "",
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  });
  finish("track.opus");
  await Promise.all([add, next]);
  expect(result.media).toContainEqual(
    expect.objectContaining({ type: "play" }),
  );
  expect(result.media).toContainEqual(
    expect.objectContaining({ type: "lyrics_unavailable" }),
  );
  expect(result.media).not.toContainEqual({ type: "stop" });
  expect(result.ephemeral).toContain(
    "Nothing was playing when you pressed Next.",
  );
  await result.coordinator.endFromSlack();
});

test("loads lyrics only for the current and next tracks", async () => {
  const requested: string[] = [];
  const tracks = {
    resolve: async () =>
      ["a", "b", "c"].map((id) => ({
        sourceInput: `https://example.com/${id}`,
        canonicalUrl: `https://example.com/${id}`,
        sourceId: id,
        title: id,
        artist: "Artist",
      })),
    prepare: async (_track: unknown, _directory: string, id: string) =>
      `${id}.opus`,
  } as unknown as TrackCatalog;
  const lyrics = {
    get: async (track: { sourceId: string }) => {
      requested.push(track.sourceId);
      return undefined;
    },
  } as unknown as LyricsCatalog;
  const result = setup(
    tracks,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    lyrics,
  );
  await result.coordinator.start();
  await result.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "add_track_to_queue",
    value: "bulkref_test",
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  });

  expect(requested).toEqual(["a", "b"]);
  await result.coordinator.endFromSlack();
});

test("rejects stale player actions", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "volume_up",
    value: "",
    channelId: "channel",
    messageTs: "stale",
    triggerId: "",
    metadata: "",
    state: {},
  });
  expect(test.ephemeral).toEqual(["That player is stale; use the newest one."]);
  expect(test.media).toEqual([]);
  await test.coordinator.endFromSlack();
});

test("rejects actions and track searches from outside the huddle", async () => {
  let searches = 0;
  let resolves = 0;
  const test = setup({
    suggestions: async () => (searches++, []),
    resolve: async () => (resolves++, {}),
  } as unknown as TrackCatalog);
  await test.coordinator.start();
  const outside = {
    type: "block_actions",
    userId: "outside",
    actionId: "add_track_to_queue",
    value: "track",
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  };

  expect(await test.coordinator.suggestions(outside)).toEqual([]);
  await test.coordinator.action(outside);
  await test.coordinator.action({ ...outside, actionId: "volume_up" });

  expect(searches).toBe(0);
  expect(resolves).toBe(0);
  expect(test.media).toEqual([]);
  expect(test.ephemeral).toEqual([
    "Join the huddle before using the player.",
    "Join the huddle before using the player.",
  ]);
  await test.coordinator.endFromSlack();
});

test("gates album and playlist additions behind add-bulk", async () => {
  const searches: unknown[] = [];
  let prepared = 0;
  const tracks = {
    suggestions: async (_query: string, allowed: unknown) => (
      searches.push(allowed),
      []
    ),
    resolve: async () =>
      ["a", "b"].map((id) => ({
        sourceInput: `https://example.com/${id}`,
        canonicalUrl: `https://example.com/${id}`,
        sourceId: id,
        title: id,
        artist: "Artist",
      })),
    prepare: async (_track: unknown, _directory: string, id: string) => (
      prepared++,
      `${id}.opus`
    ),
  } as unknown as TrackCatalog;
  const test = setup(tracks);
  await test.coordinator.start();
  const guest = {
    type: "block_actions",
    userId: "guest",
    actionId: "add_track_to_queue",
    value: "bulkref_test",
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  };

  await test.coordinator.suggestions({ ...guest, value: "album" });
  await test.coordinator.action(guest);
  expect(searches).toEqual([{ songs: true, bulk: false }]);
  expect(prepared).toBe(0);
  expect(test.ephemeral).toContain("You do not have permission for that.");

  await test.coordinator.action({
    ...interaction(test.coordinator, "save_settings", "", "view_submission"),
    state: {
      permissions: {
        selected: {
          selected_options: [
            { value: "add" },
            { value: "add-bulk" },
            { value: "remove-own" },
          ],
        },
      },
    },
  });
  Reflect.get(test.coordinator, "lastSearch").clear();
  await test.coordinator.suggestions({ ...guest, value: "album" });
  await test.coordinator.action(guest);
  expect(searches.at(-1)).toEqual({ songs: true, bulk: true });
  expect(prepared).toBe(2);
  await test.coordinator.endFromSlack();
});

test("routes message and modal interactions to their session", async () => {
  const test = setup();
  await test.coordinator.start();
  const interaction = {
    type: "block_actions",
    userId: "host",
    actionId: "add_track_to_queue",
    value: "ref",
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  };
  expect(test.coordinator.handles(interaction)).toBeTrue();
  expect(
    test.coordinator.handles({ ...interaction, messageTs: "other" }),
  ).toBeFalse();
  expect(
    test.coordinator.handles({
      ...interaction,
      channelId: "",
      messageTs: "",
      metadata: JSON.stringify({ sessionId: test.coordinator.id }),
    }),
  ).toBeTrue();
  expect(
    test.coordinator.handles({
      ...interaction,
      value: test.coordinator.id,
      channelId: "",
      messageTs: "",
    }),
  ).toBeTrue();
  await test.coordinator.endFromSlack();
});

test("adds tracks through a full-width search modal", async () => {
  let resolved = "";
  const test = setup({
    resolve: async (value: string) => {
      resolved = value;
      return {
        sourceInput: "https://example.com/track",
        canonicalUrl: "https://example.com/track",
        sourceId: "track",
        title: "Track",
        artist: "Artist",
      };
    },
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog);
  await test.coordinator.start();

  const player = JSON.stringify(test.posted[0]);
  expect(player.indexOf('"action_id":"add_track_to_queue"')).toBeLessThan(
    player.indexOf('"action_id":"open_add_to_queue"'),
  );
  expect(player).toContain('"text":":ms-arrow-up-right:"');
  await test.coordinator.action(
    interaction(test.coordinator, "open_add_to_queue"),
  );
  const modal = JSON.stringify(test.modals[0]);
  expect(modal).toContain('"type":"input","block_id":"track"');
  expect(modal).toContain('"type":"external_select"');
  expect(modal).toContain('"focus_on_load":true');

  await test.coordinator.action({
    ...interaction(
      test.coordinator,
      "add_track_to_queue",
      "",
      "view_submission",
    ),
    state: {
      track: { selection: { selected_option: { value: "track-reference" } } },
    },
  });
  expect(resolved).toBe("track-reference");
  await test.coordinator.endFromSlack();
});

test("first current participant claims a vacant host role", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.memberLeft("host");
  expect(test.posted).toHaveLength(1);
  await test.coordinator.action({
    type: "block_actions",
    userId: "guest",
    actionId: "claim_host",
    value: "old-session",
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  });
  expect(test.ephemeral).toContain("That takeover request is stale.");
  await test.coordinator.action({
    type: "block_actions",
    userId: "guest",
    actionId: "claim_host",
    value: test.coordinator.id,
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  });
  expect(test.sessions).toContainEqual({ hostId: null });
  expect(test.sessions).toContainEqual({ hostId: "guest" });
  await test.coordinator.endFromSlack();
});

test("downloads do not block End and are cancelled", async () => {
  let signal: AbortSignal | undefined;
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/track",
      canonicalUrl: "https://example.com/track",
      sourceId: "track",
      title: "Track",
      artist: "Artist",
    }),
    prepare: (
      _track: unknown,
      _directory: string,
      _id: string,
      value: AbortSignal,
    ) => {
      signal = value;
      return new Promise<string>((_resolve, reject) =>
        value.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      );
    },
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  const add = result.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "add_track_to_queue",
    value: "ref",
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  });
  while (!signal) await Bun.sleep(0);
  await result.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "end_session",
    value: result.coordinator.id,
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  });
  await add;
  expect(signal.aborted).toBeTrue();
  expect(result.media).toContainEqual({ type: "leave" });
});

test("late media events cannot advance a newer track", async () => {
  const tracks = {
    resolve: async (value: string) => ({
      sourceInput: `https://example.com/${value}`,
      canonicalUrl: `https://example.com/${value}`,
      sourceId: value,
      title: value,
      artist: "Artist",
    }),
    prepare: async (_track: unknown, _directory: string, id: string) =>
      `${id}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  for (const value of ["a", "b"])
    await result.coordinator.action({
      type: "block_actions",
      userId: "host",
      actionId: "add_track_to_queue",
      value,
      channelId: "channel",
      messageTs: "1",
      triggerId: "",
      metadata: "",
      state: {},
    });
  const plays = () =>
    result.media.filter(
      (message): message is { type: string; entryId: string } =>
        Boolean(
          message &&
          typeof message === "object" &&
          (message as { type?: string }).type === "play",
        ),
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
      sourceInput: `https://example.com/${value}`,
      canonicalUrl: `https://example.com/${value}`,
      sourceId: value,
      title: value,
      artist: "Artist",
    }),
    prepare: async (_track: unknown, _directory: string, id: string) =>
      `${id}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  const action = (actionId: string, value = "") =>
    result.coordinator.action({
      type: "block_actions",
      userId: "host",
      actionId,
      value,
      channelId: "channel",
      messageTs: "1",
      triggerId: "",
      metadata: "",
      state: {},
    });
  const plays = () =>
    result.media.filter(
      (message): message is { type: string; entryId: string } =>
        Boolean(
          message &&
          typeof message === "object" &&
          (message as { type?: string }).type === "play",
        ),
    );

  await result.coordinator.start();
  expect(JSON.stringify(result.posted[0])).toContain('"block_id":"seek_');
  expect(JSON.stringify(result.posted[0])).toContain('"action_id":"seek_back"');
  expect(JSON.stringify(result.posted[0])).toContain(
    '"action_id":"seek_forward"',
  );
  await action("add_track_to_queue", "a");
  expect(JSON.stringify(result.updates)).toContain("Added by <@host>");
  await action("add_track_to_queue", "b");
  const first = plays()[0]!.entryId;
  await result.coordinator.mediaEvent("track_ended", { entryId: first });
  const second = plays()[1]!.entryId;

  result.coordinator.mediaEvent("playback_position", {
    entryId: second,
    seconds: 6,
  });
  await action("previous_track");
  expect(result.media).toContainEqual({ type: "seek", seconds: 0 });
  expect(plays()).toHaveLength(2);

  result.coordinator.mediaEvent("playback_position", {
    entryId: second,
    seconds: 5,
  });
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
    type: "block_actions",
    userId: "manager",
    actionId: "volume_up",
    value: "",
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  });
  await result.coordinator.action({
    type: "view_submission",
    userId: "manager",
    actionId: "save_settings",
    value: "",
    channelId: "channel",
    messageTs: "",
    triggerId: "",
    metadata: JSON.stringify({
      sessionId: result.coordinator.id,
      hostId: "host",
    }),
    state: { host: { user: { selected_user: "bot" } } },
  });
  expect(result.media).toContainEqual({ type: "volume", value: 0.65 });
  expect(result.ephemeral).toContain("HuddleFM cannot be the host.");
  await result.coordinator.endFromSlack();
});

test("HuddleFM membership leave does not end active media", async () => {
  const result = setup();
  await result.coordinator.start();
  await result.coordinator.memberLeft("bot");
  expect(result.media).not.toContainEqual({ type: "leave" });
  expect(result.sessions).not.toContainEqual(
    expect.objectContaining({ status: "ended" }),
  );
  expect(result.deleted).toHaveLength(0);
  await result.coordinator.endFromSlack();
});

test("posts a collapsed recap after songs played", async () => {
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/track",
      canonicalUrl: "https://example.com/track",
      sourceId: "track",
      title: "Track",
      artist: "Artist, Featured Artist",
      duration: 180,
    }),
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "track"),
  );
  const play = result.media.find(
    (value) => (value as { type?: string }).type === "play",
  ) as { entryId: string };
  result.coordinator.mediaEvent("playback_position", {
    entryId: play.entryId,
    seconds: 42,
  });
  await result.coordinator.endFromSlack();
  const [, , text, blocks] = result.posted.at(-1) as [
    string,
    string,
    string,
    { type: string; [key: string]: unknown }[],
  ];
  expect(text).toBe("Session ended: huddle ended");
  expect(blocks[1]).toEqual(
    expect.objectContaining({
      type: "container",
      title: { type: "plain_text", text: "Session recap" },
      is_collapsible: true,
      default_collapsed: true,
    }),
  );
  expect(JSON.stringify(blocks[1])).toContain("*Listening time:* 42s");
  expect(JSON.stringify(blocks[1])).toContain("*Songs played:* 1");
  expect(JSON.stringify(blocks[1])).toContain("*Autoplay percentage:* 0%");
  expect(JSON.stringify(blocks[1])).toContain("*Unique artists:* 1");
  expect(JSON.stringify(blocks[1])).toContain(
    "*Most frequent requester:* <@host> (1 song)",
  );
  expect(JSON.stringify(blocks[1])).toContain(
    "*Most repeated artist:* Artist (1 song)",
  );
  expect(JSON.stringify(blocks[1])).toContain("*Longest song:* Track · 3m 0s");
  expect(JSON.stringify(blocks[1])).toContain("*Average song length:* 3m 0s");
  expect(JSON.stringify(blocks[1])).toContain("*Session host:* <@host>");
  expect(JSON.stringify(blocks[1])).toContain("*Track*");
});

test("announces and leaves two minutes after becoming the only Huddle participant", async () => {
  const result = setup(undefined, {
    aloneMs: 10,
    idleMs: 100,
    pausedMs: 100,
    warningMs: 20,
  });
  await result.coordinator.start();
  await result.coordinator.memberLeft("host");
  await result.coordinator.memberLeft("guest");
  await until(() => result.posted.length === 2);
  expect(result.posted[1]).toEqual([
    "channel",
    "1.0",
    "I’m alone in the Huddle, so I’ll leave in 2 minutes.",
  ]);
  await until(() =>
    result.media.some((value) => (value as { type?: string }).type === "leave"),
  );
  expect(result.media).toContainEqual({ type: "leave" });
});

test("excluded users cannot participate, host, or scrobble", async () => {
  const store = new Store(":memory:");
  store.setListenBrainzToken("host", "token", "host");
  store.setListenBrainzEnabled("host", true);
  store.setScrobblingMode("host", "ask");
  const result = setup(
    undefined,
    {
      aloneMs: 10,
      idleMs: 100,
      pausedMs: 100,
      warningMs: 20,
    },
    undefined,
    new ScrobbleDispatcher(store, {}),
    store,
    new Set(["host"]),
  );

  await result.coordinator.start();
  expect([...result.coordinator.participants]).toEqual(["bot", "guest"]);
  expect(store.db.query("SELECT host_id FROM sessions").get()).toEqual({
    host_id: "guest",
  });
  expect(result.ephemeralCalls.some((call) => call[1] === "host")).toBeFalse();

  result.coordinator.memberJoined("host");
  await result.coordinator.action(
    interaction(result.coordinator, "open_settings"),
  );
  expect(result.ephemeral).toContain(
    "Join the huddle before using the player.",
  );
  await result.coordinator.memberLeft("guest");
  await until(() =>
    result.media.some((value) => (value as { type?: string }).type === "leave"),
  );
  store.close();
});

test("warns two minutes before leaving after ten minutes with nothing playing", async () => {
  const result = setup(undefined, {
    aloneMs: 100,
    idleMs: 50,
    pausedMs: 100,
    warningMs: 30,
  });
  await result.coordinator.start();
  await until(() => result.posted.length === 2);
  expect(result.posted[1]).toEqual([
    "channel",
    "1.0",
    "Nothing is playing, so I’ll leave in 2 minutes.",
  ]);
  expect(result.recordedMessages).toHaveLength(result.posted.length);
  expect(result.media).not.toContainEqual({ type: "leave" });
  await until(() =>
    result.media.some((value) => (value as { type?: string }).type === "leave"),
  );
  expect(result.sessions).toContainEqual(
    expect.objectContaining({ status: "ended" }),
  );
});

test("warns before leaving after ten paused minutes and cancels the timer when resumed", async () => {
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/track",
      canonicalUrl: "https://example.com/track",
      sourceId: "track",
      title: "Track",
      artist: "Artist",
    }),
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog;
  const result = setup(tracks, {
    aloneMs: 100,
    idleMs: 100,
    pausedMs: 50,
    warningMs: 20,
  });
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "track"),
  );
  await result.coordinator.action(
    interaction(result.coordinator, "toggle_playback"),
  );
  await Bun.sleep(25);
  expect(result.media).not.toContainEqual({ type: "leave" });
  await result.coordinator.action(
    interaction(result.coordinator, "toggle_playback"),
  );
  await Bun.sleep(30);
  expect(result.media).not.toContainEqual({ type: "leave" });
  await result.coordinator.action(
    interaction(result.coordinator, "toggle_playback"),
  );
  await until(() => result.posted.length === 2);
  expect(result.posted[1]).toEqual([
    "channel",
    "1.0",
    "Playback is paused, so I’ll leave in 2 minutes.",
  ]);
  await until(() =>
    result.media.some((value) => (value as { type?: string }).type === "leave"),
  );
  expect(result.sessions).toContainEqual(
    expect.objectContaining({ status: "ended" }),
  );
});

test("host transfers ownership and global permissions atomically", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.action({
    type: "view_submission",
    userId: "host",
    actionId: "save_settings",
    value: "",
    channelId: "channel",
    messageTs: "",
    triggerId: "",
    metadata: JSON.stringify({
      sessionId: test.coordinator.id,
      hostId: "host",
    }),
    state: {
      volume: { percent: { value: "37.25" } },
      host: { user: { selected_user: "guest" } },
      display: { mode: { selected_option: { value: "off" } } },
      permissions: {
        selected: { selected_options: [{ value: "add" }, { value: "pause" }] },
      },
    },
  });
  expect(test.sessions).toContainEqual({ hostId: "guest" });
  expect(test.sessions).toContainEqual({ volume: 0.3725 });
  expect(test.media).toContainEqual({ type: "volume", value: 0.3725 });
  expect(test.media).toContainEqual({ type: "display_mode", mode: "off" });
  expect(test.permissions).toContainEqual({
    capability: "pause",
    allowed: true,
  });
  expect(test.permissions).toContainEqual({
    capability: "skip",
    allowed: false,
  });
  await test.coordinator.endFromSlack();
});

test("autoplay defaults off and host settings persist both toggle states", async () => {
  let recommendations = 0;
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      sourceId: "aaaaaaaaaaa",
      title: "A",
      artist: "Artist",
    }),
    prepare: async () => "a.opus",
    upNextIds: async () => (recommendations++, []),
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "a"),
  );
  await Bun.sleep(0);
  expect(recommendations).toBe(0);

  await result.coordinator.action(
    interaction(result.coordinator, "open_settings"),
  );
  const modal = JSON.stringify(result.modals.at(-1));
  expect(modal).toContain('"block_id":"autoplay"');
  expect(modal).toContain(
    '"block_id":"transition","label":{"type":"plain_text","text":"Transitions"}',
  );
  expect(modal).toContain('"text":"Disabled"');
  expect(modal).toContain('"value":"crossfade"');
  expect(modal).toContain('"value":"gapless"');
  expect(modal).toContain('"initial_options":[]');
  const positions = [
    '"text":"Session"',
    '"block_id":"volume"',
    '"block_id":"display"',
    '"block_id":"autoplay"',
    '"block_id":"transition"',
    '"block_id":"anchor"',
    '"block_id":"session_actions"',
    '"text":"Permissions"',
    '"block_id":"host"',
    '"block_id":"permission_preset"',
    '"block_id":"permissions"',
  ].map((value) => modal.indexOf(value));
  expect(
    positions.every(
      (position, index) =>
        position >= 0 && (!index || position > positions[index - 1]!),
    ),
  ).toBeTrue();
  expect(modal).toContain('"value":"configure-settings"');
  expect(modal).toContain(
    '"text":{"type":"plain_text","text":"Add albums and playlists"},"value":"add-bulk"',
  );

  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [{ value: "enabled" }] } },
  };
  await result.coordinator.action(enable);
  await until(() => recommendations === 1);
  expect(result.sessions).toContainEqual({ autoplay: true });

  const disable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  disable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [] } },
  };
  await result.coordinator.action(disable);
  expect(result.sessions).toContainEqual({ autoplay: false });

  const transition = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  transition.state = {
    transition: { mode: { selected_option: { value: "gapless" } } },
  };
  await result.coordinator.action(transition);
  expect(result.sessions).toContainEqual({ transitionMode: "gapless" });
  expect(result.media).toContainEqual({
    type: "transition_mode",
    mode: "gapless",
  });
  await result.coordinator.endFromSlack();
});

test("delegated users only see and save settings they can configure", async () => {
  const test = setup();
  await test.coordinator.start();
  const grant = interaction(
    test.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  grant.state = {
    permissions: {
      selected: {
        selected_options: [
          { value: "volume" },
          { value: "configure-settings" },
        ],
      },
    },
  };
  await test.coordinator.action(grant);

  const open = interaction(test.coordinator, "open_settings");
  open.userId = "guest";
  await test.coordinator.action(open);
  const modal = JSON.stringify(test.modals.at(-1));
  expect(modal).toContain('"text":"Session"');
  for (const block of ["volume", "display", "autoplay", "anchor"])
    expect(modal).toContain(`"block_id":"${block}"`);
  for (const block of [
    "session_actions",
    "host",
    "permission_preset",
    "permissions",
  ])
    expect(modal).not.toContain(`"block_id":"${block}"`);
  expect(modal).not.toContain('"text":"Permissions"');

  test.permissions.length = 0;
  const save = interaction(
    test.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  save.userId = "guest";
  save.state = {
    volume: { percent: { value: "25" } },
    display: { mode: { selected_option: { value: "lyrics" } } },
    autoplay: { enabled: { selected_options: [{ value: "enabled" }] } },
    anchor: { enabled: { selected_options: [{ value: "enabled" }] } },
    host: { user: { selected_user: "guest" } },
    permissions: { selected: { selected_options: [{ value: "end-session" }] } },
  };
  await test.coordinator.action(save);
  expect(test.sessions).toContainEqual({ volume: 0.25 });
  expect(test.sessions).toContainEqual({ displayMode: "lyrics" });
  expect(test.sessions).toContainEqual({ autoplay: true });
  expect(test.sessions).toContainEqual({ anchorEnabled: true });
  expect(test.sessions).not.toContainEqual({ hostId: "guest" });
  expect(test.permissions).toEqual([]);
  await test.coordinator.endFromSlack();
});

test("all participants can open user settings and end-session permission adds the session action", async () => {
  const test = setup();
  await test.coordinator.start();
  const open = interaction(test.coordinator, "open_settings");
  open.userId = "guest";
  await test.coordinator.action(open);
  expect(JSON.stringify(test.modals.at(-1))).toContain(
    '"text":"User settings"',
  );
  expect(JSON.stringify(test.modals.at(-1))).not.toContain(
    '"block_id":"session_actions"',
  );

  const grant = interaction(
    test.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  grant.state = {
    permissions: { selected: { selected_options: [{ value: "end-session" }] } },
  };
  await test.coordinator.action(grant);
  await test.coordinator.action(open);
  const modal = JSON.stringify(test.modals.at(-1));
  expect(modal).toContain('"block_id":"session_actions"');
  expect(modal).toContain('"text":"End session"');
  expect(modal).not.toContain('"block_id":"volume"');
  expect(modal).not.toContain('"text":"Permissions"');
  expect(modal).toContain('"submit"');
  await test.coordinator.endFromSlack();
});

test("Last.fm login uses the desktop authorization dialog and saves the user connection globally", async () => {
  const userStore = new Store(":memory:");
  const scrobbling = new ScrobbleDispatcher(
    userStore,
    {
      lastFmApiKey: "api-key",
      lastFmSharedSecret: "secret",
    },
    (async (_input, init) => {
      const method = new URLSearchParams(String(init?.body)).get("method");
      return Response.json(
        method === "auth.getToken"
          ? { token: "request-token" }
          : { session: { name: "last-user", key: "session-key" } },
      );
    }) as typeof fetch,
  );
  const test = setup(undefined, undefined, undefined, scrobbling);
  await test.coordinator.start();
  await test.coordinator.action(interaction(test.coordinator, "open_settings"));
  const settings = JSON.stringify(test.modals.at(-1));
  expect(settings).toContain('"action_id":"connect_lastfm"');
  expect(settings).not.toContain('"block_id":"scrobbling_mode"');
  expect(settings).not.toContain('"action_id":"toggle_session_scrobbling"');

  const connect = interaction(test.coordinator, "connect_lastfm");
  connect.messageTs = "";
  connect.metadata = JSON.stringify({ sessionId: test.coordinator.id });
  await test.coordinator.action(connect);
  const login = JSON.stringify(test.pushedModals.at(-1));
  expect(login).toContain(
    "https://www.last.fm/api/auth/?api_key=api-key&token=request-token",
  );
  expect(login).toContain('"action_id":"continue_lastfm"');

  const finish = interaction(test.coordinator, "continue_lastfm");
  finish.messageTs = "";
  finish.metadata = JSON.stringify({ sessionId: test.coordinator.id });
  Object.assign(finish, {
    viewId: "view",
    viewHash: "hash",
    previousViewId: "settings-view",
  });
  await test.coordinator.action(finish);
  expect(userStore.getUserScrobbling("host")).toEqual(
    expect.objectContaining({
      lastFmUsername: "last-user",
      lastFmSessionKey: "session-key",
      lastFmEnabled: true,
    }),
  );
  expect(test.updatedModals).toHaveLength(2);
  expect(test.updatedModals[1]?.[0]).toBe("settings-view");
  expect(JSON.stringify(test.updatedModals[1]?.[2])).toContain(
    '"action_id":"disconnect_lastfm"',
  );
  expect(JSON.stringify(test.updatedModals[1]?.[2])).toContain(
    '"block_id":"scrobbling_mode"',
  );
  await test.coordinator.endFromSlack();
  userStore.close();
});

test("ask mode prompts configured users and the shared session toggle overrides it", async () => {
  const userStore = new Store(":memory:");
  userStore.setListenBrainzToken("host", "lb-token", "lb-user");
  userStore.setListenBrainzEnabled("host", true);
  userStore.setScrobblingMode("host", "ask");
  const scrobbling = new ScrobbleDispatcher(userStore, {});
  const test = setup(undefined, undefined, undefined, scrobbling, userStore);
  await test.coordinator.start();
  expect(test.ephemeralCalls).toContainEqual([
    "channel",
    "host",
    "Do you want to scrobble your listening in this Huddle?",
    "1.0",
    expect.arrayContaining([
      expect.objectContaining({ block_id: "session_scrobbling_prompt" }),
    ]),
  ]);

  await test.coordinator.action({
    ...interaction(
      test.coordinator,
      "toggle_session_scrobbling",
      test.coordinator.id,
    ),
    responseUrl: "https://hooks.slack.com/actions/test",
  });
  expect(test.deletedOriginals).toEqual([
    ["https://hooks.slack.com/actions/test"],
  ]);
  expect(userStore.getSessionScrobbling(test.coordinator.id, "host")).toBe(
    true,
  );
  await test.coordinator.action(interaction(test.coordinator, "open_settings"));
  const modal = JSON.stringify(test.modals.at(-1));
  expect(modal).toContain('"block_id":"scrobbling_mode"');
  for (const mode of ["always", "ask", "disabled"])
    expect(modal).toContain(`"value":"${mode}"`);
  expect(modal).toContain("Disable scrobbling for this session");

  const save = interaction(
    test.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  save.state = {
    scrobbling_mode: {
      mode: { selected_option: { value: "disabled" } },
    },
  };
  await test.coordinator.action(save);
  expect(userStore.getUserScrobbling("host").mode).toBe("disabled");
  await test.coordinator.endFromSlack();
  userStore.close();
});

test("user settings remove saved scrobbling credentials", async () => {
  const userStore = new Store(":memory:");
  userStore.connectLastFm("host", "last-user", "session-key");
  userStore.setListenBrainzToken("host", "lb-token", "lb-user");
  userStore.setListenBrainzEnabled("host", true);
  const scrobbling = new ScrobbleDispatcher(userStore, {
    lastFmApiKey: "api-key",
    lastFmSharedSecret: "secret",
  });
  const test = setup(undefined, undefined, undefined, scrobbling);
  await test.coordinator.start();
  await test.coordinator.action(interaction(test.coordinator, "open_settings"));
  const modal = JSON.stringify(test.modals.at(-1));
  expect(modal).toContain('"action_id":"disconnect_lastfm"');
  expect(modal).toContain('"action_id":"disconnect_listenbrainz"');

  for (const actionId of ["disconnect_lastfm", "disconnect_listenbrainz"]) {
    const disconnect = interaction(test.coordinator, actionId);
    disconnect.messageTs = "";
    disconnect.metadata = JSON.stringify({ sessionId: test.coordinator.id });
    Object.assign(disconnect, { viewId: "view", viewHash: "hash" });
    await test.coordinator.action(disconnect);
  }
  expect(userStore.getUserScrobbling("host")).toEqual({
    lastFmEnabled: false,
    listenBrainzEnabled: false,
    mode: "always",
  });
  await test.coordinator.endFromSlack();
  userStore.close();
});

test("display mode defaults to album art and persists dropdown changes", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.action(interaction(test.coordinator, "open_settings"));
  const modal = JSON.stringify(test.modals.at(-1));
  expect(modal).toContain('"block_id":"display"');
  expect(modal).toContain('"type":"static_select"');
  expect(modal).toContain(
    '"initial_option":{"text":{"type":"plain_text","text":"Default"},"value":"default"}',
  );
  for (const mode of ["default", "lyrics", "off"])
    expect(modal).toContain(`"value":"${mode}"`);

  const save = interaction(
    test.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  save.state = {
    volume: { percent: { value: "60" } },
    display: { mode: { selected_option: { value: "lyrics" } } },
  };
  await test.coordinator.action(save);
  expect(test.sessions).toContainEqual({ displayMode: "lyrics" });
  expect(test.media).toContainEqual({ type: "display_mode", mode: "lyrics" });
  await test.coordinator.endFromSlack();
});

test("autoplay deduplicates current and recent tracks before resolving metadata", async () => {
  const ids = { a: "aaaaaaaaaaa", b: "bbbbbbbbbbb", c: "ccccccccccc" };
  const seeds: string[] = [];
  const resolved: string[] = [];
  const tracks = {
    resolve: async (value: keyof typeof ids) => ({
      sourceInput: `https://example.com/${value}`,
      canonicalUrl: `https://example.com/${value}`,
      sourceId: ids[value],
      title: value.toUpperCase(),
      artist: "Artist",
    }),
    upNextIds: async (seed: string) => (
      seeds.push(seed),
      [ids.b, ids.a, ids.c, ids.c]
    ),
    resolveVideoId: async (id: string) => (
      resolved.push(id),
      {
        sourceInput: `https://music.youtube.com/watch?v=${id}`,
        canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
        sourceId: id,
        title: "C",
        artist: "Radio",
      }
    ),
    prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "a"),
  );
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "b"),
  );
  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [{ value: "enabled" }] } },
  };
  await result.coordinator.action(enable);
  const first = (
    result.media.find(
      (value) => (value as { type?: string }).type === "play",
    ) as { entryId: string }
  ).entryId;
  await result.coordinator.mediaEvent("track_ended", { entryId: first });
  await until(() =>
    result.audit.some(
      (value) => (value as unknown[])[0] === "track.autoplay_added",
    ),
  );
  expect(seeds).toEqual([ids.b, ids.a]);
  expect(resolved).toEqual([ids.c]);
  expect(JSON.stringify(result.updates)).toContain("Autoplay recommendation");
  expect(JSON.stringify(result.audit)).toContain('"origin":"autoplay"');
  await result.coordinator.endFromSlack();
});

test("autoplay favors recommendations shared by recent manual tracks", async () => {
  const ids = {
    a: "aaaaaaaaaaa",
    b: "bbbbbbbbbbb",
    c: "ccccccccccc",
    x: "xxxxxxxxxxx",
    y: "yyyyyyyyyyy",
    z: "zzzzzzzzzzz",
  };
  const seeds: string[] = [];
  const resolved: string[] = [];
  const tracks = {
    resolve: async (value: keyof typeof ids) => ({
      sourceInput: `https://example.com/${value}`,
      canonicalUrl: `https://example.com/${value}`,
      sourceId: ids[value],
      title: value.toUpperCase(),
      artist: "Artist",
    }),
    upNextIds: async (seed: string) => {
      seeds.push(seed);
      if (seed === ids.c) return [ids.x, ids.y];
      if (seed === ids.b) return [ids.z, ids.y];
      return [ids.y];
    },
    resolveVideoId: async (id: string) => {
      resolved.push(id);
      return {
        sourceInput: `https://music.youtube.com/watch?v=${id}`,
        canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
        sourceId: id,
        title: "Recommendation",
        artist: "Radio",
      };
    },
    prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  for (const id of ["a", "b", "c"])
    await result.coordinator.action(
      interaction(result.coordinator, "add_track_to_queue", id),
    );
  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [{ value: "enabled" }] } },
  };
  await result.coordinator.action(enable);
  for (const sourceId of [ids.a, ids.b]) {
    const play = result.media.findLast(
      (value) =>
        (value as { type?: string; sourceId?: string }).type === "play" &&
        (value as { sourceId?: string }).sourceId === sourceId,
    ) as { entryId: string };
    await result.coordinator.mediaEvent("track_ended", {
      entryId: play.entryId,
    });
  }
  await until(() =>
    result.audit.some(
      (value) => (value as unknown[])[0] === "track.autoplay_added",
    ),
  );
  expect(seeds).toEqual([ids.c, ids.b, ids.a]);
  expect(resolved).toEqual([ids.y]);
  await result.coordinator.endFromSlack();
});

test("skipping rejects the track and rebuilds prepared autoplay", async () => {
  const ids = {
    a: "aaaaaaaaaaa",
    c: "ccccccccccc",
    d: "ddddddddddd",
    e: "eeeeeeeeeee",
  };
  const resolved: string[] = [];
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      sourceId: ids.a,
      title: "A",
      artist: "Artist",
    }),
    upNextIds: async () => [ids.c, ids.d, ids.e],
    resolveVideoId: async (id: string) => {
      resolved.push(id);
      return {
        sourceInput: `https://music.youtube.com/watch?v=${id}`,
        canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
        sourceId: id,
        title: id,
        artist: "Radio",
      };
    },
    prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "a"),
  );
  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [{ value: "enabled" }] } },
  };
  await result.coordinator.action(enable);
  await until(
    () =>
      result.audit.filter(
        (value) => (value as unknown[])[0] === "track.autoplay_added",
      ).length === 1,
  );
  const manual = result.media.find(
    (value) => (value as { type?: string }).type === "play",
  ) as { entryId: string };
  await result.coordinator.mediaEvent("track_ended", {
    entryId: manual.entryId,
  });
  await until(
    () =>
      result.audit.filter(
        (value) => (value as unknown[])[0] === "track.autoplay_added",
      ).length === 2,
  );
  await result.coordinator.action(
    interaction(result.coordinator, "next_track"),
  );
  await until(
    () =>
      result.audit.filter(
        (value) => (value as unknown[])[0] === "track.autoplay_added",
      ).length === 3,
  );
  expect(resolved).toEqual([ids.c, ids.d, ids.d]);
  expect(
    Reflect.get(result.coordinator, "history").map(
      (track: { sourceId: string }) => track.sourceId,
    ),
  ).toEqual([ids.a]);
  expect(
    result.media.filter(
      (value) => (value as { type?: string }).type === "play",
    ),
  ).toEqual([
    expect.objectContaining({ sourceId: ids.a }),
    expect.objectContaining({ sourceId: ids.c }),
    expect.objectContaining({ sourceId: ids.d }),
  ]);
  await result.coordinator.endFromSlack();
});

test("failed recommendation lookup leaves the session running", async () => {
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      sourceId: "aaaaaaaaaaa",
      title: "A",
      artist: "Artist",
    }),
    prepare: async () => "a.opus",
    upNextIds: async () => {
      throw new Error("unavailable");
    },
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "a"),
  );
  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [{ value: "enabled" }] } },
  };
  await result.coordinator.action(enable);
  await until(() =>
    result.audit.some(
      (value) => (value as unknown[])[0] === "autoplay.recommendation_failed",
    ),
  );
  expect(result.media).not.toContainEqual({ type: "leave" });
  expect(result.sessions).not.toContainEqual({ status: "ended" });
  await result.coordinator.endFromSlack();
});

test("a manual track replaces a prepared autoplay recommendation", async () => {
  const ids = { a: "aaaaaaaaaaa", b: "bbbbbbbbbbb", c: "ccccccccccc" };
  const tracks = {
    resolve: async (value: keyof typeof ids) => ({
      sourceInput: `https://example.com/${value}`,
      canonicalUrl: `https://example.com/${value}`,
      sourceId: ids[value],
      title: value.toUpperCase(),
      artist: "Artist",
    }),
    upNextIds: async () => [ids.c],
    resolveVideoId: async (id: string) => ({
      sourceInput: `https://music.youtube.com/watch?v=${id}`,
      canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
      sourceId: id,
      title: "C",
      artist: "Radio",
    }),
    prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "a"),
  );
  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { enabled: { selected_options: [{ value: "enabled" }] } },
  };
  await result.coordinator.action(enable);
  await until(() =>
    JSON.stringify(result.updates).includes("Autoplay recommendation"),
  );
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "b"),
  );
  const plays = result.media.filter(
    (value) => (value as { type?: string }).type === "play",
  ) as { entryId: string; sourceId: string }[];
  await result.coordinator.mediaEvent("track_ended", {
    entryId: plays[0]!.entryId,
  });
  const finalPlays = result.media.filter(
    (value) => (value as { type?: string }).type === "play",
  ) as { sourceId: string }[];
  expect(finalPlays[1]?.sourceId).toBe(ids.b);
  await result.coordinator.endFromSlack();
});

test("collaborative preset grants everything except destructive permissions", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.action({
    type: "view_submission",
    userId: "host",
    actionId: "save_settings",
    value: "",
    channelId: "channel",
    messageTs: "",
    triggerId: "",
    metadata: JSON.stringify({
      sessionId: test.coordinator.id,
      hostId: "host",
    }),
    state: {
      volume: { percent: { value: "60" } },
      permission_preset: {
        selected: { selected_option: { value: "collaborative" } },
      },
      permissions: { selected: { selected_options: [] } },
    },
  });
  expect(test.permissions).toContainEqual({
    capability: "manage-queue",
    allowed: true,
  });
  expect(test.permissions).toContainEqual({
    capability: "volume",
    allowed: true,
  });
  expect(test.permissions).toContainEqual({
    capability: "configure-settings",
    allowed: true,
  });
  expect(test.permissions).toContainEqual({
    capability: "clear",
    allowed: false,
  });
  expect(test.permissions).toContainEqual({
    capability: "end-session",
    allowed: false,
  });
  await test.coordinator.endFromSlack();
});

test("thread anchoring is disabled by default and can be enabled", async () => {
  const test = setup();
  await test.coordinator.start();
  const action = (type: string, state = {}) =>
    test.coordinator.action({
      type,
      userId: "host",
      actionId: type === "view_submission" ? "save_settings" : "open_settings",
      value: "",
      channelId: "channel",
      messageTs: type === "view_submission" ? "" : String(test.posted.length),
      triggerId: "trigger",
      metadata:
        type === "view_submission"
          ? JSON.stringify({ sessionId: test.coordinator.id, hostId: "host" })
          : "",
      state,
    });

  await action("block_actions");
  expect(JSON.stringify(test.modals[0])).toContain(
    '"block_id":"anchor","optional":true',
  );
  const initialAnchor = (
    test.modals[0] as [
      string,
      {
        blocks: { block_id: string; element: { initial_options: unknown[] } }[];
      },
    ]
  )[1].blocks.find((block) => block.block_id === "anchor");
  expect(initialAnchor?.element.initial_options).toEqual([]);
  await action("view_submission", {
    volume: { percent: { value: "60" } },
    anchor: { enabled: { selected_options: [{ value: "enabled" }] } },
  });
  expect(test.posted).toHaveLength(2);
  expect(test.deleted).toEqual([["channel", "1"]]);
  await action("block_actions");
  const anchor = (
    test.modals[1] as [
      string,
      {
        blocks: { block_id: string; element: { initial_options: unknown[] } }[];
      },
    ]
  )[1].blocks.find((block) => block.block_id === "anchor");
  expect(anchor?.element.initial_options).toEqual([
    {
      text: { type: "plain_text", text: "Keep player at bottom of thread" },
      value: "enabled",
    },
  ]);
  await test.coordinator.endFromSlack();
});

test("reposts the player on demand when thread anchoring is disabled", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.repost();
  expect(test.posted).toHaveLength(2);
  expect(test.deleted).toEqual([["channel", "1"]]);
  await test.coordinator.endFromSlack();
});
