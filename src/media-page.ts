import {
  AudioProfile,
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
} from "amazon-chime-sdk-js";

const status = document.querySelector("#status")!;
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

let session: DefaultMeetingSession | undefined;
let tone: OscillatorNode | undefined;
let audioReported = false;

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
  const value = { audio, node: audioContext.createMediaElementSource(audio), url, pastRestartThreshold: false };
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
    if (pastRestartThreshold === value.pastRestartThreshold) return;
    value.pastRestartThreshold = pastRestartThreshold;
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
  currentId = undefined;
  for (const [entryId, value] of decks) dispose(entryId, value);
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
      status.textContent = "joined";
      send("joined");
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
      const player = deck(message.entryId, message.url).audio;
      player.currentTime = 0;
      await player.play();
      send("playing", { entryId: message.entryId });
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
    if (message.type === "volume") gain.gain.value = message.value;
    if (message.type === "leave") {
      tone?.stop();
      stop();
      await session?.audioVideo.stopAudioInput();
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
