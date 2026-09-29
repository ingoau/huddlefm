import {
  DuckingController,
  parseDuckingMode,
  type DuckDecision,
} from "../ducking.ts";
import { errorMessage } from "../error-message.ts";
import { volumeGain } from "../volume.ts";
import { Compressor } from "./compressor.ts";
import {
  sampleRate,
  type Decoder,
  type DecoderFactory,
  type DurationProbe,
} from "./decoder.ts";

export type MediaEmit = (type: string, details?: unknown) => void;
export type TransitionMode = "none" | "gapless" | "adaptive";

/** Decoded audio a deck must hold before a transition may start on it. */
const readyFrames = sampleRate;
/** Decoded audio that counts as "can play through", for `preloaded`. */
const preloadedFrames = sampleRate * 3;
/** Continuous underrun that counts as a stalled track. */
const stallFrames = sampleRate * 10;

type Fade = { start: number; length: number; direction: "in" | "out" };

/** One track's decoder and playback state; the page's <audio> element. */
class Deck {
  decoder: Decoder;
  position: number;
  playing = false;
  level = 1;
  fade: Fade | undefined;
  pastRestartThreshold = false;
  lastReportedSecond = -1;
  underrunFrames = 0;
  preloadedSent = false;
  endedSent = false;
  errorSent = false;
  stalledSent = false;
  /** The file's own length, once probed. */
  duration: number | undefined;

  constructor(
    readonly entryId: string,
    readonly url: string,
    private factory: DecoderFactory,
    startSeconds = 0,
  ) {
    this.position = startSeconds;
    this.decoder = factory(url, startSeconds);
  }

  /** Moves playback to `seconds`, skipping decoded audio when it can. */
  seek(seconds: number) {
    const ahead = seconds - this.position;
    if (
      ahead >= 0 &&
      ahead * sampleRate <= this.decoder.bufferedFrames &&
      !this.decoder.error
    ) {
      let skip = Math.round(ahead * sampleRate);
      const scratch = new Float32Array(Math.min(skip, sampleRate) * 2);
      while (skip > 0) {
        const read = this.decoder.read(scratch, Math.min(skip, sampleRate));
        if (!read) break;
        skip -= read;
      }
    } else {
      this.decoder.close();
      this.decoder = this.factory(this.url, seconds);
    }
    this.position = seconds;
    this.underrunFrames = 0;
    this.endedSent = false;
    this.errorSent = false;
    this.stalledSent = false;
  }

  gainAt(sample: number) {
    const fade = this.fade;
    if (!fade) return this.level;
    const progress = Math.min(
      1,
      Math.max(0, (sample - fade.start) / fade.length),
    );
    const angle = progress * (Math.PI / 2);
    return fade.direction === "in" ? Math.sin(angle) : Math.cos(angle);
  }

  setLevel(level: number) {
    this.fade = undefined;
    this.level = level;
  }

  close() {
    this.decoder.close();
  }
}

type NextEntry = {
  entryId: string;
  url: string;
  introSeconds: number;
  fadeInSeconds: number;
};

type Ramp = { from: number; to: number; start: number; length: number };

/**
 * The music side of the native backend: the media page's decks, crossfades,
 * volume and ducking stages and limiter, driven by the coordinator's media
 * messages and rendered 20 ms at a time. Timing runs on the sample clock, so
 * transitions land on exact samples instead of animation frames.
 */
export class AudioEngine {
  readonly ducking = new DuckingController();
  private decks = new Map<string, Deck>();
  private currentId: string | undefined;
  private nextEntry: NextEntry | undefined;
  private currentOutro: number | undefined;
  private currentFadeOut = 0;
  /** The length the coordinator listed, until the file has been probed. */
  private listedDuration: number | undefined;
  private transitionMode: TransitionMode = "none";
  private transitioning = false;
  private handoff:
    { at: number; previousId: string; nextId: string } | undefined;
  private fadeEnd: { at: number; previousId: string } | undefined;
  private master = 1;
  private duck: Ramp = { from: 1, to: 1, start: 0, length: 0 };
  private duckTimer: ReturnType<typeof setTimeout> | undefined;
  private tone: { frequency: number; phase: number } | undefined;
  private clock = 0;
  private compressor = new Compressor(sampleRate);
  private scratch = new Float32Array(0);

  constructor(
    private decoderFactory: DecoderFactory,
    private emit: MediaEmit,
    private probe: DurationProbe = async () => undefined,
  ) {}

  /** Handles one coordinator media message. Returns false when unhandled. */
  handle(message: Record<string, any>) {
    try {
      return this.dispatch(message);
    } catch (error) {
      this.emit(
        message.type === "play" || message.type === "resume"
          ? "track_error"
          : "fatal",
        { entryId: this.currentId, message: errorMessage(error) },
      );
      return true;
    }
  }

  setVolume(value: number) {
    this.master = volumeGain(value);
  }

  setDuckingMode(mode: unknown) {
    this.applyDuck(this.ducking.setMode(parseDuckingMode(mode), Date.now()));
  }

  /** Lands the duck stage on a decision, holding wherever a ramp got to. */
  applyDuck = (decision: DuckDecision | undefined) => {
    if (!decision) return;
    clearTimeout(this.duckTimer);
    this.duckTimer = undefined;
    this.duck = {
      from: this.duckAt(this.clock),
      to: decision.gain,
      start: this.clock,
      length: Math.round(decision.rampSeconds * sampleRate),
    };
    if (decision.recheckMs !== undefined)
      this.duckTimer = setTimeout(
        () => this.applyDuck(this.ducking.tick(Date.now())),
        decision.recheckMs,
      );
  };

  get duckGain() {
    return this.duckAt(this.clock);
  }

  /** Where the current track is, for the video card. */
  progress() {
    const deck = this.currentId ? this.decks.get(this.currentId) : undefined;
    if (!deck) return undefined;
    return { position: deck.position, duration: this.durationOf(deck) };
  }

  /** Like the page's `audio.duration`: the file's, once it is known. */
  private durationOf(deck: Deck) {
    return deck.duration ?? this.listedDuration;
  }

  get current() {
    return this.currentId;
  }

  /** Clears every deck and the playing track, like the page's stop(). */
  stop() {
    this.clearTransition();
    this.currentId = undefined;
    this.nextEntry = undefined;
    this.currentOutro = undefined;
    this.currentFadeOut = 0;
    this.listedDuration = undefined;
    for (const deck of this.decks.values()) deck.close();
    this.decks.clear();
  }

  stopTone() {
    this.tone = undefined;
  }

  dispose() {
    this.stop();
    this.stopTone();
    clearTimeout(this.duckTimer);
    this.applyDuck(this.ducking.reset());
    clearTimeout(this.duckTimer);
  }

  private dispatch(message: Record<string, any>) {
    switch (message.type) {
      case "tone":
        this.tone = { frequency: Number(message.frequency) || 440, phase: 0 };
        this.emit("playing", { frequency: this.tone.frequency });
        return true;
      case "preload":
        this.nextEntry = (message.entries as NextEntry[]).find(
          (entry) => entry.entryId === message.nextEntryId,
        );
        this.preload(message.entries);
        return true;
      case "play":
        this.play(message);
        return true;
      case "replay":
        if (this.currentId === message.entryId) this.replay(message);
        return true;
      case "pause":
        this.cancelTransition();
        for (const deck of this.decks.values()) deck.playing = false;
        this.emit("paused");
        return true;
      case "resume": {
        const deck = this.currentId
          ? this.decks.get(this.currentId)
          : undefined;
        if (deck) deck.playing = true;
        this.emit("playing", { entryId: this.currentId });
        return true;
      }
      case "seek":
        if (this.currentId) this.seek(message);
        return true;
      case "stop":
        this.stop();
        return true;
      case "volume":
        this.setVolume(Number(message.value));
        return true;
      case "ducking_mode":
        this.setDuckingMode(message.mode);
        return true;
      case "transition_mode":
        this.transitionMode = message.mode;
        if (this.transitioning) this.cancelTransition();
        return true;
      default:
        return false;
    }
  }

  private deck(entryId: string, url: string, startSeconds = 0) {
    const existing = this.decks.get(entryId);
    if (existing?.url === url) return existing;
    existing?.close();
    const deck = new Deck(entryId, url, this.decoderFactory, startSeconds);
    this.decks.set(entryId, deck);
    this.probe(url)
      .then((seconds) => {
        if (seconds && seconds > 0) deck.duration = seconds;
      })
      .catch(() => {});
    return deck;
  }

  private preload(entries: NextEntry[]) {
    const keep = new Set([this.currentId, ...entries.map((e) => e.entryId)]);
    for (const entry of entries) {
      // The next track starts at its intro when a transition will play it, so
      // decode from there; otherwise `play` starts it from the top.
      const start =
        entry.entryId === this.nextEntry?.entryId &&
        this.transitionMode !== "none"
          ? Number(entry.introSeconds) || 0
          : 0;
      this.deck(entry.entryId, entry.url, start);
    }
    for (const [entryId, deck] of this.decks)
      if (!keep.has(entryId)) {
        deck.close();
        this.decks.delete(entryId);
      }
  }

  private play(message: Record<string, any>) {
    this.tone = undefined;
    const alreadyPlaying = this.currentId === message.entryId;
    if (!alreadyPlaying) {
      this.cancelTransition(message.entryId);
      const previous = this.currentId
        ? this.decks.get(this.currentId)
        : undefined;
      if (previous) previous.playing = false;
    }
    this.currentId = message.entryId;
    this.currentOutro = message.outroSeconds;
    this.currentFadeOut = message.fadeOutSeconds ?? 0;
    this.listedDuration =
      Number(message.duration) > 0 ? Number(message.duration) : undefined;
    const deck = this.deck(message.entryId, message.url);
    if (!alreadyPlaying) {
      if (deck.position !== 0) deck.seek(0);
      else {
        deck.endedSent = false;
        deck.errorSent = false;
      }
      deck.setLevel(1);
      deck.playing = true;
    }
    this.emit("playing", { entryId: message.entryId });
  }

  private replay(message: Record<string, any>) {
    this.cancelTransition();
    const deck = this.decks.get(message.entryId);
    if (!deck) return;
    deck.seek(Number(message.introSeconds) || 0);
    // Rewinding puts the clock behind the last reported second, which would
    // otherwise mute position reports until playback passed the old end.
    deck.pastRestartThreshold = deck.position > 5;
    deck.lastReportedSecond = -1;
    deck.setLevel(1);
    deck.playing = true;
    this.emit("playing", { entryId: message.entryId });
  }

  private seek(message: Record<string, any>) {
    this.cancelTransition();
    const deck = this.decks.get(this.currentId!);
    if (!deck) return;
    const seconds =
      message.seconds ?? deck.position + Number(message.offset ?? 0);
    const clamped = Math.max(
      0,
      Math.min(this.durationOf(deck) ?? Infinity, Number(seconds)),
    );
    deck.seek(clamped);
    deck.pastRestartThreshold = deck.position > 5;
    this.emit("playback_position", {
      entryId: this.currentId,
      seconds: deck.position,
    });
  }

  private clearTransition() {
    this.transitioning = false;
    this.handoff = undefined;
    this.fadeEnd = undefined;
  }

  private cancelTransition(keepId = this.currentId) {
    this.clearTransition();
    for (const [entryId, deck] of this.decks) {
      deck.setLevel(entryId === keepId ? 1 : 0);
      if (entryId !== keepId) deck.playing = false;
    }
  }

  private crossfadeSeconds() {
    if (this.transitionMode !== "adaptive" || !this.nextEntry) return 0;
    const seconds = Math.min(
      8,
      this.currentFadeOut,
      this.nextEntry.fadeInSeconds,
    );
    return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  }

  private transitionDue(current: Deck) {
    const next = this.nextEntry;
    if (
      !next ||
      next.entryId === this.currentId ||
      this.currentOutro === undefined ||
      this.transitionMode === "none" ||
      this.transitioning ||
      !current.playing
    )
      return false;
    const deck = this.decks.get(next.entryId);
    if (
      !deck ||
      deck.decoder.error ||
      (deck.decoder.bufferedFrames < readyFrames && !deck.decoder.drained)
    )
      return false;
    return current.position >= this.currentOutro - this.crossfadeSeconds();
  }

  private beginTransition() {
    const next = this.nextEntry!;
    const previousId = this.currentId!;
    const previous = this.decks.get(previousId)!;
    const deck = this.deck(next.entryId, next.url);
    const seconds = this.crossfadeSeconds();
    this.transitioning = true;
    const intro = Number(next.introSeconds) || 0;
    if (deck.position !== intro) deck.seek(intro);
    deck.pastRestartThreshold = deck.position > 5;
    deck.playing = true;
    if (!seconds) {
      deck.setLevel(1);
      previous.playing = false;
      this.currentId = next.entryId;
      this.transitioning = false;
      this.emit("transition", { entryId: previousId });
      return;
    }
    const length = Math.round(seconds * sampleRate);
    previous.fade = { start: this.clock, length, direction: "out" };
    deck.fade = { start: this.clock, length, direction: "in" };
    this.handoff = {
      at: this.clock + Math.round(length / 2),
      previousId,
      nextId: next.entryId,
    };
    this.fadeEnd = {
      at: this.clock + length + Math.round(0.05 * sampleRate),
      previousId,
    };
  }

  private runSchedule() {
    const handoff = this.handoff;
    if (handoff && this.clock >= handoff.at) {
      this.handoff = undefined;
      if (this.transitioning && this.currentId === handoff.previousId) {
        this.currentId = handoff.nextId;
        this.emit("transition", { entryId: handoff.previousId });
      }
    }
    const fadeEnd = this.fadeEnd;
    if (fadeEnd && this.clock >= fadeEnd.at) {
      this.fadeEnd = undefined;
      const previous = this.decks.get(fadeEnd.previousId);
      if (previous) {
        previous.playing = false;
        previous.setLevel(1);
      }
      // The incoming deck finished its fade-in at gain 1.
      for (const deck of this.decks.values())
        if (deck.fade?.direction === "in") deck.setLevel(1);
      this.transitioning = false;
    }
    const current = this.currentId ? this.decks.get(this.currentId) : undefined;
    if (current && this.transitionDue(current)) this.beginTransition();
  }

  private duckAt(sample: number) {
    const { from, to, start, length } = this.duck;
    if (length <= 0 || sample >= start + length) return to;
    return from + ((to - from) * (sample - start)) / length;
  }

  /** Renders the next `frames` stereo frames and advances the clock. */
  render(frames: number) {
    this.runSchedule();
    const out = new Float32Array(frames * 2);
    if (this.scratch.length < frames * 2)
      this.scratch = new Float32Array(frames * 2);
    for (const deck of this.decks.values()) this.renderDeck(deck, out, frames);
    for (const deck of this.decks.values()) this.reportLoad(deck);
    if (this.tone) {
      const step = (2 * Math.PI * this.tone.frequency) / sampleRate;
      for (let index = 0; index < frames; index++) {
        const value = Math.sin(this.tone.phase);
        this.tone.phase = (this.tone.phase + step) % (2 * Math.PI);
        out[index * 2] = out[index * 2]! + value;
        out[index * 2 + 1] = out[index * 2 + 1]! + value;
      }
    }
    for (let index = 0; index < frames; index++) {
      const gain = this.master * this.duckAt(this.clock + index);
      out[index * 2] = out[index * 2]! * gain;
      out[index * 2 + 1] = out[index * 2 + 1]! * gain;
    }
    this.compressor.process(out);
    this.clock += frames;
    return out;
  }

  private renderDeck(deck: Deck, out: Float32Array, frames: number) {
    if (!deck.playing) return;
    const isCurrent = deck.entryId === this.currentId;
    const decoder = deck.decoder;
    if (decoder.error) {
      deck.playing = false;
      if (isCurrent && !deck.errorSent) {
        deck.errorSent = true;
        this.emit("track_error", {
          entryId: deck.entryId,
          message: decoder.error,
        });
      }
      return;
    }
    const read = decoder.read(this.scratch, frames);
    for (let index = 0; index < read; index++) {
      const gain = deck.gainAt(this.clock + index);
      out[index * 2] = out[index * 2]! + this.scratch[index * 2]! * gain;
      out[index * 2 + 1] =
        out[index * 2 + 1]! + this.scratch[index * 2 + 1]! * gain;
    }
    if (read) {
      deck.position += read / sampleRate;
      this.reportPosition(deck);
    }
    if (read < frames) {
      if (decoder.drained) {
        deck.playing = false;
        if (isCurrent && !deck.endedSent) {
          deck.endedSent = true;
          this.emit("track_ended", { entryId: deck.entryId });
        }
        return;
      }
      deck.underrunFrames += frames - read;
      if (
        isCurrent &&
        !deck.stalledSent &&
        deck.underrunFrames >= stallFrames
      ) {
        deck.stalledSent = true;
        this.emit("stalled", { entryId: deck.entryId });
      }
    } else deck.underrunFrames = 0;
  }

  // The page reported through <audio> timeupdate: every two seconds, and as
  // soon as playback crosses the five-second restart threshold.
  private reportPosition(deck: Deck) {
    const pastRestartThreshold = deck.position > 5;
    const second = Math.floor(deck.position);
    if (
      pastRestartThreshold === deck.pastRestartThreshold &&
      second - deck.lastReportedSecond < 2
    )
      return;
    deck.pastRestartThreshold = pastRestartThreshold;
    deck.lastReportedSecond = second;
    this.emit("playback_position", {
      entryId: deck.entryId,
      seconds: deck.position,
    });
  }

  private reportLoad(deck: Deck) {
    if (deck.preloadedSent) return;
    if (
      deck.decoder.bufferedFrames >= preloadedFrames ||
      deck.decoder.drained
    ) {
      deck.preloadedSent = true;
      this.emit("preloaded", { entryId: deck.entryId });
    }
  }
}
