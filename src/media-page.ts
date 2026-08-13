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
const send = (type: string, details?: unknown) =>
  socket.send(JSON.stringify({ type, details }));

const audioContext = new AudioContext();
const gain = audioContext.createGain();
const limiter = audioContext.createDynamicsCompressor();
const destination = audioContext.createMediaStreamDestination();
gain.connect(limiter).connect(destination);
const player = new Audio();
player.preload = "auto";
audioContext.createMediaElementSource(player).connect(gain);

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

player.addEventListener("ended", () => send("track_ended"));
player.addEventListener("stalled", () => send("stalled"));
player.addEventListener("error", () => send("track_error", player.error?.message));

async function join(payload: {
  meeting: Record<string, unknown>;
  attendee: Record<string, unknown>;
  initialVolume: number;
}) {
  await audioContext.resume();
  gain.gain.value = payload.initialVolume;

  const logger = new ConsoleLogger("HuddleFM", LogLevel.WARN);
  const deviceController = new DefaultDeviceController(logger);
  const configuration = new MeetingSessionConfiguration(payload.meeting, payload.attendee);
  session = new DefaultMeetingSession(configuration, logger, deviceController);
  session.audioVideo.setAudioProfile(AudioProfile.fullbandMusicMono());
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
    if (message.type === "play") {
      tone?.stop();
      player.src = message.url;
      await player.play();
      send("playing", { entryId: message.entryId });
    }
    if (message.type === "pause") {
      player.pause();
      send("paused");
    }
    if (message.type === "resume") {
      await player.play();
      send("playing");
    }
    if (message.type === "stop") {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    if (message.type === "volume") gain.gain.value = message.value;
    if (message.type === "leave") {
      tone?.stop();
      player.pause();
      player.removeAttribute("src");
      await session?.audioVideo.stopAudioInput();
      session?.audioVideo.stop();
    }
  } catch (error) {
    status.textContent = "error";
    send("fatal", error instanceof Error ? error.message : String(error));
  }
});
