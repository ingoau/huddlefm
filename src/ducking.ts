import type { DuckingMode } from "./store.ts";
import { volumeGain } from "./volume.ts";

/**
 * Gain the music is pulled down to while someone is speaking, as a multiplier
 * applied on top of whatever volume the huddle chose. Gentle keeps the music
 * audible under a short exchange; strong is close to a conversational pause.
 */
export const duckLevels: Record<DuckingMode, number> = {
  off: 1,
  gentle: 0.45,
  strong: 0.15,
};

/** Ducking used when nothing is stored for a session and no env var is set. */
export const defaultDuckingMode: DuckingMode = "gentle";

/** Seconds to drop into the duck; short enough not to talk over the first word. */
export const duckAttackSeconds = 0.12;

/** Seconds to bring the music back once the hold has elapsed. */
export const duckReleaseSeconds = 0.7;

/**
 * Milliseconds the duck is held after the last speaker falls quiet. Gaps
 * between words and sentences are shorter than this, so the music does not
 * pump its way through a conversation.
 */
export const duckHoldMs = 1_000;

/** Chime volume indicator level an unmuted attendee counts as speech at. */
export const speechVolumeThreshold = 0.05;

export function parseDuckingMode(value: unknown): DuckingMode {
  return typeof value === "string" && value in duckLevels
    ? (value as DuckingMode)
    : defaultDuckingMode;
}

/**
 * What the huddle actually hears: the volume the session chose, scaled by the
 * duck stage. The two are separate gain nodes so ducking never rewrites — or
 * has to restore — the volume the buttons and the settings modal report.
 */
export function duckedGain(volume: number, duck: number) {
  return volumeGain(volume) * duck;
}

export type DuckDecision = {
  /** Gain the duck stage should land on. */
  gain: number;
  /** Seconds to ramp there over; 0 lands immediately. */
  rampSeconds: number;
  /** Milliseconds until `tick` should run, while a release is pending. */
  recheckMs?: number;
};

/**
 * Decides when the music ducks and when it comes back. Fed by Chime volume
 * indicators, which report a level and a mute state per attendee (either of
 * which is null when it has not changed since the last report).
 */
export class DuckingController {
  private levels = new Map<string, { volume: number; muted: boolean }>();
  private speakers = new Set<string>();
  private releaseAt: number | undefined;
  private target = 1;

  constructor(private mode: DuckingMode = "off") {}

  /** Gain the duck stage was last told to reach. */
  get gain() {
    return this.target;
  }

  /** Attendees currently counted as speaking. */
  get speaking() {
    return this.speakers.size;
  }

  setMode(mode: DuckingMode, now: number) {
    this.mode = mode;
    return this.decide(now);
  }

  /** A volume indicator for one attendee. */
  volume(
    attendeeId: string,
    volume: number | null,
    muted: boolean | null,
    now: number,
  ) {
    const level = this.levels.get(attendeeId) ?? { volume: 0, muted: false };
    if (volume !== null) level.volume = volume;
    if (muted !== null) level.muted = muted;
    this.levels.set(attendeeId, level);
    if (!level.muted && level.volume >= speechVolumeThreshold)
      this.speakers.add(attendeeId);
    else this.speakers.delete(attendeeId);
    return this.decide(now);
  }

  /** An attendee left the huddle, so they cannot still be speaking. */
  leave(attendeeId: string, now: number) {
    this.levels.delete(attendeeId);
    this.speakers.delete(attendeeId);
    return this.decide(now);
  }

  /** Called when a pending release is due. */
  tick(now: number): DuckDecision | undefined {
    const decision = this.decide(now);
    if (decision) return decision;
    // Woken early: keep waiting rather than leaving the release unscheduled.
    if (this.releaseAt === undefined) return undefined;
    return {
      gain: this.target,
      rampSeconds: 0,
      recheckMs: Math.max(0, this.releaseAt - now),
    };
  }

  /** Drops every attendee and restores the music, for teardown. */
  reset(): DuckDecision | undefined {
    this.levels.clear();
    this.speakers.clear();
    this.releaseAt = undefined;
    if (this.target === 1) return undefined;
    this.target = 1;
    return { gain: 1, rampSeconds: 0 };
  }

  private decide(now: number): DuckDecision | undefined {
    const previousTarget = this.target;
    const previousRelease = this.releaseAt;
    const level = duckLevels[this.mode];
    if (level >= 1) {
      // Ducking is off; nothing holds the music down.
      this.releaseAt = undefined;
      this.target = 1;
    } else if (this.speakers.size) {
      this.releaseAt = undefined;
      this.target = level;
    } else if (previousTarget < 1) {
      if (previousRelease === undefined) this.releaseAt = now + duckHoldMs;
      else if (now >= previousRelease) this.releaseAt = undefined;
      this.target = this.releaseAt === undefined ? 1 : level;
    } else {
      this.releaseAt = undefined;
      this.target = 1;
    }
    if (this.target === previousTarget && this.releaseAt === previousRelease)
      return undefined;
    const rampSeconds =
      this.target === previousTarget
        ? 0
        : this.target < previousTarget
          ? duckAttackSeconds
          : duckReleaseSeconds;
    return {
      gain: this.target,
      rampSeconds,
      ...(this.releaseAt === undefined
        ? {}
        : { recheckMs: Math.max(0, this.releaseAt - now) }),
    };
  }
}
