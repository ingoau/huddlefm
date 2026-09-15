import { expect, test } from "bun:test";
import {
  decay,
  FatigueIndex,
  loadFatigue,
  playHalfLifeMs,
  playWindowMs,
  skipHalfLifeMs,
  skipWindowMs,
} from "./fatigue.ts";
import type { PlayRecord, RoomPlayRecord, SkipRecord } from "./store.ts";

const now = 1_700_000_000_000;

function play(
  userId: string,
  title: string,
  artist = "Band",
  playedAt = now,
): PlayRecord {
  return { userId, title, artist, playedAt };
}

function skip(
  userId: string,
  title: string,
  weight = 1,
  artist = "Band",
  skippedAt = now,
): SkipRecord {
  return { userId, title, artist, weight, skippedAt };
}

function index(options: {
  plays?: PlayRecord[];
  skips?: SkipRecord[];
  room?: RoomPlayRecord[];
}) {
  return new FatigueIndex(
    options.plays ?? [],
    options.skips ?? [],
    options.room ?? [],
    now,
  );
}

test("decays by half over a half-life", () => {
  expect(decay(now, now, playHalfLifeMs)).toBe(1);
  expect(decay(now - playHalfLifeMs, now, playHalfLifeMs)).toBeCloseTo(0.5, 5);
  expect(decay(now - playHalfLifeMs * 2, now, playHalfLifeMs)).toBeCloseTo(
    0.25,
    5,
  );
  // A row stamped in the future is not worth more than a fresh one.
  expect(decay(now + 60_000, now, playHalfLifeMs)).toBe(1);
});

test("weighs down a song this listener has already heard", () => {
  const fatigue = index({ plays: [play("host", "Heard")] });
  const heard = fatigue.multiplier({ title: "Heard", artist: "Band" }, [
    "host",
  ]);
  const fresh = fatigue.multiplier({ title: "Unheard", artist: "Other" }, [
    "host",
  ]);
  expect(fresh).toBe(1);
  expect(heard).toBeLessThan(0.6);
  // Hearing it repeatedly pushes it further down.
  const twice = index({
    plays: [play("host", "Heard"), play("host", "Heard")],
  }).multiplier({ title: "Heard", artist: "Band" }, ["host"]);
  expect(twice).toBeLessThan(heard);
});

test("forgets a play as it ages", () => {
  const fresh = index({ plays: [play("host", "Heard")] });
  const old = index({
    plays: [play("host", "Heard", "Band", now - playHalfLifeMs * 3)],
  });
  const track = { title: "Heard", artist: "Band" };
  expect(old.multiplier(track, ["host"])).toBeGreaterThan(
    fresh.multiplier(track, ["host"]),
  );
  expect(old.multiplier(track, ["host"])).toBeGreaterThan(0.85);
});

test("matches songs across services rather than by exact title", () => {
  const fatigue = index({
    plays: [play("host", "STAY (with Justin Bieber)", "The Kid LAROI")],
  });
  expect(
    fatigue.multiplier(
      { title: "STAY", artist: "The Kid LAROI & Justin Bieber" },
      ["host"],
    ),
  ).toBeLessThan(0.6);
});

test("one listener's fatigue tilts the mix rather than vetoing it", () => {
  const fatigue = index({ plays: [play("host", "Heard")] });
  const track = { title: "Heard", artist: "Band" };
  const alone = fatigue.multiplier(track, ["host"]);
  const room = fatigue.multiplier(track, ["host", "guest", "third", "fourth"]);
  expect(alone).toBeLessThan(0.6);
  // The other three have never heard it, so the room barely notices.
  expect(room).toBeGreaterThan(0.85);
  expect(room).toBeLessThan(1);
});

test("a listener who is not there does not count", () => {
  const fatigue = index({
    plays: [play("absent", "Heard")],
    skips: [skip("absent", "Heard")],
  });
  expect(fatigue.multiplier({ title: "Heard", artist: "Band" }, ["host"])).toBe(
    1,
  );
});

test("weighs a skip more heavily than a play, and its artist far less", () => {
  const track = { title: "Song", artist: "Band" };
  const played = index({ plays: [play("host", "Song")] }).multiplier(track, [
    "host",
  ]);
  const skipped = index({ skips: [skip("host", "Song")] }).multiplier(track, [
    "host",
  ]);
  expect(skipped).toBeLessThan(played);

  // A skip of one song should not quietly cut the artist's whole catalogue.
  const sibling = { title: "Another Song", artist: "Band" };
  const siblingAfterSkip = index({ skips: [skip("host", "Song")] }).multiplier(
    sibling,
    ["host"],
  );
  expect(siblingAfterSkip).toBeGreaterThan(0.85);
});

test("counts a bystander's share of a skip less than the skipper's", () => {
  const track = { title: "Song", artist: "Band" };
  const skipper = index({ skips: [skip("host", "Song", 1)] }).multiplier(
    track,
    ["host"],
  );
  const bystander = index({ skips: [skip("guest", "Song", 0.25)] }).multiplier(
    track,
    ["guest"],
  );
  expect(bystander).toBeGreaterThan(skipper);
  expect(bystander).toBeLessThan(1);
});

test("never suppresses a song entirely", () => {
  const plays = Array.from({ length: 40 }, () => play("host", "Song"));
  const skips = Array.from({ length: 40 }, () => skip("host", "Song"));
  const room = Array.from({ length: 40 }, () => ({
    title: "Song",
    artist: "Band",
    playedAt: now,
  }));
  const worst = index({ plays, skips, room }).multiplier(
    { title: "Song", artist: "Band" },
    ["host"],
  );
  expect(worst).toBeGreaterThan(0);
  expect(worst).toBeGreaterThanOrEqual(0.12);
});

test("the room remembers even when it knows none of the listeners", () => {
  const fatigue = index({
    room: [{ title: "Song", artist: "Band", playedAt: now }],
  });
  const track = { title: "Song", artist: "Band" };
  expect(fatigue.multiplier(track, [])).toBeLessThan(1);
  expect(fatigue.multiplier(track, ["stranger"])).toBeLessThan(1);
  expect(fatigue.multiplier({ title: "Other", artist: "Band" }, [])).toBe(1);
});

test("reads only the window the decay still cares about", () => {
  const reads: Record<string, number> = {};
  const fatigue = loadFatigue(
    {
      recentPlays: (_userIds, since) => {
        reads.plays = since;
        return [];
      },
      recentSkips: (_userIds, since) => {
        reads.skips = since;
        return [];
      },
      recentRoomPlays: (roomId, since) => {
        reads.room = since;
        expect(roomId).toBe("channel");
        return [];
      },
    },
    { userIds: ["host"], roomId: "channel", now },
  );
  expect(reads.plays).toBe(now - playWindowMs);
  expect(reads.skips).toBe(now - skipWindowMs);
  expect(reads.room).toBe(now - playWindowMs);
  expect(fatigue.multiplier({ title: "Song", artist: "Band" }, ["host"])).toBe(
    1,
  );
  expect(playWindowMs).toBe(playHalfLifeMs * 4);
  expect(skipWindowMs).toBe(skipHalfLifeMs * 4);
});

test("skips nothing when the room has no listeners the mix knows", () => {
  let asked = false;
  loadFatigue(
    {
      recentPlays: () => {
        asked = true;
        return [];
      },
      recentSkips: () => [],
      recentRoomPlays: () => [],
    },
    { userIds: [], now },
  );
  // The store decides an empty listener list costs nothing; it is still asked
  // so an empty room does not silently skip the room memory either.
  expect(asked).toBeTrue();
});

test("keeps non-Latin songs apart instead of collapsing them together", () => {
  const fatigue = index({
    plays: [play("host", "夜に駆ける", "YOASOBI")],
  });
  expect(
    fatigue.multiplier({ title: "夜に駆ける", artist: "YOASOBI" }, ["host"]),
  ).toBeLessThan(0.6);
  // A different song by the same artist is a different song.
  expect(
    fatigue.multiplier({ title: "群青", artist: "YOASOBI" }, ["host"]),
  ).toBeGreaterThan(0.85);
  // And so is a different song by a different artist, in another script.
  expect(
    fatigue.multiplier({ title: "Кукушка", artist: "Кино" }, ["host"]),
  ).toBe(1);
});

test("still folds an accent rather than splitting the word at it", () => {
  const fatigue = index({ plays: [play("host", "Hoppípolla", "Sigur Rós")] });
  expect(
    fatigue.multiplier({ title: "Hoppipolla", artist: "Sigur Ros" }, ["host"]),
  ).toBeLessThan(0.6);
});
