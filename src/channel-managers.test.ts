import { expect, test } from "bun:test";
import { ChannelManagers } from "./channel-managers.ts";

function tracked(managers: string[]) {
  const lookups: string[] = [];
  return {
    lookups,
    lookup: async (channelId: string) => {
      lookups.push(channelId);
      return managers;
    },
  };
}

test("resolves once per channel and answers later checks from the cache", async () => {
  const { lookup, lookups } = tracked(["manager"]);
  const managers = new ChannelManagers(lookup);
  expect(managers.isManager("C1", "manager")).toBe(false);
  expect(await managers.resolve("C1", "manager")).toBe(true);
  expect(managers.isManager("C1", "manager")).toBe(true);
  expect(await managers.resolve("C1", "guest")).toBe(false);
  expect(managers.isManager("C1", "guest")).toBe(false);
  expect(managers.isManager("C2", "manager")).toBe(false);
  expect(lookups).toEqual(["C1"]);
});

test("shares one lookup between concurrent checks", async () => {
  const { lookup, lookups } = tracked(["manager"]);
  const managers = new ChannelManagers(lookup);
  expect(
    await Promise.all([
      managers.resolve("C1", "manager"),
      managers.resolve("C1", "guest"),
    ]),
  ).toEqual([true, false]);
  expect(lookups).toEqual(["C1"]);
});

test("never calls Slack while channel managers are granted nothing", async () => {
  const { lookup, lookups } = tracked(["manager"]);
  const managers = new ChannelManagers(lookup, { permissions: "none" });
  expect(await managers.resolve("C1", "manager")).toBe(false);
  expect(managers.isManager("C1", "manager")).toBe(false);
  expect(lookups).toEqual([]);
});

test("never asks about direct messages", async () => {
  const { lookup, lookups } = tracked(["manager"]);
  const managers = new ChannelManagers(lookup);
  expect(await managers.resolve("D1", "manager")).toBe(false);
  expect(lookups).toEqual([]);
});

test("confirms a stale answer with Slack before granting", async () => {
  let list = ["manager"];
  let now = 1_000;
  const managers = new ChannelManagers(async () => list, {
    ttlMs: 60_000,
    now: () => now,
  });
  expect(await managers.resolve("C1", "manager")).toBe(true);
  list = [];
  now += 60_000;

  // A stale answer counts for nothing until Slack confirms it.
  expect(managers.isManager("C1", "manager")).toBe(false);
  expect(await managers.resolve("C1", "manager")).toBe(false);
});

test("drops manager access when a lookup fails", async () => {
  let fail = false;
  let failures = 0;
  let now = 1_000;
  const managers = new ChannelManagers(
    async () => {
      if (!fail) return ["manager"];
      failures++;
      throw new Error("ratelimited");
    },
    { ttlMs: 60_000, now: () => now },
  );
  expect(await managers.resolve("C1", "manager")).toBe(true);
  fail = true;
  now += 60_000;
  expect(await managers.resolve("C1", "manager")).toBe(false);
  expect(managers.isManager("C1", "manager")).toBe(false);

  // Nothing is cached, so the next check tries again.
  expect(await managers.resolve("C1", "manager")).toBe(false);
  expect(failures).toBe(2);
  fail = false;
  expect(await managers.resolve("C1", "manager")).toBe(true);
});

test("denies access when the lookup never answers", async () => {
  const managers = new ChannelManagers(() => new Promise<string[]>(() => {}), {
    timeoutMs: 5,
  });
  expect(await managers.resolve("C1", "manager")).toBe(false);
  expect(managers.isManager("C1", "manager")).toBe(false);
});
