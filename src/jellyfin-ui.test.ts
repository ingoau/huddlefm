import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Jellyfin, type JellyfinFetch, type LinkedServer } from "./jellyfin.ts";
import {
  itemValue,
  JellyfinUi,
  parseItemValue,
  type QueuedItem,
} from "./jellyfin-ui.ts";
import type { Interaction } from "./slack-app.ts";
import { Store } from "./store.ts";
import { defaultVideoLimits, TrackError } from "./tracks.ts";

const serverId = "8a3e05b08edd4f20987437e9f07c4af8";
const movieId = "ba8829437260db713dd7e386ffbf6197";
const seriesId = "11111111111111111111111111111111";
const seasonId = "22222222222222222222222222222222";
const episodeId = "33333333333333333333333333333333";
const base = "https://1.1.1.1";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

type View = {
  blocks: any[];
  private_metadata: string;
  title: { text: string };
};

/** A Jellyfin server on fake routes, and a session's Jellyfin around it. */
function setup(
  options: {
    quickConnect?: boolean;
    approveAfter?: number;
    expireAfter?: number;
    movie?: Record<string, unknown>;
    revoked?: boolean;
  } = {},
) {
  let polls = 0;
  const reports: { path: string; body: any }[] = [];
  const routes: Record<string, (url: URL, init: RequestInit) => unknown> = {
    "GET /System/Info/Public": () => ({ Id: serverId, ServerName: "Home" }),
    "GET /QuickConnect/Enabled": () => options.quickConnect ?? true,
    "POST /QuickConnect/Initiate": () => ({ Code: "AB12CD", Secret: "sec" }),
    "GET /QuickConnect/Connect": () => {
      polls++;
      if (options.expireAfter !== undefined && polls > options.expireAfter)
        return new Response("", { status: 404 });
      return { Authenticated: polls >= (options.approveAfter ?? 2) };
    },
    "POST /Users/AuthenticateWithQuickConnect": () => ({
      AccessToken: "token-abc",
      User: { Id: "jfuser", Name: "Ingo" },
    }),
    "POST /Sessions/Capabilities/Full": () => "",
    "POST /Sessions/Logout": () => "",
    [`GET /Items/${movieId}`]: () =>
      options.revoked
        ? new Response("", { status: 401 })
        : {
            Id: movieId,
            Name: "Film",
            Type: "Movie",
            MediaType: "Video",
            RunTimeTicks: 5400 * 10_000_000,
            Chapters: [
              { StartPositionTicks: 0, Name: "Opening" },
              { StartPositionTicks: 600 * 10_000_000, Name: "Middle" },
            ],
            ...options.movie,
          },
    [`GET /Items/${seriesId}`]: () => ({
      Id: seriesId,
      Name: "The Show",
      Type: "Series",
    }),
    [`GET /Items/${episodeId}`]: () => ({
      Id: episodeId,
      Name: "Pilot",
      Type: "Episode",
      SeriesName: "The Show",
      SeriesId: seriesId,
      SeasonId: seasonId,
      ParentIndexNumber: 1,
      IndexNumber: 1,
    }),
    [`GET /Shows/${seriesId}/Seasons`]: () => ({
      Items: [{ Id: seasonId, Name: "Season 1", IndexNumber: 1 }],
    }),
    [`GET /Shows/${seriesId}/Episodes`]: () => ({
      Items: [
        {
          Id: episodeId,
          Name: "Pilot",
          Type: "Episode",
          IndexNumber: 1,
          SeasonId: seasonId,
          UserData: { Played: true },
        },
        {
          Id: "44444444444444444444444444444444",
          Name: "Second",
          Type: "Episode",
          IndexNumber: 2,
          SeasonId: seasonId,
          UserData: { PlaybackPositionTicks: 300 * 10_000_000 },
        },
      ],
    }),
    "GET /Shows/NextUp": () => ({
      Items: [
        {
          Id: "44444444444444444444444444444444",
          Name: "Second",
          Type: "Episode",
          SeasonId: seasonId,
        },
      ],
    }),
    "GET /Items": (url) => ({
      Items: url.searchParams.get("searchTerm")
        ? [
            {
              Id: movieId,
              Name: "Film",
              Type: "Movie",
              ProductionYear: 1999,
              RunTimeTicks: 5400 * 10_000_000,
            },
            { Id: seriesId, Name: "The Show", Type: "Series" },
          ]
        : [],
    }),
    [`POST /Items/${movieId}/PlaybackInfo`]: () => ({
      PlaySessionId: "play1",
      MediaSources: [
        {
          Id: "source1",
          SupportsDirectStream: true,
          MediaStreams: [
            { Index: 0, Type: "Video", Height: 720 },
            { Index: 1, Type: "Audio", Language: "eng" },
            {
              Index: 2,
              Type: "Subtitle",
              Language: "eng",
              IsTextSubtitleStream: true,
            },
          ],
        },
      ],
    }),
    [`GET /Videos/${movieId}/source1/Subtitles/2/0/Stream.srt`]: () =>
      new Response("1\n00:00:01,000 --> 00:00:02,000\nHello\n"),
    [`GET /Items/${movieId}/Images/Primary`]: () => new Response("jpeg"),
    "POST /Sessions/Playing": (_url, init) => (
      reports.push({ path: "start", body: JSON.parse(String(init.body)) }),
      ""
    ),
    "POST /Sessions/Playing/Progress": (_url, init) => (
      reports.push({ path: "progress", body: JSON.parse(String(init.body)) }),
      ""
    ),
    "POST /Sessions/Playing/Stopped": (_url, init) => (
      reports.push({ path: "stop", body: JSON.parse(String(init.body)) }),
      ""
    ),
  };
  const fetch: JellyfinFetch = async (href, init) => {
    const url = new URL(href);
    const route = routes[`${init.method ?? "GET"} ${url.pathname}`];
    if (!route) return new Response("missing", { status: 404 });
    const body = route(url, init);
    return body instanceof Response ? body : Response.json(body);
  };
  const jellyfin = new Jellyfin({
    proxy: () => "http://127.0.0.1:9",
    fetch,
    limits: () => defaultVideoLimits,
  });
  const store = new Store(":memory:");
  const views = new Map<string, View>();
  const modals: View[] = [];
  const queued: { capability: string; items: QueuedItem[] }[] = [];
  const notices: string[] = [];
  const refreshed: string[] = [];
  let next = 0;
  let accept = true;
  const ui = new JellyfinUi(
    {
      sessionId: "session",
      slack: {
        modal: async (_trigger, view) => {
          const id = `V${++next}`;
          views.set(id, view as View);
          modals.push(view as View);
          return { id };
        },
        pushModal: async (_trigger, view) => {
          const id = `V${++next}`;
          views.set(id, view as View);
          return { id };
        },
        updateModal: async (id, _hash, view) => {
          views.set(id, view as View);
        },
      },
      store,
      jellyfin,
      log: { info() {}, warn() {}, debug() {} } as any,
      videoMode: () => true,
      canUse: () => true,
      notice: async (_user, text) => {
        notices.push(text);
      },
      queue: async (_interaction, capability, items) => {
        if (accept) queued.push({ capability, items });
        return accept;
      },
      refreshSettings: async (_user, viewId) => {
        refreshed.push(viewId);
      },
      audit: () => {},
    },
    { pollMs: 1 },
  );
  return {
    ui,
    store,
    views,
    modals,
    queued,
    notices,
    refreshed,
    reports,
    refuse() {
      accept = false;
    },
    text(viewId: string) {
      return JSON.stringify(views.get(viewId)?.blocks ?? []);
    },
  };
}

function interaction(
  actionId: string,
  options: {
    value?: string;
    viewId?: string;
    metadata?: unknown;
    state?: Interaction["state"];
    type?: string;
  } = {},
): Interaction {
  return {
    type: options.type ?? "block_actions",
    userId: "U1",
    actionId,
    value: options.value ?? "",
    channelId: "",
    messageTs: "",
    triggerId: "trigger",
    ...(options.viewId ? { viewId: options.viewId, viewHash: "h" } : {}),
    metadata: JSON.stringify(options.metadata ?? { sessionId: "session" }),
    state: options.state ?? {},
  };
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 500 && !predicate(); index++) await Bun.sleep(2);
  expect(predicate()).toBeTrue();
}

function linked(store: Store, overrides: Partial<LinkedServer> = {}) {
  const server: LinkedServer = {
    userId: "U1",
    serverId,
    baseUrl: base,
    name: "Home",
    accessToken: "token-abc",
    jellyfinUserId: "jfuser",
    deviceId: "device",
    linkedAt: 1_700_000_000_000,
    ...overrides,
  };
  store.saveJellyfinServer(server);
  return server;
}

test("a pasted link from a server not linked yet links it, then queues the item", async () => {
  const { ui, store, views, queued, text } = setup();
  await ui.openLink(interaction("add_track_to_queue"), {
    baseUrl: base,
    itemId: movieId,
    serverId,
  });
  const viewId = "V1";
  await until(() => queued.length === 1);
  expect(queued[0]!.items[0]).toMatchObject({
    title: "Film",
    sourceId: `jellyfin:${serverId}:${movieId}`,
    canonicalUrl: `jellyfin://${serverId}/${movieId}`,
  });
  // Nothing queued carries the server's address.
  expect(JSON.stringify(queued[0]!.items)).not.toContain("1.1.1.1");
  expect(text(viewId)).toContain("Linked Home ✓ — Added *Film* to the queue.");
  expect(store.jellyfinServer("U1", serverId)).toMatchObject({
    baseUrl: base,
    name: "Home",
    accessToken: "token-abc",
    jellyfinUserId: "jfuser",
  });
  expect(views.size).toBe(1);
});

test("the code to approve is shown, with a button that fills it in", async () => {
  const { ui, text } = setup({ approveAfter: 1_000_000 });
  const opening = ui.openLink(interaction("add_track_to_queue"), {
    baseUrl: base,
    itemId: movieId,
  });
  await until(() => text("V1").includes("AB12CD"));
  expect(text("V1")).toContain(
    `"url":"${base}/web/#/quickconnect?code=AB12CD"`,
  );
  expect(text("V1")).toContain("You’ll need an account on this server");
  // Closing the dialog stops the wait.
  await ui.action(
    interaction("jellyfin", { type: "view_closed", viewId: "V1" }),
  );
  await opening;
});

test("an expired code offers a new one", async () => {
  const { ui, views, text, queued } = setup({
    approveAfter: 1_000,
    expireAfter: 1,
  });
  await ui.openLink(interaction("add_track_to_queue"), {
    baseUrl: base,
    itemId: movieId,
  });
  expect(text("V1")).toContain("That code expired");
  expect(text("V1")).toContain("jellyfin_new_code");
  expect(queued).toEqual([]);
  const metadata = JSON.parse(views.get("V1")!.private_metadata);
  expect(metadata.jellyfin).toMatchObject({
    baseUrl: base,
    serverId,
    itemId: movieId,
  });
});

test("says so when Quick Connect is off", async () => {
  const { ui, text } = setup({ quickConnect: false });
  await ui.openLink(interaction("add_track_to_queue"), {
    baseUrl: base,
    itemId: movieId,
  });
  expect(text("V1")).toContain("Quick Connect is off on *Home*");
  expect(text("V1")).toContain("Dashboard › General");
});

test("a link that names another server is refused", async () => {
  const { ui, text } = setup();
  await ui.openLink(interaction("add_track_to_queue"), {
    baseUrl: base,
    itemId: movieId,
    serverId: "ffffffffffffffffffffffffffffffff",
  });
  expect(text("V1")).toContain("different server");
});

test("a part-watched item asks where to start", async () => {
  const { ui, store, text, queued } = setup({
    movie: { UserData: { PlaybackPositionTicks: 2530 * 10_000_000 } },
  });
  linked(store);
  await ui.openLink(interaction("add_track_to_queue"), {
    baseUrl: base,
    itemId: movieId,
  });
  expect(text("V1")).toContain("was left at 42:10");
  expect(text("V1")).toContain(itemValue("resume", serverId, movieId));
  await ui.action(
    interaction("jellyfin_episode", {
      viewId: "V1",
      value: itemValue("resume", serverId, movieId),
    }),
  );
  expect(queued[0]!.items[0]!.startAt).toBe(2530);
  expect(text("V1")).toContain("from 42:10");
});

test("a show opens its seasons and episodes to pick from", async () => {
  const { ui, store, text, queued } = setup();
  linked(store);
  expect(
    await ui.choose(
      interaction("add_track_to_queue"),
      itemValue("open", serverId, seriesId),
    ),
  ).toBeTrue();
  const blocks = text("V1");
  expect(blocks).toContain("The Show");
  expect(blocks).toContain("Add next unwatched episode");
  expect(blocks).toContain("Add whole season");
  expect(blocks).toContain("Watched");
  expect(blocks).toContain("Left at 5:00");
  await ui.action(
    interaction("jellyfin_episode", {
      viewId: "V1",
      value: itemValue("start", serverId, episodeId),
      metadata: { sessionId: "session", jellyfin: { serverId, seriesId } },
    }),
  );
  expect(queued[0]!.items[0]).toMatchObject({ title: "Pilot", album: "S1:E1" });
  // The dialog stays on the show, for more.
  expect(text("V1")).toContain("Added Pilot to the queue.");
  await ui.action(
    interaction("jellyfin_whole_season", {
      viewId: "V1",
      value: seasonId,
      metadata: { sessionId: "session", jellyfin: { serverId, seriesId } },
    }),
  );
  expect(queued[1]!.capability).toBe("add-bulk");
  expect(queued[1]!.items).toHaveLength(2);
});

test("searches every linked server", async () => {
  const { ui, store } = setup();
  linked(store);
  const options = await ui.search("U1", "film");
  expect(options.map((option) => option.text.text)).toEqual([
    "Film (1999) · Movie · 90m",
    "The Show · Show",
  ]);
  expect(parseItemValue(options[0]!.value)).toEqual({
    action: "open",
    serverId,
    itemId: movieId,
  });
  expect(await ui.search("nobody", "film")).toEqual([]);
});

test("prepares an item to stream, with its captions, poster and chapters", async () => {
  const { ui, store } = setup();
  linked(store);
  const directory = `${tmpdir()}/huddlefm-jellyfin-${crypto.randomUUID()}`;
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  const entry = {
    id: "entry1",
    requesterId: "U1",
    sourceInput: `jellyfin://${serverId}/${movieId}`,
    canonicalUrl: `jellyfin://${serverId}/${movieId}`,
    sourceId: `jellyfin:${serverId}:${movieId}`,
    title: "Film",
    artist: "1999",
  };
  const prepared = await ui.prepare(entry, { video: true, directory });
  expect(prepared.form).toBe("video");
  expect(prepared.chapters).toEqual([
    { start: 0, title: "Opening" },
    { start: 600, title: "Middle" },
  ]);
  expect(new URL(prepared.stream!.url).searchParams.get("api_key")).toBe(
    "token-abc",
  );
  expect(await readFile(prepared.stream!.subtitles!, "utf8")).toContain(
    "Hello",
  );
  expect(await readFile(prepared.stream!.cover!, "utf8")).toBe("jpeg");
  // Someone else's queue entry cannot use this user's server.
  await expect(
    ui.prepare({ ...entry, requesterId: "U2" }, { video: true, directory }),
  ).rejects.toThrow("No longer available");
});

test("a server that stopped taking the token needs linking again", async () => {
  const { ui, store } = setup({ revoked: true });
  linked(store);
  const error = await ui
    .prepare(
      {
        id: "entry1",
        requesterId: "U1",
        sourceInput: "x",
        canonicalUrl: "x",
        sourceId: `jellyfin:${serverId}:${movieId}`,
        title: "Film",
        artist: "",
      },
      { video: true, directory: tmpdir() },
    )
    .catch((error) => error);
  expect(error).toBeInstanceOf(TrackError);
  expect(error.message).toBe("No longer available");
  expect(store.jellyfinServer("U1", serverId)?.revoked).toBeTrue();
  expect(ui.summary("U1")).toEqual({ linked: 1, needsLink: 1 });
  expect(ui.hasServers("U1")).toBeFalse();
});

test("tells the server what plays, to whoever queued it", async () => {
  const { ui, store, reports } = setup();
  linked(store);
  const playback = {
    serverId,
    itemId: movieId,
    mediaSourceId: "source1",
    playSessionId: "play1",
    playMethod: "DirectStream" as const,
    audioTracks: [],
    subtitleTracks: [],
  };
  const entry = {
    id: "entry1",
    requesterId: "U1",
    stream: { url: "x", jellyfin: playback },
  };
  ui.playing(entry, 0, false, true);
  ui.playing(entry, 2, false);
  ui.playing(entry, 3, true);
  ui.stopped("entry1", 3);
  await until(() => reports.length === 3);
  expect(reports.map((report) => report.path)).toEqual([
    "start",
    "progress",
    "stop",
  ]);
  expect(reports[1]!.body).toMatchObject({
    IsPaused: true,
    PositionTicks: 30_000_000,
  });
  expect(reports[2]!.body.PositionTicks).toBe(30_000_000);
});

test("the You tab links a server by address and lists it to unlink", async () => {
  const { ui, store, views, text, refreshed } = setup({ approveAfter: 1 });
  const settings = { sessionId: "session", tab: "you" };
  await ui.action(
    interaction("jellyfin_open_link", { viewId: "S1", metadata: settings }),
  );
  expect(text("V1")).toContain("Server address");
  await ui.action(
    interaction("jellyfin_address_form", {
      type: "view_submission",
      viewId: "V1",
      metadata: JSON.parse(views.get("V1")!.private_metadata),
      state: { jellyfin_address: { jellyfin_address: { value: "1.1.1.1" } } },
    }),
  );
  expect(text("V2")).toContain("Linked Home ✓");
  expect(text("V2")).toContain("jellyfin_unlink");
  expect(refreshed).toEqual(["S1"]);
  expect(store.jellyfinServers("U1")).toHaveLength(1);
  await ui.action(
    interaction("jellyfin_unlink", {
      viewId: "V2",
      value: serverId,
      metadata: JSON.parse(views.get("V2")!.private_metadata),
    }),
  );
  expect(store.jellyfinServers("U1")).toEqual([]);
  expect(text("V2")).toContain("Unlinked Home.");
  expect(refreshed).toEqual(["S1", "S1"]);
});

test("an address that is not a server says so", async () => {
  const { ui, text, views } = setup();
  await ui.action(interaction("jellyfin_open_link", { viewId: "S1" }));
  await ui.action(
    interaction("jellyfin_address", {
      viewId: "V1",
      metadata: JSON.parse(views.get("V1")!.private_metadata),
      state: { jellyfin_address: { jellyfin_address: { value: "  " } } },
    }),
  );
  expect(text("V1")).toContain("Type the address you open Jellyfin at.");
});

test("an item replaced without stopping is reported stopped where it was", async () => {
  const { ui, store, reports } = setup();
  linked(store);
  const playback = (itemId: string) => ({
    serverId,
    itemId,
    mediaSourceId: "source1",
    playMethod: "DirectStream" as const,
    audioTracks: [],
    subtitleTracks: [],
  });
  ui.playing(
    {
      id: "a",
      requesterId: "U1",
      stream: { url: "x", jellyfin: playback(movieId) },
    },
    0,
    false,
    true,
  );
  ui.playing(
    {
      id: "a",
      requesterId: "U1",
      stream: { url: "x", jellyfin: playback(movieId) },
    },
    3600,
    false,
  );
  // Previous brings back something else, which starts from the top.
  ui.playing({ id: "b", requesterId: "U1" }, 0, false, true);
  await until(() => reports.some((report) => report.path === "stop"));
  expect(
    reports.find((report) => report.path === "stop")!.body.PositionTicks,
  ).toBe(3600 * 10_000_000);
});

test("an item the account may not play leaves the link alone", async () => {
  const { ui, store, text } = setup();
  linked(store);
  // Nothing at that route answers 403 here, so make one.
  (ui as any).host.jellyfin.item = async () => {
    const { JellyfinError } = await import("./jellyfin.ts");
    throw new JellyfinError("forbidden", 403);
  };
  await ui.choose(
    interaction("add_track_to_queue"),
    itemValue("open", serverId, movieId),
  );
  expect(text("V1")).toContain("isn’t allowed to play that");
  expect(store.jellyfinServer("U1", serverId)?.revoked).toBeUndefined();
});

test("the address form can be submitted, as Slack requires of a form", async () => {
  const { ui, views } = setup();
  await ui.action(interaction("jellyfin_open_link", { viewId: "S1" }));
  const view = views.get("V1") as any;
  expect(view.submit.text).toBe("Continue");
  expect(view.callback_id).toBe("jellyfin_address_form");
});
