import YTMusic from "ytmusic-api";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { logger } from "./logger.ts";
import { type CachedMedia, MediaCache } from "./media-cache.ts";
import { assertPublicUrl, PublicNetworkProxy } from "./public-proxy.ts";
import type { StreamRelay } from "./stream-relay.ts";
import {
  captionsPath,
  chaptersFrom,
  chaptersPath,
  cleanVideoTitle,
  coreTitle,
  formatClock,
  formatLimit,
  musicVideoMatch,
  parseYouTubeNext,
  parseYouTubeSearch,
  pickSubtitles,
  shorten,
  vttToSrt,
  type Chapter,
} from "./videos.ts";
import { firstArtist } from "./artist.ts";
import {
  isJellyfinStreamLink,
  parseJellyfinLink,
  type JellyfinPlayback,
} from "./jellyfin.ts";

const log = logger.child({ component: "tracks" });
const maxEmbeddedArtworkBytes = 5 * 1024 * 1024;
// Extracted stream URLs outlive this by hours, so a download soon after its
// link was resolved can reuse the extraction instead of repeating it.
const extractionReuseMs = 60 * 60_000;
const maxReusableExtractions = 64;

// A track failure that is caused by the media itself, not by a fault in
// HuddleFM. The message is stable and safe to show in Slack; `detail` keeps the
// raw extractor line for the logs.
export class TrackError extends Error {
  readonly expected: boolean;
  readonly detail?: string;

  constructor(
    message: string,
    { expected = true, detail }: { expected?: boolean; detail?: string } = {},
  ) {
    super(message);
    this.name = "TrackError";
    this.expected = expected;
    this.detail = detail;
  }
}

export function isExpectedTrackFailure(error: unknown) {
  return error instanceof TrackError && error.expected;
}

export function trackFailureDetail(error: unknown) {
  return error instanceof TrackError ? error.detail : undefined;
}

async function readLimited(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        // Keep the size-limit error even if cancellation fails.
      }
      throw new TrackError("That link is not supported", {
        detail: "Navidrome share page is too large",
      });
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Removed, private, blocked, and unreleased media are everyday conditions, so
// they get a stable message rather than the extractor's own wording. That
// wording embeds the source ID ("[youtube] H1FAwIMz-RQ: This video is not
// available."), which would otherwise fingerprint every bad link as a separate
// error tracking issue.
const expectedExtractorFailures = [
  {
    pattern: /live event will begin|premieres? in|is scheduled for/i,
    message: "Track has not been released yet",
  },
  {
    pattern:
      /sign in to confirm your age|age[- ]restricted|inappropriate for some users/i,
    message: "That video is age-restricted",
  },
  {
    pattern:
      /members[- ]only|join this channel|available to this channel's members/i,
    message: "That video is for channel members only",
  },
  {
    // YouTube's bot check also says to use cookies, but is not a login.
    pattern:
      /^(?!.*not a bot).*(?:requires? (?:a )?log ?in|log(?:ged)? ?in (?:is )?required|need to log ?in|sign in to (?:view|watch|continue)|only available (?:to|for) registered users|use --cookies|--cookies-from-browser|account (?:is )?required)/i,
    message: "That video needs a login",
  },
  {
    pattern: /unsupported url/i,
    message: "That link is not supported",
  },
  {
    pattern: new RegExp(
      [
        "video unavailable",
        "(?:video|content|media|item) is (?:not|no longer) available",
        "(?:not|no longer) available (?:on this app|in your country|from your location)",
        "not made this video available",
        "blocked it in your country",
        "private video",
        "sign in to confirm your age",
        "age[- ]restricted",
        "members[- ]only",
        "premium members",
        "has been removed",
        "has been terminated",
        "copyright",
        "does not exist",
        "http error (?:404|410)",
      ].join("|"),
      "i",
    ),
    message: "Track is not available",
  },
];

export function extractorFailure(stderr: string) {
  const line = stderr.trim().split("\n").at(-1)?.trim();
  if (!line) return new TrackError("Extractor failed", { expected: false });
  const known = expectedExtractorFailures.find(({ pattern }) =>
    pattern.test(line),
  );
  return new TrackError(known?.message ?? anonymousFailure(line), {
    expected: Boolean(known),
    detail: line,
  });
}

// Unclassified failures still reach error tracking, so drop the source ID from
// the message to keep occurrences of the same fault grouped together.
function anonymousFailure(line: string) {
  return line
    .replace(/^ERROR:\s*/i, "")
    .replace(/^(\[[^\]]+\]\s+)[\w-]{6,}:\s+/, "$1")
    .trim();
}

// Normalizing is a nicety, so a track ffmpeg can't normalize still plays at
// its original level instead of failing to prepare. It runs as its own step
// rather than through yt-dlp, which skips conversion (and so normalization)
// for downloads that are already Opus. Says whether the track was normalized.
export async function normalizeLoudness(
  filePath: string,
  entryId: string,
  maxBytes: number,
  signal?: AbortSignal,
) {
  const normalizedPath = filePath.replace(/\.[^.]+$/, ".normalized.opus");
  try {
    await run(
      [
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-i",
        filePath,
        "-vn",
        "-af",
        "loudnorm=I=-14:LRA=11:TP=-1",
        "-c:a",
        "libopus",
        "-b:a",
        "160k",
        normalizedPath,
      ],
      120_000,
      signal,
    );
    // Re-encoding can grow a small file past the limit the download was held to.
    if ((await stat(normalizedPath)).size > maxBytes)
      throw new Error("Normalized track exceeds the download limit");
    await rename(normalizedPath, filePath);
    return true;
  } catch (error) {
    await rm(normalizedPath, { force: true });
    if (signal?.aborted) throw error;
    log.warn(
      {
        event: "loudness_normalization_failed",
        entryId,
        detail: trackFailureDetail(error),
        err: error,
      },
      "Playing track without loudness normalization",
    );
    return false;
  }
}

/**
 * A file's integrated loudness in LUFS, measured without re-encoding it, or
 * nothing when it has no sound to measure.
 */
export async function measureLoudness(filePath: string, signal?: AbortSignal) {
  const { stderr } = await run(
    [
      "ffmpeg",
      "-hide_banner",
      "-nostats",
      "-i",
      filePath,
      "-map",
      "0:a:0",
      "-af",
      "ebur128=framelog=quiet",
      "-f",
      "null",
      "-",
    ],
    120_000,
    signal,
  );
  return integratedLoudness(stderr);
}

/** The integrated loudness from ebur128's summary. */
export function integratedLoudness(output: string) {
  const summary = output.slice(output.lastIndexOf("Integrated loudness:"));
  const lufs = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  // Silence reads as the meter's floor, which no gain should chase.
  return Number.isFinite(lufs) && lufs > -70 ? lufs : undefined;
}

/** The gain that brings a loudness to the target, within its bounds. */
export function levelingGain(lufs: number) {
  const gain = loudnessTarget - lufs;
  return Math.round(Math.max(-maxCutDb, Math.min(maxBoostDb, gain)) * 10) / 10;
}

/** Gives a video with no sound a silent track as long as its picture. */
async function addSilence(filePath: string, signal?: AbortSignal) {
  const silentPath = filePath.replace(/\.[^.]+$/, ".silent.mkv");
  try {
    await run(
      [
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-i",
        filePath,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-map",
        "0:v:0",
        "-map",
        "1:a",
        "-c:v",
        "copy",
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-shortest",
        "-f",
        "matroska",
        silentPath,
      ],
      600_000,
      signal,
    );
    await rename(silentPath, filePath);
  } catch (error) {
    await rm(silentPath, { force: true });
    throw error;
  }
}

export function isYoutubeVideoId(id: string) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

const combiningMark = /\p{M}/u;
const latinBase = /[a-z0-9]/;

export function normalizeToken(value: string) {
  let folded = "";
  let afterLatin = false;
  for (const character of value.normalize("NFKD").toLowerCase()) {
    // NFKD splits an accent off into a combining mark. Dropping the ones that
    // came off a Latin letter folds "Sigur R\u00f3s" onto "Sigur Ros" rather than
    // breaking the word in two. Everywhere else a mark carries meaning of its
    // own -- Devanagari "\u0915\u093e\u0932" is not "\u0915\u0932", Cyrillic "\u0439" is not "\u0438", and "\u30c9" is not
    // "\u30c8" -- so it stays.
    if (combiningMark.test(character)) {
      if (!afterLatin) folded += character;
      continue;
    }
    afterLatin = latinBase.test(character);
    folded += character;
  }
  return (
    folded
      // Letters, digits and the marks kept above, in any script, so two songs
      // whose titles are both Japanese are still two different songs.
      // Restricting this to ASCII collapsed every non-Latin title onto the
      // same empty token.
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
      .trim()
  );
}

export type TrackMetadata = {
  sourceInput: string;
  canonicalUrl: string;
  sourceId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  artwork?: string;
  /**
   * A song, or a video worth watching for its own sake. Video mode shows a
   * video as it is and looks for a song's official video. Absent on tracks
   * saved before video mode; see trackKind.
   */
  kind?: TrackKind;
  /** A live stream: played as it arrives, with no end and no seeking. */
  live?: boolean;
};

export type TrackKind = "song" | "video";

/** A track's kind, guessing for one saved before kinds were kept. */
export function trackKind(track: Pick<TrackMetadata, "kind" | "canonicalUrl">) {
  if (track.kind) return track.kind;
  const host = parseHttpUrl(track.canonicalUrl)?.hostname.toLowerCase();
  return youtubeUrl(track.canonicalUrl) && host !== "music.youtube.com"
    ? "video"
    : "song";
}

/**
 * What a prepared file holds: audio, the track's own video, or a song's
 * official video in place of the song.
 */
export type MediaForm = "audio" | "video" | "music_video";

export type PreparedMedia = {
  /** The prepared file, or none for a stream. */
  filePath?: string;
  /** Played as it arrives instead of from a file: see MediaStream. */
  stream?: MediaStream;
  form: MediaForm;
  /** A video that would not download, prepared as audio in its place. */
  fellBack?: boolean;
  /** Chapters known without a file to read them from. */
  chapters?: Chapter[];
  /** What a video's sound is turned by to reach the loudness target. */
  gainDb?: number;
  /** The gain, when it was still being measured as the media came back. */
  leveling?: Promise<number | undefined>;
};

/**
 * Where measured loudness is kept, by source, so it outlives the cached
 * file and levels a video from its first second every time after the first.
 */
export type LoudnessStore = {
  loudness(source: string): number | undefined;
  setLoudness(source: string, lufs: number): void;
};

/** The loudness tracks are levelled to, as loudnorm's target was. */
const loudnessTarget = -14;
/** A quiet video is lifted by at most this much, so its noise is not. */
const maxBoostDb = 6;
const maxCutDb = 24;
/** How long a video waits for its loudness before playing unlevelled. */
const levelingWaitMs = 3_000;
/** The longest a streamed video's download into the cache may take. */
const cachingDeadlineMs = 15 * 60_000;
const stillMeasuring = Symbol("still measuring");

/**
 * A source played as it arrives rather than downloaded first: a live stream,
 * a YouTube video, or an item on a Jellyfin server. Its URL can carry a credential, so it only
 * ever goes to the media process, never to Slack or the logs.
 */
export type MediaStream = {
  url: string;
  /** Where the picture is read from, when not `url`. */
  videoUrl?: string;
  live?: boolean;
  /** Headers the source asks for. */
  headers?: Record<string, string>;
  /** The container's stream to take the audio from, when not its default. */
  audioStream?: number;
  /** A captions file on disk, as SRT, for when captions are on. */
  subtitles?: string;
  /** A poster on disk for the video card, never shown in Slack. */
  cover?: string;
  /** How a Jellyfin item is playing, for progress and track choices. */
  jellyfin?: JellyfinPlayback;
  /**
   * A streamed video being downloaded into the video cache under this key,
   * to play from there once it is in.
   */
  cacheKey?: string;
  /**
   * Served by the bot itself over loopback (see StreamRelay), which the
   * public network proxy refuses, so it is read without it.
   */
  local?: boolean;
};

/** What video mode allows; see the VIDEO_* settings. */
export type VideoLimits = {
  durationSeconds: number;
  downloadBytes: number;
  maxHeight: number;
  maxFps: number;
  cacheBytes: number;
};

export const defaultVideoLimits: VideoLimits = {
  durationSeconds: 3_600,
  downloadBytes: 1_500_000_000,
  maxHeight: 720,
  maxFps: 30,
  cacheBytes: 5_000_000_000,
};

/** A source that turned out to have no picture, so plays as audio. */
class NoVideoError extends Error {}

export type EmbeddedMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
};

/** Sidecar cover extracted from embedded tags, next to the prepared audio. */
export function embeddedArtworkPath(audioPath: string) {
  return audioPath.replace(/\.[^.]+$/, ".cover.jpg");
}

export async function removePreparedMedia(filePath: string) {
  await Promise.all([
    rm(filePath, { force: true }),
    rm(embeddedArtworkPath(filePath), { force: true }),
    rm(captionsPath(filePath), { force: true }),
    rm(chaptersPath(filePath), { force: true }),
  ]);
}

export type TransitionData = {
  introSeconds: number;
  outroSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
};

type CollectionReference =
  | { type: "album"; id: string }
  | { type: "playlist"; id: string; url: string }
  | { type: "navidrome-share"; url: string };

export class TrackCatalog {
  private music = new YTMusic();
  private references = new Map<
    string,
    TrackMetadata | CollectionReference | string
  >();
  private proxy?: PublicNetworkProxy;
  private activePreparations = 0;
  private transitions = new Map<string, TransitionData>();
  private extractions = new Map<string, { info: string; expiresAt: number }>();
  private cache: MediaCache;
  private videoCache: MediaCache;
  /** Where streamed videos' sound and cache downloads are fetched to. */
  private videoStaging: string;
  /** Loudness being measured, by source, so each is measured once. */
  private measuring = new Map<string, Promise<number | undefined>>();
  /** Streamed videos downloading into the video cache, by cache key. */
  private caching = new Map<string, Promise<void>>();
  private cachingQueue: Promise<unknown> = Promise.resolve();
  private levelingWait = levelingWaitMs;
  /** Stops background work, which no session waits on, at shutdown. */
  private closing = new AbortController();
  private preparationQueue: {
    priority: number;
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];

  constructor(
    private limits: {
      durationSeconds: number;
      downloadBytes: number;
      loudnessNormalization?: boolean;
      preparationConcurrency?: number;
      mediaCacheBytes?: number;
      mediaCacheMaxAgeDays?: number;
      mediaCacheDirectory?: string;
      video?: VideoLimits;
      videoCacheDirectory?: string;
    },
    private loudness?: LoudnessStore,
    private relay?: StreamRelay,
  ) {
    this.cache = new MediaCache(
      limits.mediaCacheDirectory ?? "data/cache/media",
      {
        maxBytes: limits.mediaCacheBytes ?? 0,
        maxAgeMs: (limits.mediaCacheMaxAgeDays ?? 0) * 86_400_000,
      },
    );
    const videoCacheDirectory =
      limits.videoCacheDirectory ?? "data/cache/video";
    this.videoStaging = `${videoCacheDirectory}-staging`;
    this.videoCache = new MediaCache(
      videoCacheDirectory,
      {
        maxBytes: this.video.cacheBytes,
        maxAgeMs: (limits.mediaCacheMaxAgeDays ?? 0) * 86_400_000,
      },
      "mkv",
    );
  }

  /** What video mode allows. */
  get video() {
    return this.limits.video ?? defaultVideoLimits;
  }

  async initialize() {
    const startedAt = Date.now();
    log.info({ event: "initialization_started" }, "Initializing track catalog");
    await this.cache
      .initialize()
      .catch((error) =>
        log.warn(
          { event: "media_cache_initialization_failed", err: error },
          "Preparing tracks without reading the media cache",
        ),
      );
    await this.videoCache
      .initialize()
      .catch((error) =>
        log.warn(
          { event: "video_cache_initialization_failed", err: error },
          "Preparing videos without reading the video cache",
        ),
      );
    // What a restart interrupted is never finished.
    await rm(this.videoStaging, { recursive: true, force: true });
    this.proxy = await PublicNetworkProxy.start();
    try {
      await this.music.initialize();
      log.info(
        { event: "initialized", durationMs: Date.now() - startedAt },
        "Track catalog initialized",
      );
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    this.closing.abort();
    await this.proxy?.close();
    this.proxy = undefined;
    log.info({ event: "closed" }, "Track catalog closed");
  }

  async suggestions(
    query: string,
    allowed = { songs: true, bulk: false },
    video = false,
  ) {
    const startedAt = Date.now();
    const completed = (
      inputType: string,
      options: ReturnType<typeof option>[],
      extra = {},
    ) => {
      log.debug(
        {
          event: "suggestions_completed",
          inputType,
          count: options.length,
          ...extra,
          durationMs: Date.now() - startedAt,
        },
        "Track suggestions completed",
      );
      return options;
    };
    const url = parseHttpUrl(query);
    if (!url && video) {
      const videos = allowed.songs ? await this.searchVideos(query) : [];
      return completed(
        "video_search",
        videos.slice(0, 8).map((track) => {
          // The length and channel stay; a long title gives way, at a word.
          const suffix = ` — ${track.artist}${track.duration ? ` · ${formatClock(track.duration)}` : ""}`;
          return option(
            `${shorten(track.title, Math.max(20, 75 - [...suffix].length))}${suffix}`,
            this.remember(track),
          );
        }),
        { songsAllowed: allowed.songs },
      );
    }
    if (!url) {
      const [songs, albums] = await Promise.all([
        allowed.songs ? this.music.searchSongs(query) : [],
        allowed.bulk ? this.music.searchAlbums(query) : [],
      ]);
      return completed(
        "search",
        [
          ...songs
            .slice(0, 5)
            .map((song) =>
              option(
                `${song.name} — ${song.artist.name}${song.album ? ` · ${song.album.name}` : ""}`,
                this.remember(songMetadata(song)),
              ),
            ),
          ...albums
            .slice(0, 5)
            .map((album) =>
              option(
                `Add album: ${album.name} — ${album.artist.name}`,
                this.remember({ type: "album", id: album.albumId }),
              ),
            ),
        ],
        { songsAllowed: allowed.songs, bulkAllowed: allowed.bulk },
      );
    }
    await assertPublicUrl(url);
    const share = navidromeShare(url);
    if (share) {
      const href = share.pageUrl.href;
      return completed("navidrome_share_url", [
        ...(allowed.songs
          ? [option(`Link: ${href}`, this.remember(href))]
          : []),
        ...(allowed.bulk
          ? [
              option(
                `Add share: ${href}`,
                this.remember({ type: "navidrome-share", url: href }),
              ),
            ]
          : []),
      ]);
    }
    const id = youtubePlaylistId(url);
    const playlist =
      id && allowed.bulk
        ? [
            option(
              `Add playlist: ${url.href}`,
              this.remember({ type: "playlist", id, url: url.href }),
            ),
          ]
        : [];
    if (!allowed.songs || url.pathname.replace(/\/$/, "") === "/playlist")
      return completed("playlist_url", playlist);
    return completed("url", [
      option(`Link: ${url.href}`, this.remember(url.href)),
      ...playlist,
    ]);
  }

  /**
   * The track or tracks a search result or link stands for. In video mode,
   * links are checked against the video limits instead of the song ones.
   */
  async resolve(
    reference: string,
    video = false,
  ): Promise<TrackMetadata | TrackMetadata[]> {
    const stored = this.references.get(reference);
    if (!stored) throw new TrackError("Track selection expired; search again");
    const resolved = await this.resolveStored(stored, video);
    this.references.delete(reference);
    return resolved;
  }

  private async resolveStored(
    stored: TrackMetadata | CollectionReference | string,
    video = false,
  ) {
    if (typeof stored === "object" && "type" in stored)
      return this.resolveCollection(stored.type, async () =>
        stored.type === "album"
          ? (await this.music.getAlbum(stored.id)).songs.map((song) =>
              songMetadata(song),
            )
          : stored.type === "navidrome-share"
            ? this.resolveNavidromeShare(stored.url)
            : (await this.music.getPlaylistVideos(stored.id)).map((song) =>
                songMetadata(song, stored.url),
              ),
      );
    if (typeof stored !== "string") {
      this.validate(stored, video);
      return stored;
    }
    if (!navidromeShare(parseHttpUrl(stored)))
      return this.resolveUrl(stored, video);
    const tracks = await this.resolveCollection("navidrome-share", () =>
      this.resolveNavidromeShare(stored),
    );
    return tracks.length === 1 ? tracks[0]! : tracks;
  }

  private async resolveCollection(
    collectionType: CollectionReference["type"],
    load: () => Promise<TrackMetadata[]>,
  ) {
    const startedAt = Date.now();
    const tracks = await load();
    if (!tracks.length)
      throw new TrackError("That album or playlist has no playable songs");
    for (const track of tracks) this.validate(track);
    log.info(
      {
        event: "collection_resolved",
        collectionType,
        count: tracks.length,
        durationMs: Date.now() - startedAt,
      },
      "Track collection resolved",
    );
    return tracks;
  }

  async resolveUrl(input: string, video = false): Promise<TrackMetadata> {
    const startedAt = Date.now();
    const url = parseHttpUrl(input);
    if (!url)
      throw new TrackError("Only absolute HTTP or HTTPS URLs are supported");
    // Jellyfin plays from a linked server, which the add dialog sets up.
    if (isJellyfinStreamLink(url.href))
      throw new TrackError(
        "That link has a Jellyfin sign-in in it, so HuddleFM won’t play it",
      );
    if (parseJellyfinLink(url.href))
      throw new TrackError(
        "Paste Jellyfin links into Add to queue, which links your server",
      );
    await assertPublicUrl(url);
    if (navidromeShare(url)) {
      const tracks = await this.resolveNavidromeShare(url.href);
      if (!tracks.length)
        throw new TrackError("That album or playlist has no playable songs");
      if (tracks.length > 1)
        throw new TrackError("Playlists are not supported");
      this.validate(tracks[0]!, video);
      return urlResolved(tracks[0]!, startedAt);
    }
    const metadata = await runJson([
      ...this.extractor(),
      "--dump-single-json",
      "--skip-download",
      "--no-playlist",
      // Match the format the download takes, so the size check measures
      // what will actually be fetched: the audio stream for a song, and the
      // capped video and its audio in video mode.
      "--format",
      video ? this.videoFormat() : "bestaudio/best",
      "--socket-timeout",
      "10",
      "--",
      url.href,
    ]);
    if (metadata._type === "playlist" || metadata.entries)
      throw new TrackError("Playlists are not supported");
    if (metadata.live_status === "is_upcoming")
      throw new TrackError("Track has not been released yet");
    const live = Boolean(
      metadata.is_live || metadata.live_status === "is_live",
    );
    restrictedVideo(metadata);
    if (
      !live &&
      (metadata.filesize ?? metadata.filesize_approx ?? 0) >
        (video ? this.video.downloadBytes : this.limits.downloadBytes)
    )
      throw new TrackError(
        video
          ? "That video is too big to download"
          : "Track exceeds the download limit",
      );
    const canonicalUrl = metadata.webpage_url ?? url.href;
    await assertPublicUrl(new URL(canonicalUrl));
    const kind = metadataKind(metadata);
    const channel = String(
      metadata.channel ?? metadata.uploader ?? "Unknown artist",
    );
    // yt-dlp dates a live stream's title; the full title has no date.
    const title = String(
      (live ? metadata.fulltitle : undefined) ?? metadata.title ?? "Untitled",
    );
    let track: TrackMetadata = {
      sourceInput: url.href,
      canonicalUrl,
      sourceId: String(metadata.id),
      title: kind === "video" ? cleanVideoTitle(title, channel) : title,
      artist: String(metadata.artist ?? metadata.uploader ?? "Unknown artist"),
      album: metadata.album ? String(metadata.album) : undefined,
      duration:
        metadata.duration && !live ? Number(metadata.duration) : undefined,
      artwork: await publicArtworkUrl(metadata.thumbnail),
      kind,
      ...(live ? { live: true } : {}),
    };
    // Direct files and other generic sources often only expose the filename
    // through yt-dlp; prefer embedded tags when the extractor metadata is thin.
    if (shouldProbeEmbeddedMetadata(track, metadata.extractor))
      track = applyEmbeddedMetadata(
        track,
        await probeEmbeddedMetadata(canonicalUrl, undefined, this.proxyUrl),
      );
    this.validate(track, video);
    // The extraction is only reused for the audio download it matches, and a
    // live stream is never downloaded.
    if (!video && !live) this.rememberExtraction(canonicalUrl, metadata);
    return urlResolved(track, startedAt);
  }

  async upNextIds(videoId: string) {
    return (await this.upNextTracks(videoId)).map((track) => track.sourceId);
  }

  // ytmusic-api's up-next rows do not match its own types: at runtime
  // `artists` is a plain string, `duration` is "m:ss", and there is a single
  // `thumbnail`. Accept every shape seen so far.
  async upNextTracks(videoId: string): Promise<TrackMetadata[]> {
    const results: unknown = await this.music.getUpNexts(videoId);
    return asArray(results).flatMap((row) => {
      const {
        videoId: id,
        title,
        artists,
        artist,
        duration,
        thumbnail,
        thumbnails,
      } = record(row);
      if (typeof id !== "string" || !isYoutubeVideoId(id)) return [];
      return [
        youtubeMusicTrack(id, {
          title: asString(title) ?? "Untitled",
          artist: artistName(artists) ?? artistName(artist) ?? "Unknown artist",
          duration: parseDuration(duration),
          artwork: artworkUrl(thumbnailUrl(thumbnails) ?? asString(thumbnail)),
        }),
      ];
    });
  }

  async searchSong(title: string, artist: string) {
    const query = `${title} ${artist}`.trim();
    if (!query) return;
    const songs = await this.music.searchSongs(query);
    if (!Array.isArray(songs) || !songs.length) return;
    const needle = normalizeToken(artist);
    const match =
      songs.find((song) => {
        const name = normalizeToken(song.artist?.name ?? "");
        return name && (name.includes(needle) || needle.includes(name));
      }) ?? songs[0];
    if (!match?.videoId || !isYoutubeVideoId(match.videoId)) return;
    return songMetadata(match);
  }

  // What YouTube Music is promoting on its signed-out home page right now:
  // the quick picks plus one of the featured hits playlists, chosen at
  // random. For a session with no history to seed from.
  async popularTracks(): Promise<TrackMetadata[]> {
    const startedAt = Date.now();
    const sections: unknown = await this.music.getHomeSections();
    const rows = asArray(sections).flatMap((section) =>
      asArray(record(section).contents),
    );
    const songs = rows.flatMap(homeSongMetadata);
    const playlists = rows.flatMap((row) => {
      const { type, name, playlistId } = record(row);
      // Only YouTube Music's own editorial playlists browse without an
      // account; user and chart playlists (PL…, OLAK…) return 400.
      return type === "PLAYLIST" &&
        typeof playlistId === "string" &&
        playlistId.startsWith("RDCLAK")
        ? [{ name: asString(name) ?? "", playlistId }]
        : [];
    });
    const hits = playlists.filter((playlist) =>
      /hits|top|trending|popular|bangers/i.test(playlist.name),
    );
    const pick = (list: typeof playlists) =>
      list[Math.floor(Math.random() * list.length)];
    const playlist = pick(hits.length ? hits : playlists);
    const videos: unknown = playlist
      ? await this.music
          .getPlaylistVideos(`VL${playlist.playlistId}`)
          .catch((error) => {
            log.warn(
              { event: "popular_playlist_failed", playlist, err: error },
              "Could not read featured playlist",
            );
            return [];
          })
      : [];
    const tracks = [
      ...songs,
      ...(Array.isArray(videos) ? videos : []).flatMap((row) =>
        homeSongMetadata(row),
      ),
    ].filter(
      (track, index, all) =>
        all.findIndex((other) => other.sourceId === track.sourceId) === index,
    );
    log.info(
      {
        event: "popular_tracks_loaded",
        quickPicks: songs.length,
        playlist: playlist?.name,
        count: tracks.length,
        durationMs: Date.now() - startedAt,
      },
      "Popular tracks loaded",
    );
    return tracks;
  }

  resolveVideoId(videoId: string) {
    if (!isYoutubeVideoId(videoId))
      throw new Error("Invalid YouTube Music video ID");
    return this.resolveUrl(`https://music.youtube.com/watch?v=${videoId}`);
  }

  /**
   * Videos on YouTube itself rather than YouTube Music, for video mode,
   * through the web player's search. YouTube Music's video search stands in
   * if that fails.
   */
  async searchVideos(query: string): Promise<TrackMetadata[]> {
    try {
      const response = await fetch(
        "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
        {
          method: "POST",
          proxy: this.proxyUrl,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            context: {
              client: {
                clientName: "WEB",
                clientVersion: "2.20250101.00.00",
                hl: "en",
                gl: "US",
              },
            },
            query,
            // Videos only: no channels, playlists or shorts shelves.
            params: "EgIQAQ==",
          }),
          signal: AbortSignal.timeout(2_500),
        },
      );
      if (!response.ok)
        throw new Error(`YouTube search HTTP ${response.status}`);
      const videos = parseYouTubeSearch(await response.json());
      return videos.map((video) => ({
        sourceInput: `https://www.youtube.com/watch?v=${video.videoId}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
        sourceId: video.videoId,
        title: video.title,
        artist: video.channel,
        duration: video.duration,
        artwork: video.thumbnail,
        kind: "video" as const,
      }));
    } catch (error) {
      log.warn(
        { event: "video_search_failed", err: error },
        "YouTube search failed; searching YouTube Music videos instead",
      );
      const videos = await this.music.searchVideos(query);
      return videos.map((video) => ({
        sourceInput: `https://www.youtube.com/watch?v=${video.videoId}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
        sourceId: video.videoId,
        title: cleanVideoTitle(video.name, video.artist.name),
        artist: video.artist.name,
        duration: video.duration ?? undefined,
        artwork: artworkUrl(video.thumbnails.at(-1)?.url),
        kind: "video" as const,
      }));
    }
  }

  /**
   * What YouTube would play after a video, for video mode's autoplay: its
   * related videos from the web player's watch-next, in its order, leaving
   * out any too long for video mode.
   */
  async relatedVideos(videoId: string): Promise<TrackMetadata[]> {
    if (!isYoutubeVideoId(videoId)) return [];
    const response = await fetch(
      "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
      {
        method: "POST",
        proxy: this.proxyUrl,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20250101.00.00",
              hl: "en",
              gl: "US",
            },
          },
          videoId,
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok)
      throw new Error(`YouTube watch-next HTTP ${response.status}`);
    return parseYouTubeNext(await response.json())
      .filter(
        (video) =>
          video.videoId !== videoId &&
          (!video.duration || video.duration <= this.video.durationSeconds),
      )
      .map((video) => ({
        sourceInput: `https://www.youtube.com/watch?v=${video.videoId}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
        sourceId: video.videoId,
        title: video.title,
        artist: video.channel,
        duration: video.duration,
        artwork: video.thumbnail,
        kind: "video" as const,
      }));
  }

  /**
   * The official video for a song from YouTube Music, if one surely is: see
   * musicVideoMatch. Anything less leaves the song as audio.
   */
  async findMusicVideo(track: TrackMetadata) {
    try {
      const videos = await this.music.searchVideos(
        `${coreTitle(track.title)} ${firstArtist(track.artist)}`,
      );
      const match = musicVideoMatch(
        track,
        videos.map((video) => ({
          videoId: video.videoId,
          title: video.name,
          artist: video.artist.name,
          duration: video.duration ?? undefined,
        })),
      );
      log.info(
        {
          event: "music_video_lookup",
          sourceId: track.sourceId,
          match: match?.videoId,
          candidates: videos.length,
        },
        match ? "Found the song's music video" : "No music video for the song",
      );
      return match;
    } catch (error) {
      log.warn(
        {
          event: "music_video_lookup_failed",
          sourceId: track.sourceId,
          err: error,
        },
        "Could not look for the song's music video",
      );
      return undefined;
    }
  }

  private async resolveNavidromeShare(input: string) {
    const startedAt = Date.now();
    const url = parseHttpUrl(input);
    const share = navidromeShare(url);
    if (!url || !share)
      throw new TrackError("Only absolute HTTP or HTTPS URLs are supported");
    await assertPublicUrl(share.pageUrl);
    const response = await fetch(share.pageUrl.href, {
      proxy: this.proxyUrl,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "HuddleFM",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404 || response.status === 410)
      throw new TrackError("Track is not available");
    if (!response.ok)
      throw new TrackError("That link is not supported", {
        detail: `Navidrome share HTTP ${response.status}`,
      });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > 2_000_000)
      throw new TrackError("That link is not supported", {
        detail: "Navidrome share page is too large",
      });
    const html = await readLimited(response, 2_000_000);
    const info = parseNavidromeShareInfo(html);
    if (!info?.tracks.length)
      throw new TrackError("That album or playlist has no playable songs");
    const tracks: TrackMetadata[] = [];
    for (const track of info.tracks) {
      const stream = share.streamUrl(track.id);
      await assertPublicUrl(stream);
      const tokenHash = new Bun.CryptoHasher("sha256")
        .update(track.id)
        .digest("hex")
        .slice(0, 16);
      tracks.push({
        sourceInput: share.pageUrl.href,
        canonicalUrl: stream.href,
        sourceId: `navidrome:${share.id}:${tokenHash}`,
        title: track.title?.trim() || "Untitled",
        artist: track.artist?.trim() || "Unknown artist",
        album: track.album?.trim() || undefined,
        duration:
          track.duration && Number.isFinite(track.duration)
            ? track.duration
            : undefined,
        artwork: await publicArtworkUrl(share.coverUrl(track.id).href),
        kind: "song",
      });
    }
    if (!tracks.length)
      throw new TrackError("That album or playlist has no playable songs");
    log.info(
      {
        event: "navidrome_share_resolved",
        shareId: share.id,
        count: tracks.length,
        durationMs: Date.now() - startedAt,
      },
      "Navidrome share resolved",
    );
    return tracks;
  }

  private validate(track: TrackMetadata, video = false) {
    if (!track.duration) return;
    if (video && track.duration > this.video.durationSeconds)
      throw new TrackError(
        `That video is longer than ${formatLimit(this.video.durationSeconds)}, the limit on this server`,
      );
    if (!video && track.duration > this.limits.durationSeconds)
      throw new TrackError("Track exceeds the duration limit");
  }

  /** The longest a track may run, given the mode it is prepared in. */
  private durationLimit(video: boolean) {
    return video
      ? Math.max(this.limits.durationSeconds, this.video.durationSeconds)
      : this.limits.durationSeconds;
  }

  /**
   * yt-dlp's format for video mode: H.264 when there is one, being the
   * cheapest to decode, within the size and rate limits, with the best audio.
   */
  private videoFormat() {
    const { maxHeight, maxFps } = this.video;
    // A direct file does not say how big it is, so unknown sizes pass.
    const within = `[height<=?${maxHeight}][fps<=?${maxFps}]`;
    return [
      `bv*${within}[vcodec^=avc1]+ba`,
      `bv*${within}+ba`,
      `b${within}`,
      `bv*[height<=?${maxHeight}]+ba`,
      `b[height<=?${maxHeight}]`,
      // Nothing small enough: the smallest there is.
      "wv*+ba",
      "w",
    ].join("/");
  }

  /**
   * Prepares a track's audio. `video` says it is for video mode, where songs
   * may run as long as videos.
   */
  async prepare(
    track: TrackMetadata,
    directory: string,
    entryId: string,
    signal?: AbortSignal,
    priority = 0,
    video = false,
  ) {
    // A cached track is only linked into place, so it skips the queue that
    // holds back downloads.
    if (this.cache.enabled) {
      const cached = await this.restoreCached(
        track,
        directory,
        entryId,
        signal,
        video,
      );
      if (cached) return cached;
    }
    return this.queuePreparation(priority, entryId, track, () =>
      this.download(track, directory, entryId, signal, video),
    );
  }

  /**
   * Prepares a track for video mode: a video as it is, a song as its
   * official video when one surely exists, and anything else, or anything
   * whose video turns out not to be there, as audio.
   */
  async prepareVideo(
    track: TrackMetadata,
    directory: string,
    entryId: string,
    signal?: AbortSignal,
    priority = 0,
    /** The track's audio, already prepared, to fall back on as it is. */
    preparedAudio?: string,
    /** Whether YouTube may stream it, rather than download it first. */
    stream = true,
  ): Promise<PreparedMedia> {
    const audio = async (): Promise<PreparedMedia> => ({
      filePath:
        preparedAudio && (await Bun.file(preparedAudio).exists())
          ? preparedAudio
          : await this.prepare(
              track,
              directory,
              entryId,
              signal,
              priority,
              true,
            ),
      form: "audio",
    });
    let source: { url: string; sourceId: string; form: MediaForm } | undefined;
    if (trackKind(track) === "video")
      source = {
        url: track.canonicalUrl,
        sourceId: track.sourceId,
        form: "video",
      };
    else if (
      isYoutubeVideoId(track.sourceId) &&
      youtubeUrl(track.canonicalUrl)
    ) {
      const match = await this.findMusicVideo(track);
      if (signal?.aborted) throw new TrackError("Track preparation cancelled");
      if (match)
        source = {
          url: `https://www.youtube.com/watch?v=${match.videoId}`,
          sourceId: match.videoId,
          form: "music_video",
        };
    }
    if (!source) return audio();
    const key = this.videoCacheKey(source);
    // Extracting and measuring wait their turn with other preparations.
    const queued =
      <T>(work: () => Promise<T>) =>
      () =>
        this.queuePreparation(priority, entryId, track, work);
    if (this.videoCache.enabled) {
      const cached = await this.restoreVideo(key, directory, entryId, signal);
      if (cached)
        return {
          filePath: cached,
          form: source.form,
          ...(await this.level(
            source,
            queued(() => measureLoudness(cached)),
          )),
        };
    }
    try {
      // YouTube plays as it arrives, which a long video would otherwise
      // keep everyone waiting for.
      if (stream && streamable(source))
        return await this.streamVideo(
          source,
          key,
          directory,
          entryId,
          queued,
          signal,
        );
      const filePath = await this.queuePreparation(
        priority,
        entryId,
        track,
        () => this.downloadVideo(source, key, directory, entryId, signal),
      );
      return {
        filePath,
        form: source.form,
        ...(await this.level(
          source,
          queued(() => measureLoudness(filePath)),
        )),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      // What video mode refuses stays refused; anything else that stops the
      // picture leaves the sound, which a song's own video always does.
      const refused =
        error instanceof TrackError &&
        error.expected &&
        !(error instanceof NoVideoError);
      if (refused && source.form === "video") throw error;
      log.warn(
        {
          event: "video_fallback_to_audio",
          entryId,
          sourceId: source.sourceId,
          reason: error instanceof Error ? error.message : String(error),
        },
        "Preparing the track as audio instead of video",
      );
      const prepared = await audio();
      return error instanceof NoVideoError || source.form === "music_video"
        ? prepared
        : { ...prepared, fellBack: true };
    }
  }

  /**
   * The address a live stream plays from, picked for the mode: audio for
   * music, a single file with picture and sound for video mode. Streams are
   * played as they arrive, through the public network proxy, and never
   * downloaded or cached.
   */
  async prepareLive(
    track: TrackMetadata,
    video: boolean,
    signal?: AbortSignal,
  ): Promise<PreparedMedia> {
    const startedAt = Date.now();
    if (signal?.aborted) throw new TrackError("Track preparation cancelled");
    const { maxHeight, maxFps } = this.video;
    const within = `[height<=?${maxHeight}][fps<=?${maxFps}]`;
    const format = video
      ? // YouTube serves a stream's picture and sound apart, where other
        // sites mostly send them together. The sound alone, with the card,
        // is the last resort.
        [
          `b${within}`,
          `bv*${within}+ba`,
          `b[height<=?${maxHeight}]`,
          `bv*[height<=?${maxHeight}]+ba`,
          "w",
          "ba",
        ].join("/")
      : // Live sites rarely have audio on its own; a small picture with the
        // sound costs least.
        "ba/b[height<=?360]/w";
    const metadata = record(
      JSON.parse(
        (
          await run(
            [
              ...this.extractor(),
              "--dump-single-json",
              "--skip-download",
              "--no-playlist",
              "--format",
              format,
              "--socket-timeout",
              "10",
              "--",
              track.canonicalUrl,
            ],
            30_000,
            signal,
          )
        ).stdout,
      ),
    );
    if (!(metadata.is_live || metadata.live_status === "is_live"))
      throw new TrackError("That live stream has ended");
    restrictedVideo(metadata);
    const { url, videoUrl, headers, picture } = await streamAddresses(
      metadata,
      "That live stream can't be played",
    );
    log.info(
      {
        event: "live_stream_resolved",
        sourceId: track.sourceId,
        video,
        picture,
        durationMs: Date.now() - startedAt,
      },
      "Live stream resolved",
    );
    return {
      stream: { url, ...(videoUrl ? { videoUrl } : {}), live: true, headers },
      form: video && picture ? "video" : "audio",
    };
  }

  /**
   * Plays a YouTube video as it arrives, its picture and sound apart as
   * YouTube serves them, and downloads it into the video cache behind it
   * for the next time.
   */
  private async streamVideo(
    source: { url: string; sourceId: string; form: MediaForm },
    key: string,
    directory: string,
    entryId: string,
    queued: <T>(work: () => Promise<T>) => () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<PreparedMedia> {
    const startedAt = Date.now();
    const metadata = await queued(() => this.extractVideo(source, signal))();
    const { url, videoUrl, headers } = await streamAddresses(
      metadata,
      "That video can't be played",
    );
    // Measured from the sound alone, which downloads in seconds.
    const leveled = this.level(
      source,
      queued(() => this.measureStreamed(metadata, source.sourceId)),
    );
    const captions = await this.fetchCaptions(metadata, entryId, signal);
    let subtitles: string | undefined;
    if (captions) {
      await mkdir(directory, { recursive: true });
      subtitles = `${directory}/${entryId}.stream.srt`;
      await writeFile(subtitles, captions);
    }
    const leveling = await leveled;
    if (signal?.aborted) throw new TrackError("Track preparation cancelled");
    // After the measurement, which would otherwise share the bandwidth.
    if (this.videoCache.enabled)
      this.cacheStreamed(source, key, leveling.leveling);
    // Through the relay, which fetches it in pieces, wherever it can be.
    const sound = this.relay?.register(url, headers);
    const picture = videoUrl && this.relay?.register(videoUrl, headers);
    const relayed = Boolean(sound && (!videoUrl || picture));
    log.info(
      {
        event: "video_stream_resolved",
        entryId,
        sourceId: source.sourceId,
        separate: Boolean(videoUrl),
        relayed,
        gainDb: leveling.gainDb,
        leveling: Boolean(leveling.leveling),
        durationMs: Date.now() - startedAt,
      },
      "Video stream resolved",
    );
    return {
      stream: {
        ...(relayed
          ? {
              url: sound!,
              ...(picture ? { videoUrl: picture } : {}),
              local: true,
            }
          : { url, ...(videoUrl ? { videoUrl } : {}), headers }),
        ...(subtitles ? { subtitles } : {}),
        ...(this.videoCache.enabled ? { cacheKey: key } : {}),
      },
      form: source.form,
      chapters: chaptersFrom(metadata),
      ...leveling,
    };
  }

  /**
   * Links a streamed video into place from the video cache, once its
   * download behind the stream has finished. Nothing when it is not in.
   */
  async cachedStream(stream: MediaStream, directory: string, entryId: string) {
    if (!stream.cacheKey || !this.videoCache.enabled) return;
    return this.restoreVideo(stream.cacheKey, directory, entryId);
  }

  /**
   * A video's gain: the one stored for it, or one measured now and waited
   * on briefly. One still being measured comes as `leveling` instead, for
   * the player to glide to when it arrives.
   */
  private async level(
    source: { url: string; sourceId: string },
    measure: () => Promise<number | undefined>,
  ): Promise<Pick<PreparedMedia, "gainDb" | "leveling">> {
    if (!this.limits.loudnessNormalization) return {};
    const leveling = this.measured(source, measure).then((lufs) =>
      lufs === undefined ? undefined : levelingGain(lufs),
    );
    const waited = await Promise.race([
      leveling,
      Bun.sleep(this.levelingWait).then(
        (): typeof stillMeasuring => stillMeasuring,
      ),
    ]);
    if (waited === stillMeasuring) return { leveling };
    return waited === undefined ? {} : { gainDb: waited };
  }

  /** A video's loudness, stored or measured once however many ask. */
  private measured(
    source: { url: string; sourceId: string },
    measure: () => Promise<number | undefined>,
  ) {
    const id = videoSourceId(source);
    const known = this.loudness?.loudness(id);
    if (known !== undefined) return Promise.resolve(known);
    let measuring = this.measuring.get(id);
    if (!measuring) {
      const startedAt = Date.now();
      measuring = measure()
        .then(
          (lufs) => {
            try {
              if (lufs !== undefined) this.loudness?.setLoudness(id, lufs);
            } catch (error) {
              // Only the next play is unlevelled for it.
              log.warn(
                {
                  event: "loudness_store_failed",
                  sourceId: source.sourceId,
                  err: error,
                },
                "Could not keep the video's loudness",
              );
            }
            log.info(
              {
                event: "loudness_measured",
                sourceId: source.sourceId,
                lufs,
                durationMs: Date.now() - startedAt,
              },
              "Video loudness measured",
            );
            return lufs;
          },
          (error) => {
            log.warn(
              {
                event: "loudness_measurement_failed",
                sourceId: source.sourceId,
                detail: trackFailureDetail(error),
                err: error,
              },
              "Playing the video without levelling it",
            );
            return undefined;
          },
        )
        .finally(() => this.measuring.delete(id));
      this.measuring.set(id, measuring);
    }
    return measuring;
  }

  /** Downloads a video's sound alone, from its extraction, to measure it. */
  private async measureStreamed(
    metadata: Record<string, unknown>,
    sourceId: string,
  ) {
    const directory = `${this.videoStaging}/${crypto.randomUUID()}`;
    try {
      await mkdir(directory, { recursive: true });
      const infoPath = `${directory}/extraction.json`;
      await writeFile(infoPath, JSON.stringify(metadata));
      const { stdout } = await run(
        [
          ...this.extractor(),
          "--load-info-json",
          infoPath,
          "--format",
          "ba/w",
          "--max-filesize",
          String(this.video.downloadBytes),
          "--print",
          "after_move:filepath",
          "--output",
          `${directory}/sound.%(ext)s`,
        ],
        300_000,
        this.closing.signal,
      );
      const filePath = stdout.trim().split("\n").at(-1);
      if (!filePath) throw new Error(`No sound downloaded for ${sourceId}`);
      return await measureLoudness(filePath, this.closing.signal);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Downloads a streamed video into the video cache, one at a time and
   * after `after`, so the next time it plays it plays from a file.
   */
  private cacheStreamed(
    source: { url: string; sourceId: string },
    key: string,
    after?: Promise<unknown>,
  ) {
    if (this.caching.has(key)) return;
    const id = crypto.randomUUID();
    const directory = `${this.videoStaging}/${id}`;
    const job = Promise.all([this.cachingQueue, after])
      .then(async () => {
        // One that hangs would hold up every one behind it.
        const signal = AbortSignal.any([
          this.closing.signal,
          AbortSignal.timeout(cachingDeadlineMs),
        ]);
        const filePath = await this.downloadVideo(
          source,
          key,
          directory,
          id,
          signal,
        );
        // Kept in the cache, not played from here.
        this.transitions.delete(filePath);
        // A video the stream could not measure is measured from the file.
        if (this.limits.loudnessNormalization)
          await this.measured(source, () => measureLoudness(filePath, signal));
      })
      .catch((error) => {
        if (this.closing.signal.aborted) return;
        log.warn(
          {
            event: "video_caching_failed",
            sourceId: source.sourceId,
            detail: trackFailureDetail(error),
            err: error,
          },
          "Could not cache the streamed video",
        );
      })
      .finally(async () => {
        await rm(directory, { recursive: true, force: true });
        this.caching.delete(key);
      });
    this.caching.set(key, job);
    this.cachingQueue = job;
  }

  /** The public network proxy, for media that streams through it. */
  get streamProxy() {
    return this.proxyUrl;
  }

  private queuePreparation<T>(
    priority: number,
    entryId: string,
    track: TrackMetadata,
    run: () => Promise<T>,
  ) {
    return new Promise<T>((resolve, reject) => {
      this.preparationQueue.push({
        priority,
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.preparationQueue.sort((a, b) => b.priority - a.priority);
      log.debug(
        {
          event: "preparation_queued",
          entryId,
          sourceId: track.sourceId,
          priority,
          queued: this.preparationQueue.length,
          active: this.activePreparations,
        },
        "Track preparation queued",
      );
      this.startPreparations();
    });
  }

  transition(filePath: string) {
    return this.transitions.get(filePath);
  }

  private async restoreCached(
    track: TrackMetadata,
    directory: string,
    entryId: string,
    signal?: AbortSignal,
    video = false,
  ) {
    const startedAt = Date.now();
    if (signal?.aborted) throw new TrackError("Track preparation cancelled");
    await mkdir(directory, { recursive: true });
    const filePath = `${directory}/${entryId}.opus`;
    const coverPath = embeddedArtworkPath(filePath);
    const media = await this.cache.restore(
      this.cacheKey(track),
      filePath,
      coverPath,
    );
    if (!media) return;
    try {
      if (signal?.aborted) throw new TrackError("Track preparation cancelled");
      // Only a download that kept its source read the source's tags, and
      // this request needs them.
      if (shouldRetainSourceForMetadata(track) && !media.embedded) {
        await removePreparedMedia(filePath);
        return;
      }
      const bytes = (await stat(filePath)).size;
      if (bytes > this.limits.downloadBytes)
        throw new TrackError("Track exceeds the download limit");
      if (media.duration > this.durationLimit(video))
        throw new TrackError("Track exceeds the duration limit");
      if (media.embedded) applyEmbeddedMetadata(track, media.embedded);
      if (!track.duration) track.duration = media.duration;
      if (track.artwork) await rm(coverPath, { force: true });
      this.transitions.set(filePath, media.transition);
      log.info(
        {
          event: "download_cached",
          entryId,
          sourceId: track.sourceId,
          title: track.title,
          artist: track.artist,
          bytes,
          durationSeconds: media.duration,
          durationMs: Date.now() - startedAt,
        },
        "Track restored from media cache",
      );
      return filePath;
    } catch (error) {
      await removePreparedMedia(filePath);
      throw error;
    }
  }

  private async download(
    track: TrackMetadata,
    directory: string,
    entryId: string,
    signal?: AbortSignal,
    video = false,
  ) {
    const startedAt = Date.now();
    // How long each step took, so slow preparations can be traced to one.
    const stages: Record<string, number> = {};
    const timed = async <T>(stage: string, step: () => Promise<T>) => {
      const stageStartedAt = Date.now();
      try {
        return await step();
      } finally {
        stages[stage] = (stages[stage] ?? 0) + Date.now() - stageStartedAt;
      }
    };
    log.info(
      { event: "download_started", entryId, sourceId: track.sourceId },
      "Track download started",
    );
    if (signal?.aborted) throw new TrackError("Track preparation cancelled");
    await mkdir(directory, { recursive: true });
    if (signal?.aborted) throw new TrackError("Track preparation cancelled");
    const path = `${directory}/${entryId}.%(ext)s`;
    // Keep the pre-conversion source when display metadata or artwork is still
    // thin so we can read tags/covers before Opus conversion strips them.
    const keepSource = shouldRetainSourceForMetadata(track);
    const download = [
      "--extract-audio",
      "--audio-format",
      "opus",
      "--audio-quality",
      "0",
      ...(keepSource ? ["--keep-video"] : []),
      "--no-playlist",
      "--max-filesize",
      String(this.limits.downloadBytes),
      "--print",
      "after_move:filepath",
      "--output",
      path,
    ];
    const extraction = this.reusableExtraction(track.canonicalUrl);
    let result = extraction
      ? await timed("download", () =>
          this.downloadExtracted(
            extraction,
            download,
            track,
            directory,
            entryId,
            signal,
          ),
        )
      : undefined;
    const extractionReused = Boolean(result);
    if (!result) {
      try {
        result = await timed("download", () =>
          run(
            [...this.extractor(), ...download, "--", track.canonicalUrl],
            180_000,
            signal,
          ),
        );
      } catch (error) {
        // The thrown message is classified, so match the raw extractor line.
        const detail = trackFailureDetail(error) ?? String(error);
        if (signal?.aborted || !detail.includes("HTTP Error 403")) throw error;
        log.warn(
          { event: "download_retry", entryId, sourceId: track.sourceId },
          "Retrying track download with embedded player",
        );
        result = await timed("download_retry", () =>
          run(
            [
              ...this.extractor(),
              "--extractor-args",
              "youtube:player_client=web_embedded",
              ...download,
              "--",
              track.canonicalUrl,
            ],
            180_000,
            signal,
          ),
        );
      }
    }
    const filePath = result.stdout.trim().split("\n").at(-1);
    if (!filePath || !(await Bun.file(filePath).exists()))
      throw new Error("Extractor produced no playable file");
    try {
      let embedded: EmbeddedMetadata | undefined;
      if (keepSource) {
        embedded = {};
        const sourcePath = await retainedSourcePath(filePath);
        if (sourcePath) {
          try {
            await timed("embedded_metadata", async () => {
              embedded = await probeEmbeddedMetadata(sourcePath, signal);
              applyEmbeddedMetadata(track, embedded);
              if (!track.artwork) {
                await extractEmbeddedArtwork(
                  sourcePath,
                  embeddedArtworkPath(filePath),
                  signal,
                );
              }
            });
          } finally {
            await rm(sourcePath, { force: true });
          }
        }
      }
      let bytes = (await stat(filePath)).size;
      if (bytes > this.limits.downloadBytes)
        throw new TrackError("Track exceeds the download limit");
      const probe = await timed("probe", () =>
        run(
          [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            filePath,
          ],
          15_000,
          signal,
        ),
      );
      const duration = Number(probe.stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("Could not verify the downloaded track duration");
      if (duration > this.durationLimit(video))
        throw new TrackError("Track exceeds the duration limit");
      if (!track.duration) track.duration = duration;
      // A fallback taken below is kept out of the cache, so a later download
      // of the track can do better.
      let complete = true;
      if (this.limits.loudnessNormalization) {
        complete = await timed("normalize", () =>
          normalizeLoudness(
            filePath,
            entryId,
            this.limits.downloadBytes,
            signal,
          ),
        );
        bytes = (await stat(filePath)).size;
      }
      let transition = {
        introSeconds: 0,
        outroSeconds: duration,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
      };
      try {
        const analysis = await timed("analyze", () =>
          run(
            [
              "ffmpeg",
              "-hide_banner",
              "-i",
              filePath,
              "-af",
              "silencedetect=noise=-60dB:d=0.25,aresample=1000,asetnsamples=n=250:p=1,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
              "-f",
              "null",
              "-",
            ],
            30_000,
            signal,
          ),
        );
        transition = transitionData(analysis.stderr, duration);
      } catch (error) {
        if (signal?.aborted) throw error;
        complete = false;
        log.warn(
          { event: "transition_analysis_failed", entryId, err: error },
          "Using untrimmed track boundaries",
        );
      }
      this.transitions.set(filePath, transition);
      if (this.cache.enabled && complete) {
        const coverPath = embeddedArtworkPath(filePath);
        const media: CachedMedia = {
          duration,
          transition,
          embedded,
          cover: await Bun.file(coverPath).exists(),
        };
        await timed("cache", () =>
          this.cache.store(this.cacheKey(track), filePath, coverPath, media),
        );
      }
      log.info(
        {
          event: "download_completed",
          entryId,
          sourceId: track.sourceId,
          title: track.title,
          artist: track.artist,
          bytes,
          durationSeconds: duration,
          ...transition,
          extractionReused,
          stages,
          durationMs: Date.now() - startedAt,
        },
        "Track download completed",
      );
      return filePath;
    } catch (error) {
      await removePreparedMedia(filePath);
      const sourcePath = await retainedSourcePath(filePath).catch(
        () => undefined,
      );
      if (sourcePath) await rm(sourcePath, { force: true });
      throw error;
    }
  }

  // Downloads from the extraction that resolving the link already did. Stream
  // URLs can still have gone stale, so any failure hands back to a fresh
  // extraction.
  private async downloadExtracted(
    info: string,
    download: string[],
    track: TrackMetadata,
    directory: string,
    entryId: string,
    signal?: AbortSignal,
  ) {
    // Not named after the entry, which would read as a retained source.
    const infoPath = `${directory}/extraction-${entryId}.json`;
    try {
      await writeFile(infoPath, info);
      return await run(
        [...this.extractor(), "--load-info-json", infoPath, ...download],
        180_000,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn(
        {
          event: "extraction_reuse_failed",
          entryId,
          sourceId: track.sourceId,
          reason: trackFailureDetail(error),
          err: error,
        },
        "Extracting track again",
      );
      return;
    } finally {
      await rm(infoPath, { force: true });
    }
  }

  private rememberExtraction(canonicalUrl: string, metadata: unknown) {
    // Captions and thumbnail lists are most of an extraction's size and play
    // no part in downloading the audio.
    const {
      automatic_captions: _captions,
      subtitles: _subtitles,
      heatmap: _heatmap,
      thumbnails: _thumbnails,
      ...info
    } = record(metadata);
    this.extractions.delete(canonicalUrl);
    this.extractions.set(canonicalUrl, {
      info: JSON.stringify(info),
      expiresAt: Date.now() + extractionReuseMs,
    });
    for (const [url, { expiresAt }] of this.extractions)
      if (
        this.extractions.size > maxReusableExtractions ||
        expiresAt <= Date.now()
      )
        this.extractions.delete(url);
  }

  private reusableExtraction(canonicalUrl: string) {
    const extraction = this.extractions.get(canonicalUrl);
    if (!extraction) return;
    if (extraction.expiresAt > Date.now()) return extraction.info;
    this.extractions.delete(canonicalUrl);
  }

  private async restoreVideo(
    key: string,
    directory: string,
    entryId: string,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw new TrackError("Track preparation cancelled");
    await mkdir(directory, { recursive: true });
    const filePath = `${directory}/${entryId}.video.mkv`;
    const media = await this.videoCache.restore(
      key,
      filePath,
      embeddedArtworkPath(filePath),
    );
    if (!media) return;
    try {
      if (signal?.aborted) throw new TrackError("Track preparation cancelled");
      if ((await stat(filePath)).size > this.video.downloadBytes)
        throw new TrackError("That video is too big to download");
      if (media.duration > this.video.durationSeconds)
        throw new TrackError(
          `That video is longer than ${formatLimit(this.video.durationSeconds)}, the limit on this server`,
        );
      await writeVideoExtras(filePath, media.chapters, media.captions);
      this.transitions.set(filePath, wholeTrack(media.duration));
      log.info(
        { event: "video_cached", entryId, key },
        "Video restored from video cache",
      );
      return filePath;
    } catch (error) {
      await removePreparedMedia(filePath);
      throw error;
    }
  }

  /**
   * Extracts a video in video mode's format, refusing what video mode does
   * not play before any of it is downloaded or streamed.
   */
  private async extractVideo(
    source: { url: string; sourceId: string },
    signal?: AbortSignal,
  ) {
    const metadata = record(
      JSON.parse(
        (
          await run(
            [
              ...this.extractor(),
              "--dump-single-json",
              "--skip-download",
              "--no-playlist",
              "--format",
              this.videoFormat(),
              "--socket-timeout",
              "10",
              "--",
              source.url,
            ],
            30_000,
            signal,
          )
        ).stdout,
      ),
    );
    if (metadata.is_live || metadata.live_status === "is_live")
      throw new TrackError("Live streams are not supported");
    restrictedVideo(metadata);
    if (!hasVideoFormats(metadata))
      throw new NoVideoError("The source has no video");
    const listed = Number(metadata.duration);
    if (Number.isFinite(listed) && listed > this.video.durationSeconds)
      throw new TrackError(
        `That video is longer than ${formatLimit(this.video.durationSeconds)}, the limit on this server`,
      );
    return metadata;
  }

  /**
   * Downloads a video, capped to the video limits, with its captions and
   * chapters next to it. Extracts first, to refuse what video mode does not
   * play before downloading any of it. Its sound is left as it is: the
   * player levels it by its measured loudness.
   */
  private async downloadVideo(
    source: { url: string; sourceId: string },
    key: string,
    directory: string,
    entryId: string,
    signal?: AbortSignal,
  ) {
    const startedAt = Date.now();
    log.info(
      { event: "video_download_started", entryId, sourceId: source.sourceId },
      "Video download started",
    );
    if (signal?.aborted) throw new TrackError("Track preparation cancelled");
    await mkdir(directory, { recursive: true });
    const format = this.videoFormat();
    const metadata = await this.extractVideo(source, signal);
    if (
      Number(metadata.filesize ?? metadata.filesize_approx ?? 0) >
      this.video.downloadBytes
    )
      throw new TrackError("That video is too big to download");
    const output = `${directory}/${entryId}.video.%(ext)s`;
    const download = [
      "--format",
      format,
      "--merge-output-format",
      "mkv",
      "--remux-video",
      "mkv",
      "--no-playlist",
      "--max-filesize",
      String(this.video.downloadBytes),
      "--print",
      "after_move:filepath",
      "--output",
      output,
    ];
    const infoPath = `${directory}/extraction-${entryId}.json`;
    let result: { stdout: string } | undefined;
    try {
      await writeFile(infoPath, JSON.stringify(metadata));
      result = await run(
        [...this.extractor(), "--load-info-json", infoPath, ...download],
        600_000,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn(
        {
          event: "video_extraction_reuse_failed",
          entryId,
          reason: trackFailureDetail(error),
          err: error,
        },
        "Extracting the video again",
      );
    } finally {
      await rm(infoPath, { force: true });
    }
    if (!result)
      try {
        result = await run(
          [...this.extractor(), ...download, "--", source.url],
          600_000,
          signal,
        );
      } catch (error) {
        // Like the audio download: the embedded player gets past some 403s.
        const detail = trackFailureDetail(error) ?? String(error);
        if (signal?.aborted || !detail.includes("HTTP Error 403")) throw error;
        log.warn(
          { event: "video_download_retry", entryId },
          "Retrying video download with embedded player",
        );
        result = await run(
          [
            ...this.extractor(),
            "--extractor-args",
            "youtube:player_client=web_embedded",
            ...download,
            "--",
            source.url,
          ],
          600_000,
          signal,
        );
      }
    const filePath = result.stdout.trim().split("\n").at(-1);
    if (!filePath || !(await Bun.file(filePath).exists()))
      throw new Error("Extractor produced no playable file");
    try {
      if ((await stat(filePath)).size > this.video.downloadBytes)
        throw new TrackError("That video is too big to download");
      const probe = await run(
        [
          "ffprobe",
          "-v",
          "error",
          "-show_entries",
          "format=duration:stream=codec_type",
          "-of",
          "json",
          filePath,
        ],
        15_000,
        signal,
      );
      const probed = record(JSON.parse(probe.stdout));
      const duration = Number(record(probed.format).duration);
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("Could not verify the downloaded video duration");
      if (duration > this.video.durationSeconds)
        throw new TrackError(
          `That video is longer than ${formatLimit(this.video.durationSeconds)}, the limit on this server`,
        );
      const streams = asArray(probed.streams).map(
        (stream) => record(stream).codec_type,
      );
      if (!streams.includes("video"))
        throw new NoVideoError("The download has no video");
      // Playback runs on the sound, so a silent video gets silence to run on.
      if (!streams.includes("audio")) await addSilence(filePath, signal);
      const chapters = chaptersFrom(metadata);
      const captions = await this.fetchCaptions(metadata, entryId, signal);
      await writeVideoExtras(filePath, chapters, captions);
      this.transitions.set(filePath, wholeTrack(duration));
      if (this.videoCache.enabled)
        await this.videoCache.store(
          key,
          filePath,
          embeddedArtworkPath(filePath),
          {
            duration,
            transition: wholeTrack(duration),
            cover: false,
            ...(chapters.length ? { chapters } : {}),
            ...(captions ? { captions } : {}),
          },
        );
      log.info(
        {
          event: "video_download_completed",
          entryId,
          sourceId: source.sourceId,
          bytes: (await stat(filePath)).size,
          durationSeconds: duration,
          chapters: chapters.length,
          captions: Boolean(captions),
          durationMs: Date.now() - startedAt,
        },
        "Video download completed",
      );
      return filePath;
    } catch (error) {
      await removePreparedMedia(filePath);
      throw error;
    }
  }

  /** The video's captions as SRT, or nothing when it has none or they fail. */
  private async fetchCaptions(
    metadata: Record<string, unknown>,
    entryId: string,
    signal?: AbortSignal,
  ) {
    const picked = pickSubtitles(metadata);
    if (!picked) return undefined;
    try {
      const url = new URL(picked.url);
      await assertPublicUrl(url);
      const response = await fetch(url.href, {
        proxy: this.proxyUrl,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Captions HTTP ${response.status}`);
      const srt = vttToSrt(await readText(response, 5_000_000));
      return srt.trim() ? srt : undefined;
    } catch (error) {
      if (signal?.aborted) throw new TrackError("Track preparation cancelled");
      log.warn(
        {
          event: "captions_failed",
          entryId,
          language: picked.language,
          err: error,
        },
        "Preparing the video without captions",
      );
      return undefined;
    }
  }

  private videoCacheKey(source: { url: string; sourceId: string }) {
    // Videos are kept as they came, levelled as they play: those kept
    // normalized once are left to age out.
    return new Bun.CryptoHasher("sha256")
      .update(
        `video\nsource\n${this.video.maxHeight}p${this.video.maxFps}\n${videoSourceId(source)}`,
      )
      .digest("hex")
      .slice(0, 32);
  }

  private cacheKey(track: TrackMetadata) {
    // The same video is reached through several URLs, so key it by its ID.
    const source =
      isYoutubeVideoId(track.sourceId) && youtubeUrl(track.canonicalUrl)
        ? `youtube:${track.sourceId}`
        : track.canonicalUrl;
    const variant = this.limits.loudnessNormalization ? "normalized" : "source";
    return new Bun.CryptoHasher("sha256")
      .update(`${variant}\n${source}`)
      .digest("hex")
      .slice(0, 32);
  }

  private startPreparations() {
    while (
      this.activePreparations < (this.limits.preparationConcurrency ?? 2)
    ) {
      const preparation = this.preparationQueue.shift();
      if (!preparation) return;
      this.activePreparations++;
      log.debug(
        {
          event: "preparation_started",
          active: this.activePreparations,
          queued: this.preparationQueue.length,
        },
        "Track preparation started",
      );
      void preparation
        .run()
        .then(preparation.resolve, preparation.reject)
        .finally(() => {
          this.activePreparations--;
          log.debug(
            {
              event: "preparation_finished",
              active: this.activePreparations,
              queued: this.preparationQueue.length,
            },
            "Track preparation finished",
          );
          this.startPreparations();
        });
    }
  }

  private get proxyUrl() {
    if (!this.proxy) throw new Error("Track catalog is not initialized");
    return this.proxy.url;
  }

  private extractor() {
    return ["yt-dlp", "--force-ipv4", "--proxy", this.proxyUrl];
  }

  /** The link a search result stands for, when it is one. */
  referencedUrl(reference: string) {
    const stored = this.references.get(reference);
    return typeof stored === "string" ? stored : undefined;
  }

  /** What a search result is called, when it is known before resolving. */
  referencedTitle(reference: string) {
    const stored = this.references.get(reference);
    return typeof stored === "object" && "title" in stored
      ? stored.title
      : undefined;
  }

  private remember(value: TrackMetadata | CollectionReference | string) {
    const reference = `${typeof value === "object" && "type" in value ? "bulk" : "track"}ref_${crypto.randomUUID()}`;
    this.references.set(reference, value);
    setTimeout(() => this.references.delete(reference), 10 * 60_000);
    return reference;
  }
}

/** Boundaries for a file played whole: video mode cuts straight across. */
function wholeTrack(duration: number): TransitionData {
  return {
    introSeconds: 0,
    outroSeconds: duration,
    fadeInSeconds: 0,
    fadeOutSeconds: 0,
  };
}

/** Saves a prepared video's chapters and captions next to it. */
async function writeVideoExtras(
  filePath: string,
  chapters?: Chapter[],
  captions?: string,
) {
  if (chapters?.length)
    await writeFile(chaptersPath(filePath), JSON.stringify(chapters));
  if (captions) await writeFile(captionsPath(filePath), captions);
}

async function readText(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw new Error("Response is too large");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Response is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Refuses what video mode will not play, with its own message: videos only
 * signed-in adults or channel members may watch.
 */
export function restrictedVideo(metadata: Record<string, unknown>) {
  if (Number(metadata.age_limit) >= 18)
    throw new TrackError("That video is age-restricted");
  const availability = String(metadata.availability ?? "");
  if (availability === "subscriber_only" || availability === "premium_only")
    throw new TrackError("That video is for channel members only");
  if (availability === "needs_auth")
    throw new TrackError("Track is not available");
}

/** A video that plays as it arrives: YouTube's, which can be resumed anywhere. */
function streamable(source: { url: string; sourceId: string }) {
  return isYoutubeVideoId(source.sourceId) && Boolean(youtubeUrl(source.url));
}

/** Who a video is, by its ID where several URLs reach the same one. */
function videoSourceId(source: { url: string; sourceId: string }) {
  return streamable(source) ? `youtube:${source.sourceId}` : source.url;
}

/**
 * Where an extraction plays from: one address with picture and sound, or,
 * as YouTube serves them, the sound and the picture apart.
 */
export async function streamAddresses(
  metadata: Record<string, unknown>,
  failure: string,
) {
  const formats = asArray(metadata.requested_formats).map(record);
  const sound = formats.find(
    (format) => format.vcodec === "none" && format.acodec !== "none",
  );
  const picture = formats.find(
    (format) => typeof format.vcodec === "string" && format.vcodec !== "none",
  );
  const single = formats.length ? undefined : metadata;
  const address = async (value: unknown) => {
    const url = parseHttpUrl(typeof value === "string" ? value : "");
    if (!url)
      throw new TrackError(failure, {
        expected: false,
        detail: "The extractor gave no stream URL",
      });
    await assertPublicUrl(url);
    return url.href;
  };
  const headers = Object.fromEntries(
    Object.entries(
      record((single ?? sound)?.http_headers ?? metadata.http_headers),
    ).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
  );
  if (single)
    return {
      url: await address(single.url),
      headers,
      picture:
        typeof single.vcodec === "string"
          ? single.vcodec !== "none"
          : Boolean(single.width || single.height),
    };
  if (!sound || !picture)
    throw new TrackError(failure, {
      expected: false,
      detail: "The extractor gave no separate sound and picture",
    });
  return {
    url: await address(sound.url),
    videoUrl: await address(picture.url),
    headers,
    picture: true,
  };
}

function hasVideoFormats(metadata: Record<string, unknown>) {
  const formats = [
    ...asArray(metadata.requested_formats),
    ...asArray(metadata.formats),
    metadata,
  ];
  return formats.some((format) => {
    const { vcodec, video_ext: videoExt } = record(format);
    // A direct file's codec is unknown; its extension says if it is video.
    return typeof vcodec === "string"
      ? vcodec !== "none"
      : typeof videoExt === "string" && videoExt !== "none";
  });
}

/**
 * Whether a link is a song or a video. YouTube's art tracks, which come from
 * an artist's "Topic" channel, and anything without a picture are songs.
 */
export function metadataKind(metadata: Record<string, unknown>): TrackKind {
  const channel = String(metadata.channel ?? metadata.uploader ?? "");
  if (/ - Topic$/.test(channel)) return "song";
  return hasVideoFormats(metadata) ? "video" : "song";
}

export function transitionData(output: string, duration: number) {
  const events = [...output.matchAll(/silence_(start|end): ([\d.]+)/g)].map(
    ([, type, seconds]) => ({ type, seconds: Number(seconds) }),
  );
  const leading = events[0]?.type === "start" && events[0].seconds < 0.1;
  const introSeconds =
    leading && events[1]?.type === "end" ? events[1].seconds : 0;
  const lastStart = events.findLast((event) => event.type === "start");
  const lastEnd = events.findLast((event) => event.type === "end");
  const outroSeconds =
    lastStart && (!lastEnd || lastEnd.seconds >= duration - 0.1)
      ? lastStart.seconds
      : duration;
  const levels: { seconds: number; db: number }[] = [];
  let seconds: number | undefined;
  for (const line of output.split("\n")) {
    const timestamp = line.match(/pts_time:([\d.]+)/);
    if (timestamp) seconds = Number(timestamp[1]);
    const level = line.match(/RMS_level=([-\w.]+)/);
    if (level && seconds !== undefined) {
      const db = Number(level[1]);
      if (Number.isFinite(db)) levels.push({ seconds, db });
      seconds = undefined;
    }
  }
  const audible = levels.filter(
    (sample) => sample.seconds >= introSeconds && sample.seconds < outroSeconds,
  );
  if (audible.length < 4)
    return {
      introSeconds,
      outroSeconds,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
    };
  const sorted = audible.map(({ db }) => db).sort((a, b) => a - b);
  const threshold = sorted[Math.floor((sorted.length - 1) * 0.75)]! - 8;
  const maximum = Math.min(8, (outroSeconds - introSeconds) / 4);
  const firstStrong = audible.find(({ db }) => db >= threshold);
  const lastStrong = audible.findLast(({ db }) => db >= threshold);
  const fadeInSeconds = Math.min(
    maximum,
    Math.max(0.75, (firstStrong?.seconds ?? introSeconds + 8) - introSeconds),
  );
  const fadeOutSeconds = Math.min(
    maximum,
    Math.max(
      0.75,
      outroSeconds - ((lastStrong?.seconds ?? outroSeconds - 8) + 0.25),
    ),
  );
  return { introSeconds, outroSeconds, fadeInSeconds, fadeOutSeconds };
}

function urlResolved(track: TrackMetadata, startedAt: number) {
  log.info(
    {
      event: "url_resolved",
      sourceId: track.sourceId,
      title: track.title,
      artist: track.artist,
      durationSeconds: track.duration,
      durationMs: Date.now() - startedAt,
    },
    "Media URL resolved",
  );
  return track;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const asString = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const thumbnailUrl = (thumbnails: unknown) =>
  record(asArray(thumbnails).at(-1)).url;

function youtubeMusicTrack(
  videoId: string,
  fields: Omit<TrackMetadata, "sourceInput" | "canonicalUrl" | "sourceId">,
  sourceInput = `https://music.youtube.com/watch?v=${videoId}`,
): TrackMetadata {
  return {
    sourceInput,
    canonicalUrl: `https://music.youtube.com/watch?v=${videoId}`,
    sourceId: videoId,
    kind: "song",
    ...fields,
  };
}

function songMetadata(
  song: {
    videoId: string;
    name: string;
    artist: { name: string };
    album?: { name: string } | null;
    duration?: number | null;
    thumbnails: { url: string }[];
  },
  sourceInput?: string,
) {
  return youtubeMusicTrack(
    song.videoId,
    {
      title: song.name,
      artist: song.artist.name,
      album: song.album?.name,
      duration: song.duration ?? undefined,
      artwork: artworkUrl(song.thumbnails.at(-1)?.url),
    },
    sourceInput,
  );
}

// A song or video row from the home page or a playlist, accepting the
// runtime shapes ytmusic-api returns for either.
function homeSongMetadata(row: unknown): TrackMetadata[] {
  const { type, videoId, name, artist, album, duration, thumbnails } =
    record(row);
  if (type !== "SONG" && type !== "VIDEO") return [];
  if (typeof videoId !== "string" || !isYoutubeVideoId(videoId)) return [];
  if (typeof name !== "string" || !name.trim()) return [];
  return [
    youtubeMusicTrack(videoId, {
      title: name,
      artist: artistName(artist) ?? "Unknown artist",
      album: asString(record(album).name),
      duration: parseDuration(duration),
      artwork: artworkUrl(thumbnailUrl(thumbnails)),
    }),
  ];
}

function artistName(value: unknown): string | undefined {
  if (Array.isArray(value))
    return value.map(artistName).filter(Boolean).join(", ") || undefined;
  return (asString(value) ?? asString(record(value).name))?.trim() || undefined;
}

// Seconds from a number, or a "h:mm:ss" / "m:ss" clock string.
function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !/^\d+(?::\d{1,2}){0,2}$/.test(value.trim()))
    return undefined;
  return value
    .trim()
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}

function artworkUrl(value: unknown) {
  if (!value) return;
  const artwork = String(value);
  try {
    const url = new URL(artwork);
    if (
      url.hostname === "googleusercontent.com" ||
      url.hostname.endsWith(".googleusercontent.com")
    )
      url.pathname = url.pathname.replace(/=w\d+-h\d+(?=-|$)/, "=w1200-h1200");
    return url.href;
  } catch {
    return artwork;
  }
}

// Artwork from arbitrary media pages is fetched by the media backend, so
// it must pass the same public-network check as the media URL itself.
export async function publicArtworkUrl(value: unknown) {
  const artwork = artworkUrl(value);
  if (!artwork) return;
  try {
    await assertPublicUrl(new URL(artwork));
    return artwork;
  } catch {
    return;
  }
}

const audioFilenamePattern =
  /\.(mp3|m4a|flac|wav|ogg|opus|aac|wma|aiff?|webm)$/i;

export function looksLikeFilenameTitle(
  title: string,
  url: string,
  sourceId?: string,
) {
  const trimmed = title.trim();
  if (!trimmed || trimmed === "Untitled") return true;
  if (audioFilenamePattern.test(trimmed)) return true;
  if (sourceId && trimmed === sourceId) return true;
  try {
    const base = decodeURIComponent(
      new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "",
    );
    if (!base) return false;
    const stem = base.replace(/\.[^.]+$/, "");
    return trimmed === base || trimmed === stem;
  } catch {
    return false;
  }
}

export function metadataLooksWeak(
  track: Pick<TrackMetadata, "title" | "artist" | "canonicalUrl" | "sourceId">,
) {
  return (
    track.artist === "Unknown artist" ||
    looksLikeFilenameTitle(track.title, track.canonicalUrl, track.sourceId)
  );
}

export function shouldRetainSourceForMetadata(
  track: Pick<
    TrackMetadata,
    "title" | "artist" | "canonicalUrl" | "sourceId" | "artwork"
  >,
) {
  return metadataLooksWeak(track) || !track.artwork;
}

export function shouldProbeEmbeddedMetadata(
  track: Pick<TrackMetadata, "title" | "artist" | "canonicalUrl" | "sourceId">,
  extractor: unknown,
) {
  return (
    String(extractor ?? "").toLowerCase() === "generic" ||
    metadataLooksWeak(track)
  );
}

function tagValue(tags: Record<string, string>, ...keys: string[]) {
  for (const key of keys) {
    const exact = tags[key]?.trim();
    if (exact) return exact;
  }
  const lower = new Map(
    Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const key of keys) {
    const value = lower.get(key.toLowerCase())?.trim();
    if (value) return value;
  }
}

export function applyEmbeddedMetadata<T extends TrackMetadata>(
  track: T,
  embedded: EmbeddedMetadata,
): T {
  const titleWeak = looksLikeFilenameTitle(
    track.title,
    track.canonicalUrl,
    track.sourceId,
  );
  const artistWeak = track.artist === "Unknown artist";
  if (titleWeak && embedded.title) track.title = embedded.title;
  if (artistWeak && embedded.artist) track.artist = embedded.artist;
  if (!track.album && embedded.album) track.album = embedded.album;
  if (
    !track.duration &&
    embedded.duration &&
    Number.isFinite(embedded.duration)
  )
    track.duration = embedded.duration;
  return track;
}

// FFmpeg tools reach remote inputs only through the public-network proxy, so
// the input must pass the same check as the media URL itself.
async function proxyArguments(
  input: string,
  proxyUrl: string | undefined,
  purpose: string,
) {
  const remoteUrl = parseHttpUrl(input);
  if (!remoteUrl) return [];
  await assertPublicUrl(remoteUrl);
  if (!proxyUrl) throw new Error(`Remote ${purpose} require a proxy`);
  return ["-http_proxy", proxyUrl];
}

export async function probeEmbeddedMetadata(
  input: string,
  signal?: AbortSignal,
  proxyUrl?: string,
): Promise<EmbeddedMetadata> {
  try {
    const result = await run(
      [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_entries",
        "format=duration:format_tags",
        "-analyzeduration",
        "10000000",
        "-probesize",
        "10000000",
        ...(await proxyArguments(input, proxyUrl, "metadata probes")),
        input,
      ],
      30_000,
      signal,
    );
    const data = JSON.parse(result.stdout) as {
      format?: { duration?: string; tags?: Record<string, string> };
    };
    const tags = data.format?.tags ?? {};
    const duration = Number(data.format?.duration);
    return {
      title: tagValue(tags, "title", "TITLE", "track"),
      artist: tagValue(
        tags,
        "artist",
        "ARTIST",
        "album_artist",
        "ALBUMARTIST",
        "albumartist",
      ),
      album: tagValue(tags, "album", "ALBUM"),
      ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    log.debug(
      { event: "embedded_metadata_probe_failed", input, err: error },
      "Could not read embedded media metadata",
    );
    return {};
  }
}

export async function extractEmbeddedArtwork(
  input: string,
  outputPath: string,
  signal?: AbortSignal,
  proxyUrl?: string,
) {
  try {
    await run(
      [
        "ffmpeg",
        "-hide_banner",
        "-y",
        ...(await proxyArguments(input, proxyUrl, "artwork extracts")),
        "-i",
        input,
        "-an",
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-fs",
        String(maxEmbeddedArtworkBytes),
        outputPath,
      ],
      30_000,
      signal,
    );
    if (!(await Bun.file(outputPath).exists())) return;
    // FFmpeg's -fs limit may be exceeded by a small amount while writing.
    const size = await Bun.file(outputPath).size;
    if (size <= 0 || size > maxEmbeddedArtworkBytes) {
      await rm(outputPath, { force: true });
      return;
    }
    return outputPath;
  } catch (error) {
    if (signal?.aborted) throw error;
    await rm(outputPath, { force: true }).catch(() => undefined);
    log.debug(
      { event: "embedded_artwork_extract_failed", input, err: error },
      "Could not extract embedded album artwork",
    );
  }
}

async function retainedSourcePath(opusPath: string) {
  const directory = dirname(opusPath);
  const fileName = basename(opusPath);
  const stem = fileName.replace(/\.[^.]+$/, "");
  const prefix = `${stem}.`;
  // The entry's video, and what goes with it, are not a source.
  const match = (await readdir(directory)).find(
    (name) =>
      name !== fileName &&
      name.startsWith(prefix) &&
      !name.startsWith(`${stem}.video.`) &&
      !name.startsWith(`${stem}.cover.`),
  );
  return match ? `${directory}/${match}` : undefined;
}

function option(label: string, value: string) {
  return {
    text: { type: "plain_text", text: label.slice(0, 75) },
    value,
  };
}

function parseHttpUrl(input: string) {
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return;
  }
}

/** One absolute HTTP(S) URL per line; blank lines and `#` comments are ignored. */
export function parseBulkLinkList(text: string) {
  const links: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (parseHttpUrl(line)) links.push(line);
    else invalid.push(line);
  }
  return { links, invalid };
}

function youtubeUrl(input: string) {
  const host = parseHttpUrl(input)?.hostname.toLowerCase();
  return Boolean(
    host &&
    (host === "youtu.be" ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com")),
  );
}

function youtubePlaylistId(url: URL) {
  const host = url.hostname.toLowerCase();
  if (
    host !== "youtu.be" &&
    host !== "youtube.com" &&
    !host.endsWith(".youtube.com")
  )
    return;
  const id = url.searchParams.get("list");
  return id?.match(/^[a-zA-Z0-9_-]+$/)?.[0];
}

// Navidrome public shares use a 10-character nanoid under `/share/{id}`.
// Stream and cover URLs reuse the encoded track tokens embedded in the share
// page as `/share/s/{token}` and `/share/img/{token}`.
export function navidromeShare(url?: URL) {
  if (!url) return;
  const match = url.pathname.match(
    /^(?<prefix>.*\/share)\/(?<id>[0-9A-Za-z]{10})(?:\/m3u)?\/?$/,
  );
  if (!match?.groups?.prefix || !match.groups.id) return;
  const { prefix, id } = match.groups;
  const pageUrl = new URL(url.href);
  pageUrl.pathname = `${prefix}/${id}`;
  pageUrl.search = "";
  pageUrl.hash = "";
  return {
    id,
    pageUrl,
    streamUrl(token: string) {
      const stream = new URL(pageUrl.href);
      stream.pathname = `${prefix}/s/${token}`;
      stream.search = "";
      stream.hash = "";
      return stream;
    },
    coverUrl(token: string) {
      const cover = new URL(pageUrl.href);
      cover.pathname = `${prefix}/img/${token}`;
      cover.search = "size=300&square=true";
      cover.hash = "";
      return cover;
    },
  };
}

export function parseNavidromeShareInfo(html: string) {
  const marker = "window.__SHARE_INFO__";
  const start = html.indexOf(marker);
  if (start < 0) return;
  const assignment = html.indexOf("=", start + marker.length);
  if (assignment < 0) return;
  const scriptEnd = html.indexOf("</script>", assignment);
  const raw = html
    .slice(assignment + 1, scriptEnd < 0 ? undefined : scriptEnd)
    .trim()
    .replace(/;+\s*$/, "");
  if (!raw || raw === "null" || raw === "undefined") return;
  try {
    let parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    if (!parsed || typeof parsed !== "object") return;
    const { id, description, tracks } = record(parsed);
    if (!Array.isArray(tracks)) return;
    return {
      id: asString(id),
      description: asString(description),
      tracks: tracks.flatMap((track) => {
        const { id, title, artist, album, duration } = record(track);
        if (typeof id !== "string" || !id) return [];
        return [
          {
            id,
            title: asString(title),
            artist: asString(artist),
            album: asString(album),
            duration:
              typeof duration === "number"
                ? duration
                : typeof duration === "string" && duration.trim()
                  ? Number(duration)
                  : undefined,
          },
        ];
      }),
    };
  } catch {
    return;
  }
}

async function runJson(command: string[]) {
  const { stdout } = await run(command, 30_000);
  return JSON.parse(stdout);
}

// YouTube's bot check is passing: the same request a moment later mostly gets
// through, so an extraction it stops is tried again before it fails.
const botCheckRetries = 2;
const botCheckPause = 1_500;

async function run(command: string[], timeout: number, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(command, timeout, signal);
    } catch (error) {
      if (
        signal?.aborted ||
        command[0] !== "yt-dlp" ||
        attempt >= botCheckRetries ||
        !isBotCheck(error)
      )
        throw error;
      log.warn(
        { event: "bot_check_retry", attempt: attempt + 1 },
        "Retrying extraction after YouTube's bot check",
      );
      await Bun.sleep(botCheckPause * (attempt + 1));
    }
  }
}

export function isBotCheck(error: unknown) {
  return /not a bot/i.test(trackFailureDetail(error) ?? "");
}

async function runOnce(
  command: string[],
  timeout: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new TrackError("Track preparation cancelled");
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => process.kill(), timeout);
  const abort = () => process.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  clearTimeout(timer);
  signal?.removeEventListener("abort", abort);
  if (signal?.aborted) throw new TrackError("Track preparation cancelled");
  if (code) throw extractorFailure(stderr);
  return { stdout, stderr };
}
