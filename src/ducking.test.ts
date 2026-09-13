import { expect, test } from "bun:test";
import {
  DuckingController,
  duckAttackSeconds,
  duckHoldMs,
  duckLevels,
  duckReleaseSeconds,
  duckedGain,
  defaultDuckingMode,
  parseDuckingMode,
} from "./ducking.ts";
import { volumeGain } from "./volume.ts";

test("ignores speech while ducking is off", () => {
  const ducking = new DuckingController("off");
  expect(ducking.volume("guest", 0.8, false, 0)).toBeUndefined();
  expect(ducking.speaking).toBe(1);
  expect(ducking.gain).toBe(1);
});

test("ducks on speech and releases after the hold", () => {
  const ducking = new DuckingController("gentle");
  expect(ducking.volume("guest", 0.6, false, 0)).toEqual({
    gain: duckLevels.gentle,
    rampSeconds: duckAttackSeconds,
  });
  // Still speaking: nothing new to schedule.
  expect(ducking.volume("guest", 0.5, null, 50)).toBeUndefined();
  expect(ducking.volume("guest", 0, null, 100)).toEqual({
    gain: duckLevels.gentle,
    rampSeconds: 0,
    recheckMs: duckHoldMs,
  });
  // The hold keeps the music down until it elapses.
  expect(ducking.tick(100 + duckHoldMs - 10)).toEqual({
    gain: duckLevels.gentle,
    rampSeconds: 0,
    recheckMs: 10,
  });
  expect(ducking.tick(100 + duckHoldMs)).toEqual({
    gain: 1,
    rampSeconds: duckReleaseSeconds,
  });
  expect(ducking.gain).toBe(1);
});

test("holds through the gaps between words", () => {
  const ducking = new DuckingController("strong");
  ducking.volume("guest", 0.4, false, 0);
  expect(ducking.gain).toBe(duckLevels.strong);
  expect(ducking.volume("guest", 0.01, null, 200)?.recheckMs).toBe(duckHoldMs);
  // Speech resumes inside the hold: the release is cancelled and the duck
  // stays exactly where it was rather than stopping partway back.
  expect(ducking.volume("guest", 0.5, null, 500)).toEqual({
    gain: duckLevels.strong,
    rampSeconds: 0,
  });
  expect(ducking.volume("guest", 0, null, 900)?.recheckMs).toBe(duckHoldMs);
  // The hold restarts from the last word, not from the first one.
  expect(ducking.tick(900 + duckHoldMs - 1)?.gain).toBe(duckLevels.strong);
  expect(ducking.tick(900 + duckHoldMs)).toEqual({
    gain: 1,
    rampSeconds: duckReleaseSeconds,
  });
});

test("stays ducked until every speaker stops", () => {
  const ducking = new DuckingController("gentle");
  ducking.volume("first", 0.6, false, 0);
  expect(ducking.volume("second", 0.6, false, 10)).toBeUndefined();
  expect(ducking.speaking).toBe(2);
  expect(ducking.volume("first", 0, null, 20)).toBeUndefined();
  expect(ducking.volume("second", 0, null, 30)).toEqual({
    gain: duckLevels.gentle,
    rampSeconds: 0,
    recheckMs: duckHoldMs,
  });
});

test("ignores quiet and muted attendees", () => {
  const ducking = new DuckingController("gentle");
  expect(ducking.volume("guest", 0.01, false, 0)).toBeUndefined();
  expect(ducking.volume("guest", 0.9, true, 10)).toBeUndefined();
  expect(ducking.gain).toBe(1);
  // Unmuting without a fresh level reuses the last one Chime reported.
  expect(ducking.volume("guest", null, false, 20)).toEqual({
    gain: duckLevels.gentle,
    rampSeconds: duckAttackSeconds,
  });
  expect(ducking.volume("guest", null, true, 30)?.recheckMs).toBe(duckHoldMs);
});

test("releases when a speaking attendee leaves", () => {
  const ducking = new DuckingController("gentle");
  ducking.volume("guest", 0.6, false, 0);
  expect(ducking.leave("guest", 10)).toEqual({
    gain: duckLevels.gentle,
    rampSeconds: 0,
    recheckMs: duckHoldMs,
  });
  expect(ducking.tick(10 + duckHoldMs)?.gain).toBe(1);
  expect(ducking.leave("guest", 20)).toBeUndefined();
});

test("changing the mode takes effect mid-conversation", () => {
  const ducking = new DuckingController("gentle");
  ducking.volume("guest", 0.6, false, 0);
  expect(ducking.setMode("strong", 10)).toEqual({
    gain: duckLevels.strong,
    rampSeconds: duckAttackSeconds,
  });
  // Turning ducking off restores the music without waiting out the hold.
  expect(ducking.setMode("off", 20)).toEqual({
    gain: 1,
    rampSeconds: duckReleaseSeconds,
  });
  expect(ducking.setMode("gentle", 30)).toEqual({
    gain: duckLevels.gentle,
    rampSeconds: duckAttackSeconds,
  });
});

test("turning ducking off during the hold cancels the release", () => {
  const ducking = new DuckingController("gentle");
  ducking.volume("guest", 0.6, false, 0);
  ducking.volume("guest", 0, null, 10);
  expect(ducking.setMode("off", 20)).toEqual({
    gain: 1,
    rampSeconds: duckReleaseSeconds,
  });
  expect(ducking.tick(1_000)).toBeUndefined();
});

test("resets for teardown", () => {
  const ducking = new DuckingController("gentle");
  ducking.volume("guest", 0.6, false, 0);
  expect(ducking.reset()).toEqual({ gain: 1, rampSeconds: 0 });
  expect(ducking.speaking).toBe(0);
  expect(ducking.reset()).toBeUndefined();
  // The old attendees are gone, so a stale tick cannot duck again.
  expect(ducking.tick(5_000)).toBeUndefined();
});

test("leaves the chosen volume untouched across a duck", () => {
  const ducking = new DuckingController("gentle");
  const volume = 0.35;
  expect(duckedGain(volume, ducking.gain)).toBe(volumeGain(volume));
  ducking.volume("guest", 0.6, false, 0);
  expect(duckedGain(volume, ducking.gain)).toBeCloseTo(
    volumeGain(volume) * duckLevels.gentle,
    10,
  );
  ducking.volume("guest", 0, null, 10);
  ducking.tick(10 + duckHoldMs);
  expect(duckedGain(volume, ducking.gain)).toBe(volumeGain(volume));
});

test("parses stored and configured modes", () => {
  expect(parseDuckingMode("strong")).toBe("strong");
  expect(parseDuckingMode("off")).toBe("off");
  expect(parseDuckingMode(undefined)).toBe(defaultDuckingMode);
  expect(parseDuckingMode("loud")).toBe(defaultDuckingMode);
  expect(parseDuckingMode(true)).toBe(defaultDuckingMode);
});
