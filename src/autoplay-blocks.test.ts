import { expect, test } from "bun:test";
import {
  cooldownCapMs,
  cooldownMs,
  cooldownWindowMs,
  roomBlocks,
} from "./autoplay-blocks.ts";
import type { RoomAdd, RoomSkip } from "./store.ts";

const now = 1_000 * cooldownWindowMs;
const day = 24 * 60 * 60_000;

function skip(userId: string | undefined, ago = day, overrides = {}): RoomSkip {
  return {
    ...(userId ? { userId } : {}),
    sourceId: "song",
    title: "Song",
    artist: "Band",
    skippedAt: now - ago,
    ...overrides,
  };
}

function add(requesterId: string, overrides = {}): RoomAdd {
  return {
    requesterId,
    sourceId: "song",
    title: "Song",
    artist: "Band",
    ...overrides,
  };
}

const blocked = (skips: RoomSkip[], adds: RoomAdd[]) =>
  roomBlocks(skips, adds, { botUserId: "bot", now }).sourceIds.has("song");

test("a skipped song at most one person chose is blocked", () => {
  expect(blocked([skip("U1", 300 * day)], [])).toBeTrue();
  expect(blocked([skip("U2", 300 * day)], [add("U1")])).toBeTrue();
  // Adding it again on your own does not make it the room's.
  expect(
    blocked([skip("U2", 300 * day)], [add("U1"), add("U1"), add("U1")]),
  ).toBeTrue();
  // Autoplay choosing it says nothing about the room.
  expect(blocked([skip("U2", 300 * day)], [add("U1"), add("bot")])).toBeTrue();
  // Nothing skipped, nothing blocked.
  expect(blocked([], [add("U1")])).toBeFalse();
});

test("a song several people chose only rests after a skip", () => {
  const adds = [add("U1"), add("U2")];
  expect(blocked([skip("U3", cooldownMs - day)], adds)).toBeTrue();
  expect(blocked([skip("U3", cooldownMs + day)], adds)).toBeFalse();
  // A second person adding it lifts a block that one adder had.
  expect(blocked([skip("U3", 30 * day)], [add("U1")])).toBeTrue();
  expect(blocked([skip("U3", 30 * day)], adds)).toBeFalse();
});

test("each recent skip doubles the rest, up to a cap", () => {
  const adds = [add("U1"), add("U2"), add("U3"), add("U4")];
  // Two skips: twice the rest after the latest.
  const twice = [skip("U5", 40 * day), skip("U5", 2 * cooldownMs - day)];
  expect(blocked(twice, adds)).toBeTrue();
  expect(
    blocked([skip("U5", 40 * day), skip("U5", 2 * cooldownMs + day)], adds),
  ).toBeFalse();
  // Many skips never rest it past the cap.
  const many = Array.from({ length: 8 }, (_, index) =>
    skip("U5", cooldownCapMs + day + index),
  );
  expect(blocked(many, adds)).toBeFalse();
  // Skips from long ago do not count towards the rest.
  expect(
    blocked(
      [skip("U5", cooldownWindowMs + day), skip("U5", cooldownMs + day)],
      adds,
    ),
  ).toBeFalse();
});

test("a song as many people skipped as chose is blocked", () => {
  const adds = [add("U1"), add("U2")];
  expect(
    blocked([skip("U3", 300 * day), skip("U4", 300 * day)], adds),
  ).toBeTrue();
  // The same person skipping twice is still one person.
  expect(
    blocked([skip("U3", 300 * day), skip("U3", 200 * day)], adds),
  ).toBeFalse();
});

test("forgotten adders and skippers each count as one more person", () => {
  expect(blocked([skip(undefined, 300 * day)], [add(""), add("")])).toBeTrue();
  expect(
    blocked([skip(undefined, 300 * day)], [add(""), add("U1")]),
  ).toBeFalse();
});

test("another upload of a skipped song is the same song", () => {
  const blocks = roomBlocks(
    [skip("U3", 300 * day)],
    [add("U1"), add("U2", { sourceId: "reupload" })],
    { now },
  );
  // Two people chose it, under two uploads, so it only rested.
  expect(blocks.sourceIds.size).toBe(0);
  const lone = roomBlocks(
    [skip("U3", 300 * day, { sourceId: "reupload" })],
    [add("U1")],
    { now },
  );
  expect([...lone.sourceIds].sort()).toEqual(["reupload", "song"]);
  expect(lone.keys.size).toBe(1);
  expect(lone.tracks).toEqual([
    { sourceId: "reupload", title: "Song", artist: "Band" },
  ]);
});

test("an unknown artist does not tie different songs together", () => {
  const unknown = { title: "Intro", artist: "Unknown artist" };
  const blocks = roomBlocks(
    [skip("U3", 300 * day, { ...unknown, sourceId: "one" })],
    [
      add("U1", { ...unknown, sourceId: "two" }),
      add("U2", { ...unknown, sourceId: "two" }),
    ],
    { now },
  );
  expect([...blocks.sourceIds]).toEqual(["one"]);
  expect(blocks.keys.size).toBe(0);
});

test("an add that only shares a name with another add still counts", () => {
  const blocks = roomBlocks(
    [skip("U3", 300 * day)],
    [
      // Alice added another upload under the song's name; Carol added that
      // upload when its artist was unknown.
      add("alice", { sourceId: "reupload" }),
      add("carol", { sourceId: "reupload", artist: "Unknown artist" }),
    ],
    { now },
  );
  expect(blocks.sourceIds.size).toBe(0);
});
