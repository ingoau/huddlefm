import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AuditLog } from "./audit-log.ts";
import { Coordinator } from "./coordinator.ts";
import type { LyricsCatalog } from "./lyrics.ts";
import type { SlackAppAdapter } from "./slack-app.ts";
import { Store, type DuckingMode, type SavedSession } from "./store.ts";
import type { TrackCatalog } from "./tracks.ts";
import { ScrobbleDispatcher } from "./scrobbling.ts";
import { parseIntegrationActionValue } from "./integration.ts";
import { addedBy, parseLikeValue } from "./coordinator-ui.ts";
import { RecommendationCatalog } from "./recommendations.ts";
import { ChannelManagers } from "./channel-managers.ts";
import { WorkspaceAdmins } from "./workspace-admins.ts";
import type { RolePermissions } from "./config.ts";

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
  workspaceAdmins?: WorkspaceAdmins,
  duckingMode: DuckingMode = "gentle",
  channelManagers?: ChannelManagers,
) {
  const posted: unknown[] = [];
  const updates: unknown[] = [];
  const deleted: unknown[] = [];
  const deletedOriginals: unknown[] = [];
  const modals: unknown[] = [];
  const pushedModals: unknown[] = [];
  const updatedModals: [unknown, unknown, unknown][] = [];
  const modalUpdateFailures: unknown[] = [];
  const ephemeral: string[] = [];
  const ephemeralCalls: unknown[][] = [];
  const dms: unknown[][] = [];
  const replacements: unknown[][] = [];
  const sessions: unknown[] = [];
  const created: unknown[] = [];
  const permissions: unknown[] = [];
  const suspensions: unknown[] = [];
  const queueOrders: string[][] = [];
  const usage: string[] = [];
  const media: unknown[] = [];
  const audit: unknown[] = [];
  const sessionChanges: unknown[] = [];
  const recordedMessages: unknown[] = [];
  const rememberedSkips: unknown[] = [];
  const likes: unknown[] = [];
  const unlikes: unknown[] = [];
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
      const failure = modalUpdateFailures.shift();
      if (failure) throw failure;
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
      createSession: (value: unknown) => {
        created.push(value);
      },
      setUi: () => {},
      setUiLocation: () => {},
      setTrack: () => {},
      removeTrack: () => {},
      addTrack: () => {},
      transaction: <T>(work: () => T) => work(),
      recentTracks: () => [],
      incrementUsage: (event: string) => {
        usage.push(event);
      },
      setSession: (_id: string, value: unknown) => {
        sessions.push(value);
      },
      activateSession: (_id: string, status: string) => {
        sessions.push({ activated: status });
      },
      suspendSession: (...args: unknown[]) => {
        suspensions.push(args);
      },
      setQueueOrder: (_id: string, queue: string[]) => {
        queueOrders.push(queue);
      },
      endSession: (...args: unknown[]) => {
        sessions.push({ status: "ended", args });
      },
      setEndMessage: () => {},
      sessionSaves: () => [],
      channelDefaults: () => undefined,
      channelDefaultsSaved: () => undefined,
      setPermission: (_id: string, capability: string, allowed: boolean) => {
        permissions.push({ capability, allowed });
      },
      recentPlays: () => [],
      recentRoomPlays: () => [],
      recentSkips: () => [],
      recordTrackPlay: () => {},
      recordAutoplaySkip: (value: unknown) => {
        rememberedSkips.push(value);
      },
      recentLikes: () => [],
      likeTrack: (value: unknown) => {
        likes.push(value);
      },
      unlikeTrack: (userId: string, title: string, artist: string) => {
        unlikes.push({ userId, title, artist });
        const index = likes.findIndex((like) => {
          const value = like as {
            userId: string;
            title: string;
            artist: string;
          };
          return (
            value.userId === userId &&
            value.title === title &&
            value.artist === artist
          );
        });
        if (index < 0) return false;
        likes.splice(index, 1);
        return true;
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
      duckingMode,
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
    workspaceAdmins,
    channelManagers,
  );
  return {
    coordinator,
    posted,
    created,
    updates,
    deleted,
    deletedOriginals,
    modals,
    pushedModals,
    updatedModals,
    modalUpdateFailures,
    ephemeral,
    ephemeralCalls,
    dms,
    replacements,
    sessions,
    permissions,
    suspensions,
    queueOrders,
    usage,
    media,
    audit,
    sessionChanges,
    recordedMessages,
    rememberedSkips,
    likes,
    unlikes,
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

test("refreshes a queue dialog again after a failed update", async () => {
  const result = setup();
  await result.coordinator.start();
  const open = interaction(result.coordinator, "view_full_queue");
  await result.coordinator.action(open);
  const queueChanged = Reflect.get(result.coordinator, "queueChanged").bind(
    result.coordinator,
  );

  result.modalUpdateFailures.push(
    Object.assign(new Error("An API error occurred: hash_conflict"), {
      data: { error: "hash_conflict" },
    }),
  );
  queueChanged();
  await until(() => result.updatedModals.length === 1);
  expect(result.updatedModals[0]?.[1]).toBe("hash-1");

  queueChanged();
  await until(() => result.updatedModals.length === 2);
  expect(result.updatedModals[1]?.[0]).toBe("view-1");
  expect(result.updatedModals[1]?.[1]).toBeUndefined();
  await result.coordinator.endFromSlack();
});

test("forgets a queue dialog Slack no longer holds", async () => {
  const result = setup();
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "view_full_queue"),
  );
  const queueChanged = Reflect.get(result.coordinator, "queueChanged").bind(
    result.coordinator,
  );

  result.modalUpdateFailures.push(
    Object.assign(new Error("An API error occurred: not_found"), {
      data: { error: "not_found" },
    }),
  );
  queueChanged();
  await until(() => result.updatedModals.length === 1);
  await until(
    () =>
      (Reflect.get(result.coordinator, "queueViews") as Map<string, unknown>)
        .size === 0,
  );

  queueChanged();
  await Bun.sleep(110);
  expect(result.updatedModals).toHaveLength(1);
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

function queued(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    requesterId: "host",
    sourceInput: id,
    canonicalUrl: id,
    sourceId: id,
    title: id.toUpperCase(),
    artist: "Artist",
    status: "ready",
    ...extra,
  };
}

const queueIds = (coordinator: Coordinator) =>
  (Reflect.get(coordinator, "queue") as { id: string }[]).map(
    (track) => track.id,
  );

// Math.random() === 0 turns the Fisher-Yates pass into a rotation, so the
// order a shuffle produces is known without giving up the real helper.
async function withoutRandomness(run: () => Promise<void>) {
  const random = Math.random;
  Math.random = () => 0;
  try {
    await run();
  } finally {
    Math.random = random;
  }
}

const playerBlocks = (coordinator: Coordinator) =>
  JSON.stringify(
    (Reflect.get(coordinator, "blocks") as () => unknown[]).call(coordinator),
  );

const queueDialog = (coordinator: Coordinator, userId: string) =>
  JSON.stringify(
    (Reflect.get(coordinator, "queueView") as (id: string) => unknown).call(
      coordinator,
      userId,
    ),
  );

test("adds the queued autoplay pick to the queue for the user", async () => {
  const result = setup();
  await result.coordinator.start();
  Reflect.set(
    result.coordinator,
    "current",
    queued("playing", { status: "playing" }),
  );
  Reflect.set(result.coordinator, "queue", [
    queued("pick", { requesterId: "bot", automatic: true, discovery: true }),
  ]);
  expect(queueDialog(result.coordinator, "host")).toContain("Add to queue");
  expect(queueDialog(result.coordinator, "host")).not.toContain("Move to…");

  await result.coordinator.action({
    ...interaction(result.coordinator, "queue_keep_autoplay", "pick"),
    viewId: "view-1",
    viewHash: "hash-1",
    metadata: JSON.stringify({ sessionId: result.coordinator.id }),
  });

  const [entry] = Reflect.get(result.coordinator, "queue") as {
    automatic?: boolean;
    requesterId: string;
    discovery?: boolean;
  }[];
  expect(entry).toMatchObject({ automatic: false, requesterId: "host" });
  expect(entry?.discovery).toBeUndefined();
  expect(queueDialog(result.coordinator, "host")).toContain("Added by <@host>");
  expect(queueDialog(result.coordinator, "host")).not.toContain("Add to queue");
  expect(queueDialog(result.coordinator, "host")).toContain("Move to…");
  expect(result.usage).toContain("added");
  expect(
    result.audit.some(
      (value) =>
        (value as unknown[])[0] === "track.added" &&
        JSON.stringify(value).includes("autoplay_kept"),
    ),
  ).toBe(true);
  await result.coordinator.endFromSlack();
});

test("tells the user when an autoplay pick they kept fails to prepare", async () => {
  let fail = (_error: Error) => {};
  const tracks = {
    prepare: () =>
      new Promise<string>((_resolve, reject) => {
        fail = reject;
      }),
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  Reflect.set(
    result.coordinator,
    "current",
    queued("playing", { status: "playing" }),
  );
  const pick = queued("pick", {
    requesterId: "bot",
    automatic: true,
    status: "preparing",
  });
  Reflect.set(result.coordinator, "queue", [pick]);
  const preparing = (
    Reflect.get(result.coordinator, "prepareAutoplay") as (
      entry: unknown,
      controller: AbortController,
    ) => Promise<boolean>
  ).call(result.coordinator, pick, new AbortController());

  await result.coordinator.action({
    ...interaction(result.coordinator, "queue_keep_autoplay", "pick"),
    viewId: "view-1",
    viewHash: "hash-1",
    metadata: JSON.stringify({ sessionId: result.coordinator.id }),
  });
  fail(new Error("Video unavailable"));

  expect(await preparing).toBe(false);
  expect(queueIds(result.coordinator)).toEqual([]);
  expect(result.ephemeral).toContain(
    "Could not prepare PICK: Video unavailable",
  );
  await result.coordinator.endFromSlack();
});

test("shuffles the pending queue and leaves the playing track alone", async () => {
  const result = setup();
  await result.coordinator.start();
  Reflect.set(
    result.coordinator,
    "current",
    queued("playing", {
      status: "playing",
    }),
  );
  Reflect.set(
    result.coordinator,
    "queue",
    ["a", "b", "c", "d", "e"].map((id) => queued(id)),
  );

  await withoutRandomness(() =>
    result.coordinator.action(interaction(result.coordinator, "shuffle_queue")),
  );

  expect(
    (Reflect.get(result.coordinator, "current") as { id: string }).id,
  ).toBe("playing");
  expect(queueIds(result.coordinator)).toEqual(["b", "c", "d", "e", "a"]);
  expect(result.audit).toContainEqual([
    "queue.shuffled",
    "host",
    { sessionId: result.coordinator.id, count: 5 },
  ]);
  expect(result.usage).toContain("shuffled");
  expect(result.queueOrders.at(-1)).toEqual(["b", "c", "d", "e", "a"]);
  await result.coordinator.endFromSlack();
});

test("a shuffle is a permutation of the pending queue", async () => {
  const result = setup();
  await result.coordinator.start();
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  Reflect.set(
    result.coordinator,
    "queue",
    ids.map((id) => queued(id)),
  );

  // Real randomness, so assert the invariants rather than an exact order.
  for (let round = 0; round < 10; round++) {
    await result.coordinator.action(
      interaction(result.coordinator, "shuffle_queue"),
    );
    expect([...queueIds(result.coordinator)].sort()).toEqual([...ids].sort());
  }
  await result.coordinator.endFromSlack();
});

test("shuffle leaves a queued autoplay pick in its slot", async () => {
  const result = setup();
  await result.coordinator.start();
  Reflect.set(result.coordinator, "queue", [
    queued("auto", { automatic: true }),
    queued("a"),
    queued("b"),
    queued("c"),
  ]);

  await withoutRandomness(() =>
    result.coordinator.action(interaction(result.coordinator, "shuffle_queue")),
  );

  expect(queueIds(result.coordinator)).toEqual(["auto", "b", "c", "a"]);
  await result.coordinator.endFromSlack();
});

test("shuffle needs the manage-queue permission", async () => {
  const result = setup();
  await result.coordinator.start();
  Reflect.set(
    result.coordinator,
    "queue",
    ["a", "b", "c"].map((id) => queued(id)),
  );

  await result.coordinator.action({
    ...interaction(result.coordinator, "shuffle_queue"),
    userId: "guest",
  });

  expect(result.ephemeral).toEqual(["You do not have permission for that."]);
  expect(queueIds(result.coordinator)).toEqual(["a", "b", "c"]);
  expect(result.usage).not.toContain("shuffled");
  expect(result.queueOrders).toEqual([]);
  expect(result.audit).toContainEqual([
    "action.denied",
    "guest",
    { sessionId: result.coordinator.id, capability: "manage-queue" },
  ]);
  await result.coordinator.endFromSlack();
});

test("agentShuffle shuffles under the manage-queue permission", async () => {
  const result = setup();
  await result.coordinator.start();
  result.coordinator.memberJoined("listener");
  Reflect.set(
    result.coordinator,
    "queue",
    ["a", "b", "c"].map((id) => queued(id)),
  );

  expect(await result.coordinator.agentShuffle("listener")).toEqual({
    ok: false,
    error: "You do not have permission for that.",
  });
  expect(queueIds(result.coordinator)).toEqual(["a", "b", "c"]);

  await withoutRandomness(async () => {
    expect(await result.coordinator.agentShuffle("host")).toEqual({
      ok: true,
      shuffled: 3,
    });
  });
  expect(queueIds(result.coordinator)).toEqual(["b", "c", "a"]);

  Reflect.set(result.coordinator, "queue", [queued("a")]);
  expect(await result.coordinator.agentShuffle("host")).toEqual({
    ok: false,
    error: "There are not enough queued songs to shuffle.",
  });
  await result.coordinator.endFromSlack();
});

test("a shuffled queue survives a restore", async () => {
  const store = new Store(":memory:");
  const result = setup(undefined, undefined, undefined, undefined, store);
  await result.coordinator.start();
  const ids = ["a", "b", "c", "d", "e"];
  for (const id of ids)
    store.addTrack({
      id,
      sessionId: result.coordinator.id,
      requesterId: "host",
      sourceInput: id,
      canonicalUrl: id,
      sourceId: id,
      title: id.toUpperCase(),
      artist: "Artist",
      status: "ready",
    });
  Reflect.set(
    result.coordinator,
    "queue",
    ids.map((id) => queued(id)),
  );

  await withoutRandomness(() =>
    result.coordinator.action(interaction(result.coordinator, "shuffle_queue")),
  );
  const shuffled = queueIds(result.coordinator);
  expect(shuffled).not.toEqual(ids);

  // A restart that never reached suspend still restores the new order.
  const saved = store.resumableSessions(Date.now(), 600_000).sessions[0];
  expect(saved?.tracks.map((track) => track.id)).toEqual(shuffled);
  const restored = setup(undefined, undefined, saved, undefined, store);
  expect(queueIds(restored.coordinator)).toEqual(shuffled);

  await result.coordinator.endFromSlack();
  store.close();
});

test("offers shuffle only when there is something to shuffle", async () => {
  const result = setup();
  await result.coordinator.start();

  Reflect.set(result.coordinator, "queue", [queued("a")]);
  expect(queueDialog(result.coordinator, "host")).not.toContain(
    "shuffle_queue",
  );

  // A lone autoplay pick is not counted, so neither is a queue holding one.
  Reflect.set(result.coordinator, "queue", [
    queued("a"),
    queued("auto", { automatic: true }),
  ]);
  expect(queueDialog(result.coordinator, "host")).not.toContain(
    "shuffle_queue",
  );

  Reflect.set(result.coordinator, "queue", [queued("a"), queued("b")]);
  expect(queueDialog(result.coordinator, "host")).toContain("shuffle_queue");
  expect(queueDialog(result.coordinator, "host")).toContain("clear_queue");
  expect(queueDialog(result.coordinator, "guest")).not.toContain(
    "shuffle_queue",
  );
  // Shuffle and clear live only in the queue dialog.
  expect(playerBlocks(result.coordinator)).not.toContain("shuffle_queue");
  expect(playerBlocks(result.coordinator)).not.toContain("clear_queue");
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
    loopMode: "off",
    transitionMode: "none",
    displayMode: "lyrics",
    anchorEnabled: true,
    playbackSeconds: 42,
    listenedSeconds: 84,
    mediaMode: "music",
    captions: false,
    watchedSeconds: 0,
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
  expect(JSON.stringify(result.posted[0])).not.toContain('"block_id":"seek_');
  await action("add_track_to_queue", "a");
  expect(JSON.stringify(result.updates)).toContain("Added by <@host>");
  const playing = JSON.stringify(result.updates.at(-1));
  expect(playing).toContain('"block_id":"seek_');
  expect(playing).toContain('"action_id":"seek_back"');
  expect(playing).toContain('"action_id":"seek_forward"');
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

function volumeUp(userId: string) {
  return {
    type: "block_actions" as const,
    userId,
    actionId: "volume_up",
    value: "",
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  };
}

function workspaceAdmins(
  permissions: RolePermissions,
  admins = ["admin"],
  lookups: string[] = [],
) {
  return new WorkspaceAdmins(
    async (userId) => (lookups.push(userId), admins.includes(userId)),
    { permissions },
  );
}

test("treats a workspace admin as a manager when granted host", async () => {
  const lookups: string[] = [];
  const result = setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    workspaceAdmins("host", ["admin"], lookups),
  );
  await result.coordinator.start();
  await result.coordinator.action(volumeUp("admin"));
  expect(result.media).toContainEqual({ type: "volume", value: 0.65 });
  expect(lookups).toEqual(["admin"]);

  // The cached answer keeps later actions off the Slack API.
  await result.coordinator.action(volumeUp("admin"));
  expect(lookups).toEqual(["admin"]);
  expect(result.media).toContainEqual({ type: "volume", value: 0.7 });
  await result.coordinator.endFromSlack();
});

test("leaves workspace admins alone when granted nothing", async () => {
  const lookups: string[] = [];
  const result = setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    workspaceAdmins("none", ["admin"], lookups),
  );
  await result.coordinator.start();
  await result.coordinator.action(volumeUp("admin"));
  expect(result.ephemeral).toContain(
    "Join the huddle before using the player.",
  );
  expect(result.media).not.toContainEqual({ type: "volume", value: 0.65 });
  expect(lookups).toEqual([]);
  await result.coordinator.endFromSlack();
});

test("an excluded workspace admin gains nothing", async () => {
  const result = setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(["admin"]),
    undefined,
    undefined,
    workspaceAdmins("host", ["admin"]),
  );
  await result.coordinator.start();
  await result.coordinator.action(volumeUp("admin"));
  expect(result.ephemeral).toContain(
    "Join the huddle before using the player.",
  );
  expect(result.media).not.toContainEqual({ type: "volume", value: 0.65 });
  await result.coordinator.endFromSlack();
});

test("an excluded configured manager cannot approve integration control", async () => {
  const result = setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(["manager"]),
  );
  await result.coordinator.start();
  await result.coordinator.handleIntegrationCommand(
    "Ubot",
    { type: "request_control", channel: "channel", permissions: ["pause"] },
    "9.0",
    "Dbot",
  );
  await result.coordinator.action({
    type: "block_actions",
    userId: "manager",
    actionId: "integration_accept",
    value: requestValue(result.ephemeralCalls),
    channelId: "channel",
    messageTs: "ephemeral",
    triggerId: "",
    metadata: "",
    state: {},
    responseUrl: "https://hooks.slack.com/actions/test",
  });
  expect(result.ephemeral.at(-1)).toBe("Only the host can approve that.");
  expect(
    result.dms.some((args) => String(args[1]).includes("grant_accepted")),
  ).toBe(false);
  await result.coordinator.endFromSlack();
});

test("a workspace admin holds host powers over settings", async () => {
  const result = setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    workspaceAdmins("host", ["admin"]),
  );
  await result.coordinator.start();
  await result.coordinator.action({
    type: "view_submission",
    userId: "admin",
    actionId: "save_settings",
    value: "",
    channelId: "channel",
    messageTs: "",
    triggerId: "",
    metadata: JSON.stringify({
      sessionId: result.coordinator.id,
      hostId: "host",
    }),
    state: { host: { user: { selected_user: "guest" } } },
  });
  expect(result.coordinator.hostUserId()).toBe("guest");
  await result.coordinator.endFromSlack();
});

function channelManagerSetup(
  managers = ["channel-manager"],
  excludedUserIds = new Set<string>(),
  permissions: RolePermissions = "end",
  admins?: WorkspaceAdmins,
  store?: Store,
) {
  const lookups: string[] = [];
  // How many modals had opened when each lookup asked Slack.
  const modalsAtLookup: number[] = [];
  const result = setup(
    undefined,
    undefined,
    undefined,
    undefined,
    store,
    excludedUserIds,
    undefined,
    undefined,
    admins,
    undefined,
    new ChannelManagers(
      async (channelId) => {
        lookups.push(channelId);
        modalsAtLookup.push(result.modals.length);
        return managers;
      },
      { permissions },
    ),
  );
  const act = (userId: string, actionId: string) =>
    result.coordinator.action({
      ...interaction(result.coordinator, actionId, result.coordinator.id),
      userId,
    });
  return { ...result, lookups, modalsAtLookup, act };
}

function ended(result: { sessions: unknown[] }) {
  return result.sessions.some(
    (value) => (value as { status?: string }).status === "ended",
  );
}

test("a channel manager outside the huddle can end the session", async () => {
  const result = channelManagerSetup();
  await result.coordinator.start();
  await result.act("channel-manager", "open_settings");
  expect(JSON.stringify(result.modals.at(-1))).toContain("Loading…");
  const [viewId, , view] = result.updatedModals.at(-1)!;
  expect(viewId).toBe("view-1");
  expect(JSON.stringify(view)).toContain("end_session");
  expect(result.lookups).toEqual(["channel"]);
  await result.act("channel-manager", "end_session");
  expect(ended(result)).toBeTrue();
  expect(result.media).toContainEqual({ type: "leave" });
});

function blockButtons(view: unknown, blockId: string) {
  const blocks = (
    view as {
      blocks: { block_id?: string; elements?: { action_id: string }[] }[];
    }
  ).blocks;
  return (
    blocks
      .find((block) => block.block_id === blockId)
      ?.elements?.map((element) => element.action_id) ?? []
  );
}

// The buttons under the session's settings.
const settingsButtons = (view: unknown) =>
  blockButtons(view, "session_actions");
// The Channel tab's buttons for the channel's defaults.
const channelButtons = (view: unknown) =>
  blockButtons(view, "channel_defaults_actions");
// The tabs a Settings view offers.
const settingsTabsOf = (view: unknown) =>
  blockButtons(view, "settings_tabs").map((id) =>
    id.replace("settings_tab_", ""),
  );

// Presses a Settings button with the modal's state and metadata.
function pressInSettings(
  result: Pick<ReturnType<typeof setup>, "coordinator">,
  userId: string,
  actionId: string,
  state: Parameters<Coordinator["action"]>[0]["state"] = {},
  hostId = "host",
  metadata: Record<string, unknown> = {},
  value: string = result.coordinator.id,
) {
  return result.coordinator.action({
    ...interaction(result.coordinator, actionId, value),
    userId,
    messageTs: "",
    viewId: "view-1",
    metadata: JSON.stringify({
      sessionId: result.coordinator.id,
      hostId,
      ...metadata,
    }),
    state,
  });
}

// Switches open Settings to a tab and returns what it then shows.
async function settingsTab(
  result: Pick<ReturnType<typeof setup>, "coordinator" | "updatedModals">,
  userId: string,
  tab: string,
  metadata: Record<string, unknown> = {},
) {
  await pressInSettings(
    result,
    userId,
    `settings_tab_${tab}`,
    {},
    "host",
    metadata,
  );
  return result.updatedModals.at(-1)![2];
}

test("the configured manager can save and clear the channel's defaults", async () => {
  const store = new Store(":memory:");
  const result = channelManagerSetup(
    ["channel-manager"],
    new Set(),
    "end",
    undefined,
    store,
  );
  await result.coordinator.start();
  await result.act("manager", "open_settings");
  const opened = (result.modals.at(-1) as unknown[])[1];
  expect(settingsTabsOf(opened)).toEqual(["you", "session", "channel", "host"]);
  expect(settingsButtons(opened)).toEqual(["open_end_session"]);
  // Clear appears only once there is something saved.
  const channel = await settingsTab(result, "manager", "channel");
  expect(channelButtons(channel)).toEqual(["save_channel_defaults"]);
  expect(JSON.stringify(channel)).toContain("None saved.");

  // An edit on the Session tab, kept while the Channel tab is shown, counts.
  await pressInSettings(
    result,
    "manager",
    "save_channel_defaults",
    { anchor: { enabled: { selected_options: [{ value: "enabled" }] } } },
    "host",
    {
      tab: "channel",
      draft: { autoplay: { mode: { selected_option: { value: "huddle" } } } },
    },
  );
  expect(result.ephemeral).toContain(
    "Saved. New sessions in this channel will start with these settings.",
  );
  // What the form showed was saved; the session waits for Settings to save.
  expect(store.channelDefaults("channel")).toEqual({
    volume: 0.6,
    autoplay: "huddle",
    videoAutoplay: false,
    loopMode: "off",
    displayMode: "default",
    transitionMode: "none",
    duckingMode: "gentle",
    anchorEnabled: true,
    progressBar: true,
    permissions: ["add", "remove-own"],
  });
  expect(result.sessions).not.toContainEqual({ autoplay: "huddle" });
  const saved = result.updatedModals.at(-1)![2];
  expect(channelButtons(saved)).toEqual([
    "save_channel_defaults",
    "clear_channel_defaults",
  ]);
  expect(JSON.stringify(saved)).toContain("Saved by <@manager>");

  await pressInSettings(
    result,
    "manager",
    "clear_channel_defaults",
    {},
    "host",
    { tab: "channel" },
  );
  expect(store.channelDefaults("channel")).toBeUndefined();
  expect(result.ephemeral).toContain(
    "Cleared. New sessions in this channel will start with the usual settings.",
  );
  expect(channelButtons(result.updatedModals.at(-1)![2])).toEqual([
    "save_channel_defaults",
  ]);
  await result.coordinator.endFromSlack();
});

test("saving the channel's defaults from stale Settings is refused", async () => {
  const store = new Store(":memory:");
  const result = channelManagerSetup(
    ["channel-manager"],
    new Set(),
    "end",
    undefined,
    store,
  );
  await result.coordinator.start();
  await pressInSettings(
    result,
    "manager",
    "save_channel_defaults",
    {},
    "guest",
  );
  expect(result.ephemeral).toContain("Settings are stale; reopen them.");
  expect(store.channelDefaults("channel")).toBeUndefined();
  await result.coordinator.endFromSlack();
});

test("only channel managers can save the channel's defaults", async () => {
  const store = new Store(":memory:");
  const result = channelManagerSetup(
    ["channel-manager"],
    new Set(),
    "end",
    undefined,
    store,
  );
  await result.coordinator.start();
  await pressInSettings(result, "host", "save_channel_defaults");
  expect(result.ephemeral).toContain(
    "Only channel managers can change defaults for this channel.",
  );
  expect(store.channelDefaults("channel")).toBeUndefined();
  await result.coordinator.endFromSlack();
});

test("a channel manager who sees no settings cannot save them as defaults", async () => {
  const store = new Store(":memory:");
  const result = channelManagerSetup(
    ["guest"],
    new Set(),
    "end",
    undefined,
    store,
  );
  await result.coordinator.start();
  await result.act("guest", "open_settings");
  expect(settingsTabsOf(result.updatedModals.at(-1)![2])).toEqual([
    "you",
    "session",
  ]);
  await pressInSettings(result, "guest", "save_channel_defaults", {
    permissions: { selected: { selected_options: [{ value: "clear" }] } },
  });
  expect(result.ephemeral).toContain(
    "Only channel managers can change defaults for this channel.",
  );
  expect(store.channelDefaults("channel")).toBeUndefined();
  await result.coordinator.endFromSlack();
});

test("a channel manager saves only the settings they can see", async () => {
  const store = new Store(":memory:");
  store.setChannelDefaults(
    "channel",
    { permissions: ["add", "volume"] },
    "manager",
  );
  const result = channelManagerSetup(
    ["guest"],
    new Set(),
    "end",
    undefined,
    store,
  );
  await result.coordinator.start();
  await result.act("guest", "open_settings");
  expect(settingsTabsOf(result.updatedModals.at(-1)![2])).toEqual([
    "you",
    "session",
    "channel",
  ]);
  expect(channelButtons(await settingsTab(result, "guest", "channel"))).toEqual(
    ["save_channel_defaults", "clear_channel_defaults"],
  );
  // The permissions are not in the guest's form, so a forged value is ignored.
  await pressInSettings(result, "guest", "save_channel_defaults", {
    volume: { percent: { selected_option: { value: "25" } } },
    autoplay: { mode: { selected_option: { value: "huddle" } } },
    permissions: { selected: { selected_options: [{ value: "clear" }] } },
  });
  expect(store.channelDefaults("channel")).toEqual({
    volume: 0.25,
    permissions: ["add", "volume"],
  });
  await result.coordinator.endFromSlack();
});

test("Settings in a direct message offers no channel defaults", async () => {
  const result = channelManagerSetup();
  Object.assign(result.coordinator.room, { sourceChannelId: "D123" });
  await result.coordinator.start();
  await result.act("manager", "open_settings");
  expect(settingsTabsOf((result.modals.at(-1) as unknown[])[1])).toEqual([
    "you",
    "session",
    "host",
  ]);
  await result.coordinator.endFromSlack();
});

test("channel managers granted nothing are not offered the channel's defaults", async () => {
  const result = channelManagerSetup(["host"], new Set(), "none");
  await result.coordinator.start();
  await result.act("host", "open_settings");
  expect(result.lookups).toEqual([]);
  expect(settingsTabsOf((result.modals.at(-1) as unknown[])[1])).toEqual([
    "you",
    "session",
    "host",
  ]);
  await result.coordinator.endFromSlack();
});

test("a channel manager deletes the channel's saved sessions from Settings", async () => {
  const store = new Store(":memory:");
  const channel = { type: "channel", id: "channel" } as const;
  const hosts = store.addSessionSave(channel, "Host's", "host", [], {});
  const guests = store.addSessionSave(channel, "Guest's", "guest", [], {});
  const result = channelManagerSetup(
    ["guest"],
    new Set(),
    "end",
    undefined,
    store,
  );
  await result.coordinator.start();
  await result.act("guest", "open_settings");
  expect(result.lookups).toEqual(["channel"]);
  const tab = JSON.stringify(await settingsTab(result, "guest", "channel"));
  expect(tab).toContain(`"block_id":"channel_save_${hosts}"`);
  expect(tab).toContain(`"block_id":"channel_save_${guests}"`);

  await pressInSettings(
    result,
    "guest",
    "delete_channel_save",
    {},
    "host",
    { tab: "channel" },
    hosts,
  );
  expect(store.sessionSaves([channel]).map((save) => save.id)).toEqual([
    guests,
  ]);
  const after = JSON.stringify(result.updatedModals.at(-1)![2]);
  expect(after).not.toContain(`channel_save_${hosts}`);
  expect(after).toContain(`channel_save_${guests}`);
  expect(result.audit).toContainEqual([
    "session.save_deleted",
    "guest",
    expect.objectContaining({
      saveId: hosts,
      name: "Host's",
      ownerType: "channel",
    }),
  ]);
  await result.coordinator.endFromSlack();
  store.close();
});

test("others delete only the channel saves they made", async () => {
  const store = new Store(":memory:");
  const channel = { type: "channel", id: "channel" } as const;
  const hosts = store.addSessionSave(channel, "Host's", "host", [], {});
  const guests = store.addSessionSave(channel, "Guest's", "guest", [], {});
  const result = channelManagerSetup(
    ["someone-else"],
    new Set(),
    "end",
    undefined,
    store,
  );
  await result.coordinator.start();
  await result.act("guest", "open_settings");
  const tab = JSON.stringify(await settingsTab(result, "guest", "channel"));
  expect(tab).not.toContain(`channel_save_${hosts}`);
  expect(tab).toContain(`channel_save_${guests}`);
  expect(tab).not.toContain("channel_defaults_actions");

  await pressInSettings(
    result,
    "guest",
    "delete_channel_save",
    {},
    "host",
    { tab: "channel" },
    hosts,
  );
  expect(result.ephemeral.at(-1)).toBe(
    "Only whoever saved it or a channel manager can delete that saved session.",
  );
  await pressInSettings(
    result,
    "guest",
    "delete_channel_save",
    {},
    "host",
    { tab: "channel" },
    guests,
  );
  expect(store.sessionSaves([channel]).map((save) => save.id)).toEqual([hosts]);
  // With nothing left on it, the Channel tab goes and Settings falls back.
  expect(settingsTabsOf(result.updatedModals.at(-1)![2])).toEqual([]);
  await result.coordinator.endFromSlack();
  store.close();
});

test("edits on one Settings tab are kept across tabs and saved together", async () => {
  const result = setup();
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "open_settings"),
  );
  // Leaving the Session tab with an unsaved change.
  await pressInSettings(
    result,
    "host",
    "settings_tab_host",
    { autoplay: { mode: { selected_option: { value: "huddle" } } } },
    "host",
    { tab: "session" },
  );
  const host = result.updatedModals.at(-1)![2] as {
    private_metadata: string;
    blocks: { block_id?: string }[];
  };
  expect(host.blocks.map((block) => block.block_id)).toContain("permissions");
  expect(JSON.parse(host.private_metadata)).toMatchObject({
    tab: "host",
    draft: { autoplay: { mode: { selected_option: { value: "huddle" } } } },
  });
  // Coming back shows it again.
  await pressInSettings(
    result,
    "host",
    "settings_tab_session",
    {},
    "host",
    JSON.parse(host.private_metadata),
  );
  const session = result.updatedModals.at(-1)![2] as {
    blocks: { block_id?: string; element?: Record<string, any> }[];
  };
  expect(
    session.blocks.find((block) => block.block_id === "autoplay")!.element!
      .initial_option.value,
  ).toBe("huddle");

  await result.coordinator.action({
    ...interaction(result.coordinator, "save_settings", "", "view_submission"),
    metadata: host.private_metadata,
    state: {
      permissions: { selected: { selected_options: [{ value: "skip" }] } },
    },
  });
  expect(Reflect.get(result.coordinator, "autoplayMode")).toBe("huddle");
  expect([
    ...(Reflect.get(result.coordinator, "allowed") as Set<string>),
  ]).toEqual(["skip"]);
  await result.coordinator.endFromSlack();
});

test("a restored session keeps its own settings over the channel's defaults", async () => {
  const store = new Store(":memory:");
  store.setChannelDefaults(
    "channel",
    { volume: 0.35, autoplay: "related", permissions: ["add", "skip"] },
    "manager",
  );
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
    loopMode: "off",
    transitionMode: "none",
    displayMode: "lyrics",
    anchorEnabled: false,
    playbackSeconds: 0,
    listenedSeconds: 0,
    mediaMode: "music",
    captions: false,
    watchedSeconds: 0,
    resumeUntil: 180_000,
    permissions: ["add"],
    tracks: [],
  };
  const result = setup(undefined, undefined, restored, undefined, store);
  const coordinator = result.coordinator;
  expect(Reflect.get(coordinator, "volume")).toBe(0.4);
  expect(Reflect.get(coordinator, "autoplayMode")).toBe("off");
  expect([...Reflect.get(coordinator, "allowed")]).toEqual(["add"]);
  expect(Reflect.get(coordinator, "channelDefaultsApplied")).toBeFalse();
});

test("a new session starts with its channel's saved defaults", async () => {
  const store = new Store(":memory:");
  store.setChannelDefaults(
    "channel",
    {
      volume: 0.35,
      autoplay: "related",
      displayMode: "lyrics",
      transitionMode: "gapless",
      duckingMode: "strong",
      permissions: ["add", "skip"],
    },
    "channel-manager",
  );
  const result = channelManagerSetup(
    ["channel-manager"],
    new Set(),
    "end",
    undefined,
    store,
  );
  await result.coordinator.start();
  expect(result.media).toEqual(
    expect.arrayContaining([
      { type: "volume", value: 0.35 },
      { type: "display_mode", mode: "lyrics" },
      { type: "transition_mode", mode: "gapless" },
      { type: "ducking_mode", mode: "strong" },
    ]),
  );
  const row = store.db
    .query("SELECT volume, autoplay, display_mode FROM sessions WHERE id = ?")
    .get(result.coordinator.id);
  expect(row).toEqual({
    volume: 0.35,
    autoplay: "related",
    display_mode: "lyrics",
  });
  const allowed = store.db
    .query(
      "SELECT capability FROM permissions WHERE session_id = ? AND allowed = 1 ORDER BY capability",
    )
    .all(result.coordinator.id);
  expect(allowed).toEqual([{ capability: "add" }, { capability: "skip" }]);
  await result.coordinator.endFromSlack();
});

test("a channel manager in the huddle can end it whatever the permissions", async () => {
  const result = channelManagerSetup(["guest"]);
  await result.coordinator.start();
  await result.act("guest", "end_session");
  expect(ended(result)).toBeTrue();
});

test("a channel manager gains nothing beyond ending the session", async () => {
  const result = channelManagerSetup();
  await result.coordinator.start();
  await result.coordinator.action(volumeUp("channel-manager"));
  expect(result.ephemeral).toContain(
    "Join the huddle before using the player.",
  );
  expect(result.media).not.toContainEqual({ type: "volume", value: 0.65 });
  await result.act("channel-manager", "open_settings");
  const modal = JSON.stringify(result.updatedModals.at(-1)![2]);
  expect(modal).toContain("end_session");
  expect(modal).not.toContain('"volume"');
  expect(modal).not.toContain("permission_preset");
  await result.coordinator.endFromSlack();
});

test("other users cannot end the session and the host needs no lookup", async () => {
  const result = channelManagerSetup();
  await result.coordinator.start();
  await result.act("guest", "end_session");
  expect(result.ephemeral).toContain(
    "You do not have permission to end this session.",
  );
  expect(ended(result)).toBeFalse();
  expect(result.lookups).toEqual(["channel"]);
  await result.act("host", "end_session");
  expect(ended(result)).toBeTrue();
  expect(result.lookups).toEqual(["channel"]);
});

test("an excluded channel manager cannot end the session", async () => {
  const result = channelManagerSetup(
    ["channel-manager"],
    new Set(["channel-manager"]),
  );
  await result.coordinator.start();
  await result.act("channel-manager", "end_session");
  expect(result.ephemeral).toContain(
    "Join the huddle before using the player.",
  );
  expect(ended(result)).toBeFalse();
  await result.coordinator.endFromSlack();
});

test("a channel manager can end the session through the agent", async () => {
  const result = channelManagerSetup();
  await result.coordinator.start();
  expect(await result.coordinator.agentEnd("channel-manager")).toEqual({
    ok: true,
    ended: true,
  });
  expect(ended(result)).toBeTrue();
});

test("a workspace admin outside the huddle can end the session by default", async () => {
  const result = channelManagerSetup(
    [],
    new Set(),
    "end",
    workspaceAdmins("end", ["admin"]),
  );
  await result.coordinator.start();
  await result.coordinator.action(volumeUp("admin"));
  expect(result.ephemeral).toContain(
    "Join the huddle before using the player.",
  );
  expect(result.media).not.toContainEqual({ type: "volume", value: 0.65 });
  await result.act("admin", "open_settings");
  const modal = JSON.stringify(result.updatedModals.at(-1)![2]);
  expect(modal).toContain("end_session");
  expect(modal).not.toContain('"volume"');
  await result.act("admin", "end_session");
  expect(ended(result)).toBeTrue();
});

test("a channel manager granted host powers acts as a manager", async () => {
  const result = channelManagerSetup(["channel-manager"], new Set(), "host");
  await result.coordinator.start();
  await result.coordinator.action(volumeUp("channel-manager"));
  expect(result.media).toContainEqual({ type: "volume", value: 0.65 });
  expect(result.lookups).toEqual(["channel"]);
  await result.coordinator.endFromSlack();
});

test("channel managers granted nothing cannot end the session", async () => {
  const result = channelManagerSetup(["channel-manager"], new Set(), "none");
  await result.coordinator.start();
  await result.act("channel-manager", "end_session");
  expect(result.ephemeral).toContain(
    "Join the huddle before using the player.",
  );
  expect(ended(result)).toBeFalse();
  expect(result.lookups).toEqual([]);
  await result.coordinator.endFromSlack();
});

test("someone with two roles gets the higher grant", async () => {
  const adminLookups: string[] = [];
  const result = channelManagerSetup(
    ["channel-manager"],
    new Set(),
    "end",
    workspaceAdmins("host", ["channel-manager"], adminLookups),
  );
  await result.coordinator.start();
  await result.coordinator.action(volumeUp("channel-manager"));
  expect(result.media).toContainEqual({ type: "volume", value: 0.65 });
  expect(adminLookups).toEqual(["channel-manager"]);
  await result.coordinator.endFromSlack();
});

test("Settings shows a loading view while a role lookup asks Slack", async () => {
  const result = channelManagerSetup();
  await result.coordinator.start();
  await result.act("channel-manager", "open_settings");
  // The trigger ID is spent before Slack is asked anything.
  expect(result.modalsAtLookup).toEqual([1]);
  expect(result.modals).toHaveLength(1);
  expect(JSON.stringify(result.updatedModals.at(-1)![2])).toContain(
    "end_session",
  );

  // Once the answer is cached, Settings opens directly.
  await result.act("channel-manager", "open_settings");
  expect(result.modals).toHaveLength(2);
  expect(JSON.stringify(result.modals.at(-1))).toContain("end_session");
  expect(result.modalsAtLookup).toEqual([1]);
  await result.coordinator.endFromSlack();
});

test("a refusal replaces the loading view instead of leaving it", async () => {
  const result = channelManagerSetup();
  await result.coordinator.start();
  await result.act("outsider", "open_settings");
  expect(JSON.stringify(result.updatedModals.at(-1)![2])).toContain(
    "Join the huddle before using the player.",
  );
  expect(result.ephemeral).not.toContain(
    "Join the huddle before using the player.",
  );
  await result.coordinator.endFromSlack();
});

test("Settings opens directly when no role needs a lookup", async () => {
  const result = channelManagerSetup();
  await result.coordinator.start();
  // The configured manager holds every role without asking Slack.
  await result.act("manager", "open_settings");
  expect(result.lookups).toEqual([]);
  expect(result.updatedModals).toHaveLength(0);
  expect(JSON.stringify(result.modals.at(-1))).toContain("save_settings");
  await result.coordinator.endFromSlack();
});

test("Settings asks who manages the channel when the user could save its defaults", async () => {
  const result = channelManagerSetup();
  await result.coordinator.start();
  // The host can already end the session, but sees settings a channel
  // manager could save.
  await result.act("host", "open_settings");
  expect(result.lookups).toEqual(["channel"]);
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

test("reconciling participants removes a user whose leave event was missed", async () => {
  const result = setup(undefined, {
    aloneMs: 10,
    idleMs: 100,
    pausedMs: 100,
    warningMs: 20,
  });
  await result.coordinator.start();
  const diff = await result.coordinator.reconcileParticipants(["bot"]);
  expect(diff).toEqual({ added: [], removed: ["host", "guest"] });
  await until(() => result.posted.length === 2);
  expect(result.posted[1]).toEqual([
    "channel",
    "1.0",
    "I’m alone in the Huddle, so I’ll leave in 2 minutes.",
  ]);
  await until(() =>
    result.media.some((value) => (value as { type?: string }).type === "leave"),
  );
});

test("reconciling participants cancels the alone timeout when someone is actually present", async () => {
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
  const diff = await result.coordinator.reconcileParticipants([
    "bot",
    "host",
    "guest",
  ]);
  expect(diff).toEqual({ added: ["host", "guest"], removed: [] });
  // The alone timer from the leave events would have fired within 10ms.
  await Bun.sleep(30);
  expect(result.media).not.toContainEqual({ type: "leave" });
  expect(result.posted).toHaveLength(2);
  await result.coordinator.endFromSlack();
});

test("reconciling participants ignores a snapshot a join has overtaken", async () => {
  const result = setup(undefined, {
    aloneMs: 10,
    idleMs: 100,
    pausedMs: 100,
    warningMs: 20,
  });
  await result.coordinator.start();
  const version = result.coordinator.participantsVersion;
  const pending = result.coordinator.reconcileParticipants(
    ["bot", "host", "guest"],
    version,
  );
  // A real join lands while the Slack round trip is in flight; member events
  // apply synchronously, outside the coordinator queue.
  result.coordinator.memberJoined("newbie");
  expect(await pending).toBeUndefined();
  expect(result.coordinator.hasParticipant("newbie")).toBe(true);
  await result.coordinator.endFromSlack();
});

test("reconciling participants ignores a snapshot a leave has overtaken", async () => {
  const result = setup(undefined, {
    aloneMs: 10,
    idleMs: 100,
    pausedMs: 100,
    warningMs: 20,
  });
  await result.coordinator.start();
  await result.coordinator.memberLeft("guest");
  const version = result.coordinator.participantsVersion;
  const pending = result.coordinator.reconcileParticipants(
    ["bot", "host"],
    version,
  );
  // The last human leaves while the Slack round trip is in flight. Restoring
  // the snapshot would cancel the alone timeout their leave just armed.
  await result.coordinator.memberLeft("host");
  expect(await pending).toBeUndefined();
  expect(result.coordinator.hasParticipant("host")).toBe(false);
  await until(() =>
    result.media.some((value) => (value as { type?: string }).type === "leave"),
  );
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
      volume: { percent: { selected_option: { value: "37.25" } } },
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
  // Settings opens on the session's tab; the others follow it here.
  const modal = JSON.stringify([
    result.modals.at(-1),
    await settingsTab(result, "host", "you"),
    await settingsTab(result, "host", "host"),
  ]);
  expect(modal).toContain('"block_id":"autoplay"');
  expect(modal).toContain('"value":"related"');
  expect(modal).toContain('"value":"huddle"');
  expect(modal).toContain("Huddle mix");
  expect(modal).toContain('"block_id":"loop"');
  expect(modal).toContain('"value":"track"');
  expect(modal).toContain('"value":"queue"');
  expect(modal).toContain("Include in Huddle mix");
  expect(modal).toContain('"action_id":"sources:added"');
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
    '"block_id":"settings_tabs"',
    '"block_id":"volume"',
    '"block_id":"display"',
    '"block_id":"autoplay"',
    '"block_id":"loop"',
    '"block_id":"transition"',
    '"block_id":"anchor"',
    '"block_id":"session_actions"',
    '"block_id":"host"',
    '"text":"Permissions"',
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
    volume: { percent: { selected_option: { value: "60" } } },
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
    volume: { percent: { selected_option: { value: "60" } } },
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

  const loop = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  loop.state = {
    loop: { mode: { selected_option: { value: "track" } } },
  };
  await result.coordinator.action(loop);
  expect(result.sessions).toContainEqual({ loopMode: "track" });
  await result.coordinator.endFromSlack();
});

test("track loop replays the current song without advancing", async () => {
  const tracks = {
    resolve: async (value: string) => ({
      sourceInput: value,
      canonicalUrl: value,
      sourceId: value.includes("b") ? "bbbbbbbbbbb" : "aaaaaaaaaaa",
      title: value.includes("b") ? "B" : "A",
      artist: "Artist",
      duration: 100,
    }),
    prepare: async (metadata: { sourceId: string }) =>
      `${metadata.sourceId}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "https://a"),
  );
  await Bun.sleep(0);
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "https://b"),
  );
  await Bun.sleep(0);
  const first = (
    result.media.find(
      (value) => (value as { type?: string }).type === "play",
    ) as { entryId: string }
  ).entryId;
  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    loop: { mode: { selected_option: { value: "track" } } },
  };
  await result.coordinator.action(enable);
  const preload = result.media.findLast(
    (value) => (value as { type?: string }).type === "preload",
  ) as { nextEntryId?: string };
  expect(preload.nextEntryId).toBeUndefined();
  await result.coordinator.mediaEvent("track_ended", { entryId: first });
  expect(result.media).toContainEqual({
    type: "replay",
    entryId: first,
    introSeconds: 0,
  });
  const plays = result.media.filter(
    (value) => (value as { type?: string }).type === "play",
  );
  expect(plays).toHaveLength(1);
  expect(
    (
      result.media.findLast(
        (value) => (value as { type?: string }).type === "play",
      ) as { entryId: string }
    ).entryId,
  ).toBe(first);
  expect(result.coordinator.agentStatus("host")).toMatchObject({
    nowPlaying: expect.objectContaining({ title: "A" }),
    queue: [expect.objectContaining({ title: "B" })],
  });
  await result.coordinator.endFromSlack();
});

test("queue loop rotates finished tracks to the end", async () => {
  const tracks = {
    resolve: async (value: string) => ({
      sourceInput: value,
      canonicalUrl: value,
      sourceId: value.includes("b") ? "bbbbbbbbbbb" : "aaaaaaaaaaa",
      title: value.includes("b") ? "B" : "A",
      artist: "Artist",
      duration: 100,
    }),
    prepare: async (metadata: { sourceId: string }) =>
      `${metadata.sourceId}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "https://a"),
  );
  await Bun.sleep(0);
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "https://b"),
  );
  await Bun.sleep(0);
  const first = (
    result.media.find(
      (value) => (value as { type?: string }).type === "play",
    ) as { entryId: string }
  ).entryId;
  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    loop: { mode: { selected_option: { value: "queue" } } },
  };
  await result.coordinator.action(enable);
  await result.coordinator.mediaEvent("track_ended", { entryId: first });
  const status = result.coordinator.agentStatus("host");
  expect(status).toMatchObject({
    nowPlaying: expect.objectContaining({ title: "B" }),
    queue: [expect.objectContaining({ title: "A" })],
  });
  expect((status as { queue: { id: string }[] }).queue[0]!.id).not.toBe(first);
  await result.coordinator.endFromSlack();
});

test("queue loop keeps how a looped autoplay pick was made", async () => {
  const result = setup();
  await result.coordinator.start();
  Reflect.set(result.coordinator, "loopMode", "queue");
  Reflect.set(result.coordinator, "current", {
    ...playingTrack(),
    autoplayMode: "huddle",
    autoplaySources: ["lastfm"],
  });
  await result.coordinator.mediaEvent("track_ended", { entryId: "playing" });
  await until(() =>
    result.audit.some((value) => (value as unknown[])[0] === "track.started"),
  );
  expect(
    result.audit.find((value) => (value as unknown[])[0] === "track.started"),
  ).toEqual([
    "track.started",
    undefined,
    expect.objectContaining({
      sourceId: "likedlikedl",
      origin: "autoplay",
      autoplayMode: "huddle",
      discovery: true,
      autoplaySources: ["lastfm"],
    }),
  ]);
  await result.coordinator.endFromSlack();
});

test("queue loop keeps the shared media file until the last copy goes", async () => {
  const directory = `${tmpdir()}/huddlefm-loop-${crypto.randomUUID()}`;
  await mkdir(directory, { recursive: true });
  const filePath = `${directory}/a.opus`;
  await Bun.write(filePath, "audio");
  const tracks = {
    resolve: async (value: string) => {
      const letter = value.slice(-1);
      return {
        sourceInput: value,
        canonicalUrl: value,
        sourceId: letter.repeat(11),
        title: letter.toUpperCase(),
        artist: "Artist",
        duration: 100,
      };
    },
    prepare: async (metadata: { sourceId: string }) =>
      `${directory}/${metadata.sourceId[0]}.opus`,
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "https://a"),
  );
  await Bun.sleep(0);
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "https://b"),
  );
  await Bun.sleep(0);
  const first = (
    result.media.find(
      (value) => (value as { type?: string }).type === "play",
    ) as { entryId: string }
  ).entryId;
  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = { loop: { mode: { selected_option: { value: "queue" } } } };
  await result.coordinator.action(enable);
  await result.coordinator.mediaEvent("track_ended", { entryId: first });

  // The looped copy shares the finished track's prepared file, so removing it
  // must not delete the file the history entry still plays.
  const copy = (
    result.coordinator.agentStatus("host") as { queue: { id: string }[] }
  ).queue[0]!.id;
  expect(copy).not.toBe(first);
  expect(await result.coordinator.agentRemove("host", copy)).toMatchObject({
    ok: true,
  });
  expect(await Bun.file(filePath).exists()).toBe(true);

  // An entry that is the only holder of its file still releases it.
  await Bun.write(`${directory}/c.opus`, "audio");
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "https://c"),
  );
  await Bun.sleep(0);
  const solo = (
    result.coordinator.agentStatus("host") as {
      queue: { id: string; title: string }[];
    }
  ).queue.find((entry) => entry.title === "C")!.id;
  expect(await result.coordinator.agentRemove("host", solo)).toMatchObject({
    ok: true,
  });
  expect(await Bun.file(`${directory}/c.opus`).exists()).toBe(false);

  await result.coordinator.endFromSlack();
  await rm(directory, { recursive: true, force: true });
});

test("track loop suppresses autoplay recommendations", async () => {
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
    upNextIds: async () => (recommendations++, ["bbbbbbbbbbb"]),
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "a"),
  );
  await Bun.sleep(0);
  const enable = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    autoplay: { mode: { selected_option: { value: "related" } } },
    loop: { mode: { selected_option: { value: "track" } } },
  };
  await result.coordinator.action(enable);
  await Bun.sleep(10);
  expect(recommendations).toBe(0);
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
  for (const block of ["volume", "display", "autoplay", "loop", "anchor"])
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
    volume: { percent: { selected_option: { value: "25" } } },
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
  // Their own settings are all a guest can change, so there are no tabs.
  expect(JSON.stringify(test.modals.at(-1))).toContain(
    '"block_id":"huddle_mix"',
  );
  expect(settingsTabsOf((test.modals.at(-1) as unknown[])[1])).toEqual([]);

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
  expect(settingsTabsOf((test.modals.at(-1) as unknown[])[1])).toEqual([
    "you",
    "session",
  ]);
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
  const settings = JSON.stringify(await settingsTab(test, "host", "you"));
  expect(settings).toContain('"action_id":"connect_lastfm"');
  expect(settings).not.toContain('"block_id":"scrobbling_mode"');
  expect(settings).not.toContain('"action_id":"toggle_session_scrobbling"');

  const connect = interaction(test.coordinator, "connect_lastfm");
  connect.messageTs = "";
  connect.metadata = JSON.stringify({
    sessionId: test.coordinator.id,
    hostId: "host",
    tab: "you",
  });
  await test.coordinator.action(connect);
  const login = JSON.stringify(test.pushedModals.at(-1));
  expect(login).toContain(
    "https://www.last.fm/api/auth/?api_key=api-key&token=request-token",
  );
  expect(login).toContain('"action_id":"continue_lastfm"');

  const finish = interaction(test.coordinator, "continue_lastfm");
  finish.messageTs = "";
  // The login dialog carries Settings' own metadata, to redraw it on its tab.
  finish.metadata = (
    test.pushedModals.at(-1) as [unknown, { private_metadata: string }]
  )[1].private_metadata;
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
  expect(test.updatedModals).toHaveLength(3);
  expect(test.updatedModals[2]?.[0]).toBe("settings-view");
  expect(JSON.stringify(test.updatedModals[2]?.[2])).toContain(
    '"action_id":"disconnect_lastfm"',
  );
  expect(JSON.stringify(test.updatedModals[2]?.[2])).toContain(
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
      "enable_session_scrobbling",
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
  const modal = JSON.stringify(await settingsTab(test, "host", "you"));
  expect(modal).toContain('"block_id":"scrobbling_mode"');
  for (const mode of ["always", "ask", "ask_track", "disabled"])
    expect(modal).toContain(`"value":"${mode}"`);
  // The prompt's answer shows as this session's choice.
  expect(modal).toContain(
    '"block_id":"session_scrobbling","optional":true,"label":{"type":"plain_text","text":"This session"},"element":{"type":"checkboxes","action_id":"enabled","options":[{"text":{"type":"plain_text","text":"Scrobble what I listen to here"},"value":"enabled"}],"initial_options":[{',
  );

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
  const modal = JSON.stringify(await settingsTab(test, "host", "you"));
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
    huddleMixSources: ["added"],
    mode: "always",
  });
  await test.coordinator.endFromSlack();
  userStore.close();
});

test("the You tab saves where and whether a user scrobbles", async () => {
  const userStore = new Store(":memory:");
  userStore.connectLastFm("host", "last-user", "session-key");
  userStore.setListenBrainzToken("host", "lb-token", "lb-user");
  userStore.setListenBrainzEnabled("host", true);
  const scrobbling = new ScrobbleDispatcher(userStore, {});
  const test = setup(undefined, undefined, undefined, scrobbling, userStore);
  await test.coordinator.start();
  await test.coordinator.action(interaction(test.coordinator, "open_settings"));
  const you = JSON.stringify(await settingsTab(test, "host", "you"));
  expect(you).toContain('"action_id":"services:lastfm,listenbrainz"');
  expect(you).toContain("Connected as last-user");
  expect(you).toContain("Connected as lb-user");
  // Last.fm is connected, though no longer configured, so it can be removed.
  expect(you).toContain('"action_id":"disconnect_lastfm"');
  expect(you).toContain('"action_id":"disconnect_listenbrainz"');
  expect(you).not.toContain("listenbrainz_token");

  const save = interaction(
    test.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  save.state = {
    scrobble_to: {
      "services:lastfm,listenbrainz": {
        selected_options: [{ value: "listenbrainz" }],
      },
    },
    scrobbling_mode: { mode: { selected_option: { value: "disabled" } } },
    session_scrobbling: {
      enabled: { selected_options: [{ value: "enabled" }] },
    },
  };
  await test.coordinator.action(save);
  expect(userStore.getUserScrobbling("host")).toMatchObject({
    lastFmEnabled: false,
    listenBrainzEnabled: true,
    mode: "disabled",
  });
  // A new default leaves this session scrobbling, as the form showed.
  expect(userStore.getSessionScrobbling(test.coordinator.id, "host")).toBe(
    true,
  );

  save.state = { session_scrobbling: { enabled: { selected_options: [] } } };
  await test.coordinator.action(save);
  expect(userStore.getSessionScrobbling(test.coordinator.id, "host")).toBe(
    false,
  );
  await test.coordinator.endFromSlack();
  userStore.close();
});

test("a ListenBrainz token is added in a form of its own over Settings", async () => {
  const userStore = new Store(":memory:");
  const tokens: string[] = [];
  const scrobbling = new ScrobbleDispatcher(userStore, {}, (async (
    _input,
    init,
  ) => {
    const token = String(
      (init?.headers as Record<string, string>).authorization,
    ).replace("Token ", "");
    tokens.push(token);
    return Response.json(
      token === "good"
        ? { valid: true, user_name: "lb-user" }
        : { valid: false },
    );
  }) as typeof fetch);
  const test = setup(undefined, undefined, undefined, scrobbling, userStore);
  await test.coordinator.start();
  await test.coordinator.action(interaction(test.coordinator, "open_settings"));
  const you = JSON.stringify(await settingsTab(test, "host", "you"));
  expect(you).toContain('"action_id":"open_listenbrainz_token"');
  // Last.fm has no app key here, so it is not offered at all.
  expect(you).not.toContain("lastfm_account");

  await pressInSettings(
    test,
    "host",
    "open_listenbrainz_token",
    { huddle_mix: { "sources:added": { selected_options: [] } } },
    "host",
    { tab: "you" },
  );
  const form = test.pushedModals.at(-1) as [
    string,
    { callback_id: string; private_metadata: string },
  ];
  expect(form[1].callback_id).toBe("listenbrainz_token");
  // Settings' tab and unsaved edits ride along, to redraw it with.
  expect(JSON.parse(form[1].private_metadata)).toMatchObject({
    sessionId: test.coordinator.id,
    settings: {
      tab: "you",
      draft: { huddle_mix: { "sources:added": { selected_options: [] } } },
    },
  });

  const submit = (token: string) =>
    test.coordinator.action({
      ...interaction(
        test.coordinator,
        "listenbrainz_token",
        "",
        "view_submission",
      ),
      metadata: form[1].private_metadata,
      previousViewId: "settings-view",
      state: { listenbrainz_token: { value: { value: ` ${token} ` } } },
    });
  await submit("bad");
  expect(userStore.getUserScrobbling("host").listenBrainzToken).toBeUndefined();
  let settings = test.updatedModals.at(-1)!;
  expect(settings[0]).toBe("settings-view");
  expect(JSON.stringify(settings[2])).toContain(
    "ListenBrainz was not connected: That ListenBrainz user token is invalid",
  );

  await submit("good");
  expect(tokens).toEqual(["bad", "good"]);
  expect(userStore.getUserScrobbling("host")).toMatchObject({
    listenBrainzToken: "good",
    listenBrainzUsername: "lb-user",
    listenBrainzEnabled: true,
  });
  settings = test.updatedModals.at(-1)!;
  const body = JSON.stringify(settings[2]);
  expect(body).toContain("ListenBrainz connected as lb-user.");
  expect(body).toContain('"action_id":"disconnect_listenbrainz"');
  // Still on the You tab, with the unsaved edit kept.
  expect(
    JSON.parse((settings[2] as { private_metadata: string }).private_metadata),
  ).toMatchObject({
    tab: "you",
    draft: { huddle_mix: { "sources:added": { selected_options: [] } } },
  });
  expect(body).not.toContain("good");
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
    volume: { percent: { selected_option: { value: "60" } } },
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
    volume: { percent: { selected_option: { value: "60" } } },
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
    volume: { percent: { selected_option: { value: "60" } } },
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
    volume: { percent: { selected_option: { value: "60" } } },
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
        duration: 180,
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
    volume: { percent: { selected_option: { value: "60" } } },
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
  const playing = (
    result.media.filter(
      (value) => (value as { type?: string }).type === "play",
    ) as { entryId: string }[]
  ).at(-1)!;
  result.coordinator.mediaEvent("playback_position", {
    entryId: playing.entryId,
    seconds: 42.4,
  });
  await result.coordinator.action(
    interaction(result.coordinator, "next_track"),
  );
  await until(
    () =>
      result.audit.filter(
        (value) => (value as unknown[])[0] === "track.autoplay_added",
      ).length === 3,
  );
  // A skip says how the pick was made and how far into it the room got.
  expect(
    result.audit.find((value) => (value as unknown[])[0] === "track.skipped"),
  ).toEqual([
    "track.skipped",
    "host",
    expect.objectContaining({
      sourceId: ids.c,
      origin: "autoplay",
      autoplayMode: "related",
      discovery: false,
      autoplaySources: ["related"],
      playedSeconds: 42,
      duration: 180,
    }),
  ]);
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
    volume: { percent: { selected_option: { value: "60" } } },
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
    volume: { percent: { selected_option: { value: "60" } } },
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
    volume: { percent: { selected_option: { value: "60" } } },
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
    volume: { percent: { selected_option: { value: "60" } } },
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
  await pressInSettings(
    test,
    "host",
    "apply_permission_preset",
    { autoplay: { mode: { selected_option: { value: "huddle" } } } },
    "host",
    { tab: "host" },
    "collaborative",
  );
  // Picking the preset ticks its permissions and saves nothing yet.
  expect(test.permissions).toEqual([]);
  const view = test.updatedModals.at(-1)![2] as {
    private_metadata: string;
    blocks: { block_id?: string; element?: Record<string, any> }[];
  };
  const ticked = view.blocks
    .find((block) => block.block_id === "permissions.1")!
    .element!.initial_options.map((option: { value: string }) => option.value);
  expect(ticked).toContain("manage-queue");
  expect(ticked).not.toContain("clear");
  expect(
    view.blocks.find((block) => block.block_id === "permission_preset.1"),
  ).toBeDefined();

  // Saving submits what the checkboxes show, under their new block ID.
  await test.coordinator.action({
    ...interaction(test.coordinator, "save_settings", "", "view_submission"),
    metadata: view.private_metadata,
    state: {
      "permissions.1": {
        selected: {
          selected_options: ticked.map((value: string) => ({ value })),
        },
      },
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
  // The edit made before picking the preset was kept too.
  expect(Reflect.get(test.coordinator, "autoplayMode")).toBe("huddle");
  await test.coordinator.endFromSlack();
});

test("only the host can fill in a permission preset", async () => {
  const test = setup();
  await test.coordinator.start();
  await pressInSettings(
    test,
    "guest",
    "apply_permission_preset",
    {},
    "host",
    { tab: "host" },
    "communism",
  );
  expect(test.updatedModals).toEqual([]);
  expect(test.ephemeral.at(-1)).toBe("Only the host can change permissions.");
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
    volume: { percent: { selected_option: { value: "60" } } },
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

test("asks listeners about each track in ask-for-every-track mode", async () => {
  const userStore = new Store(":memory:");
  userStore.setListenBrainzToken("host", "lb-token", "lb-user");
  userStore.setListenBrainzEnabled("host", true);
  userStore.setScrobblingMode("host", "ask_track");
  const tracks = {
    resolve: async () => ({
      sourceInput: "https://example.com/track",
      canonicalUrl: "https://example.com/track",
      sourceId: "track",
      title: "Track <1>",
      artist: "Artist",
    }),
    prepare: async () => "track.opus",
  } as unknown as TrackCatalog;
  const test = setup(
    tracks,
    undefined,
    undefined,
    new ScrobbleDispatcher(userStore, {}, (async () =>
      Response.json({ status: "ok" })) as unknown as typeof fetch),
    userStore,
  );
  await test.coordinator.start();
  // Unlike "ask", nothing is asked about the Huddle as a whole.
  expect(test.ephemeralCalls.some((call) => call[1] === "host")).toBeFalse();

  await test.coordinator.action(
    interaction(test.coordinator, "add_track_to_queue", "track"),
  );
  await until(() =>
    test.ephemeral.includes("Scrobble *Track &lt;1&gt;* — Artist?"),
  );
  const prompt = JSON.stringify(
    test.ephemeralCalls.find((call) => call[1] === "host")?.[4],
  );
  const value = /"action_id":"scrobble_track".*?"value":"([^"]+)"/.exec(
    prompt,
  )?.[1];
  expect(value).toStartWith(`${test.coordinator.id}:`);

  // The button comes from an ephemeral message, not the player.
  const confirm = {
    ...interaction(test.coordinator, "scrobble_track", value),
    messageTs: "2",
  };
  expect(test.coordinator.handles(confirm)).toBeTrue();
  await test.coordinator.action(confirm);
  expect(test.ephemeral).toContain("Scrobbling this track.");

  await test.coordinator.action({
    ...confirm,
    value: `${test.coordinator.id}:gone`,
  });
  expect(test.ephemeral).toContain(
    "That track finished a while ago, so it can't be scrobbled now.",
  );

  // "Scrobble everything" only ever turns scrobbling on, however often an
  // old prompt is pressed.
  const everything = {
    ...interaction(test.coordinator, "enable_session_scrobbling", value),
    messageTs: "2",
  };
  expect(prompt).toContain('"action_id":"enable_session_scrobbling"');
  expect(test.coordinator.handles(everything)).toBeTrue();
  await test.coordinator.action(everything);
  expect(test.ephemeral).toContain("Scrobbling enabled for this session.");
  await test.coordinator.action(everything);
  expect(test.ephemeral).toContain("You're already scrobbling this Huddle.");
  expect(userStore.getSessionScrobbling(test.coordinator.id, "host")).toBe(
    true,
  );

  // Saving Settings without changing the mode keeps pending scrobbles.
  userStore.queueScrobble(
    test.coordinator.id,
    "queued",
    "host",
    "listenbrainz",
    1,
    {},
  );
  const save = interaction(
    test.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  save.state = {
    scrobbling_mode: { mode: { selected_option: { value: "ask_track" } } },
  };
  await test.coordinator.action(save);
  expect(
    userStore.db.query("SELECT track_id FROM scrobbles").all(),
  ).toContainEqual({ track_id: "queued" });
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

test("integration add replies once songs are queued, before they download", async () => {
  const download = Promise.withResolvers<string>();
  const tracks = {
    resolve: async () => ({
      sourceId: "song",
      title: "Song",
      artist: "Artist",
      duration: 120,
    }),
    prepare: () => download.promise,
  } as never;
  const test = setup(tracks);
  await test.coordinator.start();
  await test.coordinator.handleIntegrationCommand(
    "Ubot",
    {
      type: "request_control",
      channel: "channel",
      permissions: ["add"],
      events: ["queue"],
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
    { type: "add", reference: "ref_song" },
    "10.0",
    "Dbot",
  );
  const reply = test.dms.find(
    (args) => (args[2] as { threadTs?: string })?.threadTs === "10.0",
  );
  const body = JSON.parse(String(reply?.[1]));
  expect(body).toMatchObject({
    ok: true,
    type: "add",
    added: [{ title: "Song", artist: "Artist" }],
  });
  const id = body.added[0].id;
  expect(test.coordinator.agentStatus("host")).toMatchObject({
    queue: [{ id, status: "preparing" }],
  });

  download.reject(new Error("private video"));
  await Bun.sleep(0);
  // Seeking runs on the session queue, so it lands after the failure cleanup.
  await test.coordinator.agentSeek("host", 0);
  const removed = test.dms
    .map((args) => JSON.parse(String(args[1])))
    .find((message) => message.event === "queue.removed");
  expect(removed).toMatchObject({
    type: "event",
    payload: { id, title: "Song", reason: "failed" },
  });
  expect(test.coordinator.agentStatus("host")).toMatchObject({ queue: [] });
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
  const hostSettings = JSON.stringify(await settingsTab(test, "host", "host"));
  expect(hostSettings).toContain('"block_id":"integrations"');
  expect(hostSettings).toContain("<@Ubot> has control of this session.");
  expect(hostSettings).toContain("Pause or resume");
  expect(hostSettings).toContain('"action_id":"integration_revoke"');

  const revoke = interaction(test.coordinator, "integration_revoke", granted);
  revoke.messageTs = "";
  revoke.metadata = JSON.stringify({
    sessionId: test.coordinator.id,
    tab: "host",
  });
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
  const first = ["", await settingsTab(test, "host", "host")] as [
    string,
    { blocks: unknown[] },
  ];
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
    tab: "host",
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
    volume: { percent: { selected_option: { value: "60" } } },
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
      return { discover: [], favourites: [] };
    },
    recommendation() {
      return undefined;
    },
    refreshUser() {},
    huddleMixOptedIn: () => true,
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
    noteSessions() {},
    userRecommendations() {
      return { discover: [], favourites: [] };
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
  expect(modal).toContain('"option_groups"');
  expect(modal).toContain('"text":"Discover"');
  expect(modal).toContain("For You — Band");
  const recId = catalog.userRecommendations("host").discover[0]?.id;
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

test("a manual add refreshes the adder's personal recommendations", async () => {
  const refreshed: string[] = [];
  const catalog = {
    prefetchUsers() {},
    noteSessions() {},
    userRecommendations() {
      return { discover: [], favourites: [] };
    },
    recommendation() {
      return undefined;
    },
    refreshUser(userId: string) {
      refreshed.push(userId);
    },
    huddleMixOptedIn: () => true,
    autoplayCandidates: async () => [],
  } as unknown as RecommendationCatalog;
  const track = (input: string) => ({
    sourceInput: input,
    canonicalUrl: input,
    sourceId: input.slice(-11),
    title: input,
    artist: "Artist",
  });
  const test = setup(
    {
      resolve: async (input: string) => track(input),
      resolveUrl: async (input: string) => track(input),
      prepare: async () => "track.opus",
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  await test.coordinator.action({
    type: "block_actions",
    userId: "guest",
    actionId: "add_track_to_queue",
    value: "ref",
    channelId: "channel",
    messageTs: "1",
    triggerId: "",
    metadata: "",
    state: {},
  });
  expect(refreshed).toEqual(["guest"]);
  await test.coordinator.agentAdd("host", "https://example.com/agent");
  expect(refreshed).toEqual(["guest", "host"]);
  await test.coordinator.action({
    ...interaction(
      test.coordinator,
      "bulk_add_to_queue",
      "",
      "view_submission",
    ),
    state: { links: { text: { value: "https://example.com/bulk\n" } } },
  });
  expect(refreshed).toEqual(["guest", "host", "host"]);
  await test.coordinator.endFromSlack();
});

test("starting a track tells the catalog what the session has played and tops up", async () => {
  const noted: { userIds: string[]; exclude: (string | undefined)[] }[] = [];
  const prefetched: string[][] = [];
  const catalog = {
    prefetchUsers(ids: Iterable<string>) {
      prefetched.push([...ids].sort());
    },
    noteSessions(ids: Iterable<string>, exclude: Iterable<string | undefined>) {
      noted.push({ userIds: [...ids].sort(), exclude: [...exclude] });
    },
    userRecommendations() {
      return { discover: [], favourites: [] };
    },
    recommendation() {
      return undefined;
    },
    refreshUser() {},
    huddleMixOptedIn: () => true,
    autoplayCandidates: async () => [],
  } as unknown as RecommendationCatalog;
  const test = setup(
    {
      resolve: async () => ({
        sourceInput: "https://example.com/track",
        canonicalUrl: "https://example.com/track",
        sourceId: "trackxxxxxx",
        title: "Track",
        artist: "Artist",
      }),
      prepare: async () => "track.opus",
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  expect(noted).toEqual([]);
  await test.coordinator.agentAdd("host", "https://example.com/track");
  expect(noted).toHaveLength(1);
  expect(noted[0]).toEqual({
    userIds: ["guest", "host"],
    exclude: expect.arrayContaining(["trackxxxxxx"]),
  });
  expect(prefetched.at(-1)).toEqual(["guest", "host"]);
  await test.coordinator.endFromSlack();
});

test("the add modal lists favourites before discoveries", async () => {
  const catalog = {
    prefetchUsers() {},
    noteSessions() {},
    userRecommendations() {
      const track = (id: string, title: string) => ({
        id,
        sourceInput: `https://music.youtube.com/watch?v=${id}`,
        canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
        sourceId: id,
        title,
        artist: "Band",
        sources: [],
      });
      return {
        discover: [track("rec_new", "Brand New")],
        favourites: [track("rec_fav", "Old Favourite")],
      };
    },
    recommendation() {
      return undefined;
    },
    refreshUser() {},
    huddleMixOptedIn: () => true,
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
  await test.coordinator.action(
    interaction(test.coordinator, "open_add_to_queue"),
  );
  const modal = JSON.stringify(test.modals[0]);
  expect(modal.indexOf("Your favourites")).toBeLessThan(
    modal.indexOf('"Discover"'),
  );
  expect(modal.indexOf("Old Favourite")).toBeLessThan(
    modal.indexOf("Brand New"),
  );
  await test.coordinator.endFromSlack();
});

test("an autoplay pick displaced before it plays is not counted", async () => {
  const calls: Record<string, unknown>[] = [];
  const catalog = huddleMixCatalog(
    [{ sourceId: "queuedpick1", title: "Queued", listenerIds: ["guest"] }],
    calls,
  );
  const test = setup(
    {
      resolve: async (input: string) => ({
        sourceInput: input,
        canonicalUrl: input,
        sourceId: input.slice(-11),
        title: input,
        artist: "Manual",
      }),
      prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
      upNextIds: async () => [],
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  await test.coordinator.agentAdd("host", "https://example.com/manual00001");
  await enableHuddleMix(test.coordinator);
  await until(() =>
    (Reflect.get(test.coordinator, "queue") as { automatic?: boolean }[]).some(
      (track) => track.automatic,
    ),
  );
  expect(Reflect.get(test.coordinator, "autoplayCredits")).toEqual([]);
  expect(Reflect.get(test.coordinator, "autoplaySinceDiscovery")).toBe(0);
  await test.coordinator.agentAdd("host", "https://example.com/manual00002");
  expect(
    (Reflect.get(test.coordinator, "queue") as { automatic?: boolean }[]).some(
      (track) => track.automatic,
    ),
  ).toBe(false);
  expect(Reflect.get(test.coordinator, "autoplayCredits")).toEqual([]);
  expect(Reflect.get(test.coordinator, "autoplaySinceDiscovery")).toBe(0);
  await test.coordinator.endFromSlack();
});

function huddleMixCatalog(
  candidates: {
    sourceId: string;
    title: string;
    listenerIds?: string[];
  }[],
  calls: Record<string, unknown>[],
  penalized: [string, { title: string; artist: string }][] = [],
) {
  return {
    prefetchUsers() {},
    noteSessions() {},
    userRecommendations() {
      return { discover: [], favourites: [] };
    },
    recommendation() {
      return undefined;
    },
    refreshUser() {},
    penalize(userId: string, track: { title: string; artist: string }) {
      penalized.push([userId, { title: track.title, artist: track.artist }]);
    },
    huddleMixOptedIn: () => true,
    autoplayCandidates: async (options: Record<string, unknown>) => {
      calls.push(options);
      return candidates.map((candidate, index) => ({
        sourceId: candidate.sourceId,
        score: 1,
        seedCount: 1,
        discovery: index === 0,
        listenerIds: candidate.listenerIds ?? [],
        metadata: {
          sourceInput: `https://music.youtube.com/watch?v=${candidate.sourceId}`,
          canonicalUrl: `https://music.youtube.com/watch?v=${candidate.sourceId}`,
          sourceId: candidate.sourceId,
          title: candidate.title,
          artist: "Band",
        },
      }));
    },
  } as unknown as RecommendationCatalog;
}

async function enableHuddleMix(coordinator: Coordinator) {
  const enable = interaction(
    coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  enable.state = {
    volume: { percent: { selected_option: { value: "60" } } },
    autoplay: { mode: { selected_option: { value: "huddle" } } },
  };
  await coordinator.action(enable);
}

test("huddle mix asks for a discovery on every fourth autoplay pick", async () => {
  const calls: Record<string, unknown>[] = [];
  const catalog = huddleMixCatalog(
    [{ sourceId: "discover001", title: "New To You" }],
    calls,
  );
  const test = setup(
    {
      prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
      upNextIds: async () => [],
      resolveVideoId: async () => {
        throw new Error("huddle mix should use cached metadata");
      },
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  Reflect.set(test.coordinator, "autoplaySinceDiscovery", 3);
  await enableHuddleMix(test.coordinator);
  await until(() =>
    test.audit.some(
      (value) => (value as unknown[])[0] === "track.autoplay_added",
    ),
  );
  expect(calls[0]).toMatchObject({ discover: true });
  await until(
    () => Reflect.get(test.coordinator, "autoplaySinceDiscovery") === 0,
  );
  await test.coordinator.endFromSlack();
});

test("skipping a discovery pick backs off the cadence and penalises the skipper's pools", async () => {
  const calls: Record<string, unknown>[] = [];
  const penalized: [string, { title: string; artist: string }][] = [];
  const catalog = huddleMixCatalog(
    [{ sourceId: "discover001", title: "New To You" }],
    calls,
    penalized,
  );
  const test = setup(
    {
      prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
      upNextIds: async () => [],
      resolveVideoId: async () => {
        throw new Error("huddle mix should use cached metadata");
      },
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  Reflect.set(test.coordinator, "autoplaySinceDiscovery", 3);
  await enableHuddleMix(test.coordinator);
  await until(
    () =>
      (Reflect.get(test.coordinator, "current") as { sourceId?: string })
        ?.sourceId === "discover001",
  );
  expect(
    (Reflect.get(test.coordinator, "current") as { discovery?: boolean })
      .discovery,
  ).toBe(true);
  await test.coordinator.action(interaction(test.coordinator, "next_track"));
  expect(Reflect.get(test.coordinator, "autoplayDiscoveryInterval")).toBe(8);
  expect(penalized).toEqual([
    ["host", { title: "New To You", artist: "Band" }],
  ]);
  await test.coordinator.endFromSlack();
});

test("a skipped autoplay pick is remembered for the room, not only the skipper", async () => {
  const calls: Record<string, unknown>[] = [];
  const catalog = huddleMixCatalog(
    [{ sourceId: "skipped0001", title: "Not This One" }],
    calls,
  );
  const test = setup(
    {
      prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
      upNextIds: async () => [],
      resolveVideoId: async () => {
        throw new Error("huddle mix should use cached metadata");
      },
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  await enableHuddleMix(test.coordinator);
  await until(
    () =>
      (Reflect.get(test.coordinator, "current") as { sourceId?: string })
        ?.sourceId === "skipped0001",
  );
  await test.coordinator.action(interaction(test.coordinator, "next_track"));
  // The skipper chose it, so they carry it in full; everyone else in the room
  // only tolerated it, so it follows them at a fraction.
  expect(
    test.rememberedSkips.map((skip) => {
      const value = skip as { userId: string; title: string; weight: number };
      return { userId: value.userId, title: value.title, weight: value.weight };
    }),
  ).toEqual([
    { userId: "host", title: "Not This One", weight: 1 },
    { userId: "guest", title: "Not This One", weight: 0.25 },
  ]);
  await test.coordinator.endFromSlack();
});

test("a manager who is not in the Huddle carries no skip of their own", async () => {
  const calls: Record<string, unknown>[] = [];
  const catalog = huddleMixCatalog(
    [{ sourceId: "skipped0002", title: "Not This One" }],
    calls,
  );
  const test = setup(
    {
      prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
      upNextIds: async () => [],
      resolveVideoId: async () => {
        throw new Error("huddle mix should use cached metadata");
      },
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  await enableHuddleMix(test.coordinator);
  await until(
    () =>
      (Reflect.get(test.coordinator, "current") as { sourceId?: string })
        ?.sourceId === "skipped0002",
  );
  // The manager holds host powers without joining, so they never heard it.
  await test.coordinator.action({
    ...interaction(test.coordinator, "next_track"),
    userId: "manager",
  });
  expect(
    test.rememberedSkips.map(
      (skip) => (skip as { userId: string; weight: number }).userId,
    ),
  ).toEqual(["host", "guest"]);
  expect(
    test.rememberedSkips.every(
      (skip) => (skip as { weight: number }).weight === 0.25,
    ),
  ).toBeTrue();
  await test.coordinator.endFromSlack();
});

test("skipping a song someone chose is not held against the mix", async () => {
  const test = setup();
  await test.coordinator.start();
  Reflect.set(test.coordinator, "current", {
    id: "manual",
    requesterId: "host",
    sourceInput: "manual",
    canonicalUrl: "manual",
    sourceId: "manual",
    title: "Chosen",
    artist: "Artist",
    status: "playing",
    filePath: "manual.opus",
  });
  await test.coordinator.action(interaction(test.coordinator, "next_track"));
  // Someone deliberately queued it, so skipping says nothing about the mix.
  expect(test.rememberedSkips).toEqual([]);
  await test.coordinator.endFromSlack();
});

test("removing a queued autoplay pick keeps it out of the mix", async () => {
  const calls: Record<string, unknown>[] = [];
  const penalized: [string, { title: string; artist: string }][] = [];
  const catalog = huddleMixCatalog(
    [
      { sourceId: "firstpick01", title: "First Pick" },
      { sourceId: "secondpick1", title: "Second Pick" },
    ],
    calls,
    penalized,
  );
  const test = setup(
    {
      prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
      upNextIds: async () => [],
      resolveVideoId: async () => {
        throw new Error("huddle mix should use cached metadata");
      },
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  await enableHuddleMix(test.coordinator);
  const queued = () =>
    (
      Reflect.get(test.coordinator, "queue") as {
        id: string;
        sourceId: string;
        automatic?: boolean;
      }[]
    ).find((track) => track.automatic && track.sourceId === "secondpick1");
  await until(() => Boolean(queued()));
  const entry = queued()!;
  const before = calls.length;
  expect(await test.coordinator.agentRemove("host", entry.id)).toMatchObject({
    ok: true,
  });
  expect(penalized).toEqual([
    ["host", { title: "Second Pick", artist: "Band" }],
  ]);
  expect(Reflect.get(test.coordinator, "autoplayRejected")).toContain(
    "secondpick1",
  );
  await until(() => calls.length > before);
  expect((calls.at(-1)!.exclude as Set<string>).has("secondpick1")).toBe(true);
  await test.coordinator.endFromSlack();
});

test("huddle mix credits the listeners behind recent picks", async () => {
  const calls: Record<string, unknown>[] = [];
  const catalog = huddleMixCatalog(
    [
      { sourceId: "guestpick01", title: "Guest Pick", listenerIds: ["guest"] },
      { sourceId: "guestpick02", title: "Guest Again", listenerIds: ["guest"] },
    ],
    calls,
  );
  const test = setup(
    {
      prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
      upNextIds: async () => [],
      resolveVideoId: async () => {
        throw new Error("huddle mix should use cached metadata");
      },
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  await enableHuddleMix(test.coordinator);
  await until(() => calls.length >= 2);
  expect(calls[0]).toMatchObject({ credited: {} });
  expect(calls[0]?.lastCredited).toBeUndefined();
  expect(calls[1]).toMatchObject({
    credited: { guest: 1 },
    lastCredited: ["guest"],
    // What follows on from an autoplay pick is credited like the pick.
    nowPlayingListenerIds: ["guest"],
  });
  await test.coordinator.endFromSlack();
});

test("huddle mix reports how long the current artist has been playing", async () => {
  const calls: Record<string, unknown>[] = [];
  const catalog = huddleMixCatalog(
    [{ sourceId: "bandpick001", title: "Another" }],
    calls,
  );
  const test = setup(
    {
      resolve: async () => ({
        sourceInput: "https://music.youtube.com/watch?v=bandsong001",
        canonicalUrl: "https://music.youtube.com/watch?v=bandsong001",
        sourceId: "bandsong001",
        title: "Current",
        artist: "Band",
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
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  Reflect.set(test.coordinator, "history", [
    {
      id: "older",
      requesterId: "host",
      sourceInput: "https://music.youtube.com/watch?v=otherband01",
      canonicalUrl: "https://music.youtube.com/watch?v=otherband01",
      sourceId: "otherband01",
      title: "Older",
      artist: "Other",
      status: "played",
    },
    {
      id: "previous",
      requesterId: "host",
      sourceInput: "https://music.youtube.com/watch?v=bandsong000",
      canonicalUrl: "https://music.youtube.com/watch?v=bandsong000",
      sourceId: "bandsong000",
      title: "Previous",
      artist: "Band",
      status: "played",
    },
  ]);
  await test.coordinator.action(
    interaction(test.coordinator, "add_track_to_queue", "ref"),
  );
  await until(
    () =>
      (Reflect.get(test.coordinator, "current") as { sourceId?: string })
        ?.sourceId === "bandsong001",
  );
  await enableHuddleMix(test.coordinator);
  await until(() => calls.length >= 1);
  expect(calls[0]).toMatchObject({ artistRun: 2 });
  // A song someone queued was for them.
  expect(calls[0]).toMatchObject({ nowPlayingListenerIds: ["host"] });
  await test.coordinator.endFromSlack();
});

test("huddle mix queues candidates in the catalog's order", async () => {
  const calls: Record<string, unknown>[] = [];
  const catalog = huddleMixCatalog(
    [
      { sourceId: "firstpick01", title: "First" },
      { sourceId: "secondpick1", title: "Second" },
    ],
    calls,
  );
  const test = setup(
    {
      prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
      upNextIds: async () => [],
      resolveVideoId: async () => {
        throw new Error("huddle mix should use cached metadata");
      },
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  await test.coordinator.start();
  await enableHuddleMix(test.coordinator);
  await until(() =>
    test.audit.some(
      (value) => (value as unknown[])[0] === "track.autoplay_added",
    ),
  );
  expect(calls[0]).toMatchObject({ discover: false });
  await until(
    () =>
      (Reflect.get(test.coordinator, "current") as { sourceId?: string })
        ?.sourceId === "firstpick01",
  );
  await test.coordinator.endFromSlack();
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
  // Without a scrobbler, the one checkbox offered is the whole opt-in.
  save.state = {
    huddle_mix: { "sources:added": { selected_options: [] } },
  };
  await test.coordinator.action(save);
  expect(userStore.getUserScrobbling("host").huddleMixOptIn).toBe(false);
  await test.coordinator.endFromSlack();
  userStore.close();
});

test("user settings offer a Huddle mix source per connected service", async () => {
  const userStore = new Store(":memory:");
  const scrobbling = new ScrobbleDispatcher(userStore, {});
  userStore.setListenBrainzToken("host", "token", "listener");
  userStore.setHuddleMixSources("host", { listenbrainz: false });
  const test = setup(undefined, undefined, undefined, scrobbling);
  await test.coordinator.start();
  await test.coordinator.action(interaction(test.coordinator, "open_settings"));
  const modal = JSON.stringify(await settingsTab(test, "host", "you"));
  expect(modal).toContain('"action_id":"sources:added,listenbrainz"');
  expect(modal).toContain("My ListenBrainz listening");
  expect(modal).not.toContain("My Last.fm listening");
  const save = interaction(
    test.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  save.state = {
    huddle_mix: {
      "sources:added,listenbrainz": {
        selected_options: [{ value: "listenbrainz" }],
      },
    },
  };
  await test.coordinator.action(save);
  expect(userStore.getUserScrobbling("host").huddleMixSources).toEqual([
    "listenbrainz",
  ]);
  // Last.fm was not offered, so it keeps its choice for when it is connected.
  userStore.connectLastFm("host", "last-user", "session-key");
  expect(userStore.getUserScrobbling("host").huddleMixSources).toEqual([
    "lastfm",
    "listenbrainz",
  ]);
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
  type View = {
    blocks: { block_id?: string; element?: Record<string, unknown> }[];
  };
  const views = [
    (test.modals.at(-1) as unknown[])[1],
    await settingsTab(test, "host", "host"),
    await settingsTab(test, "host", "you"),
  ] as View[];
  const selects = views
    .flatMap((view) => view.blocks)
    .filter((block) => block.element?.type === "static_select");
  expect(selects.map((block) => block.block_id)).toEqual([
    "media_mode",
    "volume",
    "display",
    "autoplay",
    "loop",
    "transition",
    "ducking",
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

function playSomethingSetup(
  candidates: { sourceId: string; title: string }[],
  popular: () => Promise<{ sourceId: string; title: string }[]>,
) {
  const calls: Record<string, unknown>[] = [];
  const catalog = huddleMixCatalog(candidates, calls);
  const test = setup(
    {
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
        throw new Error("play something should use cached metadata");
      },
      popularTracks: async () =>
        (await popular()).map((track) => ({
          sourceInput: `https://music.youtube.com/watch?v=${track.sourceId}`,
          canonicalUrl: `https://music.youtube.com/watch?v=${track.sourceId}`,
          sourceId: track.sourceId,
          title: track.title,
          artist: "Chart Act",
        })),
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(),
    undefined,
    catalog,
  );
  return { ...test, calls };
}

const playSomethingButton = (rendered: unknown) =>
  JSON.stringify(rendered ?? "").includes('"action_id":"play_something"');

test("idle player offers Play something instead of playback controls", async () => {
  const test = playSomethingSetup([], async () => []);
  await test.coordinator.start();
  const blank = JSON.stringify(test.posted[0]);
  expect(blank).toContain('"action_id":"play_something"');
  expect(blank).not.toContain('"action_id":"toggle_playback"');
  expect(blank).not.toContain('"action_id":"volume_up"');
  expect(blank).not.toContain('"action_id":"seek_back"');
  expect(blank).toContain("Volume: 60%");

  await test.coordinator.action(
    interaction(test.coordinator, "add_track_to_queue", "a"),
  );
  const playing = JSON.stringify(test.updates.at(-1));
  expect(playing).toContain('"action_id":"toggle_playback"');
  expect(playing).not.toContain('"action_id":"play_something"');

  const current = Reflect.get(test.coordinator, "current") as { id: string };
  await test.coordinator.mediaEvent("track_ended", { entryId: current.id });
  expect(playSomethingButton(test.updates.at(-1))).toBeTrue();
  await test.coordinator.endFromSlack();
});

test("Play something turns on Huddle mix and plays its pick", async () => {
  const test = playSomethingSetup(
    [{ sourceId: "mixpick0001", title: "Mix Pick" }],
    async () => {
      throw new Error("the mix had a pick, so no fallback");
    },
  );
  await test.coordinator.start();
  await test.coordinator.action(
    interaction(test.coordinator, "play_something"),
  );
  expect(test.sessions).toContainEqual({ autoplay: "huddle" });
  await until(() => JSON.stringify(test.updates).includes("Finding next song"));
  await until(() =>
    test.audit.some(
      (value) => (value as unknown[])[0] === "track.autoplay_added",
    ),
  );
  await until(() => Boolean(Reflect.get(test.coordinator, "current")));
  expect(Reflect.get(test.coordinator, "current")).toMatchObject({
    sourceId: "mixpick0001",
    automatic: true,
  });
  expect(Reflect.get(test.coordinator, "autoplayMode")).toBe("huddle");
  expect(test.calls[0]).toMatchObject({ userIds: ["host", "guest"] });
  expect(playSomethingButton(test.updates.at(-1))).toBeFalse();
  expect(test.ephemeral).toEqual([]);
  await test.coordinator.endFromSlack();
});

test("Play something falls back to a popular song when the mix is empty", async () => {
  const test = playSomethingSetup([], async () => [
    { sourceId: "popular0001", title: "Hit One" },
    { sourceId: "popular0002", title: "Hit Two" },
  ]);
  await test.coordinator.start();
  await test.coordinator.action(
    interaction(test.coordinator, "play_something"),
  );
  await until(() => Boolean(Reflect.get(test.coordinator, "current")));
  const current = Reflect.get(test.coordinator, "current") as {
    sourceId: string;
    automatic: boolean;
    artist: string;
  };
  expect(["popular0001", "popular0002"]).toContain(current.sourceId);
  expect(current).toMatchObject({ automatic: true, artist: "Chart Act" });
  expect(Reflect.get(test.coordinator, "autoplayMode")).toBe("huddle");
  expect(test.calls[0]?.nowPlaying).toBeUndefined();
  expect(test.ephemeral).toEqual([]);
  // The popular song now seeds the mix for what follows.
  await until(() => test.calls.length >= 2);
  expect(test.calls[1]).toMatchObject({
    nowPlaying: { sourceId: current.sourceId },
  });
  await test.coordinator.endFromSlack();
});

test("Play something tells the user when nothing at all can be played", async () => {
  const test = playSomethingSetup([], async () => []);
  await test.coordinator.start();
  await test.coordinator.action(
    interaction(test.coordinator, "play_something"),
  );
  await until(() =>
    test.audit.some(
      (value) => (value as unknown[])[0] === "autoplay.recommendation_failed",
    ),
  );
  await until(() => test.ephemeral.length > 0);
  expect(test.ephemeral).toEqual([
    "Could not find anything to play; add a song to get started.",
  ]);
  expect(Reflect.get(test.coordinator, "current")).toBeUndefined();
  await until(() => playSomethingButton(test.updates.at(-1)));
  await test.coordinator.endFromSlack();
});

test("Play something needs the configure-settings permission", async () => {
  const test = playSomethingSetup(
    [{ sourceId: "mixpick0001", title: "Mix Pick" }],
    async () => [],
  );
  await test.coordinator.start();
  await test.coordinator.action({
    ...interaction(test.coordinator, "play_something"),
    userId: "guest",
  });
  expect(test.ephemeral).toEqual(["You do not have permission for that."]);
  expect(Reflect.get(test.coordinator, "autoplayMode")).toBe("off");
  expect(test.calls).toEqual([]);
  expect(test.sessions).not.toContainEqual({ autoplay: "huddle" });
  await test.coordinator.endFromSlack();
});

test("stores the configured ducking mode with a new session", async () => {
  const result = setup();
  await result.coordinator.start();
  expect(result.created).toEqual([
    expect.objectContaining({ duckingMode: "gentle" }),
  ]);
  expect(result.coordinator.agentStatus("host")).toMatchObject({
    duckingMode: "gentle",
  });
  await result.coordinator.endFromSlack();
});

test("saves the ducking mode from the settings modal", async () => {
  const result = setup();
  await result.coordinator.start();
  const save = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  save.state = {
    ducking: { mode: { selected_option: { value: "strong" } } },
  };
  await result.coordinator.action(save);
  expect(result.sessions).toContainEqual({ duckingMode: "strong" });
  expect(result.media).toContainEqual({
    type: "ducking_mode",
    mode: "strong",
  });
  expect(result.coordinator.agentStatus("host")).toMatchObject({
    duckingMode: "strong",
  });

  // Saving the same mode again should not disturb a live session.
  const again = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  again.state = {
    ducking: { mode: { selected_option: { value: "strong" } } },
  };
  result.media.length = 0;
  await result.coordinator.action(again);
  expect(result.media).not.toContainEqual({
    type: "ducking_mode",
    mode: "strong",
  });

  const off = interaction(
    result.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  off.state = { ducking: { mode: { selected_option: { value: "off" } } } };
  await result.coordinator.action(off);
  expect(result.sessions).toContainEqual({ duckingMode: "off" });
  expect(result.media).toContainEqual({ type: "ducking_mode", mode: "off" });
  await result.coordinator.endFromSlack();
});

test("changes the ducking mode from the bot API", async () => {
  const result = setup();
  await result.coordinator.start();
  expect(
    await result.coordinator.agentUpdateSettings("host", {
      duckingMode: "strong",
    }),
  ).toMatchObject({ ok: true, changed: ["duckingMode=strong"] });
  expect(result.sessions).toContainEqual({ duckingMode: "strong" });
  expect(result.media).toContainEqual({
    type: "ducking_mode",
    mode: "strong",
  });
  expect(
    await result.coordinator.agentUpdateSettings("host", {
      duckingMode: "loud" as never,
    }),
  ).toEqual({ ok: false, error: "Invalid ducking mode." });
  expect(
    await result.coordinator.agentUpdateSettings("guest", {
      duckingMode: "off",
    }),
  ).toEqual({
    ok: false,
    error: "You do not have permission to change settings.",
  });
  await result.coordinator.endFromSlack();
});

test("restores the saved ducking mode and tells the media page", async () => {
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
    state: "ready",
    volume: 0.4,
    autoplay: "off",
    loopMode: "off",
    transitionMode: "none",
    duckingMode: "strong",
    displayMode: "default",
    anchorEnabled: false,
    playbackSeconds: 0,
    listenedSeconds: 0,
    mediaMode: "music",
    captions: false,
    watchedSeconds: 0,
    resumeUntil: 180_000,
    permissions: ["add"],
    tracks: [],
  };
  const result = setup(undefined, undefined, restored);
  await result.coordinator.resume("restorer");
  expect(result.media).toContainEqual({
    type: "ducking_mode",
    mode: "strong",
  });
  expect(result.coordinator.agentStatus("host")).toMatchObject({
    duckingMode: "strong",
  });
  await result.coordinator.endFromSlack();
});

test("falls back to the configured ducking mode when none was saved", async () => {
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
    state: "ready",
    volume: 0.4,
    autoplay: "off",
    loopMode: "off",
    transitionMode: "none",
    displayMode: "default",
    anchorEnabled: false,
    playbackSeconds: 0,
    listenedSeconds: 0,
    mediaMode: "music",
    captions: false,
    watchedSeconds: 0,
    resumeUntil: 180_000,
    permissions: ["add"],
    tracks: [],
  };
  const result = setup(
    undefined,
    undefined,
    restored,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "off",
  );
  await result.coordinator.resume("restorer");
  expect(result.media).toContainEqual({ type: "ducking_mode", mode: "off" });
  await result.coordinator.endFromSlack();
});

function playingTrack() {
  return {
    id: "playing",
    requesterId: "guest",
    sourceInput: "https://example.com/likedlikedl",
    canonicalUrl: "https://example.com/likedlikedl",
    sourceId: "likedlikedl",
    title: "Worth Hearing Again",
    artist: "Band",
    status: "playing",
    filePath: "liked.opus",
    automatic: true,
    discovery: true,
  };
}

test("the like button sits with the volume controls, and only while playing", async () => {
  const result = setup({
    resolve: async (value: string) => ({
      sourceInput: value,
      canonicalUrl: `https://example.com/${value}`,
      sourceId: value,
      title: value,
      artist: "Artist",
    }),
    prepare: async (_track: unknown, _directory: string, id: string) =>
      `${id}.opus`,
  } as unknown as TrackCatalog);
  await result.coordinator.start();
  // Nothing playing, so there is nothing to like.
  expect(JSON.stringify(result.posted[0])).not.toContain(
    '"action_id":"like_track"',
  );
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "a"),
  );
  const player = JSON.stringify(result.updates.at(-1));
  const volume = player.slice(
    player.indexOf('"block_id":"volume_'),
    player.indexOf('"block_id":"seek_'),
  );
  expect(volume).toContain('"action_id":"like_track"');
  expect(volume).toContain(":ms-sparkling-heart:");
  await result.coordinator.endFromSlack();
});

test("liking a song records it, answers only the listener, and leaves the card alone", async () => {
  const test = setup();
  await test.coordinator.start();
  Reflect.set(test.coordinator, "current", playingTrack());
  const renders = test.updates.length;
  await test.coordinator.action(
    interaction(test.coordinator, "like_track", "playing"),
  );
  expect(test.likes).toEqual([
    { userId: "host", title: "Worth Hearing Again", artist: "Band" },
  ]);
  // The button carries no state, so nothing about the shared card changes.
  expect(test.updates).toHaveLength(renders);
  const audited = test.audit.at(-1) as [
    string,
    string,
    Record<string, unknown>,
  ];
  expect(audited[0]).toBe("track.liked");
  expect(audited[1]).toBe("host");
  expect(audited[2]).toMatchObject({
    title: "Worth Hearing Again",
    artist: "Band",
    origin: "autoplay",
    discovery: true,
  });
  // Only the person who pressed it hears back, and the undo comes with it.
  const posted = test.ephemeralCalls.at(-1)!;
  expect(posted[1]).toBe("host");
  expect(posted[2]).toBe("This will be recommended to you more");
  expect(JSON.stringify(posted[4])).toContain('"action_id":"unlike_track"');
  await test.coordinator.endFromSlack();
});

test("the save button sits with the seek controls and DMs a song.link link", async () => {
  const test = setup();
  await test.coordinator.start();
  Reflect.set(test.coordinator, "current", {
    ...playingTrack(),
    canonicalUrl: "https://www.youtube.com/watch?v=likedlikedl",
  });
  const player = JSON.stringify(
    (Reflect.get(test.coordinator, "blocks") as () => unknown).call(
      test.coordinator,
    ),
  );
  const seek = player.slice(player.indexOf('"block_id":"seek_'));
  expect(seek).toContain('"action_id":"save_track"');
  expect(seek).toContain(":ms-floppy-disk:");
  const renders = test.updates.length;
  await test.coordinator.action(
    interaction(test.coordinator, "save_track", "playing"),
  );
  await Bun.sleep(0);
  expect(test.updates).toHaveLength(renders);
  const sent = test.dms.at(-1)!;
  expect(sent[0]).toBe("host");
  expect(sent[1]).toBe(
    "<https://song.link/https://www.youtube.com/watch?v=likedlikedl|Worth Hearing Again — Band>",
  );
  const audited = test.audit.at(-1) as [
    string,
    string,
    Record<string, unknown>,
  ];
  expect(audited[0]).toBe("track.saved");
  expect(audited[1]).toBe("host");
  expect(audited[2]).toMatchObject({
    title: "Worth Hearing Again",
    artist: "Band",
  });
  await test.coordinator.endFromSlack();
});

test("saving a song from another source links the source itself", async () => {
  const test = setup();
  await test.coordinator.start();
  Reflect.set(test.coordinator, "current", {
    ...playingTrack(),
    canonicalUrl: "https://example.com/a|b?x=<1>&y=2",
    title: "Tom & <Jerry>",
    artist: "A > B",
  });
  await test.coordinator.action(
    interaction(test.coordinator, "save_track", "playing"),
  );
  await Bun.sleep(0);
  // The URL parser has already encoded < and >, the | is encoded so it cannot
  // end the target, and the rest is escaped for mrkdwn.
  expect(test.dms.at(-1)?.[1]).toBe(
    "<https://example.com/a%7Cb?x=%3C1%3E&amp;y=2|Tom &amp; &lt;Jerry&gt; — A &gt; B>",
  );
  await test.coordinator.endFromSlack();
});

test("saving a Navidrome share keeps its token out of the DM", async () => {
  const test = setup();
  await test.coordinator.start();
  Reflect.set(test.coordinator, "current", {
    ...playingTrack(),
    canonicalUrl: "https://music.example.com/share/s/secret-token",
    sourceId: "navidrome:share:hash",
  });
  await test.coordinator.action(
    interaction(test.coordinator, "save_track", "playing"),
  );
  await Bun.sleep(0);
  const sent = test.dms.at(-1)!;
  expect(sent[1]).toBe("Worth Hearing Again — Band");
  expect(JSON.stringify(sent)).not.toContain("secret-token");
  await test.coordinator.endFromSlack();
});

test("saving a song that has moved into history still sends it", async () => {
  const test = setup();
  await test.coordinator.start();
  Reflect.set(test.coordinator, "history", [playingTrack()]);
  await test.coordinator.action(
    interaction(test.coordinator, "save_track", "playing"),
  );
  await Bun.sleep(0);
  expect(test.dms.at(-1)?.[1]).toBe(
    "<https://example.com/likedlikedl|Worth Hearing Again — Band>",
  );
  await test.coordinator.endFromSlack();
});

test("a save that cannot be sent tells the listener", async () => {
  const test = setup();
  await test.coordinator.start();
  Reflect.set(test.coordinator, "current", playingTrack());
  Reflect.get(test.coordinator, "slack").dm = async () => {
    throw new Error("channel_not_found");
  };
  const audited = test.audit.length;
  await test.coordinator.action(
    interaction(test.coordinator, "save_track", "playing"),
  );
  await Bun.sleep(0);
  expect(test.ephemeral.at(-1)).toBe(
    "Couldn't send you that song. Try again in a moment.",
  );
  expect(test.audit).toHaveLength(audited);
  await test.coordinator.endFromSlack();
});

test("saving a song nobody remembers tells the listener", async () => {
  const test = setup();
  await test.coordinator.start();
  const dms = test.dms.length;
  await test.coordinator.action(
    interaction(test.coordinator, "save_track", "gone"),
  );
  expect(test.dms).toHaveLength(dms);
  expect(test.ephemeral.at(-1)).toBe("That song has already finished.");
  await test.coordinator.endFromSlack();
});

test("the undo button is not the player's to handle", async () => {
  const test = setup();
  await test.coordinator.start();
  Reflect.set(test.coordinator, "current", playingTrack());
  await test.coordinator.action(
    interaction(test.coordinator, "like_track", "playing"),
  );
  const value = (
    test.ephemeralCalls.at(-1)![4] as { elements?: { value?: string }[] }[]
  )[1]!.elements![0]!.value;
  // A like outlives the session it was made in, so the undo is handled by the
  // app rather than here. What matters at this boundary is that the player
  // does not claim an interaction it would then serialize behind playback and
  // drop once the Huddle ends.
  expect(
    test.coordinator.handles({
      ...interaction(test.coordinator, "unlike_track", value),
      channelId: "channel",
      messageTs: "ephemeral-ts",
    }),
  ).toBeFalse();
  // And the payload carries what the app-level handler needs to act on it.
  expect(parseLikeValue(value!)).toEqual({
    sessionId: test.coordinator.id,
    title: "Worth Hearing Again",
    artist: "Band",
    discovery: true,
  });
  await test.coordinator.endFromSlack();
});

test("an undo payload from before the discovery flag still parses", () => {
  // A button rendered before the flag was carried, or for a track restored
  // after a restart, which loses it.
  expect(
    parseLikeValue(
      JSON.stringify({
        sessionId: "session",
        title: "Worth Hearing Again",
        artist: "Band",
      }),
    ),
  ).toEqual({
    sessionId: "session",
    title: "Worth Hearing Again",
    artist: "Band",
  });
  // Anything the app cannot act on is refused rather than half-read.
  expect(parseLikeValue("not json")).toBeUndefined();
  expect(
    parseLikeValue(JSON.stringify({ title: "No Session", artist: "Band" })),
  ).toBeUndefined();
});

test("a like that lands after the song has gone says so", async () => {
  const test = setup();
  await test.coordinator.start();
  Reflect.set(test.coordinator, "current", playingTrack());
  await test.coordinator.action(
    interaction(test.coordinator, "like_track", "already-finished"),
  );
  expect(test.likes).toEqual([]);
  expect(test.ephemeral.at(-1)).toBe("That song has already finished.");
  await test.coordinator.endFromSlack();
});

test("a like still lands once the song has moved into history", async () => {
  const test = setup();
  await test.coordinator.start();
  Reflect.set(test.coordinator, "history", [playingTrack()]);
  Reflect.set(test.coordinator, "current", undefined);
  await test.coordinator.action(
    interaction(test.coordinator, "like_track", "playing"),
  );
  expect(test.likes).toEqual([
    { userId: "host", title: "Worth Hearing Again", artist: "Band" },
  ]);
  await test.coordinator.endFromSlack();
});

test("saving settings audits the list of settings that changed", async () => {
  const test = setup();
  await test.coordinator.start();
  const save = interaction(
    test.coordinator,
    "save_settings",
    "",
    "view_submission",
  );
  save.state = {
    volume: { percent: { selected_option: { value: "80" } } },
    autoplay: { mode: { selected_option: { value: "related" } } },
    loop: { mode: { selected_option: { value: "off" } } },
  };
  await test.coordinator.action(save);
  const audited = test.audit.at(-1) as [
    string,
    string,
    Record<string, unknown>,
  ];
  expect(audited[0]).toBe("settings.changed");
  expect(audited[1]).toBe("host");
  expect(audited[2]).toMatchObject({
    source: "modal",
    changed: ["volume", "autoplay"],
    changes: [
      { setting: "volume", from: 0.6, to: 0.8 },
      { setting: "autoplay", from: "off", to: "related" },
    ],
  });

  // Saving the same values again changes nothing, and says so.
  await test.coordinator.action(save);
  expect((test.audit.at(-1) as unknown[])[2]).toMatchObject({
    changed: [],
    changes: [],
  });
  await test.coordinator.endFromSlack();
});

test("agent settings changes are audited by setting name", async () => {
  const test = setup();
  await test.coordinator.start();
  expect(
    await test.coordinator.agentUpdateSettings("host", {
      duckingMode: "strong",
      loopMode: "queue",
    }),
  ).toMatchObject({
    ok: true,
    changed: ["loopMode=queue", "duckingMode=strong"],
  });
  const audited = test.audit.at(-1) as [
    string,
    string,
    Record<string, unknown>,
  ];
  expect(audited[0]).toBe("settings.changed");
  expect(audited[2]).toMatchObject({
    source: "agent",
    changed: ["loopMode", "duckingMode"],
    changes: [
      { setting: "loopMode", from: "off", to: "queue" },
      { setting: "duckingMode", from: "gentle", to: "strong" },
    ],
  });
  await test.coordinator.endFromSlack();
});

function sessionSaveSetup(store: Store) {
  return setup(
    {
      prepare: async (track: { sourceId: string }) => `${track.sourceId}.opus`,
      upNextIds: async () => [],
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    store,
  );
}

const submission = (
  coordinator: Coordinator,
  actionId: string,
  userId: string,
  state: Record<string, unknown>,
) => ({
  ...interaction(coordinator, actionId, "", "view_submission"),
  userId,
  previousViewId: "settings-view",
  state: state as ReturnType<typeof interaction>["state"],
});

test("ending can save the session for the next one in the channel to load", async () => {
  const store = new Store(":memory:");
  const first = sessionSaveSetup(store);
  await first.coordinator.start();
  Reflect.set(first.coordinator, "current", queued("a", { status: "playing" }));
  Reflect.set(first.coordinator, "queue", [
    queued("b", { requesterId: "guest" }),
    queued("auto", { automatic: true }),
  ]);
  Reflect.set(first.coordinator, "volume", 0.3);
  Reflect.set(first.coordinator, "loopMode", "queue");
  Reflect.set(first.coordinator, "allowed", new Set(["add", "skip"]));

  await first.coordinator.action(
    interaction(first.coordinator, "open_end_session"),
  );
  const dialog = JSON.stringify(first.pushedModals.at(-1));
  expect(dialog).toContain("end_session_confirm");
  expect(dialog).toContain("Save to this channel");
  expect(dialog).toContain("Save to my account");
  expect(dialog).toContain("A and 1 more");

  await first.coordinator.action(
    submission(first.coordinator, "end_session_confirm", "host", {
      save_to: { choice: { selected_option: { value: "channel" } } },
      save_name: { value: { value: "  Friday  " } },
    }),
  );
  expect(Reflect.get(first.coordinator, "state")).toBe("ended");
  expect(JSON.stringify(first.updatedModals.at(-1))).toContain("“Friday”");
  const [saved] = store.sessionSaves([{ type: "channel", id: "channel" }]);
  expect(saved).toMatchObject({ name: "Friday", savedBy: "host" });
  expect(saved!.tracks.map((track) => track.sourceId)).toEqual(["a", "b"]);
  expect(saved!.tracks[0]).not.toHaveProperty("requesterId");
  expect(saved!.settings).toMatchObject({ volume: 0.3, loopMode: "queue" });
  expect(saved!.settings).not.toHaveProperty("permissions");

  const second = sessionSaveSetup(store);
  await second.coordinator.start();
  expect(JSON.stringify(second.posted[0])).toContain("open_load_session");
  await second.coordinator.action(
    interaction(second.coordinator, "open_load_session"),
  );
  const picker = JSON.stringify(second.modals.at(-1));
  expect(picker).toContain("load_session_save");
  expect(picker).toContain("Friday · 2 songs");

  await second.coordinator.action(
    submission(second.coordinator, "load_session_save", "host", {
      save: { selection: { selected_option: { value: saved!.id } } },
      forget: { enabled: { selected_options: [{ value: "enabled" }] } },
    }),
  );
  await until(() => Boolean(Reflect.get(second.coordinator, "current")));
  const loaded = [
    Reflect.get(second.coordinator, "current"),
    ...(Reflect.get(second.coordinator, "queue") as unknown[]),
  ] as { sourceId: string; requesterId: string }[];
  // Whoever loads the save asked for its songs this time.
  expect(loaded.map((entry) => [entry.sourceId, entry.requesterId])).toEqual([
    ["a", "host"],
    ["b", "host"],
  ]);
  expect(Reflect.get(second.coordinator, "volume")).toBe(0.3);
  expect(Reflect.get(second.coordinator, "loopMode")).toBe("queue");
  // Permissions are the new session's own.
  expect([
    ...(Reflect.get(second.coordinator, "allowed") as Set<string>),
  ]).toEqual(["add", "remove-own"]);
  expect(store.sessionSaves([{ type: "channel", id: "channel" }])).toEqual([]);
  await second.coordinator.endFromSlack();
  store.close();
});

test("a session saved to an account is offered only to its owner", async () => {
  const store = new Store(":memory:");
  const first = sessionSaveSetup(store);
  await first.coordinator.start();
  Reflect.set(first.coordinator, "queue", [queued("a")]);
  Reflect.set(first.coordinator, "allowed", new Set(["end-session"]));
  await first.coordinator.action(
    submission(first.coordinator, "end_session_confirm", "guest", {
      save_to: { choice: { selected_option: { value: "user" } } },
    }),
  );
  expect(Reflect.get(first.coordinator, "state")).toBe("ended");
  expect(store.sessionSaves([{ type: "user", id: "guest" }])[0]).toMatchObject({
    name: "A",
  });

  const second = sessionSaveSetup(store);
  await second.coordinator.start();
  // The guest is in the Huddle, so the player offers to load a save.
  expect(JSON.stringify(second.posted[0])).toContain("open_load_session");
  await second.coordinator.action(
    interaction(second.coordinator, "open_load_session"),
  );
  expect(second.ephemeral.at(-1)).toBe("There are no saved sessions to load.");
  await second.coordinator.action({
    ...interaction(second.coordinator, "open_load_session"),
    userId: "guest",
  });
  expect(JSON.stringify(second.modals.at(-1))).toContain("Your account");

  // Nor can the host load it by naming its id.
  const [save] = store.sessionSaves([{ type: "user", id: "guest" }]);
  await second.coordinator.action(
    submission(second.coordinator, "load_session_save", "host", {
      save: { selection: { selected_option: { value: save!.id } } },
    }),
  );
  expect(second.ephemeral.at(-1)).toBe(
    "That saved session is no longer available.",
  );
  expect(Reflect.get(second.coordinator, "queue")).toEqual([]);
  await second.coordinator.endFromSlack();
  store.close();
});

test("ending without choosing to save keeps nothing", async () => {
  const store = new Store(":memory:");
  const result = sessionSaveSetup(store);
  await result.coordinator.start();
  Reflect.set(result.coordinator, "queue", [queued("a")]);
  await result.coordinator.action(
    submission(result.coordinator, "end_session_confirm", "host", {
      save_to: { choice: { selected_option: { value: "none" } } },
    }),
  );
  expect(Reflect.get(result.coordinator, "state")).toBe("ended");
  expect(store.sessionSaves([{ type: "channel", id: "channel" }])).toEqual([]);
  store.close();
});

const savedTrack = (id: string) => ({
  sourceInput: id,
  canonicalUrl: id,
  sourceId: id,
  title: id.toUpperCase(),
  artist: "Artist",
});

const channelSave = { type: "channel", id: "channel" } as const;

const loadSave = (
  coordinator: Coordinator,
  userId: string,
  id: string,
  forget = false,
) =>
  submission(coordinator, "load_session_save", userId, {
    save: { selection: { selected_option: { value: id } } },
    ...(forget
      ? { forget: { enabled: { selected_options: [{ value: "enabled" }] } } }
      : {}),
  });

test("loading a save takes the add permission, even one without songs", async () => {
  const store = new Store(":memory:");
  const withSongs = store.addSessionSave(
    channelSave,
    "Songs",
    "host",
    [savedTrack("a")],
    {},
  );
  const empty = store.addSessionSave(channelSave, "Empty", "guest", [], {
    loopMode: "queue",
  });
  const result = sessionSaveSetup(store);
  await result.coordinator.start();
  Reflect.set(result.coordinator, "allowed", new Set(["configure-settings"]));

  await result.coordinator.action(
    loadSave(result.coordinator, "guest", withSongs),
  );
  expect(result.ephemeral.at(-1)).toBe("You do not have permission for that.");
  expect(Reflect.get(result.coordinator, "queue")).toEqual([]);

  // Not even its saver can use an empty save to change settings or delete it.
  await result.coordinator.action(
    loadSave(result.coordinator, "guest", empty, true),
  );
  expect(result.ephemeral.at(-1)).toBe("You do not have permission for that.");
  expect(Reflect.get(result.coordinator, "loopMode")).not.toBe("queue");
  expect(store.sessionSaves([channelSave])).toHaveLength(2);
  await result.coordinator.endFromSlack();
  store.close();
});

test("only whoever saved a channel save, or can end the session, deletes it", async () => {
  const store = new Store(":memory:");
  const hosts = store.addSessionSave(
    channelSave,
    "Host's",
    "host",
    [savedTrack("a")],
    {},
  );
  const guests = store.addSessionSave(
    channelSave,
    "Guest's",
    "guest",
    [savedTrack("b")],
    {},
  );
  const result = sessionSaveSetup(store);
  await result.coordinator.start();

  await result.coordinator.action(
    loadSave(result.coordinator, "guest", hosts, true),
  );
  expect(result.ephemeral.at(-1)).toContain(
    "It was kept: only whoever saved it, a channel manager, or someone who can end the session can delete it.",
  );
  await result.coordinator.action(
    loadSave(result.coordinator, "guest", guests, true),
  );
  expect(store.sessionSaves([channelSave]).map((save) => save.id)).toEqual([
    hosts,
  ]);
  // The guest asked for both songs this time.
  await until(
    () => (Reflect.get(result.coordinator, "queue") as unknown[]).length === 1,
  );
  expect(
    [
      Reflect.get(result.coordinator, "current"),
      ...(Reflect.get(result.coordinator, "queue") as unknown[]),
    ].map((entry) => (entry as { requesterId: string }).requesterId),
  ).toEqual(["guest", "guest"]);

  // The host can end the session, so can delete anyone's channel save.
  await result.coordinator.action(
    loadSave(result.coordinator, "host", hosts, true),
  );
  expect(store.sessionSaves([channelSave])).toEqual([]);
  await result.coordinator.endFromSlack();
  store.close();
});

test("a save that does not all fit in the queue loads what fits and is kept", async () => {
  const store = new Store(":memory:");
  const id = store.addSessionSave(
    channelSave,
    "Rock & <Roll>",
    "host",
    [savedTrack("a"), savedTrack("b")],
    {},
  );
  const result = sessionSaveSetup(store);
  await result.coordinator.start();
  const full = Array.from({ length: 50 }, (_, index) => queued(`q${index}`));
  Reflect.set(result.coordinator, "queue", full);
  await result.coordinator.action(
    loadSave(result.coordinator, "host", id, true),
  );
  expect(result.ephemeral.at(-1)).toBe("The queue is full.");
  expect(Reflect.get(result.coordinator, "queue")).toHaveLength(50);

  Reflect.set(result.coordinator, "queue", full.slice(1));
  await result.coordinator.action(
    loadSave(result.coordinator, "host", id, true),
  );
  expect(result.ephemeral.at(-1)).toBe(
    "Loaded “Rock &amp; &lt;Roll&gt;”, but 1 song did not fit in the queue. It was kept, since not all of its songs fit.",
  );
  expect(store.sessionSaves([channelSave])).toHaveLength(1);
  await result.coordinator.endFromSlack();
  store.close();
});

test("a save submitted after its session stopped loads nothing", async () => {
  const store = new Store(":memory:");
  const id = store.addSessionSave(
    channelSave,
    "Late",
    "host",
    [savedTrack("a")],
    {},
  );
  const result = sessionSaveSetup(store);
  await result.coordinator.start();
  await result.coordinator.endFromSlack();
  const notices = result.ephemeral.length;
  await result.coordinator.action(
    loadSave(result.coordinator, "host", id, true),
  );
  expect(Reflect.get(result.coordinator, "queue")).toEqual([]);
  expect(result.ephemeral).toHaveLength(notices);
  expect(store.sessionSaves([channelSave])).toHaveLength(1);
  store.close();
});

test("a loaded song that fails to prepare, with no way to say so, is dropped", async () => {
  const store = new Store(":memory:");
  const id = store.addSessionSave(
    channelSave,
    "Broken",
    "host",
    [savedTrack("bad")],
    {},
  );
  const result = setup(
    {
      prepare: async () => {
        throw new Error("Video unavailable");
      },
      upNextIds: async () => [],
    } as unknown as TrackCatalog,
    undefined,
    undefined,
    undefined,
    store,
  );
  await result.coordinator.start();
  Reflect.set(Reflect.get(result.coordinator, "slack"), "ephemeral", () =>
    Promise.reject(new Error("user_not_in_channel")),
  );
  await result.coordinator.action(loadSave(result.coordinator, "host", id));
  expect(Reflect.get(result.coordinator, "queue")).toEqual([]);
  expect(Reflect.get(result.coordinator, "current")).toBeUndefined();
  await result.coordinator.endFromSlack();
  store.close();
});

test("opening the end dialog without the end permission says so", async () => {
  const result = setup();
  await result.coordinator.start();
  await result.coordinator.action({
    ...interaction(result.coordinator, "open_end_session"),
    userId: "guest",
  });
  expect(result.pushedModals).toEqual([]);
  expect(result.ephemeral.at(-1)).toBe(
    "You do not have permission to end this session.",
  );
  expect(Reflect.get(result.coordinator, "state")).not.toBe("ended");
  await result.coordinator.endFromSlack();
});

test("an end dialog confirmed after the session ended saves nothing", async () => {
  const store = new Store(":memory:");
  const result = sessionSaveSetup(store);
  await result.coordinator.start();
  Reflect.set(result.coordinator, "queue", [queued("a")]);
  await result.coordinator.action(
    interaction(result.coordinator, "open_end_session"),
  );
  await result.coordinator.endFromSlack();
  await result.coordinator.action(
    submission(result.coordinator, "end_session_confirm", "host", {
      save_to: { choice: { selected_option: { value: "channel" } } },
    }),
  );
  expect(store.sessionSaves([channelSave])).toEqual([]);
  expect(JSON.stringify(result.updatedModals.at(-1))).toContain(
    "The session had already ended, so it was not saved.",
  );
  store.close();
});

test("a session that cannot be saved still ends", async () => {
  const store = new Store(":memory:");
  store.addSessionSave = () => {
    throw new Error("SQLITE_FULL");
  };
  const result = sessionSaveSetup(store);
  await result.coordinator.start();
  Reflect.set(result.coordinator, "queue", [queued("a")]);
  await result.coordinator.action(
    submission(result.coordinator, "end_session_confirm", "host", {
      save_to: { choice: { selected_option: { value: "user" } } },
    }),
  );
  expect(Reflect.get(result.coordinator, "state")).toBe("ended");
  expect(JSON.stringify(result.updatedModals.at(-1))).toContain(
    "The session has ended, but it could not be saved.",
  );
  store.close();
});

test("describes itself for the canvas until it ends, and reports membership changes", async () => {
  const result = setup();
  await result.coordinator.start();
  expect(result.coordinator.canvasSession()).toEqual({
    channelId: "channel",
    listeners: 2,
    state: "ready",
    track: undefined,
  });
  const changes = result.sessionChanges.length;
  result.coordinator.memberJoined("listener");
  expect(result.sessionChanges).toHaveLength(changes + 1);
  result.coordinator.memberJoined("listener");
  expect(result.sessionChanges).toHaveLength(changes + 1);
  expect(result.coordinator.canvasSession()?.listeners).toBe(3);
  await result.coordinator.memberLeft("listener");
  expect(result.sessionChanges).toHaveLength(changes + 2);
  await result.coordinator.endFromSlack();
  expect(result.coordinator.canvasSession()).toBeUndefined();
});

test("Your data shows what is kept about a user and deletes only theirs", async () => {
  const store = new Store(":memory:");
  const result = setup(undefined, undefined, undefined, undefined, store);
  await result.coordinator.start();
  for (const userId of ["host", "guest"]) {
    store.recordTrackPlay({
      sessionId: result.coordinator.id,
      userId,
      title: "Heard <it>",
      artist: "Artist",
    });
    store.likeTrack({ userId, title: "Liked", artist: "Artist" });
  }
  const mine = store.addSessionSave(
    { type: "user", id: "host" },
    "Mine",
    "host",
    [],
    {},
  );
  const theirs = store.addSessionSave(
    { type: "user", id: "guest" },
    "Theirs",
    "guest",
    [],
    {},
  );

  await result.coordinator.action(
    interaction(result.coordinator, "open_settings"),
  );
  const you = JSON.stringify(await settingsTab(result, "host", "you"));
  expect(you).toContain('"action_id":"open_your_data"');
  await pressInSettings(result, "host", "open_your_data", {}, "host", {
    tab: "you",
  });
  const data = JSON.stringify(result.pushedModals.at(-1));
  expect(data).toContain("*Songs you heard* · 1\\nHeard &lt;it&gt; — Artist");
  expect(data).toContain(`"block_id":"delete_own_save_${mine}"`);
  expect(data).not.toContain(theirs);
  expect(data).toContain("never deleted");

  // Your data carries Settings' metadata, to redraw it under it.
  const dataMetadata = (
    result.pushedModals.at(-1) as [unknown, { private_metadata: string }]
  )[1].private_metadata;
  expect(JSON.parse(dataMetadata)).toMatchObject({
    sessionId: result.coordinator.id,
    settings: { tab: "you" },
  });
  const press = (actionId: string, value = result.coordinator.id) =>
    result.coordinator.action({
      ...interaction(result.coordinator, actionId, value),
      messageTs: "",
      viewId: "data-view",
      viewHash: "hash",
      previousViewId: "settings-view",
      metadata: dataMetadata,
    });
  await press("delete_data_plays");
  expect(store.userData("host").plays.count).toBe(0);
  expect(store.userData("guest").plays.count).toBe(1);
  const [viewId, , view] = result.updatedModals.at(-2)!;
  expect(viewId).toBe("data-view");
  expect(result.updatedModals.at(-1)![0]).toBe("settings-view");
  expect(JSON.stringify(view)).toContain("Deleted 1 play.");
  expect(result.audit).toContainEqual([
    "data.deleted",
    "host",
    { sessionId: result.coordinator.id, kind: "plays", count: 1 },
  ]);

  // Someone else's save cannot be deleted by naming it.
  await press("delete_own_save", theirs);
  expect(JSON.stringify(result.updatedModals.at(-2))).toContain(
    "That saved session is no longer there.",
  );
  expect(store.sessionSaves([{ type: "user", id: "guest" }])).toHaveLength(1);
  await press("delete_own_save", mine);
  expect(store.sessionSaves([{ type: "user", id: "host" }])).toEqual([]);

  // A You tab edit made before deleting everything is let go with it, so
  // saving Settings afterwards cannot write it back.
  const withEdit = JSON.parse(dataMetadata);
  withEdit.settings.draft = {
    huddle_mix: { "sources:added": { selected_options: [] } },
    autoplay: { mode: { selected_option: { value: "huddle" } } },
  };
  await result.coordinator.action({
    ...interaction(
      result.coordinator,
      "delete_all_data",
      result.coordinator.id,
    ),
    messageTs: "",
    viewId: "data-view",
    viewHash: "hash",
    previousViewId: "settings-view",
    metadata: JSON.stringify(withEdit),
  });
  const redrawn = result.updatedModals.at(-1)!;
  expect(redrawn[0]).toBe("settings-view");
  expect(
    JSON.parse((redrawn[2] as { private_metadata: string }).private_metadata)
      .draft,
  ).toEqual({ autoplay: { mode: { selected_option: { value: "huddle" } } } });
  expect(store.userData("host").likes.count).toBe(0);
  expect(store.userData("guest").likes.count).toBe(1);
  expect(result.audit).toContainEqual([
    "data.deleted",
    "host",
    { sessionId: result.coordinator.id, kind: "all" },
  ]);
  await result.coordinator.endFromSlack();
  store.close();
});

test("a song whose adder took their name off it is shown without one", () => {
  expect(addedBy({ requesterId: "" })).toBe("Added by a listener");
  expect(addedBy({ requesterId: "U1" })).toBe("Added by <@U1>");
});

test("a Scrobble to choice for a service disconnected since does not stop a save", async () => {
  const userStore = new Store(":memory:");
  userStore.connectLastFm("host", "last-user", "session-key");
  const scrobbling = new ScrobbleDispatcher(userStore, {});
  const test = setup(undefined, undefined, undefined, scrobbling, userStore);
  await test.coordinator.start();
  // Disconnecting redraws Settings with the ticked box kept in its draft.
  userStore.disconnectLastFm("host");
  await test.coordinator.action({
    ...interaction(test.coordinator, "save_settings", "", "view_submission"),
    metadata: JSON.stringify({
      sessionId: test.coordinator.id,
      hostId: "host",
      draft: {
        scrobble_to: {
          "services:lastfm": { selected_options: [{ value: "lastfm" }] },
        },
      },
    }),
    state: { huddle_mix: { "sources:added": { selected_options: [] } } },
  });
  expect(test.ephemeral).toEqual([]);
  expect(userStore.getUserScrobbling("host")).toMatchObject({
    lastFmEnabled: false,
    huddleMixOptIn: false,
  });
  await test.coordinator.endFromSlack();
  userStore.close();
});

test("Settings opened with no host is stale once someone becomes host", async () => {
  const test = setup();
  await test.coordinator.start();
  Reflect.set(test.coordinator, "hostId", undefined);
  await test.coordinator.action({
    ...interaction(test.coordinator, "open_settings"),
    userId: "guest",
  });
  const metadata = (
    test.modals.at(-1) as [unknown, { private_metadata: string }]
  )[1].private_metadata;
  expect(JSON.parse(metadata).hostId).toBe("");
  Reflect.set(test.coordinator, "hostId", "host");
  await test.coordinator.action({
    ...interaction(test.coordinator, "save_settings", "", "view_submission"),
    userId: "guest",
    metadata,
  });
  expect(test.ephemeral.at(-1)).toBe("Settings are stale; reopen them.");
  await test.coordinator.endFromSlack();
});

test("songs whose adder took their name off them name nobody", async () => {
  const result = setup();
  await result.coordinator.start();
  const anonymous = queued("a", { requesterId: "", status: "played" });
  const play = await Reflect.get(result.coordinator, "playMessage").call(
    result.coordinator,
    anonymous,
  );
  expect(play.requesterLabel).toBe("Added by a listener");
  Reflect.set(result.coordinator, "history", [
    anonymous,
    queued("b", { requesterId: "guest", status: "played" }),
  ]);
  const recap = JSON.stringify(
    Reflect.get(result.coordinator, "recapBlocks").call(
      result.coordinator,
      "Ended",
    ),
  );
  expect(recap).not.toContain("<@>");
  expect(recap).toContain("*Most frequent requester:* <@guest>");
  await result.coordinator.endFromSlack();
});

test("after a restart, the video that was playing goes on first, from where it was", async () => {
  let finish = () => {};
  const tracks = {
    prepareVideo: async (_track: unknown, _directory: string, id: string) => {
      if (id === "interrupted") await new Promise<void>((r) => (finish = r));
      return { stream: { url: `https://93.184.216.34/${id}` }, form: "video" };
    },
    transition: () => undefined,
    streamProxy: "http://127.0.0.1:4000",
  } as unknown as TrackCatalog;
  const video = (id: string, title: string) => ({
    id,
    requesterId: "host",
    sourceInput: `https://www.youtube.com/watch?v=${id}`,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    sourceId: id,
    title,
    artist: "Channel",
    kind: "video" as const,
    form: "video" as const,
  });
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
    state: "playing",
    volume: 0.4,
    autoplay: "off",
    loopMode: "off",
    transitionMode: "none",
    displayMode: "default",
    anchorEnabled: false,
    playbackSeconds: 42,
    listenedSeconds: 0,
    mediaMode: "video",
    captions: false,
    watchedSeconds: 0,
    resumeUntil: 180_000,
    permissions: ["add"],
    tracks: [
      // Streamed, so it has to be fetched again.
      { ...video("interrupted", "Interrupted"), status: "playing" },
      // Downloaded, so it is ready at once.
      {
        ...video("downloaded", "Downloaded"),
        status: "ready",
        filePath: "package.json",
      },
    ],
  };
  const result = setup(tracks, undefined, restored);
  await result.coordinator.resume("restorer");
  const plays = () =>
    result.media.filter((message: any) => message.type === "play");
  await Bun.sleep(20);
  expect(plays()).toEqual([]);
  finish();
  for (let index = 0; index < 300 && !plays().length; index++)
    await Bun.sleep(2);
  expect(plays().map((message: any) => message.entryId)).toEqual([
    "interrupted",
  ]);
  expect(result.media).toContainEqual({ type: "seek", seconds: 42 });
  await result.coordinator.endFromSlack();
});

test("player updates go out beside the queue and collapse while one is in flight", async () => {
  const result = setup();
  await result.coordinator.start();
  const sent: unknown[][] = [];
  const answers: (() => void)[] = [];
  Reflect.set(
    Reflect.get(result.coordinator, "slack"),
    "update",
    (...args: unknown[]) => {
      sent.push(args);
      return new Promise<void>((resolve) => answers.push(resolve));
    },
  );
  const blocks = () =>
    (Reflect.get(result.coordinator, "blocks") as () => unknown).call(
      result.coordinator,
    );

  // Each click is done without waiting on Slack, and the first goes out at
  // once.
  for (let index = 0; index < 3; index++)
    await result.coordinator.action(
      interaction(result.coordinator, "volume_up"),
    );
  expect(sent).toHaveLength(1);
  // The two made meanwhile collapse into the newest.
  answers.shift()!();
  await until(() => sent.length === 2);
  expect(sent[1]![3]).toEqual(blocks());
  answers.shift()!();
  await Bun.sleep(0);
  expect(sent).toHaveLength(2);
  await result.coordinator.endFromSlack();
});

test("a player update Slack turns away is sent again", async () => {
  const result = setup();
  await result.coordinator.start();
  const sent: unknown[][] = [];
  let failures = 1;
  Reflect.set(
    Reflect.get(result.coordinator, "slack"),
    "update",
    async (...args: unknown[]) => {
      sent.push(args);
      if (failures-- > 0)
        throw Object.assign(new Error("rate limited"), { retryAfter: 30 });
    },
  );
  await result.coordinator.action(interaction(result.coordinator, "volume_up"));
  await Bun.sleep(0);
  // Waiting out the rate limit, which settling the player cuts short.
  expect(sent).toHaveLength(1);
  await (
    Reflect.get(result.coordinator, "settlePlayer") as () => Promise<void>
  ).call(result.coordinator);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]!);
  await result.coordinator.endFromSlack();
});

test("dialogs open without waiting behind other actions", async () => {
  const result = setup();
  await result.coordinator.start();
  let release!: () => void;
  const enqueue = Reflect.get(result.coordinator, "enqueue") as (
    work: () => Promise<void>,
  ) => Promise<void>;
  const busy = enqueue.call(
    result.coordinator,
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  await result.coordinator.action(
    interaction(result.coordinator, "view_full_queue"),
  );
  await result.coordinator.action(
    interaction(result.coordinator, "open_end_session"),
  );
  expect(result.modals).toHaveLength(1);
  expect(result.pushedModals).toHaveLength(1);
  release();
  await busy;
  await result.coordinator.endFromSlack();
});

test("searches start at once, keep the newest query, and reuse recent results", async () => {
  const queries: string[] = [];
  let finish!: () => void;
  let hold = false;
  const tracks = {
    suggestions: async (query: string) => {
      queries.push(query);
      if (hold) await new Promise<void>((resolve) => (finish = resolve));
      return [{ text: { type: "plain_text", text: query }, value: query }];
    },
  } as unknown as TrackCatalog;
  const test = setup(tracks);
  await test.coordinator.start();
  const search = (value: string) =>
    test.coordinator.suggestions(
      interaction(test.coordinator, "selection", value),
    );

  expect(await search("abc")).toEqual([
    { text: { type: "plain_text", text: "abc" }, value: "abc" },
  ]);
  // Typed again, it is not searched again.
  await search("abc");
  expect(queries).toEqual(["abc"]);

  hold = true;
  const running = search("abcd");
  const passedOver = search("abcde");
  const newest = search("abcdef");
  await Bun.sleep(0);
  hold = false;
  finish();
  expect(await running).toHaveLength(1);
  // Only the newest of those typed meanwhile is searched; Slack still gets
  // an answer for the others.
  expect(await passedOver).toEqual([]);
  expect(await newest).toHaveLength(1);
  expect(queries).toEqual(["abc", "abcd", "abcdef"]);
  await test.coordinator.endFromSlack();
});

test("played tracks before the last few give up their files, and Previous prepares one again", async () => {
  const directory = `${tmpdir()}/huddlefm-history-${crypto.randomUUID()}`;
  await mkdir(directory, { recursive: true });
  const prepared: string[] = [];
  const tracks = {
    resolve: async (value: string) => ({
      sourceInput: `https://example.com/${value}`,
      canonicalUrl: `https://example.com/${value}`,
      sourceId: value,
      title: value,
      artist: "Artist",
    }),
    prepare: async (
      track: { title: string },
      _directory: string,
      id: string,
    ) => {
      prepared.push(track.title);
      const filePath = `${directory}/${id}.opus`;
      await Bun.write(filePath, "audio");
      return filePath;
    },
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  const titles = ["a", "b", "c", "d", "e", "f", "g"];
  for (const title of titles)
    await result.coordinator.action(
      interaction(result.coordinator, "add_track_to_queue", title),
    );
  const current = () =>
    Reflect.get(result.coordinator, "current") as
      { id: string; title: string; filePath?: string } | undefined;
  for (let index = 0; index < titles.length - 1; index++)
    await result.coordinator.mediaEvent("track_ended", {
      entryId: current()!.id,
    });
  await Bun.sleep(10);
  const history = Reflect.get(result.coordinator, "history") as {
    title: string;
    filePath?: string;
  }[];
  expect(history.map((entry) => entry.title)).toEqual(titles.slice(0, -1));
  // The oldest has given up its file; the last five keep theirs.
  expect(history[0]!.filePath).toBeUndefined();
  expect(history.slice(1).every((entry) => entry.filePath)).toBeTrue();
  expect(
    await Array.fromAsync(new Bun.Glob("*.opus").scan(directory)),
  ).toHaveLength(titles.length - 1);

  // Going back that far prepares it again, and it plays.
  for (let index = 0; index < titles.length - 1; index++)
    await result.coordinator.action(
      interaction(result.coordinator, "previous_track"),
    );
  await until(() => current()?.title === "a");
  expect(prepared).toEqual([...titles, "a"]);
  expect(current()!.filePath).toBeDefined();
  await result.coordinator.endFromSlack();
  await rm(directory, { recursive: true, force: true });
});

const dataBroadcasts = (media: unknown[]) =>
  media.flatMap((message) => {
    const value = message as { type?: string; payload?: Record<string, any> };
    return value.type === "data_broadcast" && value.payload
      ? [value.payload]
      : [];
  });

async function pluginSetup() {
  const tracks = {
    resolve: async (value: string) => ({
      sourceInput: value,
      canonicalUrl: value,
      sourceId: value.includes("b") ? "bbbbbbbbbbb" : "aaaaaaaaaaa",
      title: value.includes("b") ? "B" : "A",
      artist: "Artist",
      album: "Album",
      artwork: "https://i.example/a.jpg",
      duration: 100,
    }),
    prepare: async (metadata: { sourceId: string }) =>
      `${metadata.sourceId}.opus`,
    suggestions: async (query: string) => [
      { text: { type: "plain_text", text: `Link: ${query}` }, value: query },
    ],
  } as unknown as TrackCatalog;
  const result = setup(tracks);
  await result.coordinator.start();
  const send = async (userId: string, payload: Record<string, unknown>) => {
    result.coordinator.dataMessage({
      userId,
      attendeeId: `${userId}-attendee`,
      payload: { v: 1, ...payload },
    });
    await Bun.sleep(300);
  };
  return { ...result, send };
}

test("client mods sync the session over the data channel", async () => {
  const result = await pluginSetup();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "https://a"),
  );
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "https://b"),
  );
  await Bun.sleep(0);
  // Nothing goes out before a client asks.
  expect(dataBroadcasts(result.media)).toEqual([]);
  await result.send("guest", { type: "sync" });
  const messages = dataBroadcasts(result.media);
  const state = messages.findLast((message) => message.type === "state")!;
  const you = messages.find((message) => message.type === "you")!;
  expect(state).toMatchObject({
    type: "state",
    seq: expect.any(Number),
    session: {
      mode: "music",
      state: "playing",
      volume: 60,
      hostId: "host",
      allowed: ["add", "remove-own"],
      queueLimit: 50,
      player: { channel: "channel", ts: "1" },
    },
    nowPlaying: {
      title: "A",
      artist: "Artist",
      album: "Album",
      artwork: "https://i.example/a.jpg",
      duration: 100,
      kind: "song",
      addedBy: "host",
    },
    queue: [{ title: "B", status: expect.any(String) }],
    participants: ["host", "guest"],
  });
  expect(
    (state.settings as { id: string; requires: string }[]).map((field) => [
      field.id,
      field.requires,
    ]),
  ).toContainEqual(["permissions", "admin"]);
  expect(you).toEqual({
    type: "you",
    to: "guest",
    capabilities: ["add", "remove-own"],
    admin: false,
    settings: [],
  });
  await result.coordinator.endFromSlack();
  expect(dataBroadcasts(result.media).at(-1)).toMatchObject({
    type: "state",
    session: { state: "ended" },
  });
});

test("client mods use the player as their user, noted as over the data channel", async () => {
  const result = await pluginSetup();
  await result.coordinator.action(
    interaction(result.coordinator, "add_track_to_queue", "https://a"),
  );
  await Bun.sleep(0);
  await result.send("guest", {
    type: "command",
    id: "r1",
    command: { type: "skip" },
  });
  await result.send("host", {
    type: "command",
    id: "r2",
    command: { type: "toggle" },
  });
  await result.send("stranger", {
    type: "command",
    id: "r3",
    command: { type: "pause" },
  });
  const results = dataBroadcasts(result.media).filter(
    (message) => message.type === "result",
  );
  expect(results).toEqual([
    {
      type: "result",
      to: "guest",
      id: "r1",
      command: "skip",
      ok: false,
      error: "missing_permission",
      message: "You do not have permission for that.",
    },
    {
      type: "result",
      to: "host",
      id: "r2",
      command: "toggle",
      ok: true,
    },
    expect.objectContaining({
      to: "stranger",
      id: "r3",
      ok: false,
      message: "Join the huddle before using the player.",
    }),
  ]);
  // the user's own pause, as the player's button records it
  expect(result.audit).toContainEqual([
    "playback.paused",
    "host",
    expect.objectContaining({ via: "data_channel" }),
  ]);
  // and nothing posted in the thread for what the client was answered
  expect(result.ephemeral).toEqual([]);
  await result.coordinator.endFromSlack();
});

test("client mods seek, move and end with a save as the player's dialogs do", async () => {
  const result = await pluginSetup();
  for (const link of ["https://a", "https://b", "https://a?2"])
    await result.coordinator.action(
      interaction(result.coordinator, "add_track_to_queue", link),
    );
  await Bun.sleep(0);
  const status = result.coordinator.agentStatus("host") as {
    queue: { id: string }[];
  };
  const last = status.queue.at(-1)!.id;
  await result.send("host", { type: "sync" });
  await result.send("host", {
    type: "command",
    id: "r1",
    command: { type: "seek", to: 30 },
  });
  await result.send("host", {
    type: "command",
    id: "r2",
    command: { type: "move", trackId: last, position: 1 },
  });
  await result.send("host", {
    type: "command",
    id: "r3",
    command: { type: "end", save: "channel", name: "Friday" },
  });
  const ok = (id: string) =>
    dataBroadcasts(result.media).find(
      (message) => message.type === "result" && message.id === id,
    )?.ok;
  expect([ok("r1"), ok("r2")]).toEqual([true, true]);
  for (const event of ["playback.seeked", "queue.reordered", "session.ended"])
    expect(result.audit).toContainEqual([
      event,
      "host",
      expect.objectContaining({ via: "data_channel" }),
    ]);
  expect(result.audit).toContainEqual([
    "playback.seeked",
    "host",
    expect.objectContaining({ seconds: 30 }),
  ]);
  // as End session's dialog ends it
  expect(result.audit).toContainEqual([
    "session.ended",
    "host",
    expect.objectContaining({ reason: "ended by host" }),
  ]);
  expect(dataBroadcasts(result.media).at(-1)).toMatchObject({
    type: "state",
    session: { state: "ended" },
  });
});

test("client mods add a pasted link as Add songs' search has it", async () => {
  const result = await pluginSetup();
  await result.send("host", {
    type: "command",
    id: "r1",
    command: { type: "add", reference: "https://b" },
  });
  expect(dataBroadcasts(result.media)).toContainEqual(
    expect.objectContaining({ type: "result", id: "r1", ok: true }),
  );
  await result.send("host", { type: "sync" });
  const state = dataBroadcasts(result.media).findLast(
    (message) => message.type === "state",
  )!;
  expect(state).toMatchObject({ nowPlaying: { title: "B" } });
  await result.coordinator.endFromSlack();
});

test("client mods hear what the player's buttons would quietly pass over", async () => {
  const result = await pluginSetup();
  const asks: Record<string, unknown>[] = [
    { type: "toggle" },
    { type: "remove", trackId: "gone" },
    { type: "keep", trackId: "gone" },
    { type: "seek", to: 10 },
  ];
  for (const [index, command] of asks.entries())
    await result.send("host", { type: "command", id: `r${index}`, command });
  const results = dataBroadcasts(result.media).filter(
    (message) => message.type === "result",
  );
  expect(results.map((message) => [message.ok, message.message])).toEqual([
    [false, "Nothing is playing."],
    [false, "That song isn't in the queue."],
    [false, "That song isn't an autoplay pick."],
    [false, "Nothing is playing."],
  ]);
  await result.coordinator.endFromSlack();
});

test("client mods can't send settings the modal wouldn't", async () => {
  const result = await pluginSetup();
  await result.send("host", { type: "sync" });
  const tries: [string, unknown, string?][] = [
    ["volume", ""],
    ["volume", " 1e1 "],
    // only video mode shows video's autoplay
    ["video_autoplay", "related"],
    ["permissions", undefined, "toString"],
  ];
  for (const [index, [setting, value, preset]] of tries.entries())
    await result.send("host", {
      type: "setting",
      id: `r${index}`,
      setting,
      ...(value === undefined ? {} : { value }),
      ...(preset ? { preset } : {}),
    });
  const results = dataBroadcasts(result.media).filter(
    (message) => message.type === "result",
  );
  expect(results.map((message) => message.ok)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(result.coordinator.agentStatus("host")).toMatchObject({
    volumePercent: 60,
  });
  await result.coordinator.endFromSlack();
});

test("client mods change settings as the modal would", async () => {
  const result = await pluginSetup();
  await result.send("host", { type: "sync" });
  await result.send("guest", { type: "sync" });
  await result.send("host", {
    type: "setting",
    id: "r1",
    setting: "loop",
    value: "queue",
  });
  await result.send("guest", {
    type: "setting",
    id: "r2",
    setting: "loop",
    value: "track",
  });
  await result.send("host", {
    type: "setting",
    id: "r3",
    setting: "permissions",
    value: ["skip", "volume", "not-a-capability"],
  });
  await result.send("guest", {
    type: "setting",
    id: "r4",
    setting: "volume",
    value: "35",
  });
  const messages = dataBroadcasts(result.media);
  const results = messages.filter((message) => message.type === "result");
  expect(results.map((message) => [message.id, message.ok])).toEqual([
    ["r1", true],
    ["r2", false],
    ["r3", true],
    ["r4", true],
  ]);
  expect(result.coordinator.agentStatus("host")).toMatchObject({
    loopMode: "queue",
    volumePercent: 35,
  });
  expect(result.audit).toContainEqual([
    "settings.changed",
    "host",
    expect.objectContaining({ via: "data_channel" }),
  ]);
  // The guest hears what they may do now.
  expect(
    messages.findLast(
      (message) => message.type === "you" && message.to === "guest",
    ),
  ).toMatchObject({ capabilities: ["skip", "volume"] });
  expect(
    messages.findLast((message) => message.type === "state"),
  ).toMatchObject({
    session: { allowed: ["skip", "volume"], loopMode: "queue", volume: 35 },
  });
  await result.coordinator.endFromSlack();
});
