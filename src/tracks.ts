import YTMusic from "ytmusic-api";
import { mkdir, rm, stat } from "node:fs/promises";
import { logger } from "./logger.ts";
import { assertPublicUrl, PublicNetworkProxy } from "./public-proxy.ts";

const log = logger.child({ component: "tracks" });

export const loudnessNormalizationArgs = (enabled = true) =>
  enabled
    ? ["--postprocessor-args", "ffmpeg:-af loudnorm=I=-14:LRA=11:TP=-1"]
    : [];

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

type CollectionReference =
  { type: "album"; id: string } | { type: "playlist"; id: string; url: string };

export class TrackCatalog {
  private music = new YTMusic();
  private references = new Map<
    string,
    TrackMetadata | CollectionReference | string
  >();
  private command: string[];
  private proxy?: PublicNetworkProxy;
  private activePreparations = 0;
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
    this.references.delete(reference);
    if (!stored) throw new Error("Track selection expired; search again");
    if (typeof stored === "object" && "type" in stored) {
      const tracks =
        stored.type === "album"
          ? (await this.music.getAlbum(stored.id)).songs.map((song) =>
              songMetadata(song),
            )
          : (await this.music.getPlaylistVideos(stored.id)).map((song) =>
              songMetadata(song, stored.url),
            );
      if (!tracks.length)
        throw new Error("That album or playlist has no playable songs");
      for (const track of tracks) this.validate(track);
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
      return stored;
    }
    return this.resolveUrl(stored);
  }

  async resolveUrl(input: string): Promise<TrackMetadata> {
    const startedAt = Date.now();
    const url = parseHttpUrl(input);
    if (!url) throw new Error("Only absolute HTTP or HTTPS URLs are supported");
    await assertPublicUrl(url);
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
      throw new Error("Playlists are not supported");
    if (metadata.is_live || metadata.live_status === "is_live")
      throw new Error("Live streams are not supported");
    if (metadata.duration && metadata.duration > this.limits.durationSeconds)
      throw new Error("Track exceeds the duration limit");
    if (
      (metadata.filesize ?? metadata.filesize_approx ?? 0) >
      this.limits.downloadBytes
    )
      throw new Error("Track exceeds the download limit");
    const canonicalUrl = metadata.webpage_url ?? url.href;
    await assertPublicUrl(new URL(canonicalUrl));
    const track = {
      sourceInput: url.href,
      canonicalUrl,
      sourceId: String(metadata.id),
      title: String(metadata.title ?? "Untitled"),
      artist: String(metadata.artist ?? metadata.uploader ?? "Unknown artist"),
      album: metadata.album ? String(metadata.album) : undefined,
      duration: metadata.duration ? Number(metadata.duration) : undefined,
      artwork: artworkUrl(metadata.thumbnail),
    };
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
    const results: unknown = await this.music.getUpNexts(videoId);
    if (!Array.isArray(results)) return [];
    return results.flatMap((result) => {
      if (!result || typeof result !== "object") return [];
      const id = (result as { videoId?: unknown }).videoId;
      return typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id)
        ? [id]
        : [];
    });
  }

  resolveVideoId(videoId: string) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId))
      throw new Error("Invalid YouTube Music video ID");
    return this.resolveUrl(`https://music.youtube.com/watch?v=${videoId}`);
  }

  private validate(track: TrackMetadata) {
    if (track.duration && track.duration > this.limits.durationSeconds)
      throw new Error("Track exceeds the duration limit");
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
    if (signal?.aborted) throw new Error("Track preparation cancelled");
    await mkdir(directory, { recursive: true });
    if (signal?.aborted) throw new Error("Track preparation cancelled");
    const path = `${directory}/${entryId}.%(ext)s`;
    const download = [
      "--extract-audio",
      "--audio-format",
      "opus",
      "--audio-quality",
      "0",
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
      if (signal?.aborted || !String(error).includes("HTTP Error 403"))
        throw error;
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
      const bytes = (await stat(filePath)).size;
      if (bytes > this.limits.downloadBytes)
        throw new Error("Track exceeds the download limit");
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
        throw new Error("Track exceeds the duration limit");
      log.info(
        {
          event: "download_completed",
          entryId,
          sourceId: track.sourceId,
          bytes,
          durationSeconds: duration,
          durationMs: Date.now() - startedAt,
        },
        "Track download completed",
      );
      return filePath;
    } catch (error) {
      await rm(filePath, { force: true });
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

async function runJson(command: string[]) {
  const { stdout } = await run(command, 30_000);
  return JSON.parse(stdout);
}

async function run(command: string[], timeout: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Track preparation cancelled");
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
  if (signal?.aborted) throw new Error("Track preparation cancelled");
  if (code)
    throw new Error(stderr.trim().split("\n").at(-1) ?? "Extractor failed");
  return { stdout, stderr };
}
