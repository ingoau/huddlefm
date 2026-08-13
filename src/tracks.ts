import YTMusic from "ytmusic-api";
import { mkdir, rm, stat } from "node:fs/promises";
import { assertPublicUrl, PublicNetworkProxy } from "./public-proxy.ts";

export { assertPublicUrl } from "./public-proxy.ts";

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

export class TrackCatalog {
  private music = new YTMusic();
  private references = new Map<string, TrackMetadata | string>();
  private command: string[];
  private proxy?: PublicNetworkProxy;

  constructor(
    private limits: { durationSeconds: number; downloadBytes: number; chromePath: string },
  ) {
    this.command = [
      "uvx", "--python", "3.13", "--from", "yt-dlp", "--with",
      "yt-dlp-getpot-wpc", "yt-dlp", "--remote-components", "ejs:github",
      "--extractor-args",
      `youtube:player_client=mweb;youtubepot-wpc:browser_path=${limits.chromePath}`,
    ];
  }

  async initialize() {
    this.proxy = await PublicNetworkProxy.start();
    try {
      await this.music.initialize();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    await this.proxy?.close();
    this.proxy = undefined;
  }

  async suggestions(query: string) {
    const url = parseHttpUrl(query);
    if (url) {
      await assertPublicUrl(url);
      const reference = this.remember(url.href);
      return [option(`Use this link: ${url.href}`, reference)];
    }
    const songs = (await this.music.searchSongs(query)).slice(0, 5);
    return songs.map(song => {
      const metadata = {
        sourceInput: `https://music.youtube.com/watch?v=${song.videoId}`,
        canonicalUrl: `https://music.youtube.com/watch?v=${song.videoId}`,
        sourceId: song.videoId,
        title: song.name,
        artist: song.artist.name,
        album: song.album?.name,
        duration: song.duration ?? undefined,
        artwork: song.thumbnails.at(-1)?.url,
      };
      return option(
        `${song.name} — ${song.artist.name}${song.album ? ` · ${song.album.name}` : ""}`,
        this.remember(metadata),
      );
    });
  }

  async resolve(reference: string) {
    const stored = this.references.get(reference);
    this.references.delete(reference);
    if (!stored) throw new Error("Track selection expired; search again");
    const input = typeof stored === "string" ? stored : stored.canonicalUrl;
    const resolved = await this.resolveUrl(input);
    return {
      ...resolved,
      sourceInput: typeof stored === "string" ? stored : stored.sourceInput,
      album: resolved.album ?? (typeof stored === "string" ? undefined : stored.album),
      artwork:
        resolved.artwork ?? (typeof stored === "string" ? undefined : stored.artwork),
    };
  }

  async resolveUrl(input: string): Promise<TrackMetadata> {
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
    return {
      sourceInput: url.href,
      canonicalUrl,
      sourceId: String(metadata.id),
      title: String(metadata.title ?? "Untitled"),
      artist: String(metadata.artist ?? metadata.uploader ?? "Unknown artist"),
      album: metadata.album ? String(metadata.album) : undefined,
      duration: metadata.duration ? Number(metadata.duration) : undefined,
      artwork: metadata.thumbnail ? String(metadata.thumbnail) : undefined,
    };
  }

  async prepare(track: TrackMetadata, directory: string, entryId: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Track preparation cancelled");
    await mkdir(directory, { recursive: true });
    if (signal?.aborted) throw new Error("Track preparation cancelled");
    const path = `${directory}/${entryId}.%(ext)s`;
    const result = await run([
      ...this.extractor(),
      "--extract-audio",
      "--audio-format",
      "opus",
      "--audio-quality",
      "0",
      "--no-playlist",
      "--max-filesize",
      String(this.limits.downloadBytes),
      "--print",
      "after_move:filepath",
      "--output",
      path,
      "--",
      track.canonicalUrl,
    ], 180_000, signal);
    const filePath = result.stdout.trim().split("\n").at(-1);
    if (!filePath || !(await Bun.file(filePath).exists()))
      throw new Error("Extractor produced no playable file");
    try {
      if ((await stat(filePath)).size > this.limits.downloadBytes)
        throw new Error("Track exceeds the download limit");
      const probe = await run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", filePath,
      ], 15_000, signal);
      const duration = Number(probe.stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("Could not verify the downloaded track duration");
      if (duration > this.limits.durationSeconds)
        throw new Error("Track exceeds the duration limit");
      return filePath;
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }
  }

  private extractor() {
    if (!this.proxy) throw new Error("Track catalog is not initialized");
    return [...this.command, "--proxy", this.proxy.url];
  }

  private remember(value: TrackMetadata | string) {
    const reference = `trackref_${crypto.randomUUID()}`;
    this.references.set(reference, value);
    setTimeout(() => this.references.delete(reference), 10 * 60_000);
    return reference;
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
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return;
  }
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
  if (code) throw new Error(stderr.trim().split("\n").at(-1) ?? "Extractor failed");
  return { stdout, stderr };
}
