import {
  AudioProfile,
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
} from "amazon-chime-sdk-js";
import "@braccato/core/element";
import type { BraccatoLyricsElement } from "@braccato/core/element";
import type { Lyric } from "@braccato/core";
import { volumeGain } from "./volume.ts";
import "./media-page.css";

const status = document.querySelector("#status")!;
const title = document.querySelector("#title")!;
const artist = document.querySelector("#artist")!;
const lyrics = document.querySelector<BraccatoLyricsElement>("#lyrics")!;
const capture = document.querySelector<HTMLButtonElement>("#capture")!;
const artwork = document.querySelector<HTMLElement>("#artwork")!;
const progress = document.querySelector<HTMLElement>("#progress-fill")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
lyrics.host = { getScrollElement: () => lyrics };
lyrics.theme = "/* blyrics-target-scroll-pos-ratio = 0.45; */";
const params = new URLSearchParams(location.search);
const token = params.get("token");
if (!token) throw new Error("Missing bridge token");

const protocol = location.protocol === "https:" ? "wss" : "ws";
const socket = new WebSocket(`${protocol}://${location.host}/bridge?token=${encodeURIComponent(token)}`);
let mediaSessionId: string | undefined;
const send = (type: string, details?: unknown) =>
  socket.send(JSON.stringify({ type, details, sessionId: mediaSessionId }));

const audioContext = new AudioContext();
const gain = audioContext.createGain();
const limiter = audioContext.createDynamicsCompressor();
const destination = audioContext.createMediaStreamDestination();
gain.connect(limiter).connect(destination);

type Deck = {
  audio: HTMLAudioElement;
  node: MediaElementAudioSourceNode;
  url: string;
  pastRestartThreshold: boolean;
};

const decks = new Map<string, Deck>();
let currentId: string | undefined;
let lyricPriority = Infinity;
let transition = 0;
let pendingLyrics: { entryId: string; priority: number; lines: Lyric[]; source: string } | undefined;
let pendingNoLyrics: string | undefined;

let session: DefaultMeetingSession | undefined;
let tone: OscillatorNode | undefined;
let audioReported = false;
let cameraEnabled = true;
let cameraRunning = false;
let cameraInputReady = false;
const camera = Promise.withResolvers<MediaStream>();

lyrics.addEventListener("braccato:lyrics-loaded", event => {
  const detail = (event as CustomEvent).detail;
  console.log(`[lyrics] rendered ${detail.lineCount} ${detail.syncType} lines`);
});
lyrics.addEventListener("braccato:error", event => {
  const detail = (event as CustomEvent).detail;
  console.warn(`[lyrics] render ${detail.phase}: ${detail.error?.message ?? detail.error}`);
});

capture.addEventListener("click", async () => {
  capture.remove();
  try {
    camera.resolve(await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser", width: 720, height: 720, frameRate: 30 },
      audio: false,
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions));
  } catch (error) {
    camera.reject(error);
  }
}, { once: true });

async function setCameraEnabled(enabled: boolean) {
  cameraEnabled = enabled;
  if (!session || enabled === cameraRunning) return;
  if (!enabled) {
    cameraRunning = false;
    session.audioVideo.stopLocalVideoTile();
    return;
  }
  if (!cameraInputReady) {
    await session.audioVideo.startVideoInput(await camera.promise);
    cameraInputReady = true;
  }
  if (!cameraEnabled) return;
  session.audioVideo.startLocalVideoTile();
  cameraRunning = true;
}

function playTone(frequency = 440) {
  tone?.stop();
  const oscillator = audioContext.createOscillator();
  oscillator.frequency.value = frequency;
  oscillator.connect(gain);
  oscillator.start();
  tone = oscillator;
  send("playing", { frequency });
}

function deck(entryId: string, url: string) {
  const existing = decks.get(entryId);
  if (existing?.url === url) return existing;
  if (existing) dispose(entryId, existing);
  const audio = new Audio(url);
  audio.preload = "auto";
  const value = { audio, node: audioContext.createMediaElementSource(audio), url, pastRestartThreshold: false, lastReportedSecond: -1 };
  value.node.connect(gain);
  audio.addEventListener("ended", () => {
    if (currentId === entryId) send("track_ended", { entryId });
  });
  audio.addEventListener("stalled", () => {
    if (currentId === entryId) send("stalled", { entryId });
  });
  audio.addEventListener("error", () => {
    if (currentId === entryId) send("track_error", { entryId, message: audio.error?.message });
  });
  audio.addEventListener("canplaythrough", () => send("preloaded", { entryId }), { once: true });
  audio.addEventListener("timeupdate", () => {
    const pastRestartThreshold = audio.currentTime > 5;
    const second = Math.floor(audio.currentTime);
    if (pastRestartThreshold === value.pastRestartThreshold && second - value.lastReportedSecond < 2) return;
    value.pastRestartThreshold = pastRestartThreshold;
    value.lastReportedSecond = second;
    send("playback_position", { entryId, seconds: audio.currentTime });
  });
  decks.set(entryId, value);
  return value;
}

function dispose(entryId: string, value = decks.get(entryId)) {
  if (!value) return;
  value.audio.pause();
  value.audio.removeAttribute("src");
  value.audio.load();
  value.node.disconnect();
  decks.delete(entryId);
}

function preload(entries: { entryId: string; url: string }[]) {
  const keep = new Set([currentId, ...entries.map(entry => entry.entryId)]);
  for (const entry of entries) deck(entry.entryId, entry.url).audio.load();
  for (const [entryId, value] of decks)
    if (!keep.has(entryId)) dispose(entryId, value);
}

function stop() {
  transition++;
  pendingLyrics = undefined;
  pendingNoLyrics = undefined;
  stage.classList.remove("changing");
  currentId = undefined;
  lyricPriority = Infinity;
  for (const [entryId, value] of decks) dispose(entryId, value);
  lyrics.source = null;
  lyrics.lyrics = [];
  title.textContent = "Ready for music";
  artist.textContent = "Waiting for the next track";
  artwork.style.backgroundImage = "";
  progress.style.transform = "scaleX(0)";
}

function updateProgress() {
  const player = currentId ? decks.get(currentId)?.audio : undefined;
  const amount = player && Number.isFinite(player.duration) && player.duration > 0
    ? player.currentTime / player.duration
    : 0;
  progress.style.transform = `scaleX(${Math.min(1, Math.max(0, amount))})`;
  requestAnimationFrame(updateProgress);
}
requestAnimationFrame(updateProgress);

function showLyrics(message: { priority: number; lines: Lyric[]; source: string }) {
  if (message.priority >= lyricPriority) return;
  lyricPriority = message.priority;
  lyrics.lyricsOptions = {};
  lyrics.lyrics = message.lines;
  console.log(`[lyrics] received ${message.lines.length} lines from ${message.source}`);
}

function showNoLyrics() {
  lyrics.lyricsOptions = { noLyrics: true };
  lyrics.lyrics = [{ startTimeMs: 0, durationMs: 0, words: "No lyrics found" }];
}

function takePendingLyrics() {
  const message = pendingLyrics;
  pendingLyrics = undefined;
  return message;
}

async function join(payload: {
  sessionId: string;
  meeting: Record<string, unknown>;
  attendee: Record<string, unknown>;
  initialVolume: number;
}) {
  mediaSessionId = payload.sessionId;
  await audioContext.resume();
  gain.gain.value = volumeGain(payload.initialVolume);

  const logger = new ConsoleLogger("HuddleFM", LogLevel.WARN);
  const deviceController = new DefaultDeviceController(logger);
  const configuration = new MeetingSessionConfiguration(payload.meeting, payload.attendee);
  session = new DefaultMeetingSession(configuration, logger, deviceController);
  session.audioVideo.setAudioProfile(AudioProfile.fullbandMusicStereo());
  session.audioVideo.addObserver({
    audioVideoDidStart: () => {
      void setCameraEnabled(cameraEnabled).then(() => {
        status.textContent = "joined";
        send("joined");
      }).catch(error => send("fatal", { message: error instanceof Error ? error.message : String(error) }));
    },
    metricsDidReceive: report => {
      if (!audioReported) {
        report.getRTCStatsReport().forEach(stat => {
          if (
            stat.type === "outbound-rtp" &&
            stat.kind === "audio" &&
            stat.bytesSent > 0
          ) {
            send("audio_outbound", {
              bytesSent: stat.bytesSent,
              packetsSent: stat.packetsSent,
            });
            audioReported = true;
          }
        });
      }
    },
    audioVideoDidStop: event => {
      status.textContent = "ended";
      send("ended", { code: event.statusCode() });
    },
  });
  await session.audioVideo.startAudioInput(destination.stream);
  session.audioVideo.start();
  session.audioVideo.realtimeUnmuteLocalAudio();
}

socket.addEventListener("open", () => send("ready"));
socket.addEventListener("message", async event => {
  const message = JSON.parse(String(event.data));
  try {
    if (message.type === "bootstrap") await join(message.payload);
    if (message.type === "tone") playTone(message.frequency);
    if (message.type === "preload") preload(message.entries);
    if (message.type === "play") {
      const change = ++transition;
      pendingLyrics = undefined;
      pendingNoLyrics = undefined;
      stage.classList.add("changing");
      tone?.stop();
      if (currentId && currentId !== message.entryId) decks.get(currentId)?.audio.pause();
      currentId = message.entryId;
      lyricPriority = Infinity;
      const player = deck(message.entryId, message.url).audio;
      player.currentTime = 0;
      await player.play();
      send("playing", { entryId: message.entryId });
      await new Promise(resolve => setTimeout(resolve, 220));
      if (change !== transition || currentId !== message.entryId) return;
      title.textContent = message.title;
      artist.textContent = message.artist;
      artwork.style.backgroundImage = message.artwork ? `url(${JSON.stringify(message.artwork)})` : "";
      lyrics.lyricsOptions = {};
      lyrics.lyrics = [];
      lyrics.source = player;
      const queuedLyrics = takePendingLyrics();
      if (queuedLyrics && queuedLyrics.entryId === message.entryId) showLyrics(queuedLyrics);
      else if (pendingNoLyrics === message.entryId) showNoLyrics();
      pendingNoLyrics = undefined;
      requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.remove("changing")));
    }
    if (message.type === "lyrics" && currentId === message.entryId && message.priority < lyricPriority) {
      if (stage.classList.contains("changing")) pendingLyrics = message;
      else showLyrics(message);
    }
    if (message.type === "lyrics_unavailable" && currentId === message.entryId) {
      if (stage.classList.contains("changing")) pendingNoLyrics = message.entryId;
      else showNoLyrics();
    }
    if (message.type === "pause") {
      if (currentId) decks.get(currentId)?.audio.pause();
      send("paused");
    }
    if (message.type === "resume") {
      if (currentId) await decks.get(currentId)?.audio.play();
      send("playing", { entryId: currentId });
    }
    if (message.type === "seek" && currentId) {
      const current = decks.get(currentId)!;
      const seconds = message.seconds ?? current.audio.currentTime + message.offset;
      current.audio.currentTime = Math.max(0, Math.min(current.audio.duration || Infinity, seconds));
      current.pastRestartThreshold = current.audio.currentTime > 5;
      send("playback_position", { entryId: currentId, seconds: current.audio.currentTime });
    }
    if (message.type === "stop") stop();
    if (message.type === "volume") gain.gain.value = volumeGain(message.value);
    if (message.type === "lyrics_enabled") await setCameraEnabled(message.enabled);
    if (message.type === "leave") {
      tone?.stop();
      stop();
      await session?.audioVideo.stopAudioInput();
      session?.audioVideo.stopLocalVideoTile();
      await session?.audioVideo.stopVideoInput();
      cameraRunning = false;
      cameraInputReady = false;
      session?.audioVideo.stop();
    }
  } catch (error) {
    status.textContent = "error";
    const details = {
      entryId: currentId,
      message: error instanceof Error ? error.message : String(error),
    };
    send(message.type === "play" || message.type === "resume" ? "track_error" : "fatal", details);
  }
});
