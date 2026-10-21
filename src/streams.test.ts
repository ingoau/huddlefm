import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AuditLog } from "./audit-log.ts";
import { Coordinator } from "./coordinator.ts";
import { Jellyfin, type JellyfinFetch } from "./jellyfin.ts";
import type { LyricsCatalog } from "./lyrics.ts";
import type { SlackAppAdapter } from "./slack-app.ts";
import { Store } from "./store.ts";
import {
  defaultVideoLimits,
  TrackError,
  type PreparedMedia,
  type TrackCatalog,
  type TrackMetadata,
} from "./tracks.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

type Block = {
  type: string;
  block_id?: string;
  elements?: { action_id?: string }[];
  child_blocks?: Block[];
  title?: { text: string };
  subtitle?: { text: string };
};

const serverId = "8a3e05b08edd4f20987437e9f07c4af8";
const movieId = "ba8829437260db713dd7e386ffbf6197";

/** A Jellyfin server with one film in two languages. */
function jellyfinServer() {
  const reports: string[] = [];
  const playbackBodies: any[] = [];
  const routes: Record<string, (url: URL, init: RequestInit) => unknown> = {
    [`GET /Items/${movieId}`]: () => ({
      Id: movieId,
      Name: "Film",
      Type: "Movie",
      MediaType: "Video",
      RunTimeTicks: 5400 * 10_000_000,
    }),
    [`POST /Items/${movieId}/PlaybackInfo`]: (_url, init) => {
      playbackBodies.push(JSON.parse(String(init.body)));
      return {
        PlaySessionId: `play${playbackBodies.length}`,
        MediaSources: [
          {
            Id: "source1",
            SupportsDirectStream: true,
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
              { Index: 0, Type: "Video", Height: 720 },
              { Index: 1, Type: "Audio", DisplayTitle: "English" },
              { Index: 2, Type: "Audio", DisplayTitle: "Japanese" },
            ],
          },
        ],
      };
    },
    [`GET /Items/${movieId}/Images/Primary`]: () => new Response("jpeg"),
    "POST /Sessions/Playing": () => (reports.push("start"), ""),
    "POST /Sessions/Playing/Progress": () => (reports.push("progress"), ""),
    "POST /Sessions/Playing/Stopped": () => (reports.push("stop"), ""),
  };
  const fetch: JellyfinFetch = async (href, init) => {
    const url = new URL(href);
    const route = routes[`${init.method ?? "GET"} ${url.pathname}`];
    if (!route) return new Response("missing", { status: 404 });
    const body = route(url, init);
    return body instanceof Response ? body : Response.json(body);
  };
  return {
    reports,
    playbackBodies,
    jellyfin: new Jellyfin({
      proxy: () => "http://127.0.0.1:9",
      fetch,
      limits: () => defaultVideoLimits,
    }),
  };
}

async function setup() {
  const directory = `${tmpdir()}/huddlefm-streams-${crypto.randomUUID()}`;
  await mkdir(directory, { recursive: true });
  directories.push(directory);
  const posted: unknown[][] = [];
  const updates: unknown[][] = [];
  const ephemeral: { user: string; text: string }[] = [];
  const modals: any[] = [];
  const updatedModals: [string, any][] = [];
  const media: any[] = [];
  const liveCalls: boolean[] = [];
  const references = new Map<string, TrackMetadata>();
  let liveFailure: Error | undefined;
  let videoPreparation:
    ((id: string, stream: boolean) => Promise<PreparedMedia>) | undefined;
  let cachedVideo: string | undefined;
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
    modal: async (_trigger: string, view: unknown) => {
      modals.push(view);
      return { id: `view${modals.length}`, hash: "hash" };
    },
    pushModal: async () => undefined,
    updateModal: async (viewId: string, _hash: string, view: any) => {
      updatedModals.push([viewId, view]);
      return { id: viewId };
    },
    userName: async (userId: string) => `Name ${userId}`,
    dm: async () => undefined,
  } as unknown as SlackAppAdapter;
  const tracks = {
    prepare: async (_track: TrackMetadata, _dir: string, id: string) => {
      const path = `${directory}/${id}.opus`;
      await writeFile(path, "media");
      return path;
    },
    prepareVideo: async (
      _track: TrackMetadata,
      _dir: string,
      id: string,
      _signal?: AbortSignal,
      _priority?: number,
      _audio?: string,
      stream = true,
    ): Promise<PreparedMedia> => {
      if (videoPreparation) return videoPreparation(id, stream);
      const path = `${directory}/${id}.opus`;
      await writeFile(path, "media");
      return { filePath: path, form: "audio" };
    },
    prepareLive: async (
      _track: TrackMetadata,
      video: boolean,
    ): Promise<PreparedMedia> => {
      liveCalls.push(video);
      if (liveFailure) throw liveFailure;
      return {
        stream: {
          url: `https://manifest.example.com/live${liveCalls.length}.m3u8`,
          live: true,
          headers: { "User-Agent": "yt-dlp" },
        },
        form: video ? "video" : "audio",
      };
    },
    cachedStream: async () => cachedVideo,
    resolve: async (reference: string) => references.get(reference)!,
    suggestions: async () => [],
    transition: () => undefined,
    referencedUrl: () => undefined,
    streamProxy: "http://127.0.0.1:4000",
  } as unknown as TrackCatalog;
  const store = new Store(":memory:");
  const server = jellyfinServer();
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
    { record: () => {} } as unknown as AuditLog,
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
      video: { sessionLimit: 2 },
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
    () => 0,
    server.jellyfin,
  );
  await coordinator.start();
  const allowed = ["add", "add-bulk", "skip", "pause"];
  for (const capability of allowed)
    store.setPermission(coordinator.id, capability, true);
  Reflect.set(coordinator, "allowed", new Set(allowed));
  return {
    coordinator,
    store,
    ephemeral,
    modals,
    updatedModals,
    media,
    liveCalls,
    references,
    server,
    directory,
    failLive(error: Error | undefined) {
      liveFailure = error;
    },
    prepareVideoWith(
      prepare: (id: string, stream: boolean) => Promise<PreparedMedia>,
    ) {
      videoPreparation = prepare;
    },
    cacheVideo(path: string | undefined) {
      cachedVideo = path;
    },
    player() {
      return [
        ...posted.map((call) => call[3]),
        ...updates.map((call) => call[3]),
      ]
        .filter(Boolean)
        .at(-1) as Block[];
    },
    plays() {
      return media.filter((message) => message.type === "play");
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

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
  } = {},
) {
  const type = options.type ?? "block_actions";
  return coordinator.action({
    type,
    userId: options.userId ?? "host",
    actionId,
    value: options.value ?? coordinator.id,
    channelId: "channel",
    messageTs: type === "view_submission" ? "" : "1",
    triggerId: "trigger",
    ...(options.viewId ? { viewId: options.viewId, viewHash: "hash" } : {}),
    metadata: JSON.stringify({
      sessionId: coordinator.id,
      hostId: "host",
      ...options.metadata,
    }),
    state: options.state ?? {},
  });
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 300 && !predicate(); index++) await Bun.sleep(2);
  expect(predicate()).toBeTrue();
}

async function queue(result: Setup, track: TrackMetadata) {
  const reference = `trackref_${crypto.randomUUID()}`;
  result.references.set(reference, track);
  await press(result.coordinator, "add_track_to_queue", {
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

const radio: TrackMetadata = {
  sourceInput: "https://www.youtube.com/watch?v=jfKfPfyJRdk",
  canonicalUrl: "https://www.youtube.com/watch?v=jfKfPfyJRdk",
  sourceId: "jfKfPfyJRdk",
  title: "lofi hip hop radio",
  artist: "Lofi Girl",
  kind: "video",
  live: true,
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

test("a live stream plays as it arrives, through the proxy, with no lyrics", async () => {
  const result = await setup();
  await queue(result, radio);
  await until(() => result.plays().length === 1);
  expect(result.liveCalls).toEqual([false]);
  expect(result.plays()[0]).toMatchObject({
    url: "https://manifest.example.com/live1.m3u8",
    stream: {
      proxy: "http://127.0.0.1:4000",
      live: true,
      headers: { "User-Agent": "yt-dlp" },
    },
  });
  expect(result.media).toContainEqual({
    type: "lyrics_unavailable",
    entryId: result.plays()[0].entryId,
  });
  // Nothing about it is ever preloaded.
  expect(
    result.media
      .filter((message) => message.type === "preload")
      .flatMap((message) => message.entries),
  ).toEqual([]);
});

test("the player says it is live, without seeking, and the queue waits on it", async () => {
  const result = await setup();
  await queue(result, radio);
  await queue(result, song);
  await until(() => result.plays().length === 1);
  await until(() =>
    JSON.stringify(result.player()).includes("waiting on the live stream"),
  );
  const player = result.player();
  const text = JSON.stringify(player);
  expect(text).toContain("🔴 LIVE · watching since <!date^");
  expect(text).toContain("Up next: waiting on the live stream");
  expect(buttons(player)).not.toContain("seek_back");
  expect(buttons(player)).not.toContain("seek_forward");
  expect(buttons(player)).toContain("save_track");
  await press(result.coordinator, "seek_forward");
  expect(result.ephemeral.at(-1)?.text).toContain("can't be skipped through");
  expect(result.media.some((message) => message.type === "seek")).toBeFalse();
  const status = await result.coordinator.agentSeek("host", 30);
  expect(status.ok).toBeFalse();
});

test("resuming a paused live stream joins it where it is now", async () => {
  const result = await setup();
  await queue(result, radio);
  await until(() => result.plays().length === 1);
  const entryId = result.plays()[0].entryId;
  await press(result.coordinator, "toggle_playback");
  expect(result.media.at(-1)).toEqual({ type: "pause" });
  await press(result.coordinator, "toggle_playback");
  expect(result.media).toContainEqual({
    type: "replay",
    entryId,
    introSeconds: 0,
  });
  expect(result.media.some((message) => message.type === "resume")).toBeFalse();
});

test("a live stream that ends says so and moves on", async () => {
  const result = await setup();
  await queue(result, radio);
  await queue(result, song);
  await until(() => result.plays().length === 1);
  const entryId = result.plays()[0].entryId;
  result.coordinator.mediaEvent("track_ended", { entryId });
  await until(() => result.plays().length === 2);
  expect(result.ephemeral.map((notice) => notice.text)).toContain(
    "The live stream lofi hip hop radio has ended.",
  );
  expect(result.plays()[1].title).toBe("A Song");
});

test("a stream that fails is picked up again, then skipped if it keeps failing", async () => {
  const result = await setup();
  await queue(result, radio);
  await queue(result, song);
  await until(() => result.plays().length === 1);
  const entryId = result.plays()[0].entryId;
  result.coordinator.mediaEvent("track_error", { entryId });
  await until(() => result.plays().length === 2);
  expect(result.plays()[1]).toMatchObject({
    entryId,
    url: "https://manifest.example.com/live2.m3u8",
  });
  result.coordinator.mediaEvent("stalled", { entryId });
  await until(() => result.plays().length === 3);
  expect(result.plays()[2].entryId).toBe(entryId);
  result.coordinator.mediaEvent("track_error", { entryId });
  await until(() => result.plays().length === 4);
  expect(result.plays()[3].title).toBe("A Song");
  expect(result.ephemeral.map((notice) => notice.text)).toContain(
    "The live stream lofi hip hop radio stopped working, so it was skipped.",
  );
});

test("a live stream that has ended by the time it is retried says why", async () => {
  const result = await setup();
  await queue(result, radio);
  await until(() => result.plays().length === 1);
  result.failLive(new TrackError("That live stream has ended"));
  result.coordinator.mediaEvent("track_error", {
    entryId: result.plays()[0].entryId,
  });
  await until(() =>
    result.ephemeral.some((notice) =>
      notice.text.includes("stopped playing: That live stream has ended"),
    ),
  );
});

test("video mode plays a live stream's picture on the screen share", async () => {
  const result = await setup();
  await press(result.coordinator, "save_settings", {
    type: "view_submission",
    state: { media_mode: { mode: { selected_option: { value: "video" } } } },
  });
  await queue(result, radio);
  await until(() => result.plays().length === 1);
  expect(result.liveCalls).toEqual([true]);
  expect(result.plays()[0]).toMatchObject({
    video: {},
    stream: { live: true },
  });
  // Jump to has nowhere to go.
  expect(buttons(result.player())).not.toContain("open_jump_to");
});

function linkServer(store: Store, userId = "host") {
  store.saveJellyfinServer({
    userId,
    serverId,
    baseUrl: "https://1.1.1.1",
    name: "Home",
    accessToken: "secret-token",
    jellyfinUserId: "jfuser",
    deviceId: "device",
    linkedAt: 1,
  });
}

test("whoever linked Jellyfin can search it from the add dialog", async () => {
  const result = await setup();
  await press(result.coordinator, "open_add_to_queue", { userId: "guest" });
  expect(JSON.stringify(result.modals.at(-1))).not.toContain("add_source");
  linkServer(result.store);
  await press(result.coordinator, "open_add_to_queue");
  expect(JSON.stringify(result.modals.at(-1))).toContain("add_source");
  await press(result.coordinator, "add_source", {
    value: "jellyfin",
    viewId: "view2",
  });
  const [viewId, view] = result.updatedModals.at(-1)!;
  expect(viewId).toBe("view2");
  expect(JSON.parse(view.private_metadata).source).toBe("jellyfin");
  expect(JSON.stringify(view)).toContain("Search your Jellyfin");
});

test("a Jellyfin item streams from whoever queued it, and its language can change", async () => {
  const result = await setup();
  linkServer(result.store);
  await press(result.coordinator, "save_settings", {
    type: "view_submission",
    state: { media_mode: { mode: { selected_option: { value: "video" } } } },
  });
  await press(result.coordinator, "add_track_to_queue", {
    type: "view_submission",
    state: {
      jellyfin_track: {
        selection: {
          selected_option: { value: `open:${serverId}:${movieId}` },
        },
      },
    },
  });
  await until(() => result.plays().length === 1);
  const play = result.plays()[0];
  const url = new URL(play.url);
  expect(url.pathname).toBe(`/Videos/${movieId}/stream`);
  expect(url.searchParams.get("api_key")).toBe("secret-token");
  expect(play).toMatchObject({
    title: "Film",
    video: {},
    stream: { proxy: "http://127.0.0.1:4000", audioStream: 1 },
  });
  // The poster goes to the card through the loopback, never to Slack.
  expect(play.artwork).toStartWith("http://127.0.0.1:3210/artwork/");
  expect(result.coordinator.artworkPath(play.entryId, "token")).toEndWith(
    ".jellyfin.jpg",
  );
  const player = JSON.stringify(result.player());
  expect(player).not.toContain("1.1.1.1");
  expect(player).not.toContain("secret-token");
  await until(() => result.server.reports.includes("start"));
  // CC picks the language and captions.
  await press(result.coordinator, "toggle_captions");
  const picker = result.modals.at(-1);
  expect(picker.callback_id).toBe("jellyfin_tracks");
  expect(JSON.stringify(picker)).toContain("Japanese");
  await press(result.coordinator, "jellyfin_tracks", {
    type: "view_submission",
    metadata: { itemId: movieId },
    state: {
      audio: { track: { selected_option: { value: "2" } } },
      subtitles: { track: { selected_option: { value: "off" } } },
    },
  });
  await until(() => result.plays().length === 2);
  expect(result.plays()[1]).toMatchObject({
    entryId: play.entryId,
    stream: { audioStream: 2 },
  });
  expect(result.server.playbackBodies.at(-1).AudioStreamIndex).toBe(2);
  // The new stream picks up where the old one was.
  await until(
    () => result.server.reports.filter((r) => r === "start").length === 2,
  );
  expect(result.server.reports).toContain("stop");
});

test("someone else's Jellyfin item is no longer available once unlinked", async () => {
  const result = await setup();
  linkServer(result.store);
  await press(result.coordinator, "add_track_to_queue", {
    type: "view_submission",
    state: {
      jellyfin_track: {
        selection: {
          selected_option: { value: `open:${serverId}:${movieId}` },
        },
      },
    },
  });
  await until(() => result.plays().length === 1);
  result.store.removeJellyfinServer("host", serverId);
  await queue(result, {
    sourceInput: `jellyfin://${serverId}/${movieId}`,
    canonicalUrl: `jellyfin://${serverId}/${movieId}`,
    sourceId: `jellyfin:${serverId}:${movieId}`,
    title: "Film again",
    artist: "1999",
  });
  await until(() =>
    result.ephemeral.some((notice) =>
      notice.text.includes("Could not prepare Film again: No longer available"),
    ),
  );
});

test("nothing crossfades in ahead of a stream that plays next", async () => {
  const result = await setup();
  await queue(result, song);
  await until(() => result.plays().length === 1);
  await queue(result, radio);
  await queue(result, { ...song, sourceId: "songsong222", title: "Later" });
  await until(() => result.liveCalls.length === 1);
  await Bun.sleep(20);
  const preload = result.media
    .filter((message) => message.type === "preload")
    .at(-1);
  expect(preload.nextEntryId).toBeUndefined();
});

const talk: TrackMetadata = {
  sourceInput: "https://www.youtube.com/watch?v=3OshsLm3_OQ",
  canonicalUrl: "https://www.youtube.com/watch?v=3OshsLm3_OQ",
  sourceId: "3OshsLm3_OQ",
  title: "A talk",
  artist: "Channel",
  duration: 1_873,
  kind: "video",
};

async function videoMode(result: Setup) {
  await press(result.coordinator, "save_settings", {
    type: "view_submission",
    state: { media_mode: { mode: { selected_option: { value: "video" } } } },
  });
}

/** A YouTube video as the catalog streams it. */
function streamed(extra: Partial<PreparedMedia> = {}): PreparedMedia {
  return {
    stream: {
      url: "https://93.184.216.34/sound",
      videoUrl: "https://93.184.216.34/picture",
      headers: { "User-Agent": "yt-dlp" },
      cacheKey: "cachekey",
    },
    form: "video",
    ...extra,
  };
}

test("video mode streams a YouTube video, its sound and picture apart, levelled", async () => {
  const result = await setup();
  await videoMode(result);
  result.prepareVideoWith(async () => streamed({ gainDb: -4 }));
  await queue(result, talk);
  await until(() => result.plays().length === 1);
  const play = result.plays()[0];
  expect(play).toMatchObject({
    url: "https://93.184.216.34/sound",
    gainDb: -4,
    stream: {
      proxy: "http://127.0.0.1:4000",
      headers: { "User-Agent": "yt-dlp" },
    },
    video: { url: "https://93.184.216.34/picture" },
  });
  // It can be sought, unlike a live stream.
  expect(play.stream.live).toBeUndefined();
  expect(buttons(result.player())).toContain("open_jump_to");
});

test("a video's loudness measured after it started glides in, and is kept", async () => {
  const result = await setup();
  await videoMode(result);
  let level = (_gainDb: number) => {};
  const leveling = new Promise<number | undefined>(
    (resolve) => (level = resolve),
  );
  result.prepareVideoWith(async () => streamed({ leveling }));
  await queue(result, talk);
  await until(() => result.plays().length === 1);
  const { entryId } = result.plays()[0];
  expect(result.plays()[0].gainDb).toBeUndefined();
  level(-3);
  await until(() => result.media.some((message) => message.type === "gain"));
  expect(result.media.find((message) => message.type === "gain")).toEqual({
    type: "gain",
    entryId,
    gainDb: -3,
  });
  expect(
    result.store.db
      .query("SELECT gain_db FROM tracks WHERE id = ?")
      .get(entryId),
  ).toEqual({ gain_db: -3 });
});

test("a streamed video cached by the time it plays plays from the file", async () => {
  const result = await setup();
  await videoMode(result);
  result.prepareVideoWith(async () => streamed({ gainDb: 2 }));
  await queue(result, talk);
  await queue(result, { ...talk, sourceId: "otherotherx", title: "Another" });
  await until(() => result.plays().length === 1);
  await until(() =>
    (Reflect.get(result.coordinator, "queue") as { status: string }[]).some(
      (entry) => entry.status === "ready",
    ),
  );
  const cached = `${result.directory}/cached.video.mkv`;
  await writeFile(cached, "video");
  result.cacheVideo(cached);
  result.coordinator.mediaEvent("track_ended", {
    entryId: result.plays()[0].entryId,
  });
  await until(() => result.plays().length === 2);
  const play = result.plays()[1];
  expect(play.title).toBe("Another");
  expect(play.url).toStartWith("http://127.0.0.1:3210/audio/");
  expect(play.stream).toBeUndefined();
  // Its gain is the video's, wherever it plays from.
  expect(play.gainDb).toBe(2);
});

test("a video YouTube keeps failing to stream is downloaded for its last try", async () => {
  const result = await setup();
  await videoMode(result);
  const tries: boolean[] = [];
  result.prepareVideoWith(async (id, stream) => {
    tries.push(stream);
    if (stream) return streamed();
    const path = `${result.directory}/${id}.video.mkv`;
    await writeFile(path, "video");
    return { filePath: path, form: "video" };
  });
  await queue(result, talk);
  await until(() => result.plays().length === 1);
  const { entryId } = result.plays()[0];
  result.coordinator.mediaEvent("track_error", { entryId });
  await until(() => result.plays().length === 2);
  result.coordinator.mediaEvent("track_error", { entryId });
  await until(() => result.plays().length === 3);
  expect(tries).toEqual([true, true, false]);
  expect(result.plays()[2]).toMatchObject({ entryId, title: "A talk" });
  expect(result.plays()[2].url).toStartWith("http://127.0.0.1:3210/audio/");
});
