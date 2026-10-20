import { assertPublicUrl } from "./public-proxy.ts";
import type { Chapter } from "./videos.ts";
import {
  TrackError,
  type MediaForm,
  type TrackMetadata,
  type VideoLimits,
} from "./tracks.ts";

// Jellyfin counts time in ticks of 100 nanoseconds.
export const ticksPerSecond = 10_000_000;

const clientName = "HuddleFM";
const clientVersion = "1.0.0";
const requestTimeoutMs = 10_000;
// Above this, a file the right size is still too much for a far server's
// upload, so it is converted.
const directStreamBitrate = 12_000_000;
// What a converted stream is asked to fit.
const transcodeVideoBitrate = 3_500_000;
const transcodeAudioBitrate = 192_000;

/** The parts of a Jellyfin web link that say which item it is. */
export type JellyfinLink = {
  /** The server's address, with any path it is served under. */
  baseUrl: string;
  itemId: string;
  serverId?: string;
};

const itemIdPattern = /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i;

/**
 * Reads a link copied from Jellyfin's web app, such as
 * `https://jellyfin.example.com/web/#/details?id=…&serverId=…`. Everything
 * after `#` stays in the browser, so the server is never asked for it.
 */
export function parseJellyfinLink(input: string): JellyfinLink | undefined {
  const url = URL.parse(input.trim());
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return;
  const webAt = url.pathname.search(/\/web(?:\/|$)/i);
  if (webAt < 0) return;
  const route = url.hash.replace(/^#!?/, "");
  const query = route.indexOf("?");
  if (query < 0) return;
  const page = route.slice(0, query).replace(/\/+$/, "").toLowerCase();
  if (
    !["/details", "/item", "/details.html", "/itemdetails.html"].includes(page)
  )
    return;
  const params = new URLSearchParams(route.slice(query + 1));
  const itemId = params.get("id") ?? "";
  if (!itemIdPattern.test(itemId)) return;
  const serverId = params.get("serverId") ?? undefined;
  return {
    baseUrl: `${url.origin}${url.pathname.slice(0, webAt)}`,
    itemId: itemId.replaceAll("-", "").toLowerCase(),
    ...(serverId && /^[0-9a-f-]{32,36}$/i.test(serverId)
      ? { serverId: serverId.replaceAll("-", "").toLowerCase() }
      : {}),
  };
}

/**
 * A link from Jellyfin's "Copy stream URL", which carries the user's access
 * token in the open. It is never played, so the token does not end up
 * shared in Slack.
 */
export function isJellyfinStreamLink(input: string) {
  const url = URL.parse(input.trim());
  if (!url) return false;
  const token = [...url.searchParams.keys()].some((key) =>
    /^(?:api_?key|x-emby-token|x-mediabrowser-token)$/i.test(key),
  );
  return (
    token && /\/(?:videos|audio|items)\/[0-9a-f-]{32,36}\//i.test(url.pathname)
  );
}

/**
 * A server address as someone typed it: a scheme is added when missing, and
 * a path into the web app is taken off.
 */
export function serverAddress(input: string) {
  const text = input.trim();
  if (!text) return;
  const url = URL.parse(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
  );
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return;
  if (url.username || url.password) return;
  const webAt = url.pathname.search(/\/web(?:\/|$)/i);
  const path = (
    webAt < 0 ? url.pathname : url.pathname.slice(0, webAt)
  ).replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/** Where a queued Jellyfin item lives: never an address, only IDs. */
export function jellyfinSource(serverId: string, itemId: string) {
  return {
    sourceId: `jellyfin:${serverId}:${itemId}`,
    canonicalUrl: `jellyfin://${serverId}/${itemId}`,
  };
}

export function parseJellyfinSource(sourceId: string) {
  const match = /^jellyfin:([0-9a-f]{32}):([0-9a-f]{32})$/.exec(sourceId);
  return match ? { serverId: match[1]!, itemId: match[2]! } : undefined;
}

/** A Jellyfin server a user has linked, with the token it gave HuddleFM. */
export type LinkedServer = {
  userId: string;
  serverId: string;
  baseUrl: string;
  name: string;
  accessToken: string;
  jellyfinUserId: string;
  jellyfinUserName?: string;
  deviceId: string;
  linkedAt: number;
  /** The server stopped taking the token: linked again to use it. */
  revoked?: boolean;
};

export type JellyfinServerInfo = { id: string; name: string; version?: string };

/** The parts of a Jellyfin item HuddleFM reads. */
export type JellyfinItem = {
  Id: string;
  Name?: string;
  Type?: string;
  MediaType?: string;
  SeriesName?: string;
  SeriesId?: string;
  SeasonId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  RunTimeTicks?: number;
  Album?: string;
  AlbumArtist?: string;
  Artists?: string[];
  ChildCount?: number;
  UserData?: { PlaybackPositionTicks?: number; Played?: boolean };
  Chapters?: { StartPositionTicks?: number; Name?: string }[];
  MediaStreams?: JellyfinMediaStream[];
};

export type JellyfinMediaStream = {
  Index: number;
  Type?: string;
  Language?: string;
  DisplayTitle?: string;
  Title?: string;
  Codec?: string;
  IsExternal?: boolean;
  IsTextSubtitleStream?: boolean;
  IsDefault?: boolean;
  Height?: number;
  Width?: number;
  RealFrameRate?: number;
  AverageFrameRate?: number;
};

type MediaSource = {
  Id?: string;
  Bitrate?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  SupportsTranscoding?: boolean;
  DefaultAudioStreamIndex?: number;
  DefaultSubtitleStreamIndex?: number;
  MediaStreams?: JellyfinMediaStream[];
};

/** A track of an item that can be picked: a language, or captions. */
export type JellyfinTrack = { index: number; label: string };

/** How a Jellyfin item is playing, for reporting progress and switching. */
export type JellyfinPlayback = {
  serverId: string;
  itemId: string;
  mediaSourceId: string;
  playSessionId?: string;
  playMethod: "DirectStream" | "Transcode";
  audioTracks: JellyfinTrack[];
  subtitleTracks: JellyfinTrack[];
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
};

export const videoItemTypes = [
  "Movie",
  "Series",
  "Season",
  "Episode",
  "Video",
  "MusicVideo",
];
export const musicItemTypes = ["Audio", "MusicAlbum"];
const playableTypes = new Set([
  "Movie",
  "Episode",
  "Video",
  "MusicVideo",
  "Audio",
  "AudioBook",
  "Trailer",
]);

/** A server's refusal or failure, with its status. */
export class JellyfinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JellyfinError";
  }

  /** The server no longer takes the token. */
  get unauthorized() {
    return this.status === 401 || this.status === 403;
  }
}

export type JellyfinFetch = (
  url: string,
  init: RequestInit & { proxy?: string },
) => Promise<Response>;

type RequestOptions = {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  deviceId: string;
  token?: string;
  signal?: AbortSignal;
};

/** Whether an item can be queued as it is, rather than opened. */
export function isPlayable(item: Pick<JellyfinItem, "Type">) {
  return playableTypes.has(item.Type ?? "");
}

/** Whether an item has a picture to watch. */
export function isVideoItem(item: Pick<JellyfinItem, "Type" | "MediaType">) {
  return item.MediaType === "Video" || videoItemTypes.includes(item.Type ?? "");
}

/** An episode's place in its show, like `S2:E5`. */
export function episodeNumber(item: JellyfinItem) {
  if (item.Type !== "Episode") return undefined;
  const season = item.ParentIndexNumber;
  const episode = item.IndexNumber;
  if (season === undefined && episode === undefined) return undefined;
  return `${season === undefined ? "" : `S${season}`}${season !== undefined && episode !== undefined ? ":" : ""}${episode === undefined ? "" : `E${episode}`}`;
}

/** Where an item was left, in seconds, when part watched. */
export function resumeSeconds(item: JellyfinItem) {
  const ticks = item.UserData?.PlaybackPositionTicks ?? 0;
  if (item.UserData?.Played || ticks <= 0) return undefined;
  const seconds = Math.floor(ticks / ticksPerSecond);
  // A few seconds in is not worth asking about.
  return seconds >= 30 ? seconds : undefined;
}

/** A Jellyfin item as a queued track. Nothing in it names the server. */
export function itemTrack(serverId: string, item: JellyfinItem): TrackMetadata {
  const video = isVideoItem(item);
  const seconds = item.RunTimeTicks
    ? item.RunTimeTicks / ticksPerSecond
    : undefined;
  const source = jellyfinSource(serverId, item.Id);
  const title = item.Name?.trim() || "Untitled";
  const artist =
    item.Type === "Episode"
      ? item.SeriesName?.trim() || "Episode"
      : video
        ? item.ProductionYear
          ? String(item.ProductionYear)
          : item.Type === "Movie"
            ? "Movie"
            : "Video"
        : item.AlbumArtist?.trim() ||
          item.Artists?.[0]?.trim() ||
          "Unknown artist";
  const album =
    item.Type === "Episode"
      ? episodeNumber(item)
      : video
        ? undefined
        : item.Album;
  return {
    sourceInput: source.canonicalUrl,
    canonicalUrl: source.canonicalUrl,
    sourceId: source.sourceId,
    title,
    artist,
    ...(album ? { album } : {}),
    ...(seconds && Number.isFinite(seconds) ? { duration: seconds } : {}),
    kind: video ? "video" : "song",
  };
}

/** An item's chapters, as Jump to lists them. */
export function itemChapters(item: JellyfinItem): Chapter[] {
  const chapters = (item.Chapters ?? [])
    .map((chapter, index) => ({
      start: Math.max(0, (chapter.StartPositionTicks ?? 0) / ticksPerSecond),
      title: chapter.Name?.trim() || `Chapter ${index + 1}`,
    }))
    .sort((a, b) => a.start - b.start);
  // One chapter is the whole item; Jellyfin's made-up "Chapter 1, 2…" every
  // five minutes still help to skip around.
  return chapters.length > 1 ? chapters : [];
}

function trackLabel(stream: JellyfinMediaStream) {
  return (
    stream.DisplayTitle?.trim() ||
    [stream.Language, stream.Title, stream.Codec].filter(Boolean).join(" · ") ||
    `Track ${stream.Index}`
  );
}

/** The audio and text caption tracks an item offers. */
export function itemTracks(streams: JellyfinMediaStream[] = []) {
  return {
    audio: streams
      .filter((stream) => stream.Type === "Audio")
      .map((stream) => ({ index: stream.Index, label: trackLabel(stream) })),
    // Only text captions can be burned in; picture ones are left out.
    subtitles: streams
      .filter(
        (stream) =>
          stream.Type === "Subtitle" && stream.IsTextSubtitleStream !== false,
      )
      .map((stream) => ({ index: stream.Index, label: trackLabel(stream) })),
  };
}

/**
 * Picks how to play a media source: as the file itself when it is already
 * small enough, and otherwise converted by the server to fit the video
 * limits.
 */
export function playMethod(
  source: MediaSource,
  options: {
    video: boolean;
    limits: Pick<VideoLimits, "maxHeight" | "maxFps">;
  },
) {
  if (!options.video) return "DirectStream" as const;
  const picture = source.MediaStreams?.find(
    (stream) => stream.Type === "Video",
  );
  const fps = picture?.RealFrameRate ?? picture?.AverageFrameRate;
  const fits =
    (picture?.Height ?? 0) <= options.limits.maxHeight &&
    (fps === undefined || fps <= options.limits.maxFps + 0.5) &&
    (source.Bitrate ?? 0) <= directStreamBitrate;
  if (fits && source.SupportsDirectStream !== false)
    return "DirectStream" as const;
  if (source.SupportsTranscoding === false) return "DirectStream" as const;
  return "Transcode" as const;
}

/**
 * Talks to Jellyfin servers as the HuddleFM client, through the public
 * network proxy, so a server address can never reach the host's own
 * network.
 */
export class Jellyfin {
  private fetcher: JellyfinFetch;

  constructor(
    private options: {
      proxy: () => string | undefined;
      fetch?: JellyfinFetch;
      limits: () => VideoLimits;
    },
  ) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The header that names HuddleFM, its device, and its token. */
  authorization(deviceId: string, token?: string) {
    const quote = (value: string) => value.replaceAll('"', "");
    return `MediaBrowser Client="${clientName}", Device="${clientName}", DeviceId="${quote(deviceId)}", Version="${clientVersion}"${token ? `, Token="${quote(token)}"` : ""}`;
  }

  private async request(
    baseUrl: string,
    path: string,
    options: RequestOptions,
  ) {
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    await assertPublicUrl(url);
    // Never straight out: only the proxy keeps a server address off the
    // host's own network.
    const proxy = this.options.proxy();
    if (!proxy)
      throw new JellyfinError("HuddleFM isn’t ready to reach Jellyfin");
    const authorization = this.authorization(options.deviceId, options.token);
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeoutMs)])
      : AbortSignal.timeout(requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url.href, {
        method: options.method ?? "GET",
        proxy,
        headers: {
          accept: "application/json",
          authorization,
          "x-emby-authorization": authorization,
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new JellyfinError("The Jellyfin server didn’t answer");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new JellyfinError(
        `Jellyfin answered ${response.status}`,
        response.status,
      );
    }
    return response;
  }

  private async json<T>(
    baseUrl: string,
    path: string,
    options: RequestOptions,
  ) {
    const response = await this.request(baseUrl, path, options);
    const text = await response.text();
    try {
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      throw new JellyfinError("The Jellyfin server sent something unreadable");
    }
  }

  // Jellyfin 10.9 moved the user routes from /Users/{id}/… to a userId query;
  // older servers only know the first.
  private async userRoute<T>(
    server: LinkedServer,
    path: string,
    legacy: string,
    query: RequestOptions["query"] = {},
    signal?: AbortSignal,
  ) {
    const options = {
      deviceId: server.deviceId,
      token: server.accessToken,
      signal,
    };
    try {
      return await this.json<T>(server.baseUrl, path, {
        ...options,
        query: { ...query, userId: server.jellyfinUserId },
      });
    } catch (error) {
      if (
        !(error instanceof JellyfinError) ||
        (error.status !== 404 && error.status !== 405)
      )
        throw error;
      return this.json<T>(server.baseUrl, legacy, { ...options, query });
    }
  }

  /** What a server says about itself without signing in. */
  async publicInfo(baseUrl: string): Promise<JellyfinServerInfo> {
    let info: Record<string, unknown> | undefined;
    try {
      info = await this.json<Record<string, unknown>>(
        baseUrl,
        "/System/Info/Public",
        { deviceId: clientName },
      );
    } catch (error) {
      if (error instanceof JellyfinError)
        throw new TrackError(
          "That doesn’t look like a Jellyfin server HuddleFM can reach",
        );
      throw error;
    }
    const id = typeof info?.Id === "string" ? info.Id.replaceAll("-", "") : "";
    if (!/^[0-9a-f]{32}$/i.test(id))
      throw new TrackError(
        "That doesn’t look like a Jellyfin server HuddleFM can reach",
      );
    return {
      id: id.toLowerCase(),
      name:
        typeof info?.ServerName === "string" && info.ServerName.trim()
          ? info.ServerName.trim()
          : new URL(baseUrl).hostname,
      ...(typeof info?.Version === "string" ? { version: info.Version } : {}),
    };
  }

  async quickConnectEnabled(baseUrl: string) {
    return (
      (await this.json<unknown>(baseUrl, "/QuickConnect/Enabled", {
        deviceId: clientName,
      })) === true
    );
  }

  /** Asks for a Quick Connect code for the user to approve. */
  async initiateQuickConnect(baseUrl: string, deviceId: string) {
    let result: Record<string, unknown> | undefined;
    try {
      result = await this.json(baseUrl, "/QuickConnect/Initiate", {
        method: "POST",
        deviceId,
      });
    } catch (error) {
      // Before 10.9 this was a GET.
      if (!(error instanceof JellyfinError) || error.status !== 405)
        throw error;
      result = await this.json(baseUrl, "/QuickConnect/Initiate", { deviceId });
    }
    const code = typeof result?.Code === "string" ? result.Code : "";
    const secret = typeof result?.Secret === "string" ? result.Secret : "";
    if (!code || !secret)
      throw new JellyfinError("Jellyfin gave no Quick Connect code");
    return { code, secret };
  }

  /** Whether the code was approved yet, or is gone. */
  async quickConnectState(baseUrl: string, deviceId: string, secret: string) {
    try {
      const result = await this.json<Record<string, unknown>>(
        baseUrl,
        "/QuickConnect/Connect",
        { deviceId, query: { secret } },
      );
      return result?.Authenticated === true
        ? ("approved" as const)
        : ("waiting" as const);
    } catch (error) {
      if (
        error instanceof JellyfinError &&
        (error.status === 404 || error.status === 401 || error.status === 400)
      )
        return "expired" as const;
      throw error;
    }
  }

  /** Signs in with an approved code, for a token of HuddleFM's own. */
  async authenticateQuickConnect(
    baseUrl: string,
    deviceId: string,
    secret: string,
  ) {
    const result = await this.json<Record<string, unknown>>(
      baseUrl,
      "/Users/AuthenticateWithQuickConnect",
      { method: "POST", deviceId, body: { Secret: secret } },
    );
    const user = (result?.User ?? {}) as Record<string, unknown>;
    const accessToken =
      typeof result?.AccessToken === "string" ? result.AccessToken : "";
    const userId = typeof user.Id === "string" ? user.Id : "";
    if (!accessToken || !userId)
      throw new JellyfinError("Jellyfin did not sign HuddleFM in");
    return {
      accessToken,
      userId,
      userName: typeof user.Name === "string" ? user.Name : undefined,
    };
  }

  /** Tells the server HuddleFM plays, but takes no remote control. */
  async capabilities(server: LinkedServer) {
    await this.request(server.baseUrl, "/Sessions/Capabilities/Full", {
      method: "POST",
      deviceId: server.deviceId,
      token: server.accessToken,
      body: {
        PlayableMediaTypes: ["Audio", "Video"],
        SupportedCommands: [],
        SupportsMediaControl: false,
        SupportsPersistentIdentifier: false,
      },
    });
  }

  /** Ends HuddleFM's sign-in, so the token stops working on the server too. */
  async logout(server: LinkedServer) {
    await this.request(server.baseUrl, "/Sessions/Logout", {
      method: "POST",
      deviceId: server.deviceId,
      token: server.accessToken,
    });
  }

  async search(
    server: LinkedServer,
    query: string,
    types: string[],
    signal?: AbortSignal,
  ) {
    const result = await this.userRoute<{ Items?: JellyfinItem[] }>(
      server,
      "/Items",
      `/Users/${server.jellyfinUserId}/Items`,
      {
        searchTerm: query,
        recursive: true,
        includeItemTypes: types.join(","),
        limit: 10,
        fields: "ProductionYear,ChildCount",
        enableImages: false,
      },
      signal,
    );
    return result?.Items ?? [];
  }

  async item(server: LinkedServer, itemId: string) {
    const item = await this.userRoute<JellyfinItem>(
      server,
      `/Items/${itemId}`,
      `/Users/${server.jellyfinUserId}/Items/${itemId}`,
      { fields: "Chapters,MediaStreams" },
    );
    if (!item?.Id) throw new JellyfinError("Jellyfin has no such item", 404);
    return normalizeItem(item);
  }

  async seasons(server: LinkedServer, seriesId: string) {
    const result = await this.json<{ Items?: JellyfinItem[] }>(
      server.baseUrl,
      `/Shows/${seriesId}/Seasons`,
      {
        deviceId: server.deviceId,
        token: server.accessToken,
        query: { userId: server.jellyfinUserId },
      },
    );
    return normalizeItems(result?.Items);
  }

  async episodes(server: LinkedServer, seriesId: string, seasonId: string) {
    const result = await this.json<{ Items?: JellyfinItem[] }>(
      server.baseUrl,
      `/Shows/${seriesId}/Episodes`,
      {
        deviceId: server.deviceId,
        token: server.accessToken,
        query: { userId: server.jellyfinUserId, seasonId },
      },
    );
    return normalizeItems(result?.Items);
  }

  /** The episode to watch next in a show, if there is one. */
  async nextUp(server: LinkedServer, seriesId: string) {
    const result = await this.json<{ Items?: JellyfinItem[] }>(
      server.baseUrl,
      "/Shows/NextUp",
      {
        deviceId: server.deviceId,
        token: server.accessToken,
        query: { userId: server.jellyfinUserId, seriesId, limit: 1 },
      },
    );
    return normalizeItems(result?.Items)[0];
  }

  /** What an album or playlist holds, in order. */
  async children(server: LinkedServer, parentId: string) {
    const result = await this.userRoute<{ Items?: JellyfinItem[] }>(
      server,
      "/Items",
      `/Users/${server.jellyfinUserId}/Items`,
      {
        parentId,
        recursive: true,
        includeItemTypes: "Audio,Movie,Episode,Video,MusicVideo",
        sortBy: "ParentIndexNumber,IndexNumber,SortName",
        limit: 200,
      },
    );
    return normalizeItems(result?.Items);
  }

  /** Continue watching. */
  async resumeItems(server: LinkedServer) {
    const result = await this.userRoute<{ Items?: JellyfinItem[] }>(
      server,
      "/UserItems/Resume",
      `/Users/${server.jellyfinUserId}/Items/Resume`,
      { limit: 8, mediaTypes: "Video" },
    );
    return normalizeItems(result?.Items);
  }

  /** Recently added. */
  async latestItems(server: LinkedServer) {
    const result = await this.userRoute<JellyfinItem[]>(
      server,
      "/Items/Latest",
      `/Users/${server.jellyfinUserId}/Items/Latest`,
      { limit: 8, includeItemTypes: "Movie,Episode,Video" },
    );
    return normalizeItems(Array.isArray(result) ? result : []);
  }

  /** An item's poster, for the video card; never for Slack. */
  async poster(server: LinkedServer, itemId: string) {
    const response = await this.request(
      server.baseUrl,
      `/Items/${itemId}/Images/Primary`,
      {
        deviceId: server.deviceId,
        token: server.accessToken,
        query: { maxWidth: 640, format: "Jpg" },
      },
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 5_000_000) throw new JellyfinError("Poster too big");
    return bytes;
  }

  /** A text caption track as SRT. */
  async subtitles(
    server: LinkedServer,
    itemId: string,
    mediaSourceId: string,
    index: number,
  ) {
    const response = await this.request(
      server.baseUrl,
      `/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/0/Stream.srt`,
      { deviceId: server.deviceId, token: server.accessToken },
    );
    const text = await response.text();
    if (text.length > 5_000_000) throw new JellyfinError("Captions too big");
    return text;
  }

  /**
   * Sets up playing an item: the URL to stream it from, and how it plays.
   * The URL carries the token, so it only goes to the media process.
   */
  async playback(
    server: LinkedServer,
    item: JellyfinItem,
    options: {
      video: boolean;
      audioStreamIndex?: number;
      subtitleStreamIndex?: number;
    },
  ): Promise<{
    url: string;
    audioStream?: number;
    playback: JellyfinPlayback;
    form: MediaForm;
  }> {
    const info = await this.json<{
      MediaSources?: MediaSource[];
      PlaySessionId?: string;
    }>(server.baseUrl, `/Items/${item.Id}/PlaybackInfo`, {
      method: "POST",
      deviceId: server.deviceId,
      token: server.accessToken,
      query: { userId: server.jellyfinUserId },
      body: {
        UserId: server.jellyfinUserId,
        ...(options.audioStreamIndex === undefined
          ? {}
          : { AudioStreamIndex: options.audioStreamIndex }),
        EnableDirectPlay: true,
        EnableDirectStream: true,
        EnableTranscoding: true,
        AutoOpenLiveStream: false,
      },
    });
    const source = info?.MediaSources?.[0];
    if (!source?.Id) throw new JellyfinError("Jellyfin has nothing to play");
    const mediaSourceId = source.Id;
    const tracks = itemTracks(source.MediaStreams ?? item.MediaStreams);
    const audioStreamIndex = tracks.audio.some(
      (track) => track.index === options.audioStreamIndex,
    )
      ? options.audioStreamIndex
      : source.DefaultAudioStreamIndex;
    const subtitleStreamIndex = pickSubtitleTrack(
      source.MediaStreams ?? item.MediaStreams ?? [],
      options.subtitleStreamIndex ?? source.DefaultSubtitleStreamIndex,
    );
    const picture =
      isVideoItem(item) &&
      (source.MediaStreams ?? []).some((stream) => stream.Type === "Video");
    const method = playMethod(source, {
      video: options.video && picture,
      limits: this.options.limits(),
    });
    const base = server.baseUrl.replace(/\/+$/, "");
    const query = new URLSearchParams({
      mediaSourceId,
      deviceId: server.deviceId,
      api_key: server.accessToken,
      ...(info?.PlaySessionId ? { playSessionId: info.PlaySessionId } : {}),
    });
    let url: string;
    if (method === "DirectStream") {
      query.set("static", "true");
      url = `${base}/${picture ? "Videos" : "Audio"}/${item.Id}/stream?${query}`;
    } else {
      const { maxHeight, maxFps } = this.options.limits();
      for (const [key, value] of Object.entries({
        videoCodec: "h264",
        audioCodec: "aac",
        maxHeight: String(maxHeight),
        maxFramerate: String(maxFps),
        videoBitrate: String(transcodeVideoBitrate),
        audioBitrate: String(transcodeAudioBitrate),
        transcodingMaxAudioChannels: "2",
        segmentContainer: "ts",
        breakOnNonKeyFrames: "true",
        ...(audioStreamIndex === undefined
          ? {}
          : { audioStreamIndex: String(audioStreamIndex) }),
      }))
        query.set(key, value);
      url = `${base}/Videos/${item.Id}/master.m3u8?${query}`;
    }
    return {
      url,
      // The file itself has every language in it; the converted stream
      // only the one asked for.
      ...(method === "DirectStream" && audioStreamIndex !== undefined
        ? { audioStream: audioStreamIndex }
        : {}),
      form: options.video && picture ? "video" : "audio",
      playback: {
        serverId: server.serverId,
        itemId: item.Id,
        mediaSourceId,
        ...(info?.PlaySessionId ? { playSessionId: info.PlaySessionId } : {}),
        playMethod: method,
        audioTracks: tracks.audio,
        subtitleTracks: tracks.subtitles,
        ...(audioStreamIndex === undefined ? {} : { audioStreamIndex }),
        ...(subtitleStreamIndex === undefined ? {} : { subtitleStreamIndex }),
      },
    };
  }

  /** Reports playback to the server: started, moved on, or stopped. */
  async report(
    server: LinkedServer,
    event: "start" | "progress" | "stop",
    playback: JellyfinPlayback,
    position: number,
    paused = false,
  ) {
    const path =
      event === "start"
        ? "/Sessions/Playing"
        : event === "progress"
          ? "/Sessions/Playing/Progress"
          : "/Sessions/Playing/Stopped";
    await this.request(server.baseUrl, path, {
      method: "POST",
      deviceId: server.deviceId,
      token: server.accessToken,
      body: {
        ItemId: playback.itemId,
        MediaSourceId: playback.mediaSourceId,
        ...(playback.playSessionId
          ? { PlaySessionId: playback.playSessionId }
          : {}),
        PositionTicks: Math.max(0, Math.round(position * ticksPerSecond)),
        ...(event === "stop"
          ? {}
          : {
              IsPaused: paused,
              CanSeek: true,
              PlayMethod: playback.playMethod,
              ...(playback.audioStreamIndex === undefined
                ? {}
                : { AudioStreamIndex: playback.audioStreamIndex }),
              ...(playback.subtitleStreamIndex === undefined
                ? {}
                : { SubtitleStreamIndex: playback.subtitleStreamIndex }),
            }),
      },
    });
  }
}

/**
 * The captions to burn in when captions are on: the track asked for, else
 * the item's default, else English, else the first. Only text tracks count.
 */
export function pickSubtitleTrack(
  streams: JellyfinMediaStream[],
  wanted?: number,
) {
  const text = streams.filter(
    (stream) =>
      stream.Type === "Subtitle" && stream.IsTextSubtitleStream !== false,
  );
  return (
    text.find((stream) => stream.Index === wanted) ??
    text.find((stream) => stream.IsDefault) ??
    text.find((stream) => /^(?:en|eng)(?:-|$)/i.test(stream.Language ?? "")) ??
    text[0]
  )?.Index;
}

// Jellyfin writes IDs with or without dashes depending on where they come
// from; HuddleFM keeps them without.
function normalizeId(id: string | undefined) {
  return id?.replaceAll("-", "").toLowerCase();
}

function normalizeItem(item: JellyfinItem): JellyfinItem {
  return {
    ...item,
    Id: normalizeId(item.Id)!,
    ...(item.SeriesId ? { SeriesId: normalizeId(item.SeriesId) } : {}),
    ...(item.SeasonId ? { SeasonId: normalizeId(item.SeasonId) } : {}),
  };
}

function normalizeItems(items: JellyfinItem[] | undefined) {
  return (items ?? [])
    .filter((item) => typeof item?.Id === "string")
    .map(normalizeItem);
}
