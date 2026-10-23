import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AuditLog } from "./audit-log.ts";
import { Coordinator } from "./coordinator.ts";
import type { LyricsCatalog } from "./lyrics.ts";
import type { SlackAppAdapter } from "./slack-app.ts";
import { Store } from "./store.ts";
import type { PreparedMedia, TrackCatalog, TrackMetadata } from "./tracks.ts";
import { captionsPath, chaptersPath } from "./videos.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function mediaDirectory() {
  const directory = `${tmpdir()}/huddlefm-video-${crypto.randomUUID()}`;
  await mkdir(directory, { recursive: true });
  directories.push(directory);
  return directory;
}

type Block = {
  type: string;
  block_id?: string;
  action_id?: string;
  elements?: { action_id?: string; text?: { text?: string } }[];
  child_blocks?: Block[];
  title?: { text: string };
  subtitle?: { text: string };
  element?: Record<string, unknown>;
  text?: { text: string };
};

/**
 * A session with a real store and a fake catalog that prepares videos as
 * files on disk, which counts what it was asked for.
 */
async function setup(
  options: { videoSessions?: number; sessionLimit?: number } = {},
) {
  const directory = await mediaDirectory();
  const posted: unknown[][] = [];
  const updates: unknown[][] = [];
  const ephemeral: { user: string; text: string }[] = [];
  const modals: unknown[][] = [];
  const updatedModals: [string, string | undefined, any][] = [];
  const dms: unknown[][] = [];
  const replacements: unknown[][] = [];
  const media: any[] = [];
  const audit: unknown[][] = [];
  const prepared: { id: string; video: boolean }[] = [];
  const references = new Map<string, TrackMetadata | string>();
  // What YouTube would play after each video, by video ID.
  const related = new Map<string, TrackMetadata[]>();
  let post = 0;
  const slack = {
    post: async (...args: unknown[]) => (posted.push(args), String(++post)),
    update: async (...args: unknown[]) => {
      updates.push(args);
    },
    delete: async () => {},
    ephemeral: async (_channel: string, user: string, text: string) => {
      ephemeral.push({ user, text });
    },
    modal: async (...args: unknown[]) => {
      modals.push(args);
      return { id: "view", hash: "hash" };
    },
    pushModal: async () => {},
    updateModal: async (
      viewId: string,
      hash: string | undefined,
      view: any,
    ) => {
      updatedModals.push([viewId, hash, view]);
      return { id: viewId, hash: "next" };
    },
    userName: async (userId: string) => `Name ${userId}`,
    dm: async (...args: unknown[]) => {
      dms.push(args);
      return { channelId: "D1", ts: `dm-${dms.length}` };
    },
    replaceOriginal: async (...args: unknown[]) => {
      replacements.push(args);
    },
  } as unknown as SlackAppAdapter;
  const file = async (name: string) => {
    const path = `${directory}/${name}`;
    await writeFile(path, "media");
    return path;
  };
  const tracks = {
    prepare: async (_track: TrackMetadata, _dir: string, id: string) => {
      prepared.push({ id, video: false });
      return file(`${id}.opus`);
    },
    prepareVideo: async (
      track: TrackMetadata,
      _dir: string,
      id: string,
      _signal?: AbortSignal,
      _priority?: number,
      preparedAudio?: string,
    ): Promise<PreparedMedia> => {
      prepared.push({ id, video: true });
      if (track.kind === "video") {
        const filePath = await file(`${id}.video.mkv`);
        await writeFile(
          captionsPath(filePath),
          "1\n00:00:00,000 --> 00:00:01,000\nHi\n",
        );
        await writeFile(
          chaptersPath(filePath),
          JSON.stringify([
            { start: 0, title: "Intro" },
            { start: 90, title: "The good part" },
          ]),
        );
        return { filePath, form: "video" };
      }
      if (track.title.includes("Video"))
        return { filePath: await file(`${id}.video.mkv`), form: "music_video" };
      return {
        filePath: preparedAudio ?? (await file(`${id}.opus`)),
        form: "audio",
      };
    },
    resolve: async (reference: string) => {
      const stored = references.get(reference);
      if (!stored) throw new Error("expired");
      return typeof stored === "string"
        ? { ...clip, sourceInput: stored, canonicalUrl: stored }
        : stored;
    },
    resolveUrl: async (url: string) => ({
      ...clip,
      sourceInput: url,
      canonicalUrl: url,
    }),
    suggestions: async () => [],
    relatedVideos: async (videoId: string) => related.get(videoId) ?? [],
    transition: () => undefined,
    referencedUrl: (reference: string) => {
      const stored = references.get(reference);
      return typeof stored === "string" ? stored : undefined;
    },
    referencedTitle: (reference: string) => {
      const stored = references.get(reference);
      return typeof stored === "object" ? stored.title : undefined;
    },
  } as unknown as TrackCatalog;
  const store = new Store(":memory:");
  const coordinator = new Coordinator(
    {
      huddleCallId: "call",
      huddleId: "huddle",
      huddleCreatorId: "host",
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
    { get: async () => undefined } as unknown as LyricsCatalog,
    {
      record: (...args: unknown[]) => {
        audit.push(args);
      },
    } as unknown as AuditLog,
    {
      queueLimit: 50,
      initialVolume: 0.6,
      duckingMode: "gentle",
      aloneMs: 60_000,
      idleMs: 600_000,
      pausedMs: 600_000,
      warningMs: 120_000,
      port: 3210,
      excludedUserIds: new Set(),
      video: { sessionLimit: options.sessionLimit ?? 2 },
    },
    "token",
    (message) => media.push(message),
    async () => {},
    undefined,
    undefined,
    () => {},
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    () => options.videoSessions ?? 0,
  );
  await coordinator.start();
  // Everyone may add, skip and pause.
  const allowed = ["add", "add-bulk", "skip", "pause"];
  for (const capability of allowed)
    store.setPermission(coordinator.id, capability, true);
  Reflect.set(coordinator, "allowed", new Set(allowed));
  return {
    coordinator,
    store,
    posted,
    updates,
    ephemeral,
    modals,
    updatedModals,
    dms,
    replacements,
    media,
    audit,
    prepared,
    references,
    related,
    /** The player as last drawn. */
    player() {
      const last = [
        ...posted.map((call) => call[3]),
        ...updates.map((call) => call[3]),
      ]
        .filter(Boolean)
        .at(-1) as Block[];
      return last;
    },
  };
}

const clip: TrackMetadata = {
  sourceInput: "https://www.youtube.com/watch?v=abcdefghijk",
  canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk",
  sourceId: "abcdefghijk",
  title: "A clip",
  artist: "Channel",
  duration: 600,
  kind: "video",
};

const song: TrackMetadata = {
  sourceInput: "https://music.youtube.com/watch?v=songsongson",
  canonicalUrl: "https://music.youtube.com/watch?v=songsongson",
  sourceId: "songsongson",
  title: "A Song",
  artist: "Artist",
  duration: 200,
  kind: "song",
};

function press(
  coordinator: Coordinator,
  actionId: string,
  options: {
    userId?: string;
    value?: string;
    type?: string;
    state?: Record<string, Record<string, any>>;
    metadata?: Record<string, unknown>;
    viewId?: string;
    messageTs?: string;
    responseUrl?: string;
  } = {},
) {
  const type = options.type ?? "block_actions";
  return coordinator.action({
    type,
    userId: options.userId ?? "host",
    actionId,
    value: options.value ?? coordinator.id,
    channelId: "channel",
    messageTs: options.messageTs ?? (type === "view_submission" ? "" : "1"),
    triggerId: "trigger",
    ...(options.viewId ? { viewId: options.viewId, viewHash: "hash" } : {}),
    ...(options.responseUrl ? { responseUrl: options.responseUrl } : {}),
    metadata: JSON.stringify({
      sessionId: coordinator.id,
      hostId: "host",
      ...options.metadata,
    }),
    state: options.state ?? {},
  });
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 200 && !predicate(); index++) await Bun.sleep(2);
  expect(predicate()).toBeTrue();
}

async function saveMode(
  coordinator: Coordinator,
  mode: string,
  userId = "host",
) {
  await press(coordinator, "save_settings", {
    userId,
    type: "view_submission",
    state: { media_mode: { mode: { selected_option: { value: mode } } } },
  });
}

async function queue(
  result: Awaited<ReturnType<typeof setup>>,
  track: TrackMetadata,
  userId = "host",
) {
  const reference = `trackref_${crypto.randomUUID()}`;
  result.references.set(reference, track);
  await press(result.coordinator, "add_track_to_queue", {
    userId,
    type: "view_submission",
    state: { track: { selection: { selected_option: { value: reference } } } },
  });
}

function buttons(blocks: Block[]) {
  return blocks
    .flatMap((block) => [block, ...(block.child_blocks ?? [])])
    .flatMap((block) => block.elements ?? [])
    .map((element) => element.action_id);
}

test("the host switches to video mode in Settings, and media shares the screen", async () => {
  const result = await setup();
  await saveMode(result.coordinator, "video");
  expect(result.coordinator.videoMode).toBeTrue();
  expect(result.media).toContainEqual({ type: "video_mode", on: true });
  // The music's own settings stop applying without changing.
  expect(result.media).toContainEqual({
    type: "transition_mode",
    mode: "none",
  });
  expect(result.media).toContainEqual({ type: "ducking_mode", mode: "off" });
  expect(
    result.store.resumableSessions(Date.now(), 60_000).sessions[0],
  ).toMatchObject({
    mediaMode: "video",
  });
  expect(result.audit).toContainEqual([
    "session.mode_changed",
    "host",
    expect.objectContaining({ mode: "video", previous: "music" }),
  ]);
  await saveMode(result.coordinator, "music");
  expect(result.coordinator.videoMode).toBeFalse();
  expect(result.media.at(-1)).toEqual({ type: "video_mode", on: false });
  expect(result.media).toContainEqual({ type: "ducking_mode", mode: "gentle" });
  await result.coordinator.endFromSlack();
});

test("only the host switches modes", async () => {
  const result = await setup();
  Reflect.set(result.coordinator, "allowed", new Set(["configure-settings"]));
  await saveMode(result.coordinator, "video", "guest");
  expect(result.coordinator.videoMode).toBeFalse();
  await result.coordinator.endFromSlack();
});

test("video mode waits for a screen share slot and the server's limit", async () => {
  const busy = await setup();
  busy.coordinator.mediaEvent("content_shares", { count: 2 });
  await saveMode(busy.coordinator, "video");
  expect(busy.coordinator.videoMode).toBeFalse();
  expect(busy.ephemeral.at(-1)?.text).toContain(
    "Two people are already sharing their screens",
  );
  busy.coordinator.mediaEvent("content_shares", { count: 1 });
  await saveMode(busy.coordinator, "video");
  expect(busy.coordinator.videoMode).toBeTrue();
  await busy.coordinator.endFromSlack();

  const full = await setup({ videoSessions: 2 });
  await saveMode(full.coordinator, "video");
  expect(full.coordinator.videoMode).toBeFalse();
  expect(full.ephemeral.at(-1)?.text).toBe(
    "Video mode is in use in 2 other huddles, the limit on this server.",
  );
  await full.coordinator.endFromSlack();

  const off = await setup({ sessionLimit: 0 });
  await saveMode(off.coordinator, "video");
  expect(off.coordinator.videoMode).toBeFalse();
  expect(off.ephemeral.at(-1)?.text).toBe(
    "Video mode is turned off on this server.",
  );
  await off.coordinator.endFromSlack();
});

test("a video plays on the share with its captions, and the player swaps Like for Jump to", async () => {
  const result = await setup();
  await saveMode(result.coordinator, "video");
  await queue(result, clip);
  await until(() => result.media.some((message) => message.type === "play"));
  const play = result.media.find((message) => message.type === "play");
  expect(play.video.subtitles).toEndWith(".video.captions.srt");
  expect(result.prepared).toContainEqual({ id: play.entryId, video: true });
  const controls = buttons(result.player());
  expect(controls).toContain("open_jump_to");
  expect(controls).toContain("toggle_captions");
  expect(controls).not.toContain("like_track");
  expect(controls).toContain("save_track");
  await result.coordinator.endFromSlack();
});

test("music mode keeps Like and has no captions or Jump to", async () => {
  const result = await setup();
  await queue(result, song);
  await until(() => result.media.some((message) => message.type === "play"));
  const play = result.media.find((message) => message.type === "play");
  expect(play.video).toBeUndefined();
  const controls = buttons(result.player());
  expect(controls).toContain("like_track");
  expect(controls).not.toContain("open_jump_to");
  expect(controls).not.toContain("toggle_captions");
  await result.coordinator.endFromSlack();
});

test("captions are off by default, last the session, and say when a video has none", async () => {
  const result = await setup();
  await saveMode(result.coordinator, "video");
  expect(result.media).toContainEqual({ type: "captions", on: false });
  await queue(result, { ...song, title: "Plain Song" });
  await until(() => result.media.some((message) => message.type === "play"));
  await press(result.coordinator, "toggle_captions");
  expect(result.media.at(-1)).toEqual({ type: "captions", on: true });
  expect(result.ephemeral.at(-1)?.text).toBe("This video has no captions.");
  expect(
    result.store.resumableSessions(Date.now(), 60_000).sessions[0],
  ).toMatchObject({
    captions: true,
  });
  await result.coordinator.endFromSlack();
});

test("Jump to offers the video's chapters and a time, and seeks there", async () => {
  const result = await setup();
  await saveMode(result.coordinator, "video");
  await queue(result, clip);
  await until(() => result.media.some((message) => message.type === "play"));
  const play = result.media.find((message) => message.type === "play");
  await press(result.coordinator, "open_jump_to");
  const view = result.modals.at(-1)![1] as { blocks: Block[] };
  const chapter = view.blocks.find((block) => block.block_id === "chapter")!;
  expect(
    (chapter.element!.options as { text: { text: string } }[]).map(
      (option) => option.text.text,
    ),
  ).toEqual(["0:00 · Intro", "1:30 · The good part"]);
  const submit = (state: Record<string, Record<string, any>>) =>
    press(result.coordinator, "jump_to_time", {
      type: "view_submission",
      state,
      metadata: { entryId: play.entryId },
    });
  await submit({ chapter: { start: { selected_option: { value: "90" } } } });
  expect(result.media.at(-1)).toEqual({ type: "seek", seconds: 90 });
  await submit({ time: { value: { value: "4:05" } } });
  expect(result.media.at(-1)).toEqual({ type: "seek", seconds: 245 });
  await submit({ time: { value: { value: "soon" } } });
  expect(result.ephemeral.at(-1)?.text).toBe(
    "Times look like 42:10 or 1:23:45.",
  );
  await submit({ time: { value: { value: "11:00" } } });
  expect(result.ephemeral.at(-1)?.text).toBe(
    "That is past the end; it runs 10:00.",
  );
  await result.coordinator.endFromSlack();
});

test("switching modes plays the same video on with or without its picture", async () => {
  const result = await setup();
  await saveMode(result.coordinator, "video");
  await queue(result, clip);
  await until(() => result.media.some((message) => message.type === "play"));
  const first = result.media.find((message) => message.type === "play");
  result.coordinator.mediaEvent("playback_position", {
    entryId: first.entryId,
    seconds: 42,
  });
  const before = result.media.length;
  await saveMode(result.coordinator, "music");
  const replay = result.media
    .slice(before)
    .find((message) => message.type === "play");
  // The same file carries on: no seek back to the top, and no picture.
  expect(replay).toMatchObject({ entryId: first.entryId, url: first.url });
  expect(replay.video).toBeUndefined();
  expect(
    result.media.slice(before).some((message) => message.type === "seek"),
  ).toBeFalse();
  await result.coordinator.endFromSlack();
});

test("a song playing in music mode becomes its video from the top in video mode", async () => {
  const result = await setup();
  await queue(result, { ...song, title: "A Song With A Video" });
  await until(() => result.media.some((message) => message.type === "play"));
  const first = result.media.find((message) => message.type === "play");
  result.coordinator.mediaEvent("playback_position", {
    entryId: first.entryId,
    seconds: 30,
  });
  const before = result.media.length;
  await saveMode(result.coordinator, "video");
  await until(() =>
    result.media
      .slice(before)
      .some((message) => message.type === "play" && message.video),
  );
  const swapped = result.media
    .slice(before)
    .find((message) => message.type === "play" && message.video);
  expect(swapped.entryId).toBe(first.entryId);
  expect(
    result.media
      .slice(before)
      .some((message) => message.type === "seek" && message.seconds > 0),
  ).toBeFalse();
  await result.coordinator.endFromSlack();
});

test("video mode leaves the music's autoplay and settings out of Settings", async () => {
  const result = await setup();
  await press(result.coordinator, "open_settings");
  const music = (result.modals.at(-1)![1] as { blocks: Block[] }).blocks.map(
    (block) => block.block_id,
  );
  expect(music).toEqual(
    expect.arrayContaining([
      "media_mode",
      "display",
      "autoplay",
      "transition",
      "ducking",
      "loop",
    ]),
  );
  await saveMode(result.coordinator, "video");
  await press(result.coordinator, "open_settings");
  const video = (result.modals.at(-1)![1] as { blocks: Block[] }).blocks.map(
    (block) => block.block_id,
  );
  expect(music).not.toContain("video_autoplay");
  expect(video).toContain("media_mode");
  expect(video).toContain("loop");
  expect(video).toContain("video_autoplay");
  for (const hidden of ["display", "autoplay", "transition", "ducking"])
    expect(video).not.toContain(hidden);
  await result.coordinator.endFromSlack();
});

test("saving Settings in video mode leaves the hidden music settings as they were", async () => {
  const result = await setup();
  Reflect.set(result.coordinator, "autoplayMode", "related");
  Reflect.set(result.coordinator, "transitionMode", "adaptive");
  await saveMode(result.coordinator, "video");
  // A draft from before the switch still holds the music settings.
  await press(result.coordinator, "save_settings", {
    type: "view_submission",
    state: {
      autoplay: { mode: { selected_option: { value: "off" } } },
      transition: { mode: { selected_option: { value: "none" } } },
    },
  });
  expect(Reflect.get(result.coordinator, "autoplayMode")).toBe("related");
  expect(Reflect.get(result.coordinator, "transitionMode")).toBe("adaptive");
  await saveMode(result.coordinator, "music");
  expect(result.media).toContainEqual({
    type: "transition_mode",
    mode: "adaptive",
  });
  await result.coordinator.endFromSlack();
});

test("a video link in music mode gets a hint, and the host can add it and switch", async () => {
  const result = await setup();
  const reference = "trackref_link";
  result.references.set(reference, "https://youtu.be/abcdefghijk");
  const state = {
    track: { selection: { selected_option: { value: reference } } },
  };
  await press(result.coordinator, "selection", {
    value: reference,
    viewId: "add-view",
    messageTs: "",
    state,
  });
  const hinted = result.updatedModals.at(-1)![2];
  expect(JSON.stringify(hinted.blocks)).toContain("This looks like a video");
  expect(buttons(hinted.blocks)).toContain("add_with_video_mode");
  expect(JSON.stringify(hinted.blocks)).toContain(
    "Add and switch to video mode",
  );
  // Picking it again does not redraw the dialog.
  const redraws = result.updatedModals.length;
  await press(result.coordinator, "selection", {
    value: reference,
    viewId: "add-view",
    messageTs: "",
    state,
  });
  expect(result.updatedModals).toHaveLength(redraws);

  await press(result.coordinator, "add_with_video_mode", {
    viewId: "add-view",
    messageTs: "",
    state,
  });
  expect(result.coordinator.videoMode).toBeTrue();
  expect(JSON.stringify(result.updatedModals.at(-1)![2])).toContain(
    "Added, and switched to video mode.",
  );
  await until(() => result.media.some((message) => message.type === "play"));
  await result.coordinator.endFromSlack();
});

test("anyone else asks the host, more asks join the request, and not now pauses asking", async () => {
  const result = await setup();
  const reference = "trackref_link";
  result.references.set(reference, { ...clip, title: "Cats" });
  const ask = (userId: string) =>
    press(result.coordinator, "add_with_video_mode", {
      userId,
      viewId: `view-${userId}`,
      messageTs: "",
      state: {
        track: { selection: { selected_option: { value: reference } } },
      },
    });
  await ask("guest");
  expect(result.coordinator.videoMode).toBeFalse();
  expect(result.dms).toHaveLength(1);
  expect(result.dms[0]![0]).toBe("host");
  expect(result.dms[0]![1]).toBe(
    "<@guest> wants to switch to video mode to watch “Cats”.",
  );
  result.coordinator.participants.add("third");
  await ask("third");
  // The open request is updated rather than a second one sent.
  expect(result.dms).toHaveLength(1);
  expect(result.updates.filter((update) => update[0] === "D1").at(-1)).toEqual([
    "D1",
    "dm-1",
    "<@guest> and 1 other want to switch to video mode to watch “Cats”.",
    expect.any(Array),
  ]);
  await press(result.coordinator, "decline_video_request", {
    messageTs: "dm-1",
  });
  expect(result.updates.filter((update) => update[0] === "D1").at(-1)![2]).toBe(
    "Not now. Nobody can ask again for 15 minutes.",
  );
  // The hint no longer offers to ask.
  result.references.set(
    "trackref_url",
    "https://www.youtube.com/watch?v=abcdefghijk",
  );
  await press(result.coordinator, "selection", {
    userId: "guest",
    viewId: "guest-view",
    messageTs: "",
    state: {
      track: { selection: { selected_option: { value: "trackref_url" } } },
    },
  });
  const hinted = result.updatedModals.at(-1)![2];
  expect(JSON.stringify(hinted.blocks)).toContain("This looks like a video");
  expect(buttons(hinted.blocks)).not.toContain("add_with_video_mode");
  await result.coordinator.endFromSlack();
});

test("the host switches from the request", async () => {
  const result = await setup();
  await press(result.coordinator, "add_with_video_mode", {
    userId: "guest",
    viewId: "guest-view",
    messageTs: "",
    state: { links: { text: { value: "https://youtu.be/abcdefghijk" } } },
  });
  expect(result.dms[0]![1]).toBe(
    "<@guest> wants to switch to video mode to watch a video.",
  );
  await press(result.coordinator, "approve_video_request", {
    messageTs: "dm-1",
  });
  expect(result.coordinator.videoMode).toBeTrue();
  expect(result.updates.filter((update) => update[0] === "D1").at(-1)![2]).toBe(
    "Video mode is on.",
  );
  await result.coordinator.endFromSlack();
});

test("videos watched count apart from songs in the stats", async () => {
  const result = await setup();
  await saveMode(result.coordinator, "video");
  await queue(result, clip);
  await until(() => result.media.some((message) => message.type === "play"));
  const play = result.media.find((message) => message.type === "play");
  result.coordinator.mediaEvent("playback_position", {
    entryId: play.entryId,
    seconds: 60,
  });
  result.coordinator.mediaEvent("track_ended", { entryId: play.entryId });
  await until(() => result.store.canvasStats().videos.count === 1);
  const stats = result.store.canvasStats();
  expect(stats.tracks.count).toBe(0);
  expect(stats.sessions.watched).toBeGreaterThanOrEqual(60);
  expect(stats.topVideos).toEqual([
    { title: "A clip", channel: "Channel", count: 1 },
  ]);
  // A watched video is no one's recent song.
  expect(result.store.recentTracks("host")).toEqual([]);
  await result.coordinator.endFromSlack();
});

test("a share that fails tells whoever added the video", async () => {
  const result = await setup();
  await saveMode(result.coordinator, "video");
  await queue(result, clip, "guest");
  await until(() => result.media.some((message) => message.type === "play"));
  await result.coordinator.mediaEvent("share_failed", { reason: "refused" });
  expect(result.ephemeral.at(-1)).toEqual({
    user: "guest",
    text: "Couldn’t share the screen in the huddle, so videos will play as audio for now.",
  });
  await result.coordinator.mediaEvent("video_failed", {
    entryId: result.media.find((message) => message.type === "play").entryId,
  });
  expect(result.ephemeral.at(-1)?.text).toBe(
    "Couldn’t show the video for A clip, so it’s playing as audio.",
  );
  await result.coordinator.endFromSlack();
});

test("the assistant's settings refuse the music settings in video mode", async () => {
  const result = await setup();
  await saveMode(result.coordinator, "video");
  expect(
    await result.coordinator.agentUpdateSettings("host", {
      autoplayMode: "related",
    }),
  ).toEqual({ ok: false, error: "That’s paused in video mode." });
  expect(
    await result.coordinator.agentUpdateSettings("guest", { mode: "music" }),
  ).toMatchObject({ ok: false });
  expect(
    await result.coordinator.agentUpdateSettings("host", {
      mode: "music",
      autoplayMode: "related",
    }),
  ).toMatchObject({ ok: true, mode: "music", autoplay: "related" });
  await result.coordinator.endFromSlack();
});

test("the assistant jumps to a chapter by name", async () => {
  const result = await setup();
  await saveMode(result.coordinator, "video");
  await queue(result, clip);
  await until(() => result.media.some((message) => message.type === "play"));
  expect(
    await result.coordinator.agentJumpTo("guest", { chapter: "good part" }),
  ).toEqual({ ok: true, playbackSeconds: 90 });
  expect(result.media.at(-1)).toEqual({ type: "seek", seconds: 90 });
  expect(
    await result.coordinator.agentJumpTo("guest", { chapter: "outro" }),
  ).toEqual({ ok: false, error: "No chapter by that name." });
  await until(
    () =>
      result.coordinator.agentStatus("host").ok === true &&
      Boolean(
        (result.coordinator.agentStatus("host") as any).nowPlaying?.chapters,
      ),
  );
  expect(result.coordinator.agentStatus("host")).toMatchObject({
    mode: "video",
    captions: false,
    nowPlaying: { playingAs: "video", kind: "video" },
  });
  await result.coordinator.endFromSlack();
});

const relatedClip: TrackMetadata = {
  sourceInput: "https://www.youtube.com/watch?v=relatedclip",
  canonicalUrl: "https://www.youtube.com/watch?v=relatedclip",
  sourceId: "relatedclip",
  title: "A related clip",
  artist: "Other channel",
  duration: 300,
  kind: "video",
};

async function saveVideoAutoplay(coordinator: Coordinator, mode: string) {
  await press(coordinator, "save_settings", {
    type: "view_submission",
    state: { video_autoplay: { mode: { selected_option: { value: mode } } } },
  });
}

const queued = (result: Awaited<ReturnType<typeof setup>>) =>
  Reflect.get(result.coordinator, "queue") as {
    sourceId: string;
    automatic?: boolean;
    autoplaySources?: string[];
  }[];

test("video mode's autoplay queues a related video, and leaves the music's alone", async () => {
  const result = await setup();
  result.related.set(clip.sourceId, [clip, relatedClip]);
  await saveMode(result.coordinator, "video");
  await saveVideoAutoplay(result.coordinator, "related");
  expect(Reflect.get(result.coordinator, "videoAutoplay")).toBeTrue();
  expect(Reflect.get(result.coordinator, "autoplayMode")).toBe("off");
  expect(
    Reflect.get(result.store, "db")
      .query("SELECT video_autoplay FROM sessions WHERE id = ?")
      .get(result.coordinator.id),
  ).toEqual({ video_autoplay: 1 });
  await queue(result, clip);
  await until(() => queued(result).some((entry) => entry.automatic));
  // What is playing is never picked again.
  expect(queued(result)).toEqual([
    expect.objectContaining({
      sourceId: "relatedclip",
      automatic: true,
      autoplaySources: ["related_videos"],
    }),
  ]);
  await saveVideoAutoplay(result.coordinator, "off");
  expect(queued(result)).toEqual([]);
  await result.coordinator.endFromSlack();
});

test("switching modes drops the other mode's autoplay pick", async () => {
  const result = await setup();
  result.related.set(clip.sourceId, [relatedClip]);
  await saveMode(result.coordinator, "video");
  await saveVideoAutoplay(result.coordinator, "related");
  await queue(result, clip);
  await until(() => queued(result).some((entry) => entry.automatic));
  await saveMode(result.coordinator, "music");
  expect(queued(result)).toEqual([]);
  await result.coordinator.endFromSlack();
});

test("the assistant turns video mode's autoplay on", async () => {
  const result = await setup();
  await saveMode(result.coordinator, "video");
  expect(
    await result.coordinator.agentUpdateSettings("host", { autoplay: true }),
  ).toMatchObject({ ok: true, changed: ["videoAutoplay=true"] });
  expect(Reflect.get(result.coordinator, "autoplayMode")).toBe("off");
  expect(result.coordinator.agentStatus("host")).toMatchObject({
    autoplay: "related videos",
  });
  await result.coordinator.endFromSlack();
});
