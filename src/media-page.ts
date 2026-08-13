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

let session: DefaultMeetingSession | undefined;
let source: AudioScheduledSourceNode | undefined;
let audioReported = false;

function playTone(frequency = 440) {
  source?.stop();
  const oscillator = audioContext.createOscillator();
  oscillator.frequency.value = frequency;
  oscillator.connect(gain);
  oscillator.start();
  source = oscillator;
  send("playing", { frequency });
}

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
      playTone();
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
    if (message.type === "volume") gain.gain.value = message.value;
    if (message.type === "leave") {
      source?.stop();
      await session?.audioVideo.stopAudioInput();
      session?.audioVideo.stop();
    }
  } catch (error) {
    status.textContent = "error";
    send("fatal", error instanceof Error ? error.message : String(error));
  }
});
