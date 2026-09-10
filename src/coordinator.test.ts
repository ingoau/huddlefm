import { expect, test } from "bun:test";
import type { AuditLog } from "./audit-log.ts";
import { Coordinator } from "./coordinator.ts";
import type { LyricsCatalog } from "./lyrics.ts";
import type { SlackAppAdapter } from "./slack-app.ts";
import { Store, type SavedSession } from "./store.ts";
import type { TrackCatalog } from "./tracks.ts";
import { ScrobbleDispatcher } from "./scrobbling.ts";
import { parseIntegrationActionValue } from "./integration.ts";
import { RecommendationCatalog } from "./recommendations.ts";

function setup(
  tracks = {} as TrackCatalog,
  timeouts: {
    aloneMs: number;
    idleMs: number;
    pausedMs: number;
    warningMs: number;
    footer?: string;
  } = {
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
  recommendations?: import("./recommendations.ts").RecommendationCatalog,
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
  const dms: unknown[][] = [];
  const replacements: unknown[][] = [];
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
    userName: (userId: string) => Promise.resolve(`Name ${userId}`),
    dm: async (...args: unknown[]) => {
      dms.push(args);
    },
    replaceOriginal: async (...args: unknown[]) => {
      replacements.push(args);
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
      recentTracks: () => [],
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
    recommendations,
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
    dms,
    replacements,
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

function queueChildBlocks(posted: unknown[]) {
  const [, , , blocks] = posted[0] as [
    string,
    string,
    string,
    {
      child_blocks: {
        type: string;
        block_id?: string;
        elements?: unknown[];
      }[];
    }[],
  ];
  const childBlocks = blocks[1]?.child_blocks;
  if (!childBlocks) throw new Error("missing queue container");
  return childBlocks;
}

test("appends a configured mrkdwn footer under queue controls", async () => {
  const omitted = setup();
  await omitted.coordinator.start();
  expect(
    queueChildBlocks(omitted.posted).some((block) =>
      block.block_id?.startsWith("footer_"),
    ),
  ).toBeFalse();
  await omitted.coordinator.endFromSlack();

  const result = setup(undefined, {
    aloneMs: 60_000,
    idleMs: 600_000,
    pausedMs: 600_000,
    warningMs: 120_000,
    footer: "*Need help?* Ask in <#C123>",
  });
  await result.coordinator.start();
  expect(queueChildBlocks(result.posted).at(-1)).toEqual({
    type: "context",
    block_id: expect.stringMatching(/^footer_/),
    elements: [
      {
        type: "mrkdwn",
        text: "*Need help?* Ask in <#C123>",
      },
    ],
  });
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

test("plays a queued track next", async () => {
  const result = setup();
  await result.coordinator.start();
  Reflect.set(result.coordinator, "queue", [
    {
      id: "first",
      requesterId: "host",
      sourceInput: "first",
      canonicalUrl: "first",
      sourceId: "first",
      title: "First",
      artist: "Artist",
      status: "ready",
    },
    {
      id: "second",
      requesterId: "host",
      sourceInput: "second",
      canonicalUrl: "second",
      sourceId: "second",
      title: "Second",
      artist: "Artist",
      status: "ready",
    },
  ]);
  const queueView = {
    ...interaction(result.coordinator, "queue_play_next"),
    viewId: "view-1",
    viewHash: "hash-1",
    metadata: JSON.stringify({ sessionId: result.coordinator.id }),
    value: "second",
  };

  await result.coordinator.action(queueView);

  expect(
    (Reflect.get(result.coordinator, "queue") as { id: string }[]).map(
      (track) => track.id,
    ),
  ).toEqual(["second", "first"]);
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
    autoplay: "off",
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
  expect(second.media).toContainEqual(
    expect.objectContaining({ type: "lyrics_unavailable", entryId: "track" }),
  );
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

test("sends adaptive fade analysis for the current and next tracks", async () => {
  const tracks = {
    resolve: async (id: string) => ({
      sourceInput: id,
      canonicalUrl: id,
      sourceId: id,
      title: id,
      artist: "Artist",
    }),
    prepare: async (_track: unknown, _directory: string, id: string) =>
      `${id}.opus`,
    transition: () => ({
      introSeconds: 1,
      outroSeconds: 59,
      fadeInSeconds: 3,
      fadeOutSeconds: 5,
    }),
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  for (const id of ["a", "b"])
    await result.coordinator.action(
      interaction(result.coordinator, "add_track_to_queue", id),
    );
  expect(result.media).toContainEqual(
    expect.objectContaining({
      type: "play",
      fadeOutSeconds: 5,
      outroSeconds: 59,
    }),
  );
  expect(result.media).toContainEqual(
    expect.objectContaining({
      type: "preload",
      entries: expect.arrayContaining([
        expect.objectContaining({ fadeInSeconds: 3, introSeconds: 1 }),
      ]),
    }),
  );
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
  expect(player).not.toContain('"action_id":"add_track_to_queue"');
  expect(player).toContain('"text":"Add to queue"');
  await test.coordinator.action(
    interaction(test.coordinator, "open_add_to_queue"),
  );
  const modal = JSON.stringify(test.modals[0]);
  expect(modal).toContain('"type":"input","block_id":"track"');
  expect(modal).toContain('"type":"external_select"');
  expect(modal).toContain('"focus_on_load":true');
  expect(modal).toContain('"action_id":"open_bulk_add"');
  expect(modal).toContain('"text":{"type":"plain_text","text":"Add in bulk"}');

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

test("opens bulk link paste from the add modal and enqueues each URL", async () => {
  const resolved: string[] = [];
  const test = setup({
    resolveUrl: async (input: string) => {
      resolved.push(input);
      return {
        sourceInput: input,
        canonicalUrl: input,
        sourceId: input,
        title: input.split("/").at(-1) ?? "Track",
        artist: "Artist",
      };
    },
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog);
  await test.coordinator.start();

  await test.coordinator.action(
    interaction(test.coordinator, "open_add_to_queue"),
  );
  expect(JSON.stringify(test.modals[0])).toContain(
    '"action_id":"open_bulk_add"',
  );

  await test.coordinator.action({
    ...interaction(test.coordinator, "open_bulk_add"),
    messageTs: "",
    viewId: "view-1",
    viewHash: "hash-1",
  });
  const bulk = JSON.stringify(test.updatedModals.at(-1));
  expect(bulk).toContain('"callback_id":"bulk_add_to_queue"');
  expect(bulk).toContain('"multiline":true');
  expect(bulk).toContain('"block_id":"links"');

  await test.coordinator.action({
    ...interaction(
      test.coordinator,
      "bulk_add_to_queue",
      "",
      "view_submission",
    ),
    state: {
      links: {
        text: {
          value:
            "# playlist\nhttps://example.com/a.mp3\n\nhttps://example.com/b.mp3\n",
        },
      },
    },
  });
  expect(resolved).toEqual([
    "https://example.com/a.mp3",
    "https://example.com/b.mp3",
  ]);
  expect(Reflect.get(test.coordinator, "current")).toMatchObject({
    canonicalUrl: "https://example.com/a.mp3",
  });
  expect(Reflect.get(test.coordinator, "queue")).toEqual([
    expect.objectContaining({ canonicalUrl: "https://example.com/b.mp3" }),
  ]);
  await test.coordinator.endFromSlack();
});

test("truncates bulk links to remaining queue capacity before resolution", async () => {
  const resolved: string[] = [];
  const result = setup({
    resolveUrl: async (input: string) => {
      resolved.push(input);
      return {
        sourceInput: input,
        canonicalUrl: input,
        sourceId: input,
        title: "Track",
        artist: "Artist",
      };
    },
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog);
  await result.coordinator.start();
  Reflect.set(result.coordinator, "current", {
    id: "now",
    requesterId: "host",
    sourceId: "now",
    title: "Now",
    artist: "Artist",
    status: "ready",
  });

  const links = Array.from(
    { length: 50 },
    (_, index) => `https://example.com/${index}.mp3`,
  );
  await result.coordinator.action({
    ...interaction(
      result.coordinator,
      "bulk_add_to_queue",
      "",
      "view_submission",
    ),
    state: { links: { text: { value: links.join("\n") } } },
  });

  expect(resolved).toEqual(links.slice(0, 49));
  expect(Reflect.get(result.coordinator, "queue")).toHaveLength(49);
  expect(result.ephemeral.at(-1)).toBe(
    "Added 49 of 50 songs; the rest did not fit.",
  );
  await result.coordinator.endFromSlack();
});

test("bulk links use capacity reclaimed from queued autoplay", async () => {
  const resolved: string[] = [];
  const result = setup({
    resolveUrl: async (input: string) => {
      resolved.push(input);
      return {
        sourceInput: input,
        canonicalUrl: input,
        sourceId: input,
        title: "Track",
        artist: "Artist",
      };
    },
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog);
  await result.coordinator.start();
  Reflect.set(result.coordinator, "current", {
    id: "now",
    requesterId: "host",
    sourceId: "now",
    title: "Now",
    artist: "Artist",
    status: "ready",
  });
  Reflect.set(result.coordinator, "queue", [
    ...Array.from({ length: 47 }, (_, index) => ({
      id: `queued-${index}`,
      requesterId: "host",
      sourceId: `queued-${index}`,
      title: `Queued ${index}`,
      artist: "Artist",
      status: "ready",
    })),
    {
      id: "autoplay",
      requesterId: "bot",
      sourceId: "autoplay",
      title: "Autoplay",
      artist: "Radio",
      automatic: true,
      status: "ready",
    },
  ]);

  const links = [
    "https://example.com/first.mp3",
    "https://example.com/second.mp3",
  ];
  await result.coordinator.action({
    ...interaction(
      result.coordinator,
      "bulk_add_to_queue",
      "",
      "view_submission",
    ),
    state: { links: { text: { value: links.join("\n") } } },
  });

  expect(resolved).toEqual(links);
  expect(Reflect.get(result.coordinator, "queue")).toHaveLength(49);
  expect(Reflect.get(result.coordinator, "queue")).not.toContainEqual(
    expect.objectContaining({ automatic: true }),
  );
  await result.coordinator.endFromSlack();
});

test("truncates album adds to remaining queue capacity", async () => {
  const album = Array.from({ length: 5 }, (_, index) => ({
    sourceInput: `https://example.com/${index}`,
    canonicalUrl: `https://example.com/${index}`,
    sourceId: `song-${index}`,
    title: `Song ${index}`,
    artist: "Artist",
  }));
  const test = setup({
    resolve: async () => album,
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog);
  await test.coordinator.start();
  Reflect.set(test.coordinator, "current", {
    id: "now",
    requesterId: "host",
    sourceId: "now",
    title: "Now",
    artist: "Artist",
    status: "ready",
  });
  Reflect.set(
    test.coordinator,
    "queue",
    Array.from({ length: 48 }, (_, index) => ({
      id: `queued-${index}`,
      requesterId: "host",
      sourceId: `queued-${index}`,
      title: `Queued ${index}`,
      artist: "Artist",
      status: "ready",
    })),
  );

  await test.coordinator.action(
    interaction(test.coordinator, "add_track_to_queue", "bulkref_album"),
  );

  const queue = Reflect.get(test.coordinator, "queue") as { title: string }[];
  expect(queue.map((track) => track.title)).toEqual([
    ...Array.from({ length: 48 }, (_, index) => `Queued ${index}`),
    "Song 0",
  ]);
  expect(test.ephemeral.at(-1)).toBe(
    "Added 1 of 5 songs; the rest did not fit.",
  );
  await test.coordinator.endFromSlack();
});

test("rejects adds when the queue is completely full", async () => {
  const test = setup({
    resolve: async () => [
      {
        sourceInput: "https://example.com/a",
        canonicalUrl: "https://example.com/a",
        sourceId: "a",
        title: "A",
        artist: "Artist",
      },
      {
        sourceInput: "https://example.com/b",
        canonicalUrl: "https://example.com/b",
        sourceId: "b",
        title: "B",
        artist: "Artist",
      },
    ],
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog);
  await test.coordinator.start();
  Reflect.set(test.coordinator, "current", {
    id: "now",
    requesterId: "host",
    sourceId: "now",
    title: "Now",
    artist: "Artist",
    status: "ready",
  });
  Reflect.set(
    test.coordinator,
    "queue",
    Array.from({ length: 49 }, (_, index) => ({
      id: `queued-${index}`,
      requesterId: "host",
      sourceId: `queued-${index}`,
      title: `Queued ${index}`,
      artist: "Artist",
      status: "ready",
    })),
  );

  await test.coordinator.action(
    interaction(test.coordinator, "add_track_to_queue", "bulkref_album"),
  );
  expect(test.ephemeral.at(-1)).toBe("The queue is full.");
  expect(Reflect.get(test.coordinator, "queue")).toHaveLength(49);
  await test.coordinator.endFromSlack();
});

test("hides bulk add without add-bulk and rejects bulk submission", async () => {
  const resolved: string[] = [];
  const test = setup({
    resolveUrl: async (input: string) => {
      resolved.push(input);
      return {
        sourceInput: input,
        canonicalUrl: input,
        sourceId: input,
        title: "Track",
        artist: "Artist",
      };
    },
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog);
  await test.coordinator.start();
  await test.coordinator.action({
    ...interaction(test.coordinator, "open_add_to_queue"),
    userId: "guest",
  });
  expect(JSON.stringify(test.modals.at(-1))).not.toContain("open_bulk_add");

  await test.coordinator.action({
    ...interaction(
      test.coordinator,
      "bulk_add_to_queue",
      "",
      "view_submission",
    ),
    userId: "guest",
    state: {
      links: { text: { value: "https://example.com/a.mp3" } },
    },
  });
  expect(resolved).toEqual([]);
  expect(test.ephemeral.at(-1)).toContain("permission");
  await test.coordinator.endFromSlack();
});

test("adds a recent song from the expanded queue modal", async () => {
  let resolved = false;
  const store = new Store(":memory:");
  store.createSession({
    id: "previous",
    huddleId: "previous",
    callId: "previous",
    channelId: "channel",
    threadTs: "1",
    creatorId: "host",
    hostId: "host",
    volume: 0.6,
  });
  const titles = Array.from(
    { length: 15 },
    (_, index) => `Recent ${index + 1}`,
  );
  for (const [index, title] of titles.entries()) {
    store.addTrack({
      id: `recent-${index + 1}`,
      sessionId: "previous",
      requesterId: "host",
      sourceInput: `https://example.com/recent-${index + 1}`,
      canonicalUrl: `https://example.com/recent-${index + 1}`,
      sourceId: `recent-${index + 1}`,
      title,
      artist: "Artist",
      status: "played",
    });
  }
  const test = setup(
    {
      resolve: async () => ((resolved = true), {}),
      prepare: async () => "track.opus",
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    store,
  );
  await test.coordinator.start();

  await test.coordinator.action(
    interaction(test.coordinator, "open_add_to_queue"),
  );
  const modal = JSON.stringify(test.modals[0]);
  expect(modal).toContain('"block_id":"recent"');
  expect(modal).toContain('"type":"static_select"');
  for (const title of titles) expect(modal).toContain(`${title} — Artist`);

  await test.coordinator.action({
    ...interaction(
      test.coordinator,
      "add_track_to_queue",
      "",
      "view_submission",
    ),
    state: {
      recent: {
        selection: { selected_option: { value: "recent-1" } },
      },
    },
  });
  expect(resolved).toBeFalse();
  expect(
    store.db
      .query("SELECT title FROM tracks WHERE session_id = ?")
      .all(test.coordinator.id),
  ).toEqual([{ title: "Recent 1" }]);
  await test.coordinator.endFromSlack();
  store.close();
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

test("previous restarts the first track before five seconds", async () => {
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      sourceId: "a",
      title: "A",
      artist: "Artist",
    }),
    prepare: async () => "a.opus",
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "a"),
  );
  const playing = result.media.find(
    (value) => (value as { type?: string }).type === "play",
  ) as { entryId: string };
  result.coordinator.mediaEvent("playback_position", {
    entryId: playing.entryId,
    seconds: 2,
  });
  await result.coordinator.action(
    interaction(result.coordinator, "previous_track"),
  );
  expect(result.media).toContainEqual({ type: "seek", seconds: 0 });
  expect(
    result.media.filter(
      (value) => (value as { type?: string }).type === "play",
    ),
  ).toHaveLength(1);
  await result.coordinator.endFromSlack();
});

test("previous notices when nothing can be restarted", async () => {
  const result = setup();
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "previous_track"),
  );
  expect(result.ephemeral).toContain(
    "Nothing was playing when you pressed Previous.",
  );
  await result.coordinator.endFromSlack();
});

test("skipping plays a ready autoplay track ahead of a later manual track", async () => {
  const result = setup();
  await result.coordinator.start();
  Reflect.set(result.coordinator, "current", {
    id: "now",
    requesterId: "host",
    sourceInput: "now",
    canonicalUrl: "now",
    sourceId: "now",
    title: "Now",
    artist: "Artist",
    status: "playing",
    filePath: "now.opus",
  });
  Reflect.set(result.coordinator, "queue", [
    {
      id: "auto",
      requesterId: "bot",
      sourceInput: "auto",
      canonicalUrl: "auto",
      sourceId: "auto",
      title: "Auto",
      artist: "Radio",
      automatic: true,
      status: "ready",
      filePath: "auto.opus",
    },
    {
      id: "manual",
      requesterId: "host",
      sourceInput: "manual",
      canonicalUrl: "manual",
      sourceId: "manual",
      title: "Manual",
      artist: "Artist",
      status: "ready",
      filePath: "manual.opus",
    },
  ]);
  await result.coordinator.action(
    interaction(result.coordinator, "next_track"),
  );
  expect(
    result.media.filter(
      (value) => (value as { type?: string }).type === "play",
    ),
  ).toEqual([expect.objectContaining({ sourceId: "auto", entryId: "auto" })]);
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
  expect(modal).toContain('"value":"related"');
  expect(modal).toContain('"value":"huddle"');
  expect(modal).toContain("Huddle mix");
  expect(modal).toContain("Include my listening in Huddle mix");
  expect(modal).toContain(
    '"block_id":"transition","label":{"type":"plain_text","text":"Transitions"}',
  );
  expect(modal).toContain('"text":"Disabled"');
  expect(modal).not.toContain('"value":"crossfade"');
  expect(modal).toContain('"value":"gapless"');
  expect(modal).toContain('"text":"Adaptive crossfade"');
  expect(modal).toContain('"value":"adaptive"');
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
    '"text":{"type":"plain_text","text":"Add albums, playlists, and link lists"},"value":"add-bulk"',
  );

  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { mode: { selected_option: { value: "related" } } },
  };
  await result.coordinator.action(enable);
  await until(() => recommendations === 1);
  expect(result.sessions).toContainEqual({ autoplay: "related" });

  const disable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  disable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { mode: { selected_option: { value: "off" } } },
  };
  await result.coordinator.action(disable);
  expect(result.sessions).toContainEqual({ autoplay: "off" });

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
  transition.state = {
    transition: { mode: { selected_option: { value: "adaptive" } } },
  };
  await result.coordinator.action(transition);
  expect(result.sessions).toContainEqual({ transitionMode: "adaptive" });
  expect(result.media).toContainEqual({
    type: "transition_mode",
    mode: "adaptive",
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
    autoplay: { mode: { selected_option: { value: "related" } } },
    anchor: { enabled: { selected_options: [{ value: "enabled" }] } },
    host: { user: { selected_user: "guest" } },
    permissions: { selected: { selected_options: [{ value: "end-session" }] } },
  };
  await test.coordinator.action(save);
  expect(test.sessions).toContainEqual({ volume: 0.25 });
  expect(test.sessions).toContainEqual({ displayMode: "lyrics" });
  expect(test.sessions).toContainEqual({ autoplay: "related" });
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
    huddleMixOptIn: true,
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
    autoplay: { mode: { selected_option: { value: "related" } } },
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
    autoplay: { mode: { selected_option: { value: "related" } } },
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

test("skipping a manual track plays the queued autoplay recommendation", async () => {
  const ids = { a: "aaaaaaaaaaa", c: "ccccccccccc", d: "ddddddddddd" };
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      sourceId: ids.a,
      title: "A",
      artist: "Artist",
    }),
    upNextIds: async () => [ids.c, ids.d],
    resolveVideoId: async (id: string) => ({
      sourceInput: `https://music.youtube.com/watch?v=${id}`,
      canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
      sourceId: id,
      title: id,
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
    autoplay: { mode: { selected_option: { value: "related" } } },
  };
  await result.coordinator.action(enable);
  await until(
    () =>
      result.audit.filter(
        (value) => (value as unknown[])[0] === "track.autoplay_added",
      ).length === 1,
  );
  const queued = (
    Reflect.get(result.coordinator, "queue") as {
      id: string;
      sourceId: string;
    }[]
  )[0];
  expect(queued?.sourceId).toBe(ids.c);
  await result.coordinator.action(
    interaction(result.coordinator, "next_track"),
  );
  expect(
    result.media.filter(
      (value) => (value as { type?: string }).type === "play",
    ),
  ).toEqual([
    expect.objectContaining({ sourceId: ids.a }),
    expect.objectContaining({ sourceId: ids.c, entryId: queued?.id }),
  ]);
  expect(
    Reflect.get(result.coordinator, "history").map(
      (track: { sourceId: string }) => track.sourceId,
    ),
  ).toEqual([ids.a]);
  await result.coordinator.endFromSlack();
});

test("skipping an autoplay track plays the queued next autoplay", async () => {
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
    autoplay: { mode: { selected_option: { value: "related" } } },
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
  const queued = (
    Reflect.get(result.coordinator, "queue") as {
      id: string;
      sourceId: string;
    }[]
  )[0];
  expect(queued?.sourceId).toBe(ids.d);
  await result.coordinator.action(
    interaction(result.coordinator, "next_track"),
  );
  await until(
    () =>
      result.audit.filter(
        (value) => (value as unknown[])[0] === "track.autoplay_added",
      ).length === 3,
  );
  expect(resolved).toEqual([ids.c, ids.d, ids.e]);
  expect(
    Reflect.get(result.coordinator, "history").map(
      (track: { sourceId: string }) => track.sourceId,
    ),
  ).toEqual([ids.a, ids.c]);
  expect(
    result.media.filter(
      (value) => (value as { type?: string }).type === "play",
    ),
  ).toEqual([
    expect.objectContaining({ sourceId: ids.a }),
    expect.objectContaining({ sourceId: ids.c }),
    expect.objectContaining({ sourceId: ids.d, entryId: queued?.id }),
  ]);
  await result.coordinator.endFromSlack();
});

test("a late-prepared autoplay track still queues the following recommendation", async () => {
  const ids = {
    a: "aaaaaaaaaaa",
    c: "ccccccccccc",
    d: "ddddddddddd",
  };
  const preparing = new Map<string, () => void>();
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      sourceId: ids.a,
      title: "A",
      artist: "Artist",
    }),
    upNextIds: async () => [ids.c, ids.d],
    resolveVideoId: async (id: string) => ({
      sourceInput: `https://music.youtube.com/watch?v=${id}`,
      canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
      sourceId: id,
      title: id,
      artist: "Radio",
    }),
    prepare: async (track: { sourceId: string }) => {
      if (track.sourceId !== ids.a)
        await new Promise<void>((resolve) => {
          preparing.set(track.sourceId, resolve);
        });
      return `${track.sourceId}.opus`;
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
    autoplay: { mode: { selected_option: { value: "related" } } },
  };
  await result.coordinator.action(enable);
  const first = (
    result.media.find(
      (value) => (value as { type?: string }).type === "play",
    ) as { entryId: string }
  ).entryId;
  await until(() => preparing.has(ids.c));
  await result.coordinator.mediaEvent("track_ended", { entryId: first });
  preparing.get(ids.c)!();
  await until(() =>
    result.media.some(
      (value) =>
        (value as { type?: string; sourceId?: string }).type === "play" &&
        (value as { sourceId?: string }).sourceId === ids.c,
    ),
  );
  await until(() => preparing.has(ids.d));
  expect(
    result.audit.filter(
      (value) => (value as unknown[])[0] === "track.autoplay_added",
    ),
  ).toHaveLength(2);
  preparing.get(ids.d)?.();
  await result.coordinator.endFromSlack();
});

test("player shows autoplay search while the next song is being chosen", async () => {
  const ids = { a: "aaaaaaaaaaa", c: "ccccccccccc" };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      sourceId: ids.a,
      title: "A",
      artist: "Artist",
    }),
    upNextIds: async () => {
      await blocked;
      return [ids.c];
    },
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
    autoplay: { mode: { selected_option: { value: "related" } } },
  };
  await result.coordinator.action(enable);
  await Bun.sleep(150);
  expect(JSON.stringify(result.updates)).toContain("Finding next song");
  expect(JSON.stringify(result.updates)).toContain(
    "Autoplay is picking a recommendation",
  );
  release();
  await until(() =>
    JSON.stringify(result.updates).includes("Autoplay recommendation"),
  );
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
    autoplay: { mode: { selected_option: { value: "related" } } },
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
    autoplay: { mode: { selected_option: { value: "related" } } },
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

test("agent controls enforce the same permissions as the Slack UI", async () => {
  const result = setup();
  await result.coordinator.start();
  result.coordinator.memberJoined("listener");

  const denied = await result.coordinator.agentSkip("listener");
  expect(denied).toEqual({
    ok: false,
    error: "You do not have permission for that.",
  });

  const outsider = await result.coordinator.agentStatus("stranger");
  expect(outsider).toMatchObject({
    ok: false,
    error: "Join the huddle before using the player.",
  });

  const status = await result.coordinator.agentStatus("host");
  expect(status).toMatchObject({
    ok: true,
    youAreHost: true,
    scrobbling: { available: false },
  });

  const volume = await result.coordinator.agentSetVolume("host", 42);
  expect(volume).toEqual({ ok: true, volumePercent: 42 });
  expect(result.media).toContainEqual({ type: "volume", value: 0.42 });

  const scrobblingDenied = result.coordinator.agentSetSessionScrobbling(
    "host",
    true,
  );
  expect(scrobblingDenied).toEqual({
    ok: false,
    error: "Scrobbling is not available on this bot.",
  });

  await result.coordinator.endFromSlack();
});

test("agent can enable and disable session scrobbling when configured", async () => {
  const userStore = new Store(":memory:");
  userStore.setListenBrainzToken("host", "lb-token", "lb-user");
  userStore.setListenBrainzEnabled("host", true);
  userStore.setScrobblingMode("host", "ask");
  const scrobbling = new ScrobbleDispatcher(userStore, {});
  const test = setup(undefined, undefined, undefined, scrobbling, userStore);
  await test.coordinator.start();

  const status = test.coordinator.agentStatus("host");
  expect(status).toMatchObject({
    ok: true,
    scrobbling: {
      configured: true,
      sessionEnabled: false,
      mode: "ask",
    },
  });

  const enabled = test.coordinator.agentSetSessionScrobbling("host", true);
  expect(enabled).toEqual({ ok: true, sessionEnabled: true });
  expect(userStore.getSessionScrobbling(test.coordinator.id, "host")).toBe(
    true,
  );
  expect(test.coordinator.agentSetSessionScrobbling("host", true)).toEqual({
    ok: true,
    sessionEnabled: true,
    unchanged: true,
  });

  const disabled = test.coordinator.agentSetSessionScrobbling("host", false);
  expect(disabled).toEqual({ ok: true, sessionEnabled: false });
  expect(userStore.getSessionScrobbling(test.coordinator.id, "host")).toBe(
    false,
  );

  userStore.setListenBrainzToken("listener", "", "");
  test.coordinator.memberJoined("listener");
  expect(
    test.coordinator.agentSetSessionScrobbling("listener", true),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("Connect Last.fm or ListenBrainz"),
  });

  await test.coordinator.endFromSlack();
  userStore.close();
});

test("agentAdd aborts before queue mutation when signal is aborted", async () => {
  let resolveUrl!: (value: unknown) => void;
  const tracks = {
    resolve: async () => {
      throw new Error("expired");
    },
    resolveUrl: () =>
      new Promise((resolve) => {
        resolveUrl = resolve;
      }),
  } as never;
  const test = setup(tracks);
  await test.coordinator.start();
  const controller = new AbortController();
  const pending = test.coordinator.agentAdd(
    "host",
    "https://example.com/song",
    controller.signal,
  );
  await Bun.sleep(10);
  controller.abort();
  resolveUrl({
    sourceId: "song",
    title: "Song",
    artist: "Artist",
    duration: 120,
  });
  await expect(pending).rejects.toBeTruthy();
  const status = test.coordinator.agentStatus("host");
  expect(status).toMatchObject({ ok: true, queue: [] });
  await test.coordinator.endFromSlack();
});

test("agentAdd skips enqueue when aborted after resolve", async () => {
  const tracks = {
    resolve: async () => {
      throw new Error("expired");
    },
    resolveUrl: async () => ({
      sourceId: "song",
      title: "Song",
      artist: "Artist",
      duration: 120,
    }),
  } as never;
  const test = setup(tracks);
  await test.coordinator.start();
  const controller = new AbortController();
  controller.abort();
  await expect(
    test.coordinator.agentAdd(
      "host",
      "https://example.com/song",
      controller.signal,
    ),
  ).rejects.toBeTruthy();
  expect(test.coordinator.agentStatus("host")).toMatchObject({
    ok: true,
    queue: [],
  });
  await test.coordinator.endFromSlack();
});

test("agentAdd restores autoplay when aborted during autoplay hold", async () => {
  const tracks = {
    resolve: async () => {
      throw new Error("expired");
    },
    resolveUrl: async () => ({
      sourceId: "song",
      title: "Song",
      artist: "Artist",
      duration: 120,
    }),
    prepare: (
      _track: unknown,
      _directory: string,
      _entryId: string,
      signal?: AbortSignal,
    ) =>
      new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () =>
            reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  } as never;
  const test = setup(tracks);
  await test.coordinator.start();
  Reflect.set(test.coordinator, "queue", [
    {
      id: "auto",
      requesterId: "bot",
      sourceId: "auto",
      title: "Auto",
      artist: "Radio",
      automatic: true,
      status: "ready",
      filePath: "auto.opus",
    },
  ]);
  const controller = new AbortController();
  const pending = test.coordinator.agentAdd(
    "host",
    "https://example.com/song",
    controller.signal,
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const queue = Reflect.get(test.coordinator, "queue") as {
      automatic?: boolean;
    }[];
    if (!queue.some((track) => track.automatic)) {
      controller.abort();
      break;
    }
    await Bun.sleep(1);
  }
  await expect(pending).rejects.toBeTruthy();
  expect(test.coordinator.agentStatus("host")).toMatchObject({
    ok: true,
    queue: [
      expect.objectContaining({
        id: "auto",
        title: "Auto",
        automatic: true,
      }),
    ],
  });
  await test.coordinator.endFromSlack();
});

test("agentAdd restores autoplay when aborted during preparation", async () => {
  const tracks = {
    resolve: async () => {
      throw new Error("expired");
    },
    resolveUrl: async () => ({
      sourceId: "song",
      title: "Song",
      artist: "Artist",
      duration: 120,
    }),
    prepare: (
      _track: unknown,
      _directory: string,
      _entryId: string,
      signal?: AbortSignal,
    ) =>
      new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () =>
            reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  } as never;
  const test = setup(tracks);
  await test.coordinator.start();
  Reflect.set(test.coordinator, "queue", [
    {
      id: "auto",
      requesterId: "bot",
      sourceId: "auto",
      title: "Auto",
      artist: "Radio",
      automatic: true,
      status: "ready",
      filePath: "auto.opus",
    },
  ]);
  const controller = new AbortController();
  const pending = test.coordinator.agentAdd(
    "host",
    "https://example.com/song",
    controller.signal,
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const queue = Reflect.get(test.coordinator, "queue") as {
      id: string;
      automatic?: boolean;
    }[];
    if (queue.some((track) => track.id !== "auto" && !track.automatic)) {
      controller.abort();
      break;
    }
    await Bun.sleep(1);
  }
  await expect(pending).rejects.toBeTruthy();
  expect(test.coordinator.agentStatus("host")).toMatchObject({
    ok: true,
    queue: [
      expect.objectContaining({
        id: "auto",
        title: "Auto",
        automatic: true,
      }),
    ],
  });
  expect(
    test.ephemeral.some((text) => text.includes("Could not prepare")),
  ).toBe(false);
  await test.coordinator.endFromSlack();
});

test("agentAdd reports failure when preparation removes the track", async () => {
  const tracks = {
    resolve: async () => {
      throw new Error("expired");
    },
    resolveUrl: async () => ({
      sourceId: "song",
      title: "Song",
      artist: "Artist",
      duration: 120,
    }),
    prepare: async () => {
      throw new Error("private video");
    },
  } as never;
  const test = setup(tracks);
  await test.coordinator.start();
  const result = await test.coordinator.agentAdd(
    "host",
    "https://example.com/song",
  );
  expect(result).toMatchObject({
    ok: false,
    error: "Could not prepare that track.",
  });
  expect(test.coordinator.agentStatus("host")).toMatchObject({
    ok: true,
    queue: [],
  });
  await test.coordinator.endFromSlack();
});

test("agentAdd truncates albums to remaining queue capacity", async () => {
  const album = Array.from({ length: 4 }, (_, index) => ({
    sourceInput: `https://example.com/${index}`,
    canonicalUrl: `https://example.com/${index}`,
    sourceId: `song-${index}`,
    title: `Song ${index}`,
    artist: "Artist",
  }));
  const test = setup({
    resolve: async () => album,
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog);
  await test.coordinator.start();
  Reflect.set(test.coordinator, "current", {
    id: "now",
    requesterId: "host",
    sourceId: "now",
    title: "Now",
    artist: "Artist",
    status: "ready",
  });
  Reflect.set(
    test.coordinator,
    "queue",
    Array.from({ length: 48 }, (_, index) => ({
      id: `queued-${index}`,
      requesterId: "host",
      sourceId: `queued-${index}`,
      title: `Queued ${index}`,
      artist: "Artist",
      status: "ready",
    })),
  );

  const result = await test.coordinator.agentAdd("host", "bulkref_album");
  expect(result).toMatchObject({
    ok: true,
    added: [{ title: "Song 0", artist: "Artist" }],
    omitted: 3,
  });
  expect(Reflect.get(test.coordinator, "queue")).toHaveLength(49);
  await test.coordinator.endFromSlack();
});

test("agentUpdateSettings validates the full patch before mutating", async () => {
  const test = setup();
  await test.coordinator.start();
  expect(test.coordinator.agentStatus("host")).toMatchObject({
    ok: true,
    displayMode: "default",
    autoplay: "off",
  });
  const result = await test.coordinator.agentUpdateSettings("host", {
    displayMode: "lyrics",
    autoplay: true,
    hostUserId: "stranger",
  });
  expect(result).toMatchObject({
    ok: false,
    error: "That user is not in this huddle.",
  });
  expect(test.coordinator.agentStatus("host")).toMatchObject({
    ok: true,
    displayMode: "default",
    autoplay: "off",
    hostId: "host",
  });
  expect(test.sessions).not.toContainEqual({ displayMode: "lyrics" });
  expect(test.sessions).not.toContainEqual({ autoplay: "related" });
  await test.coordinator.endFromSlack();
});

function requestValue(calls: unknown[][]) {
  const blocks = calls.at(-1)?.[4] as {
    elements?: { action_id?: string; value?: string }[];
  }[];
  const accept = blocks
    ?.flatMap((block) => block.elements ?? [])
    .find((element) => element.action_id === "integration_accept");
  return accept?.value ?? "";
}

test("integration control requires host approval and grants without huddle membership", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.handleIntegrationCommand(
    "Ubot",
    {
      type: "request_control",
      channel: "channel",
      permissions: ["pause", "skip"],
      events: ["playback.state", "track"],
    },
    "9.0",
    "Dbot",
  );
  expect(test.ephemeralCalls[0]?.[1]).toBe("host");
  const prompt = JSON.stringify(test.ephemeralCalls[0]?.[4]);
  expect(prompt).toContain("Pause or resume");
  expect(prompt).toContain("Skip songs");
  expect(prompt).not.toContain('"pause"');
  expect(test.updates.flat().join("")).not.toContain("Controlling:");

  const denied = await test.coordinator.agentSkip("Ubot");
  expect(denied).toMatchObject({
    ok: false,
    error: "Join the huddle before using the player.",
  });

  const value = requestValue(test.ephemeralCalls);
  expect(parseIntegrationActionValue(value)?.sessionId).toBe(
    test.coordinator.id,
  );
  await test.coordinator.action({
    type: "block_actions",
    userId: "guest",
    actionId: "integration_accept",
    value,
    channelId: "channel",
    messageTs: "ephemeral",
    triggerId: "",
    metadata: "",
    state: {},
    responseUrl: "https://hooks.slack.com/actions/test",
  });
  expect(test.ephemeral.at(-1)).toBe("Only the host can approve that.");

  await test.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "integration_accept",
    value,
    channelId: "channel",
    messageTs: "ephemeral",
    triggerId: "",
    metadata: "",
    state: {},
    responseUrl: "https://hooks.slack.com/actions/test",
  });
  const accepted = test.dms.find((args) =>
    String(args[1]).includes("grant_accepted"),
  );
  expect(accepted?.[2]).toEqual({ channelId: "Dbot", threadTs: "9.0" });
  expect(JSON.parse(String(accepted?.[1]))).toMatchObject({
    v: 1,
    replyTo: "9.0",
    ok: true,
    type: "grant_accepted",
    permissions: ["pause", "skip"],
    events: ["playback.state", "track"],
  });
  expect(JSON.parse(String(accepted?.[1])).hostId).toBeUndefined();
  expect(JSON.stringify(test.updates.at(-1))).toContain("Controlling: <@Ubot>");

  expect(await test.coordinator.agentSkip("Ubot")).toMatchObject({
    ok: false,
    error: "Nothing is playing.",
  });
  expect(await test.coordinator.agentSetVolume("Ubot", 20)).toMatchObject({
    ok: false,
    error: "You do not have permission for that.",
  });

  await test.coordinator.handleIntegrationCommand(
    "Ubot2",
    {
      type: "request_control",
      channel: "channel",
      permissions: ["volume"],
      events: ["volume"],
    },
    "10.0",
    "Dbot2",
  );
  await test.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "integration_accept",
    value: requestValue(test.ephemeralCalls),
    channelId: "channel",
    messageTs: "ephemeral",
    triggerId: "",
    metadata: "",
    state: {},
  });
  expect(JSON.stringify(test.updates.at(-1))).toContain("<@Ubot>");
  expect(JSON.stringify(test.updates.at(-1))).toContain("<@Ubot2>");
  expect(await test.coordinator.agentSetVolume("Ubot2", 20)).toEqual({
    ok: true,
    volumePercent: 20,
  });
  const volumeEvent = test.dms.find((args) =>
    String(args[1]).includes("volume.changed"),
  );
  expect(JSON.parse(String(volumeEvent?.[1]))).toMatchObject({
    type: "event",
    channel: "channel",
    event: "volume.changed",
    payload: { volumePercent: 20 },
  });
  expect(JSON.parse(String(volumeEvent?.[1])).sessionId).toBeUndefined();
  expect(volumeEvent?.[0]).toBe("Ubot2");
  expect(
    test.dms.some(
      (args) =>
        String(args[0]) === "Ubot" &&
        String(args[1]).includes("volume.changed"),
    ),
  ).toBe(false);

  await test.coordinator.handleIntegrationCommand(
    "Ubot",
    { type: "release_control" },
    "11.0",
    "Dbot",
  );
  const afterRelease = JSON.stringify(test.updates.at(-1));
  expect(afterRelease).not.toContain("<@Ubot>");
  expect(afterRelease).toContain("<@Ubot2>");
  await test.coordinator.endFromSlack();
});

test("integration decline and revoke notify the bot in the request thread", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.handleIntegrationCommand(
    "Ubot",
    {
      type: "request_control",
      channel: "channel",
      permissions: ["pause"],
      events: ["playback.state"],
    },
    "9.0",
    "Dbot",
  );
  const value = requestValue(test.ephemeralCalls);
  await test.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "integration_decline",
    value,
    channelId: "channel",
    messageTs: "ephemeral",
    triggerId: "",
    metadata: "",
    state: {},
    responseUrl: "https://example.com/response",
  });
  expect(JSON.parse(String(test.dms.at(-1)?.[1]))).toMatchObject({
    type: "grant_declined",
    replyTo: "9.0",
  });
  await test.coordinator.handleIntegrationCommand(
    "Ubot",
    {
      type: "request_control",
      channel: "channel",
      permissions: ["pause"],
      events: ["playback.state"],
    },
    "12.0",
    "Dbot",
  );
  const granted = requestValue(test.ephemeralCalls);
  await test.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "integration_accept",
    value: granted,
    channelId: "channel",
    messageTs: "ephemeral",
    triggerId: "",
    metadata: "",
    state: {},
    responseUrl: "https://example.com/response",
  });
  await test.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "integration_revoke",
    value: granted,
    channelId: "channel",
    messageTs: "ephemeral",
    triggerId: "",
    metadata: "",
    state: {},
    responseUrl: "https://example.com/response",
  });
  expect(JSON.parse(String(test.dms.at(-1)?.[1]))).toMatchObject({
    type: "grant_revoked",
    replyTo: "12.0",
  });
  expect(await test.coordinator.agentToggle("Ubot")).toMatchObject({
    ok: false,
    error: "Join the huddle before using the player.",
  });
  await test.coordinator.endFromSlack();
});

test("host can revoke integration access from settings", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.handleIntegrationCommand(
    "Ubot",
    {
      type: "request_control",
      channel: "channel",
      permissions: ["pause", "skip"],
      events: ["playback.state"],
    },
    "9.0",
    "Dbot",
  );
  const granted = requestValue(test.ephemeralCalls);
  await test.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "integration_accept",
    value: granted,
    channelId: "channel",
    messageTs: "ephemeral",
    triggerId: "",
    metadata: "",
    state: {},
  });

  const guestOpen = interaction(test.coordinator, "open_settings");
  guestOpen.userId = "guest";
  await test.coordinator.action(guestOpen);
  expect(JSON.stringify(test.modals.at(-1))).not.toContain(
    '"block_id":"integrations"',
  );
  expect(JSON.stringify(test.modals.at(-1))).not.toContain(
    '"action_id":"integration_revoke"',
  );

  await test.coordinator.action(interaction(test.coordinator, "open_settings"));
  const hostSettings = JSON.stringify(test.modals.at(-1));
  expect(hostSettings).toContain('"block_id":"integrations"');
  expect(hostSettings).toContain("<@Ubot> has control of this session.");
  expect(hostSettings).toContain("Pause or resume");
  expect(hostSettings).toContain('"action_id":"integration_revoke"');

  const revoke = interaction(test.coordinator, "integration_revoke", granted);
  revoke.messageTs = "";
  revoke.metadata = JSON.stringify({ sessionId: test.coordinator.id });
  Object.assign(revoke, { viewId: "settings-view", viewHash: "hash" });
  await test.coordinator.action(revoke);
  expect(JSON.parse(String(test.dms.at(-1)?.[1]))).toMatchObject({
    type: "grant_revoked",
    replyTo: "9.0",
  });
  expect(test.updatedModals.at(-1)?.[0]).toBe("settings-view");
  expect(JSON.stringify(test.updatedModals.at(-1)?.[2])).not.toContain(
    '"block_id":"integrations"',
  );
  expect(JSON.stringify(test.updates.at(-1))).not.toContain("Controlling:");
  expect(await test.coordinator.agentToggle("Ubot")).toMatchObject({
    ok: false,
    error: "Join the huddle before using the player.",
  });
  await test.coordinator.endFromSlack();
});

test("settings paginates integration grants within the modal block limit", async () => {
  const test = setup();
  await test.coordinator.start();
  const integrations = new Map(
    Array.from({ length: 50 }, (_, index) => [
      `Ubot${index}`,
      {
        permissions: new Set(["pause"]),
        events: new Set<string>(),
        channel: "channel",
        dmChannelId: "Dbot",
        requestTs: "9.0",
        requestId: `r${index}`,
      },
    ]),
  );
  Reflect.set(test.coordinator, "integrations", integrations);
  await test.coordinator.action(interaction(test.coordinator, "open_settings"));
  const first = test.modals.at(-1) as [string, { blocks: unknown[] }];
  expect(first[1].blocks.length).toBeLessThanOrEqual(100);
  const firstBody = JSON.stringify(first);
  expect(firstBody).toContain("<@Ubot0> has control of this session.");
  expect(firstBody).toContain('"action_id":"integration_grants_next"');
  expect(firstBody).not.toContain("<@Ubot49> has control of this session.");

  const nextValue = first[1].blocks
    .flatMap(
      (block) =>
        (
          block as {
            elements?: { action_id?: string; value?: string }[];
          }
        ).elements ?? [],
    )
    .find((element) => element.action_id === "integration_grants_next")?.value;
  const next = interaction(
    test.coordinator,
    "integration_grants_next",
    nextValue,
  );
  next.messageTs = "";
  next.metadata = JSON.stringify({
    sessionId: test.coordinator.id,
    hostId: "host",
    integrationPage: 0,
  });
  Object.assign(next, { viewId: "settings-view", viewHash: "hash" });
  await test.coordinator.action(next);
  const second = test.updatedModals.at(-1)?.[2] as { blocks: unknown[] };
  expect(second.blocks.length).toBeLessThanOrEqual(100);
  const secondBody = JSON.stringify(second);
  expect(secondBody).toContain("<@Ubot49> has control of this session.");
  expect(secondBody).toContain('"action_id":"integration_grants_prev"');
  expect(secondBody).not.toContain("<@Ubot0> has control of this session.");
  await test.coordinator.endFromSlack();
});

test("integration command replies stay in the request thread when an agent method throws", async () => {
  const test = setup();
  await test.coordinator.start();
  await test.coordinator.handleIntegrationCommand(
    "Ubot",
    {
      type: "request_control",
      channel: "channel",
      permissions: ["skip"],
      events: ["track"],
    },
    "9.0",
    "Dbot",
  );
  await test.coordinator.action({
    type: "block_actions",
    userId: "host",
    actionId: "integration_accept",
    value: requestValue(test.ephemeralCalls),
    channelId: "channel",
    messageTs: "ephemeral",
    triggerId: "",
    metadata: "",
    state: {},
  });
  await test.coordinator.handleIntegrationCommand(
    "Ubot",
    { type: "skip" },
    "13.0",
    "Dbot",
  );
  expect(JSON.parse(String(test.dms.at(-1)?.[1]))).toMatchObject({
    v: 1,
    replyTo: "13.0",
    ok: false,
    type: "skip",
    error: "nothing_playing",
  });
  expect(test.dms.at(-1)?.[2]).toEqual({ channelId: "Dbot", threadTs: "13.0" });

  test.coordinator.agentSkip = async () => {
    throw new Error("media page crashed");
  };
  await test.coordinator.handleIntegrationCommand(
    "Ubot",
    { type: "skip" },
    "14.0",
    "Dbot",
  );
  expect(JSON.parse(String(test.dms.at(-1)?.[1]))).toMatchObject({
    v: 1,
    replyTo: "14.0",
    ok: false,
    type: "skip",
    error: "failed",
    message: "media page crashed",
  });
  expect(test.dms.at(-1)?.[2]).toEqual({ channelId: "Dbot", threadTs: "14.0" });
  await test.coordinator.endFromSlack();
});

test("unknown session targeting does not list other sessions", async () => {
  const test = setup();
  await test.coordinator.start();
  expect(test.coordinator.ownsChannel("missing")).toBe(false);
  expect(test.coordinator.ownsChannel("channel")).toBe(true);
  await test.coordinator.endFromSlack();
});

test("huddle mix autoplay uses compiled past additions when YouTube up next is empty", async () => {
  const store = new Store(":memory:");
  store.createSession({
    id: "previous",
    huddleId: "previous",
    callId: "previous",
    channelId: "channel",
    threadTs: "1",
    creatorId: "host",
    hostId: "host",
    volume: 0.6,
  });
  store.addTrack({
    id: "past-host",
    sessionId: "previous",
    requesterId: "host",
    sourceInput: "https://music.youtube.com/watch?v=hostpick001",
    canonicalUrl: "https://music.youtube.com/watch?v=hostpick001",
    sourceId: "hostpick001",
    title: "Host Favorite",
    artist: "Shared Band",
    status: "played",
  });
  store.addTrack({
    id: "past-guest",
    sessionId: "previous",
    requesterId: "guest",
    sourceInput: "https://music.youtube.com/watch?v=hostpick001",
    canonicalUrl: "https://music.youtube.com/watch?v=hostpick001",
    sourceId: "hostpick001",
    title: "Host Favorite",
    artist: "Shared Band",
    status: "played",
  });
  const recTracks = {
    searchSong: async () => ({
      sourceInput: "https://music.youtube.com/watch?v=mixpick0001",
      canonicalUrl: "https://music.youtube.com/watch?v=mixpick0001",
      sourceId: "mixpick0001",
      title: "Mix Pick",
      artist: "Shared Band",
    }),
    upNextTracks: async () => [],
  };
  const catalog = new RecommendationCatalog(store, recTracks);
  const result = setup(
    {
      ...recTracks,
      resolve: async () => ({
        sourceInput: "https://example.com/a",
        canonicalUrl: "https://example.com/a",
        sourceId: "aaaaaaaaaaa",
        title: "A",
        artist: "Artist",
      }),
      prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
      upNextIds: async () => [],
      resolveVideoId: async () => {
        throw new Error("huddle mix should use cached metadata");
      },
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    store,
    new Set(),
    undefined,
    catalog,
  );
  await result.coordinator.start();
  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    volume: { percent: { value: "60" } },
    autoplay: { mode: { selected_option: { value: "huddle" } } },
  };
  await result.coordinator.action(enable);
  await until(() =>
    result.audit.some(
      (value) => (value as unknown[])[0] === "track.autoplay_added",
    ),
  );
  expect(JSON.stringify(result.updates)).toContain("Autoplay recommendation");
  expect(JSON.stringify(result.audit)).toContain('"autoplayMode":"huddle"');
  expect(Reflect.get(result.coordinator, "current")).toMatchObject({
    sourceId: "hostpick001",
    automatic: true,
  });
  await result.coordinator.endFromSlack();
  store.close();
});

test("prefetches personal recommendations on start and join", async () => {
  const requested: string[][] = [];
  const catalog = {
    prefetchUsers(ids: Iterable<string>) {
      requested.push([...ids].sort());
    },
    userRecommendations() {
      return [];
    },
    recommendation() {
      return undefined;
    },
    autoplayCandidates: async () => [],
  } as unknown as RecommendationCatalog;
  const test = setup(
    {} as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  expect(requested[0]).toEqual(["guest", "host"]);
  test.coordinator.memberJoined("listener");
  expect(requested.at(-1)).toEqual(["listener"]);
  await test.coordinator.endFromSlack();
});

test("add modal omits recommendations when the cache is empty", async () => {
  const catalog = {
    prefetchUsers() {},
    userRecommendations() {
      return [];
    },
  } as unknown as RecommendationCatalog;
  const test = setup(
    {} as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  await test.coordinator.action(
    interaction(test.coordinator, "open_add_to_queue"),
  );
  expect(JSON.stringify(test.modals[0])).not.toContain(
    '"block_id":"recommend"',
  );
  await test.coordinator.endFromSlack();
});

test("add modal shows cached personal recommendations", async () => {
  const store = new Store(":memory:");
  store.createSession({
    id: "previous",
    huddleId: "previous",
    callId: "previous",
    channelId: "channel",
    threadTs: "1",
    creatorId: "host",
    hostId: "host",
    volume: 0.6,
  });
  store.addTrack({
    id: "past-host",
    sessionId: "previous",
    requesterId: "host",
    sourceInput: "https://music.youtube.com/watch?v=hostseed001",
    canonicalUrl: "https://music.youtube.com/watch?v=hostseed001",
    sourceId: "hostseed001",
    title: "Seed",
    artist: "Band",
    status: "played",
  });
  const recTracks = {
    searchSong: async () => undefined,
    upNextTracks: async () => [
      {
        sourceInput: "https://music.youtube.com/watch?v=foryou00001",
        canonicalUrl: "https://music.youtube.com/watch?v=foryou00001",
        sourceId: "foryou00001",
        title: "For You",
        artist: "Band",
      },
    ],
  };
  const catalog = new RecommendationCatalog(store, recTracks);
  let resolved = false;
  const test = setup(
    {
      ...recTracks,
      resolve: async () => ((resolved = true), {}),
      prepare: async () => "track.opus",
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    store,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  await catalog.prefetchUser("host");
  await test.coordinator.action(
    interaction(test.coordinator, "open_add_to_queue"),
  );
  const modal = JSON.stringify(test.modals[0]);
  expect(modal).toContain('"block_id":"recommend"');
  expect(modal).toContain("For You — Band");
  const recId = catalog.userRecommendations("host")[0]?.id;
  expect(recId).toBeTruthy();
  await test.coordinator.action({
    ...interaction(
      test.coordinator,
      "add_track_to_queue",
      "",
      "view_submission",
    ),
    state: {
      recommend: {
        selection: { selected_option: { value: recId } },
      },
    },
  });
  expect(resolved).toBeFalse();
  expect(
    store.db
      .query("SELECT title FROM tracks WHERE session_id = ?")
      .all(test.coordinator.id),
  ).toEqual([{ title: "For You" }]);
  await test.coordinator.endFromSlack();
  store.close();
});

test("opted-out listeners still see personal recommendations", async () => {
  const store = new Store(":memory:");
  store.setHuddleMixOptIn("host", false);
  store.createSession({
    id: "previous",
    huddleId: "previous",
    callId: "previous",
    channelId: "channel",
    threadTs: "1",
    creatorId: "host",
    hostId: "host",
    volume: 0.6,
  });
  store.addTrack({
    id: "past-host",
    sessionId: "previous",
    requesterId: "host",
    sourceInput: "https://music.youtube.com/watch?v=hostseed001",
    canonicalUrl: "https://music.youtube.com/watch?v=hostseed001",
    sourceId: "hostseed001",
    title: "Seed",
    artist: "Band",
    status: "played",
  });
  const recTracks = {
    searchSong: async () => undefined,
    upNextTracks: async () => [
      {
        sourceInput: "https://music.youtube.com/watch?v=foryou00001",
        canonicalUrl: "https://music.youtube.com/watch?v=foryou00001",
        sourceId: "foryou00001",
        title: "For You",
        artist: "Band",
      },
    ],
  };
  const catalog = new RecommendationCatalog(store, recTracks);
  const test = setup(
    recTracks as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    store,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  await catalog.prefetchUser("host");
  await test.coordinator.action(
    interaction(test.coordinator, "open_add_to_queue"),
  );
  expect(JSON.stringify(test.modals[0])).toContain('"block_id":"recommend"');
  expect(JSON.stringify(test.modals[0])).toContain("For You — Band");
  await test.coordinator.endFromSlack();
  store.close();
});

test("user settings persist huddle mix opt-out", async () => {
  const userStore = new Store(":memory:");
  const scrobbling = new ScrobbleDispatcher(userStore, {});
  const test = setup(undefined, undefined, undefined, scrobbling);
  await test.coordinator.start();
  expect(userStore.getUserScrobbling("host").huddleMixOptIn).toBe(true);
  const save = interaction(
    test.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  save.state = {
    huddle_mix: { enabled: { selected_options: [] } },
  };
  await test.coordinator.action(save);
  expect(userStore.getUserScrobbling("host").huddleMixOptIn).toBe(false);
  await test.coordinator.endFromSlack();
  userStore.close();
});

test("settings selects offer an initial option Slack can match", async () => {
  const store = new Store(":memory:");
  const scrobbling = new ScrobbleDispatcher(store, {});
  store.setListenBrainzToken("host", "token", "listener");
  const test = setup(undefined, undefined, undefined, scrobbling);
  await test.coordinator.start();
  await test.coordinator.action(interaction(test.coordinator, "open_settings"));
  const view = (test.modals.at(-1) as unknown[])[1] as {
    blocks: { block_id?: string; element?: Record<string, unknown> }[];
  };
  const selects = view.blocks.filter(
    (block) => block.element?.type === "static_select",
  );
  expect(selects.map((block) => block.block_id)).toEqual([
    "display",
    "autoplay",
    "transition",
    "permission_preset",
    "scrobbling_mode",
  ]);
  for (const block of selects) {
    const element = block.element as {
      options: unknown[];
      initial_option?: unknown;
    };
    // permission_preset intentionally opens unselected; every other select
    // preselects the current value.
    if (block.block_id === "permission_preset") {
      expect(element.initial_option).toBeUndefined();
      continue;
    }
    expect(element.initial_option).toBeDefined();
    // Slack rejects the view with invalid_arguments unless initial_option is
    // an exact copy of one of the options, descriptions included.
    expect(element.options).toContainEqual(element.initial_option);
  }
  await test.coordinator.endFromSlack();
  store.close();
});
