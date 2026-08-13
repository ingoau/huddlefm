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
import "./media-page.css";

const status = document.querySelector("#status")!;
const title = document.querySelector("#title")!;
const artist = document.querySelector("#artist")!;
const lyrics = document.querySelector<BraccatoLyricsElement>("#lyrics")!;
const capture = document.querySelector<HTMLButtonElement>("#capture")!;
lyrics.host = { getScrollElement: () => lyrics };
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
};

const decks = new Map<string, Deck>();
let currentId: string | undefined;
let lyricPriority = Infinity;

let session: DefaultMeetingSession | undefined;
let tone: OscillatorNode | undefined;
let audioReported = false;
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
  const value = { audio, node: audioContext.createMediaElementSource(audio), url };
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
  currentId = undefined;
  lyricPriority = Infinity;
  for (const [entryId, value] of decks) dispose(entryId, value);
  lyrics.source = null;
  lyrics.lyrics = [];
  title.textContent = "Ready for music";
  artist.textContent = "Waiting for the next track";
}

async function join(payload: {
  sessionId: string;
  meeting: Record<string, unknown>;
  attendee: Record<string, unknown>;
  initialVolume: number;
}) {
  mediaSessionId = payload.sessionId;
  await audioContext.resume();
  gain.gain.value = payload.initialVolume;

  const logger = new ConsoleLogger("HuddleFM", LogLevel.WARN);
  const deviceController = new DefaultDeviceController(logger);
  const configuration = new MeetingSessionConfiguration(payload.meeting, payload.attendee);
  session = new DefaultMeetingSession(configuration, logger, deviceController);
  session.audioVideo.setAudioProfile(AudioProfile.fullbandMusicStereo());
  session.audioVideo.addObserver({
    audioVideoDidStart: () => {
      void camera.promise.then(async stream => {
        await session!.audioVideo.startVideoInput(stream);
        session!.audioVideo.startLocalVideoTile();
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
      tone?.stop();
      if (currentId && currentId !== message.entryId) decks.get(currentId)?.audio.pause();
      currentId = message.entryId;
      lyricPriority = Infinity;
      const player = deck(message.entryId, message.url).audio;
      title.textContent = message.title;
      artist.textContent = message.artist;
      lyrics.lyrics = [];
      lyrics.source = player;
      player.currentTime = 0;
      await player.play();
      send("playing", { entryId: message.entryId });
    }
    if (message.type === "lyrics" && currentId === message.entryId && message.priority < lyricPriority) {
      lyricPriority = message.priority;
      lyrics.lyrics = message.lines as Lyric[];
      console.log(`[lyrics] received ${message.lines.length} lines from ${message.source}`);
    }
    if (message.type === "pause") {
      if (currentId) decks.get(currentId)?.audio.pause();
      send("paused");
    }
    if (message.type === "resume") {
      if (currentId) await decks.get(currentId)?.audio.play();
      send("playing", { entryId: currentId });
    }
    if (message.type === "stop") stop();
    if (message.type === "volume") gain.gain.value = message.value;
    if (message.type === "leave") {
      tone?.stop();
      stop();
      await session?.audioVideo.stopAudioInput();
      session?.audioVideo.stopLocalVideoTile();
      await session?.audioVideo.stopVideoInput();
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
