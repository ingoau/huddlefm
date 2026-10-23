// The native media backend for one Huddle, run as a child process by
// NativeMediaSession. It reads the bootstrap and then the coordinator's media
// messages as JSON lines on stdin, and writes media events and log lines as
// JSON lines on stdout.
import { Application, createEncoder, Signal } from "libopus-wasm";
import type { Lyric } from "@braccato/core";
import type { ChimeBootstrap } from "../slack-huddle.ts";
import { errorMessage } from "../error-message.ts";
import { AudioEngine } from "./audio-engine.ts";
import {
  ChimeLink,
  statusCodes,
  type ChimeAttendee,
  type ChimeMeeting,
} from "./chime-link.ts";
import { ContentShares, contentSuffix } from "./content-shares.ts";
import { FfmpegDecoder, probeDuration, sampleRate } from "./decoder.ts";
import { SpeechSignals } from "./speech.ts";
import type { LyricsCredits } from "./lyrics-view.ts";
import type { DisplayMode } from "./video-card.ts";
import { shareFormat } from "./video-format.ts";
import { VideoThread, type IdleText } from "./video-thread.ts";

type Level = "trace" | "debug" | "info" | "warn" | "error";

const frameSamples = 960; // 20 ms at 48 kHz
const frameMs = (frameSamples / sampleRate) * 1_000;
/** Frames the pacer may fall behind before it skips ahead instead of bursting. */
const maxCatchUpFrames = 10;
/** The page waits this long after `play` before swapping the card. */
const trackSwapDelayMs = 220;
/** What the card says when nothing is playing in video mode. */
const videoIdle: IdleText = {
  title: "Video mode",
  subtitle: "Queue something to watch",
};

let sessionId: string | undefined;
function write(line: unknown) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
function emit(type: string, details?: unknown) {
  write({ type, details, sessionId });
}
function log(
  level: Level,
  event: string,
  message: string,
  fields: Record<string, unknown> = {},
) {
  write({ log: { level, event, message, ...fields } });
}

let engine: AudioEngine | undefined;
let link: ChimeLink | undefined;
let bootstrapped: ChimeBootstrap | undefined;
/**
 * The screen share in video mode: a second attendee, `<bot>#content`, which
 * carries the video and the music while it is up.
 */
let share: ChimeLink | undefined;
let videoMode = false;
let shareFailures = 0;
let contentShares: ContentShares | undefined;
/** Numbers for entries, so the video worker can tell whose clock it has. */
const entryKeys = new Map<string, number>();
let nextEntryKey = 1;
/** The video card and its encoder, drawn in a worker off this thread. */
let card: VideoThread | undefined;
let pacer: ReturnType<typeof setInterval> | undefined;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let leaving: Promise<void> | undefined;
let trackSwap = 0;
let wantVideo = true;
/** The entry the card shows, which trails `play` by the swap delay. */
let shownEntry: string | undefined;
/** The best lyrics so far for the current entry, like the page's. */
let lyrics:
  | {
      entryId: string;
      priority: number;
      lines: Lyric[];
      credits: LyricsCredits;
    }
  | undefined;
let noLyrics: string | undefined;

function entryKey(entryId: string) {
  let key = entryKeys.get(entryId);
  if (key === undefined) {
    key = nextEntryKey++;
    entryKeys.set(entryId, key);
  }
  return key;
}

async function start(bootstrap: ChimeBootstrap) {
  sessionId = bootstrap.sessionId;
  bootstrapped = bootstrap;
  const audio = new AudioEngine(
    (url, startSeconds, input) => new FfmpegDecoder(url, startSeconds, input),
    emit,
    probeDuration,
  );
  engine = audio;
  audio.setVolume(bootstrap.initialVolume);
  audio.setDuckingMode(bootstrap.duckingMode);
  card = new VideoThread(
    (bootstrap.lyricsOffsetMs ?? 0) / 1_000,
    {
      onAccessUnit: (nals, timestamp) => link?.sendVideo(nals, timestamp),
      onShareUnit: (nals, timestamp) => share?.sendVideo(nals, timestamp),
      log: (event, message, fields) => {
        log("warn", event, message, fields);
        // The card stands in for a video that cannot be shown; whoever
        // added it hears why.
        if (event === "native_video_playback_failed")
          emit("video_failed", { entryId: engine?.current });
      },
    },
    undefined,
    shareFormat(bootstrap.video),
  );
  let speech: SpeechSignals | undefined;
  const chime = new ChimeLink(
    bootstrap.meeting as unknown as ChimeMeeting,
    bootstrap.attendee as unknown as ChimeAttendee,
    wantVideo,
    {
      log: (level, event, message, fields) =>
        log(level, event, message, fields),
      onSignaling: () => {
        speech?.reset();
        contentShares?.reset();
      },
      onFrame: (frame) => {
        speech?.handle(frame);
        contentShares?.handle(frame);
      },
      onConnected: () => syncVideo(),
      onVideoChanged: () => syncVideo(),
      onPictureLoss: () => card?.requestKeyframe(),
      onTerminal: (code, reason) => {
        log("warn", "native_media_ended", "Chime session ended", {
          code,
          reason,
        });
        void finish(code);
      },
    },
  );
  link = chime;
  speech = new SpeechSignals(chime.attendeeId, audio.ducking, audio.applyDuck);
  contentShares = new ContentShares(chime.attendeeId, (count) =>
    emit("content_shares", { count }),
  );
  const startedAt = Date.now();
  await chime.start();
  log("info", "native_media_joined", "Native media joined Chime", {
    durationMs: Date.now() - startedAt,
    video: chime.sendingVideo,
  });
  await startPacer(audio, chime);
  emit("joined");
  statsTimer = setInterval(
    () =>
      log("debug", "native_media_stats", "Native media stats", {
        ...chime.stats,
        connected: chime.connected,
        video: chime.sendingVideo,
        duckGain: audio.duckGain,
        ...(share ? { share: { ...share.stats, live: shareLive() } } : {}),
      }),
    60_000,
  );
}

function syncVideo() {
  if (!link) return;
  card?.setVideo(link.sendingVideo && wantVideo && !share);
}

/** The camera tile is off while the screen share shows the card instead. */
function syncCamera() {
  link?.setVideo(wantVideo && !share);
  syncVideo();
}

/** Whether the screen share is up and carrying the music. */
function shareLive() {
  return Boolean(share?.connected && share.sendingVideo);
}

function startShare() {
  const bootstrap = bootstrapped;
  if (share || !bootstrap || !videoMode || leaving) return;
  const attendee = bootstrap.attendee as unknown as ChimeAttendee;
  // Like the JS SDK's DefaultContentShareController: the share is the same
  // attendee and join token with the content modality on the end.
  const content = new ChimeLink(
    bootstrap.meeting as unknown as ChimeMeeting,
    {
      AttendeeId: `${attendee.AttendeeId}${contentSuffix}`,
      JoinToken: `${attendee.JoinToken}${contentSuffix}`,
    },
    true,
    {
      log: (level, event, message, fields) =>
        log(level, event, message, { ...fields, share: true }),
      onSignaling: () => {},
      onFrame: () => {},
      onConnected: (reconnect) => {
        if (share !== content) return;
        if (!content.sendingVideo) {
          failShare(content, "Chime refused the screen share");
          return;
        }
        shareFailures = 0;
        card?.setShare(true);
        log("info", "native_share_started", "Screen share started", {
          reconnect,
        });
        if (!reconnect) emit("share_started");
      },
      onVideoChanged: () => {},
      onPictureLoss: () => card?.requestShareKeyframe(),
      onTerminal: (code, reason) => failShare(content, reason, code),
    },
    true,
    shareFormat(bootstrap.video),
  );
  share = content;
  syncCamera();
  content.start().catch((error) => failShare(content, errorMessage(error)));
}

/** The share could not start or was lost: the camera tile takes over. */
function failShare(content: ChimeLink, reason: string, code?: number) {
  if (share !== content) return;
  share = undefined;
  shareFailures++;
  content.close();
  card?.setShare(false);
  syncCamera();
  log("warn", "native_share_failed", "Screen share failed", { reason, code });
  emit("share_failed", { reason });
}

async function stopShare() {
  const content = share;
  share = undefined;
  card?.setShare(false);
  syncCamera();
  if (content) await content.leave().catch(() => {});
}

function currentIdle() {
  return videoMode ? videoIdle : undefined;
}

async function startPacer(audio: AudioEngine, chime: ChimeLink) {
  const opus = await createEncoder({
    application: Application.Audio,
    signal: Signal.Music,
    channels: 2,
    sampleRate: 48_000,
    bitrate: 128_000,
    complexity: 10,
    vbr: true,
    fec: true,
    packetLossPercent: 5,
  });
  // A still frame of silence for the bot's own attendee while the share
  // carries the music, encoded once by an encoder of its own.
  const quiet = await createEncoder({
    application: Application.Audio,
    signal: Signal.Music,
    channels: 2,
    sampleRate: 48_000,
    bitrate: 32_000,
  });
  const silence = quiet.encodeFloat(new Float32Array(frameSamples * 2));
  let reported = false;
  let base = performance.now();
  let sent = 0;
  pacer = setInterval(() => {
    const due = Math.floor((performance.now() - base) / frameMs);
    if (due - sent > maxCatchUpFrames) {
      // After a stall, carry on from now rather than rushing out a burst.
      base = performance.now() - frameMs;
      sent = 0;
    }
    const target = Math.floor((performance.now() - base) / frameMs);
    while (sent < target) {
      sent++;
      const samples = audio.render(frameSamples);
      for (let index = 0; index < samples.length; index++)
        samples[index] = Math.max(-1, Math.min(1, samples[index]!));
      const packet = opus.encodeFloat(samples);
      const content = shareLive() ? share : undefined;
      if (content) {
        content.sendAudio(packet);
        chime.sendAudio(silence);
      } else if (chime.sendAudio(packet) && !reported) {
        reported = true;
        emit("audio_outbound", {
          bytesSent: chime.stats.audioBytes,
          packetsSent: chime.stats.audioPackets,
        });
      }
    }
    card?.tick(
      audio.progress(),
      audio.current ? entryKey(audio.current) : undefined,
    );
  }, 10);
}

function handle(message: Record<string, any>) {
  if (message.type === "bootstrap") return;
  if (message.type === "leave") {
    void leave();
    return;
  }
  if (!engine || leaving) return;
  if (message.type === "display_mode") {
    wantVideo = message.mode !== "off";
    card?.setDisplayMode(message.mode as DisplayMode);
    syncCamera();
    return;
  }
  if (message.type === "video_mode") {
    if (Boolean(message.on) === videoMode) return;
    videoMode = Boolean(message.on);
    shareFailures = 0;
    if (videoMode) startShare();
    else void stopShare();
    if (!shownEntry) card?.reset(currentIdle());
    return;
  }
  if (message.type === "captions") {
    card?.setCaptions(Boolean(message.on));
    return;
  }
  if (message.type === "progress_bar") {
    card?.setProgressBar(message.on !== false);
    return;
  }
  if (message.type === "lyrics") {
    handleLyrics(message);
    return;
  }
  if (message.type === "lyrics_unavailable") {
    if (
      message.entryId !== engine.current ||
      lyrics?.entryId === message.entryId
    )
      return;
    noLyrics = message.entryId;
    if (shownEntry === message.entryId) card?.setLyricsUnavailable();
    return;
  }
  engine.handle(message);
  if (message.type === "play") {
    // A share that failed gets another go with each new song, unless it
    // keeps failing.
    if (videoMode && !share && shareFailures < 3) startShare();
    const video = message.video as
      { subtitles?: unknown; url?: unknown } | undefined;
    card?.setShareSource(
      video && typeof message.url === "string"
        ? {
            key: entryKey(String(message.entryId)),
            url: typeof video.url === "string" ? video.url : message.url,
            subtitles:
              typeof video.subtitles === "string" ? video.subtitles : undefined,
            ...(message.stream ? { input: message.stream } : {}),
          }
        : undefined,
    );
    const swap = ++trackSwap;
    lyrics = undefined;
    noLyrics = undefined;
    card?.beginChange(message.artwork);
    setTimeout(() => {
      if (swap !== trackSwap || engine?.current !== message.entryId) return;
      shownEntry = message.entryId;
      card?.setTrack(
        String(message.title ?? ""),
        message.requesterLabel
          ? `${message.artist} — ${message.requesterLabel}`
          : String(message.artist ?? ""),
        message.artwork,
      );
      if (lyrics && lyrics.entryId === message.entryId)
        card?.setLyrics(lyrics.lines, lyrics.credits);
      else if (noLyrics === message.entryId) card?.setLyricsUnavailable();
    }, trackSwapDelayMs);
  }
  if (message.type === "stop") {
    trackSwap++;
    shownEntry = undefined;
    lyrics = undefined;
    noLyrics = undefined;
    card?.setShareSource(undefined);
    card?.reset(currentIdle());
  }
}

function handleLyrics(message: Record<string, any>) {
  const entryId = String(message.entryId);
  const priority = Number(message.priority);
  if (entryId !== engine?.current || !Array.isArray(message.lines)) return;
  if (lyrics?.entryId === entryId && !(priority < lyrics.priority)) return;
  const credits: LyricsCredits = {
    songwriters: Array.isArray(message.songwriters)
      ? message.songwriters.map(String)
      : undefined,
    source: typeof message.source === "string" ? message.source : undefined,
  };
  lyrics = { entryId, priority, lines: message.lines, credits };
  noLyrics = undefined;
  if (shownEntry === entryId) card?.setLyrics(message.lines, credits);
}

async function leave() {
  leaving ??= (async () => {
    emit("leaving");
    await finish(statusCodes.left);
  })();
  return leaving;
}

let finishing: Promise<void> | undefined;
function finish(code: number) {
  finishing ??= (async () => {
    clearInterval(pacer);
    clearInterval(statsTimer);
    engine?.dispose();
    await card?.stop();
    const content = share;
    share = undefined;
    await Promise.all([
      content?.leave().catch(() => {}),
      link?.leave().catch(() => {}),
    ]);
    emit("ended", { code });
    // Let stdout drain before exiting.
    await Bun.sleep(50);
    process.exit(0);
  })();
  return finishing;
}

async function main() {
  const decoder = new TextDecoder();
  let buffered = "";
  let started = false;
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (!line) continue;
      let message: Record<string, any>;
      try {
        message = JSON.parse(line);
      } catch {
        log("warn", "native_bad_message", "Ignored a malformed media message");
        continue;
      }
      if (!started && message.type === "bootstrap") {
        started = true;
        start(message.payload).catch((error) => {
          emit("fatal", { message: errorMessage(error) });
          void finish(statusCodes.taskFailed);
        });
        continue;
      }
      try {
        handle(message);
      } catch (error) {
        emit(
          message.type === "play" || message.type === "resume"
            ? "track_error"
            : "fatal",
          { entryId: engine?.current, message: errorMessage(error) },
        );
      }
    }
  }
  // The parent went away without saying leave: leave the Huddle anyway.
  await leave();
}

process.on("SIGTERM", () => void leave());
process.on("SIGINT", () => void leave());
void main();
