// What video mode needs to know about videos that is not about playing them:
// their titles, chapters and captions, which song a music video belongs to,
// and YouTube's own search results.
import { readFile } from "node:fs/promises";
import { firstArtist } from "./artist.ts";

/** A point in a video someone can jump to. */
export type Chapter = { start: number; title: string };

/** Captions burned into a prepared video, next to it. */
export function captionsPath(mediaPath: string) {
  return mediaPath.replace(/\.[^.]+$/, ".captions.srt");
}

/** A prepared video's chapters, next to it. */
export function chaptersPath(mediaPath: string) {
  return mediaPath.replace(/\.[^.]+$/, ".chapters.json");
}

/** The chapters saved with a prepared video, or none. */
export async function readChapters(mediaPath: string): Promise<Chapter[]> {
  try {
    return validChapters(
      JSON.parse(await readFile(chaptersPath(mediaPath), "utf8")),
    );
  } catch {
    return [];
  }
}

export function validChapters(value: unknown): Chapter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const { start, title } = (item ?? {}) as Record<string, unknown>;
    return typeof start === "number" &&
      Number.isFinite(start) &&
      start >= 0 &&
      typeof title === "string" &&
      title.trim()
      ? [{ start, title: title.trim() }]
      : [];
  });
}

/** Chapters from yt-dlp's metadata, in order. */
export function chaptersFrom(metadata: Record<string, unknown>) {
  const chapters = validChapters(
    (Array.isArray(metadata.chapters) ? metadata.chapters : []).map(
      (chapter: Record<string, unknown>) => ({
        start: Number(chapter?.start_time),
        title: String(chapter?.title ?? ""),
      }),
    ),
  ).sort((a, b) => a.start - b.start);
  // One chapter is no more than the video itself.
  return chapters.length > 1 ? chapters : [];
}

const ellipsis = "…";

/**
 * Text cut to `length` characters at a word boundary, with an ellipsis, so a
 * long title does not stop partway through a word.
 */
export function shorten(text: string, length: number) {
  const characters = [...text.trim()];
  if (characters.length <= length) return text.trim();
  const cut = characters.slice(0, Math.max(1, length - 1)).join("");
  // Where the cut already falls between words, the last word is whole.
  const between = /\s/.test(characters[length - 1] ?? "");
  const space = cut.search(/\s\S*$/);
  // A single long word is cut where it has to be.
  const kept = between || space <= length / 2 ? cut : cut.slice(0, space);
  return `${kept.replace(/[\s\p{P}]+$/u, "")}${ellipsis}`;
}

/**
 * A video's title tidied for showing: trailing hashtags and a trailing
 * "| Channel" that repeats the channel go, and runs of whitespace collapse.
 * Everything else, emoji included, is the title.
 */
export function cleanVideoTitle(title: string, channel?: string) {
  let cleaned = title.replace(/\s+/g, " ").trim();
  // Hashtags at the end: "Clip #shorts #fyp".
  cleaned = cleaned.replace(/(?:\s*#[\p{L}\p{N}_]+)+$/u, "").trim();
  if (channel?.trim()) {
    const name = channel.trim().toLowerCase();
    const parts = cleaned.split(/\s+\|\s+/);
    if (parts.length > 1 && parts.at(-1)!.trim().toLowerCase() === name)
      cleaned = parts.slice(0, -1).join(" | ").trim();
  }
  return cleaned || title.trim();
}

/**
 * Whether a link is to a YouTube video, as opposed to a song on YouTube
 * Music or anything else.
 */
export function isVideoLink(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (host === "youtu.be") return /^\/[\w-]{11}/.test(url.pathname);
  if (host !== "youtube.com") return false;
  return (
    (url.pathname === "/watch" &&
      /^[\w-]{11}$/.test(url.searchParams.get("v") ?? "")) ||
    /^\/(shorts|live|embed)\/[\w-]{11}/.test(url.pathname)
  );
}

/** Seconds from "42:10", "1:23:45" or "90", or undefined. */
export function parseClock(value: string) {
  const text = value.trim();
  if (!/^\d+(?::\d{1,2}){0,2}$/.test(text)) return undefined;
  const parts = text.split(":").map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return undefined;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** "4:05" or "1:02:03". */
export function formatClock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

/** "1 hour", "90 minutes", "1 hour 30 minutes". */
export function formatLimit(seconds: number) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const unit = (count: number, name: string) =>
    `${count} ${name}${count === 1 ? "" : "s"}`;
  if (!hours) return unit(Math.max(1, minutes), "minute");
  return rest
    ? `${unit(hours, "hour")} ${unit(rest, "minute")}`
    : unit(hours, "hour");
}

type SubtitleTrack = { url: string; ext?: string };

/**
 * Which captions a video gets, from yt-dlp's metadata: subtitles uploaded
 * with it before YouTube's automatic ones, and English before the video's own
 * language. Only WebVTT is taken, since every YouTube video offers it.
 */
export function pickSubtitles(metadata: Record<string, unknown>) {
  const manual = tracksOf(metadata.subtitles);
  const automatic = tracksOf(metadata.automatic_captions);
  const language =
    typeof metadata.language === "string"
      ? metadata.language.toLowerCase()
      : undefined;
  const english = (code: string) => code === "en" || code.startsWith("en-");
  const original = (code: string) =>
    Boolean(language) && (code === language || code.startsWith(`${language}-`));
  const candidates: [
    Map<string, SubtitleTrack[]>,
    (code: string) => boolean,
  ][] = [
    [manual, english],
    [automatic, (code) => code === "en-orig"],
    [automatic, (code) => code === "en"],
    [manual, original],
    [automatic, (code) => code === `${language}-orig`],
    [automatic, original],
    [automatic, (code) => code.endsWith("-orig")],
  ];
  for (const [tracks, wanted] of candidates)
    for (const [code, formats] of tracks) {
      if (!wanted(code) || code === "live_chat") continue;
      const vtt = formats.find((format) => format.ext === "vtt");
      if (vtt) return { language: code, url: vtt.url };
    }
}

function tracksOf(value: unknown) {
  const tracks = new Map<string, SubtitleTrack[]>();
  if (!value || typeof value !== "object") return tracks;
  for (const [code, formats] of Object.entries(value)) {
    if (!Array.isArray(formats)) continue;
    const usable = formats.filter(
      (format): format is SubtitleTrack =>
        typeof format?.url === "string" && /^https?:\/\//.test(format.url),
    );
    if (usable.length) tracks.set(code.toLowerCase(), usable);
  }
  return tracks;
}

function vttTime(value: string) {
  const match = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/);
  if (!match) return undefined;
  const [, hours, minutes, seconds, millis] = match;
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(millis) / 1000
  );
}

function srtTime(seconds: number) {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(millis / 3_600_000))}:${pad(Math.floor(millis / 60_000) % 60)}:${pad(Math.floor(millis / 1000) % 60)},${pad(millis % 1000, 3)}`;
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * WebVTT to SRT for the subtitles filter, at most two lines a caption.
 * YouTube's automatic captions roll: each cue repeats the line before it and
 * flashes for a moment between, so repeated lines and instant cues go.
 */
export function vttToSrt(vtt: string) {
  const cues: { start: number; end: number; lines: string[] }[] = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const [from, to] = lines[timing]!.split("-->").map(
      (part) => part.trim().split(/\s+/)[0]!,
    );
    const start = vttTime(from ?? "");
    const end = vttTime(to ?? "");
    if (start === undefined || end === undefined || end - start < 0.05)
      continue;
    const text = lines
      .slice(timing + 1)
      .map((line) =>
        line
          .replace(/<[^>]*>/g, "")
          .replace(/&(\w+);/g, (match, name: string) => entities[name] ?? match)
          .replace(/[{}]/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean);
    if (text.length) cues.push({ start, end, lines: text });
  }
  const out: { start: number; end: number; lines: string[] }[] = [];
  let previous: string[] = [];
  for (const cue of cues) {
    const lines = cue.lines.filter((line) => !previous.includes(line));
    previous = cue.lines;
    if (!lines.length) continue;
    const last = out.at(-1);
    const shown = lines.slice(-2);
    if (
      last &&
      last.lines.join("\n") === shown.join("\n") &&
      cue.start - last.end < 0.1
    ) {
      last.end = cue.end;
      continue;
    }
    // Rolling captions overlap; each one ends when the next starts.
    if (last && last.end > cue.start) last.end = cue.start;
    out.push({ start: cue.start, end: cue.end, lines: shown });
  }
  return out
    .filter((cue) => cue.end - cue.start >= 0.05)
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.lines.join("\n")}\n`,
    )
    .join("\n");
}

/** Words in a video's title that make it something other than the song. */
const notTheSong =
  /\b(lyrics?|letra|live|cover|karaoke|sped\s*up|slowed|reverb|nightcore|8d|remix|instrumental|reaction|fan\s*made|visuali[sz]er|audio|tutorial|lesson|loop|hours?|extended|subtitulado|parody|teaser|trailer|shorts?|acoustic|piano|guitar|drum|bass\s*boosted)\b/i;

function fold(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A song's title without versions and features: "Song (Remastered)". */
export function coreTitle(title: string) {
  const core = title
    .replace(/\s*[([].*?[)\]]/g, "")
    .replace(/\s+-\s+.*$/, "")
    .trim();
  return core || title.trim();
}

export type VideoCandidate = {
  videoId: string;
  title: string;
  artist: string;
  duration?: number;
};

/**
 * The official video for a song, if one of the candidates surely is: by the
 * song's artist, named after the song, about as long, and not a lyric video,
 * live take, cover or edit. Search order is kept, since the official video
 * usually comes first.
 */
export function musicVideoMatch(
  song: { sourceId: string; title: string; artist: string; duration?: number },
  candidates: VideoCandidate[],
) {
  const title = fold(coreTitle(song.title));
  const artist = fold(firstArtist(song.artist));
  if (!title || !artist) return undefined;
  const songWords = new Set(
    [...song.title.matchAll(new RegExp(notTheSong, "gi"))].map((match) =>
      match[0].toLowerCase(),
    ),
  );
  return candidates.find((video) => {
    if (video.videoId === song.sourceId) return false;
    const videoTitle = fold(video.title);
    const videoArtist = fold(video.artist);
    const byArtist =
      Boolean(videoArtist) &&
      (videoArtist.includes(artist) || artist.includes(videoArtist));
    if (!byArtist || !videoTitle.includes(title)) return false;
    const extra = [...video.title.matchAll(new RegExp(notTheSong, "gi"))].some(
      (match) => !songWords.has(match[0].toLowerCase()),
    );
    if (extra) return false;
    if (song.duration && video.duration)
      return (
        video.duration >= song.duration - 15 &&
        video.duration <= song.duration + 180
      );
    return true;
  });
}

export type SearchedVideo = {
  videoId: string;
  title: string;
  channel: string;
  duration?: number;
  thumbnail?: string;
};

const runsText = (value: unknown) => {
  const node = (value ?? {}) as {
    simpleText?: unknown;
    runs?: { text?: unknown }[];
  };
  if (typeof node.simpleText === "string") return node.simpleText;
  return Array.isArray(node.runs)
    ? node.runs.map((run) => String(run?.text ?? "")).join("")
    : "";
};

/**
 * The videos in a YouTube web search response, leaving out live streams,
 * members-only videos and anything that is not a plain video.
 */
export function parseYouTubeSearch(response: unknown): SearchedVideo[] {
  const videos: SearchedVideo[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const renderer = (node as Record<string, unknown>).videoRenderer as
      Record<string, unknown> | undefined;
    if (renderer) {
      const video = searchedVideo(renderer);
      if (video) videos.push(video);
      return;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(response);
  return videos.filter(
    (video, index) =>
      videos.findIndex((other) => other.videoId === video.videoId) === index,
  );
}

function searchedVideo(renderer: Record<string, unknown>) {
  const videoId = renderer.videoId;
  if (typeof videoId !== "string" || !/^[\w-]{11}$/.test(videoId)) return;
  const badges = JSON.stringify(renderer.badges ?? []).toLowerCase();
  const overlays = JSON.stringify(
    renderer.thumbnailOverlays ?? [],
  ).toLowerCase();
  if (
    badges.includes("live") ||
    overlays.includes('"live"') ||
    badges.includes("members only") ||
    badges.includes("members_only")
  )
    return;
  const length = runsText(renderer.lengthText);
  // Live and upcoming streams have no length.
  if (!length) return;
  const title = runsText(renderer.title).trim();
  if (!title) return;
  const channel = runsText(
    renderer.ownerText ?? renderer.longBylineText,
  ).trim();
  const thumbnails = (
    (renderer.thumbnail ?? {}) as { thumbnails?: { url?: unknown }[] }
  ).thumbnails;
  const thumbnail = thumbnails?.at(-1)?.url;
  return {
    videoId,
    title: cleanVideoTitle(title, channel),
    channel: channel || "Unknown channel",
    duration: parseClock(length),
    thumbnail:
      typeof thumbnail === "string"
        ? thumbnail.replace(/\?.*$/, "")
        : undefined,
  } satisfies SearchedVideo;
}
