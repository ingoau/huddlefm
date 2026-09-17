import {
  AudioProfile,
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
} from "amazon-chime-sdk-js";
import { LyricPlayer, type LyricLine } from "@applemusic-like-lyrics/core";
import type { DisplayMode } from "./store.ts";
import {
  DuckingController,
  parseDuckingMode,
  type DuckDecision,
} from "./ducking.ts";
import { volumeGain } from "./volume.ts";
import "@applemusic-like-lyrics/core/style.css";
import "./media-page.css";

const status = document.querySelector("#status")!;
const title = document.querySelector("#title")!;
const artist = document.querySelector("#artist")!;
const lyricsFrame = document.querySelector<HTMLElement>("#lyrics-frame")!;
const capture = document.querySelector<HTMLButtonElement>("#capture")!;
const artwork = document.querySelector<HTMLElement>("#artwork")!;
const cover = document.querySelector<HTMLElement>("#cover")!;
const progress = document.querySelector<HTMLElement>("#progress-fill")!;
const elapsed = document.querySelector("#elapsed")!;
const duration = document.querySelector("#duration")!;
const stage = document.querySelector<HTMLElement>("#stage")!;

const lyricPlayer = new LyricPlayer();
// Apple Music keeps the line being sung above the middle so the lines still to
// come stay in view; the frame's mask fades whatever runs past either edge.
lyricPlayer.setAlignPosition(0.36);
lyricsFrame.append(lyricPlayer.getElement());
const params = new URLSearchParams(location.search);
const token = params.get("token");
if (!token) throw new Error("Missing bridge token");

const protocol = location.protocol === "https:" ? "wss" : "ws";
const socket = new WebSocket(
  `${protocol}://${location.host}/bridge?token=${encodeURIComponent(token)}`,
);
let mediaSessionId: string | undefined;
const send = (type: string, details?: unknown) =>
  socket.send(JSON.stringify({ type, details, sessionId: mediaSessionId }));

const audioContext = new AudioContext();
const gain = audioContext.createGain();
// Auto-ducking rides its own stage so it never overwrites the volume the
// session chose: `gain` stays exactly where the volume controls put it.
const duck = audioContext.createGain();
const limiter = audioContext.createDynamicsCompressor();
const destination = audioContext.createMediaStreamDestination();
gain.connect(duck).connect(limiter).connect(destination);

const ducking = new DuckingController();
let duckTimer: ReturnType<typeof setTimeout> | undefined;
// Volume indicator callbacks are kept so they can be unsubscribed per attendee.
const duckSubscriptions = new Map<
  string,
  (attendeeId: string, volume: number | null, muted: boolean | null) => void
>();
let attendeePresence:
  ((attendeeId: string, present: boolean) => void) | undefined;

function applyDuck(decision: DuckDecision | undefined) {
  if (!decision) return;
  clearTimeout(duckTimer);
  duckTimer = undefined;
  const now = audioContext.currentTime;
  // Holding at the value the ramp actually reached keeps rapid speech from
  // leaving the gain parked partway between ducked and restored.
  duck.gain.cancelAndHoldAtTime(now);
  if (decision.rampSeconds > 0)
    duck.gain.linearRampToValueAtTime(
      decision.gain,
      now + decision.rampSeconds,
    );
  else duck.gain.setValueAtTime(decision.gain, now);
  if (decision.recheckMs !== undefined)
    duckTimer = setTimeout(
      () => applyDuck(ducking.tick(Date.now())),
      decision.recheckMs,
    );
}

function stopDucking() {
  clearTimeout(duckTimer);
  duckTimer = undefined;
  for (const [attendeeId, callback] of duckSubscriptions)
    session?.audioVideo.realtimeUnsubscribeFromVolumeIndicator(
      attendeeId,
      callback,
    );
  duckSubscriptions.clear();
  if (attendeePresence)
    session?.audioVideo.realtimeUnsubscribeToAttendeeIdPresence(
      attendeePresence,
    );
  attendeePresence = undefined;
  applyDuck(ducking.reset());
}

type Deck = {
  audio: HTMLAudioElement;
  node: MediaElementAudioSourceNode;
  gain: GainNode;
  url: string;
  pastRestartThreshold: boolean;
  lastReportedSecond: number;
};

const decks = new Map<string, Deck>();
let currentId: string | undefined;
let transitionMode: "none" | "gapless" | "adaptive" = "none";
let nextEntry:
  | {
      entryId: string;
      url: string;
      introSeconds: number;
      fadeInSeconds: number;
    }
  | undefined;
let currentOutro: number | undefined;
let currentFadeOut = 0;
let transitioning = false;
let transitionTimer: ReturnType<typeof setTimeout> | undefined;
let handoffTimer: ReturnType<typeof setTimeout> | undefined;
let fadeTimer: ReturnType<typeof setTimeout> | undefined;
let lyricPriority = Infinity;
let transition = 0;
let pendingLyrics:
  | { entryId: string; priority: number; lines: LyricLine[]; source: string }
  | undefined;
let pendingNoLyrics: string | undefined;
let preferredDisplayMode: DisplayMode = "default";
let lyricsAvailable: boolean | undefined;
// The deck the lyrics are timed against. It only follows the `play` message,
// never `currentId`, so a crossfade cannot re-time the outgoing song's lyrics
// to the incoming one halfway through the fade.
let lyricSource: HTMLAudioElement | undefined;
let lyricPlaying = false;
let lastFrameAt = performance.now();

let session: DefaultMeetingSession | undefined;
let tone: OscillatorNode | undefined;
let audioReported = false;
let cameraEnabled = true;
let cameraRunning = false;
let cameraInputReady = false;
const camera = Promise.withResolvers<MediaStream>();

async function applyDisplayMode() {
  const mode =
    preferredDisplayMode === "lyrics" && lyricsAvailable === false
      ? "default"
      : preferredDisplayMode;
  stage.dataset.displayMode = mode === "lyrics" ? "lyrics" : "default";
  await setCameraEnabled(preferredDisplayMode !== "off");
}

async function setDisplayMode(mode: DisplayMode) {
  preferredDisplayMode = mode;
  await applyDisplayMode();
}

capture.addEventListener(
  "click",
  async () => {
    capture.remove();
    try {
      camera.resolve(
        await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: "browser",
            width: 720,
            height: 720,
            frameRate: 30,
          },
          audio: false,
          preferCurrentTab: true,
        } as DisplayMediaStreamOptions),
      );
    } catch (error) {
      camera.reject(error);
    }
  },
  { once: true },
);

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
  const value = {
    audio,
    node: audioContext.createMediaElementSource(audio),
    gain: audioContext.createGain(),
    url,
    pastRestartThreshold: false,
    lastReportedSecond: -1,
  };
  value.node.connect(value.gain).connect(gain);
  audio.addEventListener("ended", () => {
    if (currentId === entryId) send("track_ended", { entryId });
  });
  audio.addEventListener("stalled", () => {
    if (currentId === entryId) send("stalled", { entryId });
  });
  audio.addEventListener("error", () => {
    if (currentId === entryId)
      send("track_error", { entryId, message: audio.error?.message });
  });
  audio.addEventListener(
    "canplaythrough",
    () => send("preloaded", { entryId }),
    { once: true },
  );
  audio.addEventListener("timeupdate", () => {
    const pastRestartThreshold = audio.currentTime > 5;
    const second = Math.floor(audio.currentTime);
    if (
      pastRestartThreshold === value.pastRestartThreshold &&
      second - value.lastReportedSecond < 2
    )
      return;
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
  value.gain.disconnect();
  decks.delete(entryId);
}

function preload(entries: { entryId: string; url: string }[]) {
  const keep = new Set([currentId, ...entries.map((entry) => entry.entryId)]);
  for (const entry of entries) deck(entry.entryId, entry.url).audio.load();
  for (const [entryId, value] of decks)
    if (!keep.has(entryId)) dispose(entryId, value);
}

function clearTransitionTimers() {
  clearTimeout(transitionTimer);
  clearTimeout(handoffTimer);
  clearTimeout(fadeTimer);
  transitionTimer = undefined;
  handoffTimer = undefined;
  fadeTimer = undefined;
}

function cancelTransition(keepId = currentId) {
  clearTransitionTimers();
  transitioning = false;
  const now = audioContext.currentTime;
  for (const [entryId, value] of decks) {
    value.gain.gain.cancelScheduledValues(now);
    value.gain.gain.setValueAtTime(entryId === keepId ? 1 : 0, now);
    if (entryId !== keepId) value.audio.pause();
  }
}

function stop() {
  clearTransitionTimers();
  transitioning = false;
  transition++;
  pendingLyrics = undefined;
  pendingNoLyrics = undefined;
  lyricsAvailable = undefined;
  stage.classList.remove("changing");
  currentId = undefined;
  nextEntry = undefined;
  currentOutro = undefined;
  currentFadeOut = 0;
  lyricPriority = Infinity;
  for (const [entryId, value] of decks) dispose(entryId, value);
  lyricSource = undefined;
  clearLyrics();
  void applyDisplayMode();
  title.textContent = "Ready for music";
  artist.textContent = "Waiting for the next track";
  artwork.style.backgroundImage = "";
  cover.style.backgroundImage = "";
  progress.style.transform = "scaleX(0)";
  elapsed.textContent = "0:00";
  duration.textContent = "0:00";
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

/**
 * AMLL drives itself from the clock it is given rather than from an audio
 * element, so every frame hands it the deck's position and the elapsed time its
 * springs need to advance. Passing the deck's own `currentTime` rather than a
 * wall clock keeps the karaoke sweep honest through pauses, seeks, and
 * crossfades.
 */
function updateLyrics(now: number) {
  const playing = Boolean(lyricSource && !lyricSource.paused);
  if (playing !== lyricPlaying) {
    lyricPlaying = playing;
    if (playing) lyricPlayer.resume();
    else lyricPlayer.pause();
  }
  if (lyricSource) lyricPlayer.setCurrentTime(lyricSource.currentTime * 1_000);
  lyricPlayer.update(now - lastFrameAt);
  lastFrameAt = now;
}

/**
 * Jumps the lyrics to a new position. A seek has to be announced so the player
 * drops the lines it was animating through instead of sweeping across the gap.
 */
function seekLyrics(seconds: number) {
  lyricPlayer.setCurrentTime(seconds * 1_000, true);
  void lyricPlayer.calcLayout(true, true);
}

function updateProgress(now: number = performance.now()) {
  updateLyrics(now);
  const player = currentId ? decks.get(currentId)?.audio : undefined;
  const amount =
    player && Number.isFinite(player.duration) && player.duration > 0
      ? player.currentTime / player.duration
      : 0;
  progress.style.transform = `scaleX(${Math.min(1, Math.max(0, amount))})`;
  elapsed.textContent = formatTime(player?.currentTime ?? 0);
  duration.textContent = formatTime(player?.duration ?? 0);
  const remaining =
    player && currentOutro !== undefined
      ? currentOutro - adaptiveCrossfadeSeconds() - player.currentTime
      : Infinity;
  if (
    player &&
    nextEntry &&
    nextEntry.entryId !== currentId &&
    currentOutro !== undefined &&
    transitionMode !== "none" &&
    !transitioning &&
    transitionReady()
  ) {
    if (remaining <= 0.25 && !transitionTimer)
      transitionTimer = setTimeout(
        () => {
          transitionTimer = undefined;
          const current = currentId ? decks.get(currentId)?.audio : undefined;
          if (!current || current.paused || currentOutro === undefined) return;
          const transitionAt = currentOutro - adaptiveCrossfadeSeconds();
          if (current.currentTime < transitionAt - 0.02) return;
          void beginTransition().catch(transitionFailed);
        },
        Math.max(0, remaining * 1_000),
      );
  }
  requestAnimationFrame(updateProgress);
}
requestAnimationFrame(updateProgress);

function transitionReady() {
  return Boolean(
    nextEntry && deck(nextEntry.entryId, nextEntry.url).audio.readyState >= 3,
  );
}

function adaptiveCrossfadeSeconds() {
  if (transitionMode !== "adaptive" || !nextEntry) return 0;
  const duration = Math.min(8, currentFadeOut, nextEntry.fadeInSeconds);
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

function transitionFailed(error: unknown) {
  send("track_error", {
    entryId: nextEntry?.entryId,
    message: error instanceof Error ? error.message : String(error),
  });
}

async function beginTransition() {
  if (!currentId || !nextEntry) return;
  transitioning = true;
  const previousId = currentId;
  const previous = decks.get(previousId)!;
  const next = deck(nextEntry.entryId, nextEntry.url);
  const nextId = nextEntry.entryId;
  const duration = adaptiveCrossfadeSeconds();
  next.audio.currentTime = nextEntry.introSeconds;
  next.pastRestartThreshold = next.audio.currentTime > 5;
  previous.gain.gain.cancelScheduledValues(audioContext.currentTime);
  next.gain.gain.cancelScheduledValues(audioContext.currentTime);
  next.gain.gain.value = duration ? 0 : 1;
  await next.audio.play();
  if (!duration) {
    previous.audio.pause();
    currentId = nextId;
    transitioning = false;
    return send("transition", { entryId: previousId });
  }
  const now = audioContext.currentTime;
  const steps = 64;
  previous.gain.gain.setValueCurveAtTime(
    Float32Array.from({ length: steps }, (_, index) =>
      Math.cos((index / (steps - 1)) * (Math.PI / 2)),
    ),
    now,
    duration,
  );
  next.gain.gain.setValueCurveAtTime(
    Float32Array.from({ length: steps }, (_, index) =>
      Math.sin((index / (steps - 1)) * (Math.PI / 2)),
    ),
    now,
    duration,
  );
  handoffTimer = setTimeout(() => {
    handoffTimer = undefined;
    if (!transitioning || currentId !== previousId) return;
    currentId = nextId;
    send("transition", { entryId: previousId });
  }, duration * 500);
  fadeTimer = setTimeout(
    () => {
      fadeTimer = undefined;
      previous.audio.pause();
      previous.gain.gain.cancelScheduledValues(audioContext.currentTime);
      previous.gain.gain.value = 1;
      transitioning = false;
    },
    duration * 1_000 + 50,
  );
}

function showLyrics(message: {
  priority: number;
  lines: LyricLine[];
  source: string;
}) {
  if (message.priority >= lyricPriority) return;
  lyricPriority = message.priority;
  setLyricLines(message.lines);
  lyricsAvailable = true;
  console.log(
    `[lyrics] received ${message.lines.length} lines from ${message.source}`,
  );
}

function clearLyrics() {
  setLyricLines([]);
}

/**
 * Hands a new set of lines to the player and lays them out immediately. The
 * layout has to be forced: the spring animation starts from the previous song's
 * positions, so without it the first line slides in from wherever the last one
 * ended.
 */
function setLyricLines(lines: LyricLine[]) {
  lyricPlayer.setLyricLines(lines, (lyricSource?.currentTime ?? 0) * 1_000);
  lyricPlayer.resetScroll();
  void lyricPlayer.calcLayout(true, true);
}

function markLyricsUnavailable() {
  clearLyrics();
  lyricsAvailable = false;
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
  duckingMode?: string;
}) {
  mediaSessionId = payload.sessionId;
  await audioContext.resume();
  gain.gain.value = volumeGain(payload.initialVolume);
  applyDuck(ducking.setMode(parseDuckingMode(payload.duckingMode), Date.now()));

  const logger = new ConsoleLogger("HuddleFM", LogLevel.WARN);
  const deviceController = new DefaultDeviceController(logger);
  const configuration = new MeetingSessionConfiguration(
    payload.meeting,
    payload.attendee,
  );
  session = new DefaultMeetingSession(configuration, logger, deviceController);
  session.audioVideo.setAudioProfile(AudioProfile.fullbandMusicStereo());
  session.audioVideo.addObserver({
    audioVideoDidStart: () => {
      void setCameraEnabled(cameraEnabled)
        .then(() => {
          status.textContent = "joined";
          send("joined");
        })
        .catch((error) =>
          send("fatal", {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
    },
    metricsDidReceive: (report) => {
      if (!audioReported) {
        report.getRTCStatsReport().forEach((stat) => {
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
    audioVideoDidStop: (event) => {
      status.textContent = "ended";
      send("ended", { code: event.statusCode() });
    },
  });
  listenForSpeech(session, configuration.credentials?.attendeeId ?? undefined);
  await session.audioVideo.startAudioInput(destination.stream);
  session.audioVideo.start();
  session.audioVideo.realtimeUnmuteLocalAudio();
}

/**
 * Watches the volume indicators of everyone but the bot, whose own attendee is
 * the music itself. Chime reports a level and a mute state per attendee; the
 * controller decides what that means for the duck stage.
 */
function listenForSpeech(
  meeting: DefaultMeetingSession,
  botAttendeeId?: string,
) {
  const watch = (attendeeId: string) => {
    if (attendeeId === botAttendeeId || duckSubscriptions.has(attendeeId))
      return;
    const callback = (
      id: string,
      volume: number | null,
      muted: boolean | null,
    ) => applyDuck(ducking.volume(id, volume, muted, Date.now()));
    duckSubscriptions.set(attendeeId, callback);
    meeting.audioVideo.realtimeSubscribeToVolumeIndicator(attendeeId, callback);
  };
  const forget = (attendeeId: string) => {
    const callback = duckSubscriptions.get(attendeeId);
    if (!callback) return;
    duckSubscriptions.delete(attendeeId);
    meeting.audioVideo.realtimeUnsubscribeFromVolumeIndicator(
      attendeeId,
      callback,
    );
    applyDuck(ducking.leave(attendeeId, Date.now()));
  };
  attendeePresence = (attendeeId: string, present: boolean) =>
    present ? watch(attendeeId) : forget(attendeeId);
  meeting.audioVideo.realtimeSubscribeToAttendeeIdPresence(attendeePresence);
}

socket.addEventListener("open", () => send("ready"));
socket.addEventListener("message", async (event) => {
  const message = JSON.parse(String(event.data));
  try {
    if (message.type === "bootstrap") await join(message.payload);
    if (message.type === "tone") playTone(message.frequency);
    if (message.type === "preload") {
      nextEntry = message.entries.find(
        (entry: { entryId: string }) => entry.entryId === message.nextEntryId,
      );
      preload(message.entries);
    }
    if (message.type === "play") {
      const change = ++transition;
      pendingLyrics = undefined;
      pendingNoLyrics = undefined;
      lyricsAvailable = undefined;
      stage.classList.add("changing");
      tone?.stop();
      const alreadyPlaying = currentId === message.entryId;
      if (!alreadyPlaying) cancelTransition(message.entryId);
      const previous = !alreadyPlaying && currentId && decks.get(currentId);
      if (previous) previous.audio.pause();
      currentId = message.entryId;
      currentOutro = message.outroSeconds;
      currentFadeOut = message.fadeOutSeconds ?? 0;
      lyricPriority = Infinity;
      const next = deck(message.entryId, message.url);
      const player = next.audio;
      if (!alreadyPlaying) player.currentTime = 0;
      const now = audioContext.currentTime;
      if (!alreadyPlaying) {
        next.gain.gain.cancelScheduledValues(now);
        next.gain.gain.setValueAtTime(1, now);
        await player.play();
      }
      send("playing", { entryId: message.entryId });
      await new Promise((resolve) => setTimeout(resolve, 220));
      if (change !== transition || currentId !== message.entryId) return;
      title.textContent = message.title;
      artist.textContent = message.requesterLabel
        ? `${message.artist} — ${message.requesterLabel}`
        : message.artist;
      artwork.style.backgroundImage = message.artwork
        ? `url(${JSON.stringify(message.artwork)})`
        : "";
      cover.style.backgroundImage = message.artwork
        ? `url(${JSON.stringify(message.artwork)})`
        : "";
      lyricSource = player;
      clearLyrics();
      const queuedLyrics = takePendingLyrics();
      if (queuedLyrics && queuedLyrics.entryId === message.entryId)
        showLyrics(queuedLyrics);
      else if (pendingNoLyrics === message.entryId) markLyricsUnavailable();
      pendingNoLyrics = undefined;
      await applyDisplayMode();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => stage.classList.remove("changing")),
      );
    }
    if (message.type === "replay" && currentId === message.entryId) {
      cancelTransition();
      const current = decks.get(message.entryId);
      if (!current) return;
      const player = current.audio;
      const intro = Number(message.introSeconds) || 0;
      player.currentTime = intro;
      // Rewinding puts the clock behind the last reported second, which would
      // otherwise mute position reports until playback passed the old end.
      current.pastRestartThreshold = player.currentTime > 5;
      current.lastReportedSecond = -1;
      if (lyricSource === player) seekLyrics(intro);
      const now = audioContext.currentTime;
      current.gain.gain.cancelScheduledValues(now);
      current.gain.gain.setValueAtTime(1, now);
      await player.play();
      send("playing", { entryId: message.entryId });
    }
    if (
      message.type === "lyrics" &&
      currentId === message.entryId &&
      message.priority < lyricPriority
    ) {
      if (stage.classList.contains("changing")) pendingLyrics = message;
      else {
        showLyrics(message);
        await applyDisplayMode();
      }
    }
    if (
      message.type === "lyrics_unavailable" &&
      currentId === message.entryId
    ) {
      if (stage.classList.contains("changing"))
        pendingNoLyrics = message.entryId;
      else {
        markLyricsUnavailable();
        await applyDisplayMode();
      }
    }
    if (message.type === "pause") {
      cancelTransition();
      for (const deck of decks.values())
        if (!deck.audio.paused) deck.audio.pause();
      send("paused");
    }
    if (message.type === "resume") {
      if (currentId) await decks.get(currentId)?.audio.play();
      send("playing", { entryId: currentId });
    }
    if (message.type === "seek" && currentId) {
      cancelTransition();
      const current = decks.get(currentId)!;
      const seconds =
        message.seconds ?? current.audio.currentTime + message.offset;
      current.audio.currentTime = Math.max(
        0,
        Math.min(current.audio.duration || Infinity, seconds),
      );
      current.pastRestartThreshold = current.audio.currentTime > 5;
      if (lyricSource === current.audio) seekLyrics(current.audio.currentTime);
      send("playback_position", {
        entryId: currentId,
        seconds: current.audio.currentTime,
      });
    }
    if (message.type === "stop") stop();
    if (message.type === "volume") gain.gain.value = volumeGain(message.value);
    if (message.type === "ducking_mode")
      applyDuck(ducking.setMode(parseDuckingMode(message.mode), Date.now()));
    if (message.type === "transition_mode") {
      transitionMode = message.mode;
      if (transitioning) cancelTransition();
    }
    if (message.type === "display_mode") await setDisplayMode(message.mode);
    if (message.type === "leave") {
      send("leaving");
      tone?.stop();
      stop();
      stopDucking();
      session?.audioVideo.stop();
      await session?.audioVideo.stopAudioInput();
      session?.audioVideo.stopLocalVideoTile();
      await session?.audioVideo.stopVideoInput();
      cameraRunning = false;
      cameraInputReady = false;
    }
  } catch (error) {
    status.textContent = "error";
    const details = {
      entryId: currentId,
      message: error instanceof Error ? error.message : String(error),
    };
    send(
      message.type === "play" || message.type === "resume"
        ? "track_error"
        : "fatal",
      details,
    );
  }
});
