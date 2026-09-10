import YTMusic from "ytmusic-api";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { logger } from "./logger.ts";
import { assertPublicUrl, PublicNetworkProxy } from "./public-proxy.ts";

const log = logger.child({ component: "tracks" });
const maxEmbeddedArtworkBytes = 5 * 1024 * 1024;

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
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
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

export const loudnessNormalizationArgs = (enabled = false) =>
  enabled
    ? [
        "--postprocessor-args",
        "ffmpeg:-c:a libopus -af loudnorm=I=-14:LRA=11:TP=-1",
      ]
    : [];

export function isYoutubeVideoId(id: string) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

export function normalizeToken(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeArtist(value: string) {
  return normalizeToken(value);
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
};

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
  private command: string[];
  private proxy?: PublicNetworkProxy;
  private activePreparations = 0;
  private transitions = new Map<string, TransitionData>();
  private preparationQueue: {
    priority: number;
    run: () => Promise<string>;
    resolve: (path: string) => void;
    reject: (error: unknown) => void;
  }[] = [];

  constructor(
    private limits: {
      durationSeconds: number;
      downloadBytes: number;
      loudnessNormalization?: boolean;
    },
  ) {
    this.command = ["yt-dlp", "--force-ipv4"];
  }

  async initialize() {
    const startedAt = Date.now();
    log.info({ event: "initialization_started" }, "Initializing track catalog");
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
    await this.proxy?.close();
    this.proxy = undefined;
    log.info({ event: "closed" }, "Track catalog closed");
  }

  async suggestions(query: string, allowed = { songs: true, bulk: false }) {
    const startedAt = Date.now();
    const url = parseHttpUrl(query);
    if (url) {
      await assertPublicUrl(url);
      const share = navidromeShare(url);
      if (share) {
        const options = [
          ...(allowed.songs
            ? [
                option(
                  `Link: ${share.pageUrl.href}`,
                  this.remember(share.pageUrl.href),
                ),
              ]
            : []),
          ...(allowed.bulk
            ? [
                option(
                  `Add share: ${share.pageUrl.href}`,
                  this.remember({
                    type: "navidrome-share",
                    url: share.pageUrl.href,
                  }),
                ),
              ]
            : []),
        ];
        log.debug(
          {
            event: "suggestions_completed",
            inputType: "navidrome_share_url",
            count: options.length,
            durationMs: Date.now() - startedAt,
          },
          "Track suggestions completed",
        );
        return options;
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
      if (!allowed.songs || url.pathname.replace(/\/$/, "") === "/playlist") {
        log.debug(
          {
            event: "suggestions_completed",
            inputType: "playlist_url",
            count: playlist.length,
            durationMs: Date.now() - startedAt,
          },
          "Track suggestions completed",
        );
        return playlist;
      }
      const reference = this.remember(url.href);
      const options = [option(`Link: ${url.href}`, reference), ...playlist];
      log.debug(
        {
          event: "suggestions_completed",
          inputType: "url",
          count: options.length,
          durationMs: Date.now() - startedAt,
        },
        "Track suggestions completed",
      );
      return options;
    }
    const [songs, albums] = await Promise.all([
      allowed.songs ? this.music.searchSongs(query) : [],
      allowed.bulk ? this.music.searchAlbums(query) : [],
    ]);
    const options = [
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
    ];
    log.debug(
      {
        event: "suggestions_completed",
        inputType: "search",
        count: options.length,
        songsAllowed: allowed.songs,
        bulkAllowed: allowed.bulk,
        durationMs: Date.now() - startedAt,
      },
      "Track suggestions completed",
    );
    return options;
  }

  async resolve(reference: string): Promise<TrackMetadata | TrackMetadata[]> {
    const startedAt = Date.now();
    const stored = this.references.get(reference);
    if (!stored) throw new TrackError("Track selection expired; search again");
    if (typeof stored === "object" && "type" in stored) {
      const tracks =
        stored.type === "album"
          ? (await this.music.getAlbum(stored.id)).songs.map((song) =>
              songMetadata(song),
            )
          : stored.type === "navidrome-share"
            ? await this.resolveNavidromeShare(stored.url)
            : (await this.music.getPlaylistVideos(stored.id)).map((song) =>
                songMetadata(song, stored.url),
              );
      if (!tracks.length)
        throw new TrackError("That album or playlist has no playable songs");
      for (const track of tracks) this.validate(track);
      this.references.delete(reference);
      log.info(
        {
          event: "collection_resolved",
          collectionType: stored.type,
          count: tracks.length,
          durationMs: Date.now() - startedAt,
        },
        "Track collection resolved",
      );
      return tracks;
    }
    if (typeof stored !== "string") {
      this.validate(stored);
      this.references.delete(reference);
      return stored;
    }
    const share = navidromeShare(parseHttpUrl(stored));
    if (share) {
      const tracks = await this.resolveNavidromeShare(stored);
      if (!tracks.length)
        throw new TrackError("That album or playlist has no playable songs");
      for (const track of tracks) this.validate(track);
      this.references.delete(reference);
      log.info(
        {
          event: "collection_resolved",
          collectionType: "navidrome-share",
          count: tracks.length,
          durationMs: Date.now() - startedAt,
        },
        "Track collection resolved",
      );
      return tracks.length === 1 ? tracks[0]! : tracks;
    }
    const track = await this.resolveUrl(stored);
    this.references.delete(reference);
    return track;
  }

  async resolveUrl(input: string): Promise<TrackMetadata> {
    const startedAt = Date.now();
    const url = parseHttpUrl(input);
    if (!url)
      throw new TrackError("Only absolute HTTP or HTTPS URLs are supported");
    await assertPublicUrl(url);
    const share = navidromeShare(url);
    if (share) {
      const tracks = await this.resolveNavidromeShare(url.href);
      if (!tracks.length)
        throw new TrackError("That album or playlist has no playable songs");
      if (tracks.length > 1)
        throw new TrackError("Playlists are not supported");
      this.validate(tracks[0]!);
      log.info(
        {
          event: "url_resolved",
          sourceId: tracks[0]!.sourceId,
          title: tracks[0]!.title,
          artist: tracks[0]!.artist,
          durationSeconds: tracks[0]!.duration,
          durationMs: Date.now() - startedAt,
        },
        "Media URL resolved",
      );
      return tracks[0]!;
    }
    const metadata = await runJson([
      ...this.extractor(),
      "--dump-single-json",
      "--skip-download",
      "--no-playlist",
      "--socket-timeout",
      "10",
      "--",
      url.href,
    ]);
    if (metadata._type === "playlist" || metadata.entries)
      throw new TrackError("Playlists are not supported");
    if (metadata.is_live || metadata.live_status === "is_live")
      throw new TrackError("Live streams are not supported");
    if (
      (metadata.filesize ?? metadata.filesize_approx ?? 0) >
      this.limits.downloadBytes
    )
      throw new TrackError("Track exceeds the download limit");
    const canonicalUrl = metadata.webpage_url ?? url.href;
    await assertPublicUrl(new URL(canonicalUrl));
    let track: TrackMetadata = {
      sourceInput: url.href,
      canonicalUrl,
      sourceId: String(metadata.id),
      title: String(metadata.title ?? "Untitled"),
      artist: String(metadata.artist ?? metadata.uploader ?? "Unknown artist"),
      album: metadata.album ? String(metadata.album) : undefined,
      duration: metadata.duration ? Number(metadata.duration) : undefined,
      artwork: await publicArtworkUrl(metadata.thumbnail),
    };
    // Direct files and other generic sources often only expose the filename
    // through yt-dlp; prefer embedded tags when the extractor metadata is thin.
    if (shouldProbeEmbeddedMetadata(track, metadata.extractor)) {
      if (!this.proxy) throw new Error("Track catalog is not initialized");
      track = applyEmbeddedMetadata(
        track,
        await probeEmbeddedMetadata(canonicalUrl, undefined, this.proxy.url),
      );
    }
    if (track.duration && track.duration > this.limits.durationSeconds)
      throw new TrackError("Track exceeds the duration limit");
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

  async upNextIds(videoId: string) {
    return (await this.upNextTracks(videoId)).map((track) => track.sourceId);
  }

  async upNextTracks(videoId: string): Promise<TrackMetadata[]> {
    const results: unknown = await this.music.getUpNexts(videoId);
    if (!Array.isArray(results)) return [];
    return results.flatMap((result) => {
      if (!result || typeof result !== "object") return [];
      const row = result as {
        videoId?: unknown;
        title?: unknown;
        artists?: { name?: unknown };
        duration?: unknown;
        thumbnails?: { url?: string }[];
      };
      const id = row.videoId;
      if (typeof id !== "string" || !isYoutubeVideoId(id)) return [];
      const title = typeof row.title === "string" ? row.title : "Untitled";
      const artist =
        typeof row.artists?.name === "string"
          ? row.artists.name
          : "Unknown artist";
      return [
        {
          sourceInput: `https://music.youtube.com/watch?v=${id}`,
          canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
          sourceId: id,
          title,
          artist,
          duration: typeof row.duration === "number" ? row.duration : undefined,
          artwork: artworkUrl(row.thumbnails?.at(-1)?.url),
        } satisfies TrackMetadata,
      ];
    });
  }

  async searchSong(title: string, artist: string) {
    const query = `${title} ${artist}`.trim();
    if (!query) return;
    const songs = await this.music.searchSongs(query);
    if (!Array.isArray(songs) || !songs.length) return;
    const needle = normalizeArtist(artist);
    const match =
      songs.find((song) => {
        const name = normalizeArtist(song.artist?.name ?? "");
        return name && (name.includes(needle) || needle.includes(name));
      }) ?? songs[0];
    if (!match?.videoId || !isYoutubeVideoId(match.videoId)) return;
    return songMetadata(match);
  }

  resolveVideoId(videoId: string) {
    if (!isYoutubeVideoId(videoId))
      throw new Error("Invalid YouTube Music video ID");
    return this.resolveUrl(`https://music.youtube.com/watch?v=${videoId}`);
  }

  private async resolveNavidromeShare(input: string) {
    const startedAt = Date.now();
    const url = parseHttpUrl(input);
    const share = navidromeShare(url);
    if (!url || !share)
      throw new TrackError("Only absolute HTTP or HTTPS URLs are supported");
    await assertPublicUrl(share.pageUrl);
    if (!this.proxy) throw new Error("Track catalog is not initialized");
    const response = await fetch(share.pageUrl.href, {
      proxy: this.proxy.url,
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
      if (!track.id) continue;
      const stream = share.streamUrl(track.id);
      const artwork = share.coverUrl(track.id);
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
            ? Number(track.duration)
            : undefined,
        artwork: await publicArtworkUrl(artwork.href),
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

  private validate(track: TrackMetadata) {
    if (track.duration && track.duration > this.limits.durationSeconds)
      throw new TrackError("Track exceeds the duration limit");
  }

  async prepare(
    track: TrackMetadata,
    directory: string,
    entryId: string,
    signal?: AbortSignal,
    priority = 0,
  ) {
    return new Promise<string>((resolve, reject) => {
      this.preparationQueue.push({
        priority,
        run: () => this.download(track, directory, entryId, signal),
        resolve,
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

  private async download(
    track: TrackMetadata,
    directory: string,
    entryId: string,
    signal?: AbortSignal,
  ) {
    const startedAt = Date.now();
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
      ...loudnessNormalizationArgs(this.limits.loudnessNormalization),
      "--no-playlist",
      "--max-filesize",
      String(this.limits.downloadBytes),
      "--print",
      "after_move:filepath",
      "--output",
      path,
      "--",
      track.canonicalUrl,
    ];
    let result;
    try {
      result = await run([...this.extractor(), ...download], 180_000, signal);
    } catch (error) {
      // The thrown message is classified, so match the raw extractor line.
      const detail = trackFailureDetail(error) ?? String(error);
      if (signal?.aborted || !detail.includes("HTTP Error 403")) throw error;
      log.warn(
        { event: "download_retry", entryId, sourceId: track.sourceId },
        "Retrying track download with embedded player",
      );
      result = await run(
        [
          ...this.extractor(),
          "--extractor-args",
          "youtube:player_client=web_embedded",
          ...download,
        ],
        180_000,
        signal,
      );
    }
    const filePath = result.stdout.trim().split("\n").at(-1);
    if (!filePath || !(await Bun.file(filePath).exists()))
      throw new Error("Extractor produced no playable file");
    try {
      if (keepSource) {
        const sourcePath = await retainedSourcePath(filePath);
        if (sourcePath) {
          try {
            applyEmbeddedMetadata(
              track,
              await probeEmbeddedMetadata(sourcePath, signal),
            );
            if (!track.artwork) {
              await extractEmbeddedArtwork(
                sourcePath,
                embeddedArtworkPath(filePath),
                signal,
              );
            }
          } finally {
            await rm(sourcePath, { force: true });
          }
        }
      }
      const bytes = (await stat(filePath)).size;
      if (bytes > this.limits.downloadBytes)
        throw new TrackError("Track exceeds the download limit");
      const probe = await run(
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
      );
      const duration = Number(probe.stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("Could not verify the downloaded track duration");
      if (duration > this.limits.durationSeconds)
        throw new TrackError("Track exceeds the duration limit");
      if (!track.duration) track.duration = duration;
      let transition = {
        introSeconds: 0,
        outroSeconds: duration,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
      };
      try {
        const analysis = await run(
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
        );
        transition = transitionData(analysis.stderr, duration);
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn(
          { event: "transition_analysis_failed", entryId, err: error },
          "Using untrimmed track boundaries",
        );
      }
      this.transitions.set(filePath, transition);
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

  private startPreparations() {
    while (this.activePreparations < 2) {
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

  private extractor() {
    if (!this.proxy) throw new Error("Track catalog is not initialized");
    return [...this.command, "--proxy", this.proxy.url];
  }

  private remember(value: TrackMetadata | CollectionReference | string) {
    const reference = `${typeof value === "object" && "type" in value ? "bulk" : "track"}ref_${crypto.randomUUID()}`;
    this.references.set(reference, value);
    setTimeout(() => this.references.delete(reference), 10 * 60_000);
    return reference;
  }
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

function songMetadata(
  song: {
    videoId: string;
    name: string;
    artist: { name: string };
    album?: { name: string } | null;
    duration?: number | null;
    thumbnails: { url: string }[];
  },
  sourceInput = `https://music.youtube.com/watch?v=${song.videoId}`,
): TrackMetadata {
  return {
    sourceInput,
    canonicalUrl: `https://music.youtube.com/watch?v=${song.videoId}`,
    sourceId: song.videoId,
    title: song.name,
    artist: song.artist.name,
    album: song.album?.name,
    duration: song.duration ?? undefined,
    artwork: artworkUrl(song.thumbnails.at(-1)?.url),
  };
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

// Artwork from arbitrary media pages is fetched by the host-side browser, so
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

export async function probeEmbeddedMetadata(
  input: string,
  signal?: AbortSignal,
  proxyUrl?: string,
): Promise<EmbeddedMetadata> {
  try {
    const remoteUrl = parseHttpUrl(input);
    if (remoteUrl) {
      await assertPublicUrl(remoteUrl);
      if (!proxyUrl) throw new Error("Remote metadata probes require a proxy");
    }
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
        ...(remoteUrl ? ["-http_proxy", proxyUrl!] : []),
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
    const remoteUrl = parseHttpUrl(input);
    if (remoteUrl) {
      await assertPublicUrl(remoteUrl);
      if (!proxyUrl) throw new Error("Remote artwork extracts require a proxy");
    }
    await run(
      [
        "ffmpeg",
        "-hide_banner",
        "-y",
        ...(remoteUrl ? ["-http_proxy", proxyUrl!] : []),
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
  const slash = opusPath.lastIndexOf("/");
  const directory = slash >= 0 ? opusPath.slice(0, slash) : ".";
  const fileName = slash >= 0 ? opusPath.slice(slash + 1) : opusPath;
  const prefix = fileName.replace(/\.[^.]+$/, "");
  const match = (await readdir(directory)).find((name) => {
    if (name === fileName) return false;
    return name.startsWith(`${prefix}.`);
  });
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
    const tracks = (parsed as { tracks?: unknown }).tracks;
    if (!Array.isArray(tracks)) return;
    return {
      id:
        typeof (parsed as { id?: unknown }).id === "string"
          ? (parsed as { id: string }).id
          : undefined,
      description:
        typeof (parsed as { description?: unknown }).description === "string"
          ? (parsed as { description: string }).description
          : undefined,
      tracks: tracks.flatMap((track) => {
        if (!track || typeof track !== "object") return [];
        const value = track as {
          id?: unknown;
          title?: unknown;
          artist?: unknown;
          album?: unknown;
          duration?: unknown;
        };
        if (typeof value.id !== "string" || !value.id) return [];
        return [
          {
            id: value.id,
            title: typeof value.title === "string" ? value.title : undefined,
            artist: typeof value.artist === "string" ? value.artist : undefined,
            album: typeof value.album === "string" ? value.album : undefined,
            duration:
              typeof value.duration === "number"
                ? value.duration
                : typeof value.duration === "string" && value.duration.trim()
                  ? Number(value.duration)
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

async function run(command: string[], timeout: number, signal?: AbortSignal) {
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
