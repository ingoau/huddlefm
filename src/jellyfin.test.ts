import { expect, test } from "bun:test";
import {
  episodeNumber,
  isJellyfinStreamLink,
  itemChapters,
  itemTrack,
  itemTracks,
  Jellyfin,
  JellyfinError,
  parseJellyfinLink,
  parseJellyfinSource,
  pickSubtitleTrack,
  playMethod,
  resumeSeconds,
  serverAddress,
  type JellyfinFetch,
  type LinkedServer,
} from "./jellyfin.ts";
import { defaultVideoLimits } from "./tracks.ts";

const itemId = "ba8829437260db713dd7e386ffbf6197";
const serverId = "8a3e05b08edd4f20987437e9f07c4af8";

test("reads the item and server from a Jellyfin web link", () => {
  expect(
    parseJellyfinLink(
      `https://jellyfin.notoverkill.com/web/#/details?id=${itemId}&serverId=${serverId}`,
    ),
  ).toEqual({
    baseUrl: "https://jellyfin.notoverkill.com",
    itemId,
    serverId,
  });
  // Older web apps, a server under a path, and dashed IDs.
  expect(
    parseJellyfinLink(
      "http://media.example.com:8096/jf/web/index.html#!/details?id=BA882943-7260-DB71-3DD7-E386FFBF6197",
    ),
  ).toEqual({
    baseUrl: "http://media.example.com:8096/jf",
    itemId,
  });
  for (const link of [
    "https://jellyfin.example.com/web/#/home",
    "https://jellyfin.example.com/web/#/details?id=nope",
    `https://jellyfin.example.com/details?id=${itemId}`,
    `ftp://jellyfin.example.com/web/#/details?id=${itemId}`,
    "not a link",
  ])
    expect(parseJellyfinLink(link)).toBeUndefined();
});

test("spots a copied stream link, which carries a sign-in", () => {
  expect(
    isJellyfinStreamLink(
      `https://jellyfin.example.com/Videos/${itemId}/stream.mkv?static=true&api_key=secret`,
    ),
  ).toBeTrue();
  expect(
    isJellyfinStreamLink(
      `https://jellyfin.example.com/Audio/${itemId}/universal?ApiKey=secret`,
    ),
  ).toBeTrue();
  expect(
    isJellyfinStreamLink(
      `https://jellyfin.example.com/Videos/${itemId}/stream`,
    ),
  ).toBeFalse();
  expect(
    isJellyfinStreamLink("https://www.youtube.com/watch?v=abc&api_key=1"),
  ).toBeFalse();
});

test("turns a typed address into a server's base address", () => {
  expect(serverAddress("jellyfin.example.com")).toBe(
    "https://jellyfin.example.com",
  );
  expect(serverAddress("http://10.0.0.5:8096/web/index.html")).toBe(
    "http://10.0.0.5:8096",
  );
  expect(serverAddress("https://example.com/jellyfin/")).toBe(
    "https://example.com/jellyfin",
  );
  expect(serverAddress("https://user:pass@example.com")).toBeUndefined();
  expect(serverAddress("ftp://example.com")).toBeUndefined();
  expect(serverAddress("  ")).toBeUndefined();
});

test("a queued item names its server and item by ID, never by address", () => {
  const track = itemTrack(serverId, {
    Id: itemId,
    Name: "Pilot",
    Type: "Episode",
    SeriesName: "The Show",
    ParentIndexNumber: 1,
    IndexNumber: 2,
    RunTimeTicks: 25 * 60 * 10_000_000,
  });
  expect(track).toEqual({
    sourceInput: `jellyfin://${serverId}/${itemId}`,
    canonicalUrl: `jellyfin://${serverId}/${itemId}`,
    sourceId: `jellyfin:${serverId}:${itemId}`,
    title: "Pilot",
    artist: "The Show",
    album: "S1:E2",
    duration: 1500,
    kind: "video",
  });
  expect(parseJellyfinSource(track.sourceId)).toEqual({ serverId, itemId });
  expect(parseJellyfinSource("abcdefghijk")).toBeUndefined();
  expect(
    itemTrack(serverId, {
      Id: itemId,
      Name: "Film",
      Type: "Movie",
      ProductionYear: 1999,
    }),
  ).toMatchObject({ artist: "1999", kind: "video" });
  expect(
    itemTrack(serverId, {
      Id: itemId,
      Name: "Song",
      Type: "Audio",
      AlbumArtist: "Band",
      Album: "Record",
    }),
  ).toMatchObject({ artist: "Band", album: "Record", kind: "song" });
  expect(episodeNumber({ Id: itemId, Type: "Episode", IndexNumber: 4 })).toBe(
    "E4",
  );
});

test("reads chapters, tracks and where an item was left", () => {
  expect(
    itemChapters({
      Id: itemId,
      Chapters: [
        { StartPositionTicks: 600 * 10_000_000, Name: "Later" },
        { StartPositionTicks: 0 },
      ],
    }),
  ).toEqual([
    { start: 0, title: "Chapter 2" },
    { start: 600, title: "Later" },
  ]);
  expect(
    itemChapters({ Id: itemId, Chapters: [{ StartPositionTicks: 0 }] }),
  ).toEqual([]);
  const streams = [
    { Index: 0, Type: "Video" },
    { Index: 1, Type: "Audio", DisplayTitle: "English - AAC" },
    { Index: 2, Type: "Audio", Language: "jpn" },
    { Index: 3, Type: "Subtitle", Language: "ger", IsTextSubtitleStream: true },
    { Index: 4, Type: "Subtitle", Language: "eng", IsTextSubtitleStream: true },
    {
      Index: 5,
      Type: "Subtitle",
      Language: "eng",
      IsTextSubtitleStream: false,
    },
  ];
  expect(itemTracks(streams)).toEqual({
    audio: [
      { index: 1, label: "English - AAC" },
      { index: 2, label: "jpn" },
    ],
    subtitles: [
      { index: 3, label: "ger" },
      { index: 4, label: "eng" },
    ],
  });
  expect(pickSubtitleTrack(streams)).toBe(4);
  expect(pickSubtitleTrack(streams, 3)).toBe(3);
  // A picture track cannot be burned in.
  expect(pickSubtitleTrack(streams, 5)).toBe(4);
  expect(pickSubtitleTrack([])).toBeUndefined();
  expect(
    resumeSeconds({
      Id: itemId,
      UserData: { PlaybackPositionTicks: 2530 * 10_000_000 },
    }),
  ).toBe(2530);
  expect(
    resumeSeconds({
      Id: itemId,
      UserData: { PlaybackPositionTicks: 5 * 10_000_000 },
    }),
  ).toBeUndefined();
  expect(
    resumeSeconds({
      Id: itemId,
      UserData: { PlaybackPositionTicks: 2530 * 10_000_000, Played: true },
    }),
  ).toBeUndefined();
});

test("streams a file as it is when it fits, and has the server convert it otherwise", () => {
  const limits = { maxHeight: 720, maxFps: 30 };
  const source = (height: number, bitrate: number, fps = 24) => ({
    Bitrate: bitrate,
    MediaStreams: [
      { Index: 0, Type: "Video", Height: height, RealFrameRate: fps },
    ],
  });
  expect(playMethod(source(720, 4_000_000), { video: true, limits })).toBe(
    "DirectStream",
  );
  expect(playMethod(source(1080, 4_000_000), { video: true, limits })).toBe(
    "Transcode",
  );
  expect(playMethod(source(720, 40_000_000), { video: true, limits })).toBe(
    "Transcode",
  );
  expect(playMethod(source(720, 4_000_000, 60), { video: true, limits })).toBe(
    "Transcode",
  );
  // Only the sound is wanted for music.
  expect(playMethod(source(2160, 80_000_000), { video: false, limits })).toBe(
    "DirectStream",
  );
});

const server: LinkedServer = {
  userId: "U1",
  serverId,
  baseUrl: "https://1.1.1.1/jf",
  name: "Home",
  accessToken: "token-123",
  jellyfinUserId: "user1",
  deviceId: "device1",
  linkedAt: 1,
};

function fakeServer(
  routes: Record<string, (url: URL, init: RequestInit) => unknown>,
) {
  const calls: {
    method: string;
    url: URL;
    init: RequestInit & { proxy?: string };
  }[] = [];
  const fetch: JellyfinFetch = async (href, init) => {
    const url = new URL(href);
    const method = init.method ?? "GET";
    calls.push({ method, url, init });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response("missing", { status: 404 });
    const body = route(url, init);
    if (body instanceof Response) return body;
    return Response.json(body);
  };
  return {
    calls,
    jellyfin: new Jellyfin({
      proxy: () => "http://127.0.0.1:9",
      fetch,
      limits: () => defaultVideoLimits,
    }),
  };
}

test("asks a server about itself through the proxy, as HuddleFM", async () => {
  const { jellyfin, calls } = fakeServer({
    "GET /jf/System/Info/Public": () => ({
      Id: "8A3E05B0-8EDD-4F20-9874-37E9F07C4AF8",
      ServerName: "Home",
      Version: "10.10.0",
    }),
  });
  expect(await jellyfin.publicInfo("https://1.1.1.1/jf")).toEqual({
    id: serverId,
    name: "Home",
    version: "10.10.0",
  });
  expect(calls[0]!.init.proxy).toBe("http://127.0.0.1:9");
  expect(
    (calls[0]!.init.headers as Record<string, string>).authorization,
  ).toStartWith('MediaBrowser Client="HuddleFM"');
  const broken = fakeServer({
    "GET /System/Info/Public": () => ({ hello: "world" }),
  });
  await expect(broken.jellyfin.publicInfo("https://1.1.1.1")).rejects.toThrow(
    "That doesn’t look like a Jellyfin server HuddleFM can reach",
  );
});

test("never reaches a server without the proxy", async () => {
  const jellyfin = new Jellyfin({
    proxy: () => undefined,
    fetch: async () => Response.json(true),
    limits: () => defaultVideoLimits,
  });
  await expect(jellyfin.quickConnectEnabled("https://1.1.1.1")).rejects.toThrow(
    JellyfinError,
  );
});

test("links with Quick Connect, falling back to GET on older servers", async () => {
  let approved = false;
  const { jellyfin, calls } = fakeServer({
    "POST /QuickConnect/Initiate": () => new Response("", { status: 405 }),
    "GET /QuickConnect/Initiate": () => ({ Code: "AB12CD", Secret: "s3cret" }),
    "GET /QuickConnect/Connect": (url) =>
      url.searchParams.get("secret") === "s3cret"
        ? { Authenticated: approved }
        : new Response("", { status: 404 }),
    "POST /Users/AuthenticateWithQuickConnect": (_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({ Secret: "s3cret" });
      return { AccessToken: "tok", User: { Id: "u1", Name: "Ingo" } };
    },
  });
  const base = "https://1.1.1.1";
  expect(await jellyfin.initiateQuickConnect(base, "dev")).toEqual({
    code: "AB12CD",
    secret: "s3cret",
  });
  expect(await jellyfin.quickConnectState(base, "dev", "s3cret")).toBe(
    "waiting",
  );
  approved = true;
  expect(await jellyfin.quickConnectState(base, "dev", "s3cret")).toBe(
    "approved",
  );
  expect(await jellyfin.quickConnectState(base, "dev", "other")).toBe(
    "expired",
  );
  expect(
    await jellyfin.authenticateQuickConnect(base, "dev", "s3cret"),
  ).toEqual({ accessToken: "tok", userId: "u1", userName: "Ingo" });
  expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toContain(
    "GET /QuickConnect/Initiate",
  );
});

test("falls back to the old user routes on servers before 10.9", async () => {
  const { jellyfin, calls } = fakeServer({
    "GET /jf/Users/user1/Items/Resume": () => ({
      Items: [{ Id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", Name: "Film" }],
    }),
  });
  const items = await jellyfin.resumeItems(server);
  expect(items).toEqual([
    { Id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Name: "Film" },
  ]);
  expect(calls.map((call) => call.url.pathname)).toEqual([
    "/jf/UserItems/Resume",
    "/jf/Users/user1/Items/Resume",
  ]);
  // Anything but a missing route is not retried.
  const refused = fakeServer({
    "GET /jf/UserItems/Resume": () => new Response("", { status: 401 }),
  });
  const error = await refused.jellyfin.resumeItems(server).catch((e) => e);
  expect(error).toBeInstanceOf(JellyfinError);
  expect(error.unauthorized).toBeTrue();
});

const movie = {
  Id: itemId,
  Name: "Film",
  Type: "Movie",
  MediaType: "Video",
};

function playbackServer(height: number) {
  return fakeServer({
    [`POST /jf/Items/${itemId}/PlaybackInfo`]: (_url, init) => {
      const body = JSON.parse(String(init.body));
      return {
        PlaySessionId: "play1",
        MediaSources: [
          {
            Id: "source1",
            Bitrate: 5_000_000,
            SupportsDirectStream: true,
            SupportsTranscoding: true,
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
              { Index: 0, Type: "Video", Height: height },
              { Index: 1, Type: "Audio", Language: "eng" },
              { Index: 2, Type: "Audio", Language: "jpn" },
              {
                Index: 3,
                Type: "Subtitle",
                Language: "eng",
                IsTextSubtitleStream: true,
              },
            ],
            requested: body.AudioStreamIndex,
          },
        ],
      };
    },
  });
}

test("plays a file that fits as it is, in the language picked", async () => {
  const { jellyfin } = playbackServer(720);
  const play = await jellyfin.playback(server, movie, {
    video: true,
    audioStreamIndex: 2,
  });
  const url = new URL(play.url);
  expect(url.pathname).toBe(`/jf/Videos/${itemId}/stream`);
  expect(url.searchParams.get("static")).toBe("true");
  expect(url.searchParams.get("api_key")).toBe("token-123");
  expect(url.searchParams.get("mediaSourceId")).toBe("source1");
  expect(play.audioStream).toBe(2);
  expect(play.form).toBe("video");
  expect(play.playback).toMatchObject({
    serverId,
    itemId,
    mediaSourceId: "source1",
    playSessionId: "play1",
    playMethod: "DirectStream",
    audioStreamIndex: 2,
    subtitleStreamIndex: 3,
  });
});

test("has the server convert a file too big to send as it is", async () => {
  const { jellyfin } = playbackServer(2160);
  const play = await jellyfin.playback(server, movie, {
    video: true,
    audioStreamIndex: 2,
  });
  const url = new URL(play.url);
  expect(url.pathname).toBe(`/jf/Videos/${itemId}/master.m3u8`);
  expect(url.searchParams.get("maxHeight")).toBe("720");
  expect(url.searchParams.get("videoCodec")).toBe("h264");
  expect(url.searchParams.get("audioStreamIndex")).toBe("2");
  // The converted stream has only the language asked for.
  expect(play.audioStream).toBeUndefined();
  expect(play.playback.playMethod).toBe("Transcode");
  // Music mode takes only the sound.
  const music = await jellyfin.playback(server, movie, { video: false });
  expect(music.form).toBe("audio");
  expect(music.playback.playMethod).toBe("DirectStream");
});

test("reports playback against the item and its play session", async () => {
  const bodies: unknown[] = [];
  const { jellyfin } = fakeServer({
    "POST /jf/Sessions/Playing": (_url, init) => (
      bodies.push(JSON.parse(String(init.body))),
      ""
    ),
    "POST /jf/Sessions/Playing/Stopped": (_url, init) => (
      bodies.push(JSON.parse(String(init.body))),
      ""
    ),
  });
  const playback = {
    serverId,
    itemId,
    mediaSourceId: "source1",
    playSessionId: "play1",
    playMethod: "Transcode" as const,
    audioTracks: [],
    subtitleTracks: [],
    audioStreamIndex: 1,
  };
  await jellyfin.report(server, "start", playback, 12.5, false);
  await jellyfin.report(server, "stop", playback, 60);
  expect(bodies).toEqual([
    {
      ItemId: itemId,
      MediaSourceId: "source1",
      PlaySessionId: "play1",
      PositionTicks: 125_000_000,
      IsPaused: false,
      CanSeek: true,
      PlayMethod: "Transcode",
      AudioStreamIndex: 1,
    },
    {
      ItemId: itemId,
      MediaSourceId: "source1",
      PlaySessionId: "play1",
      PositionTicks: 600_000_000,
    },
  ]);
});
