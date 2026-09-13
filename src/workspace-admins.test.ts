import { expect, test } from "bun:test";
import { WorkspaceAdmins } from "./workspace-admins.ts";

function tracked(admins: string[]) {
  const lookups: string[] = [];
  return {
    lookups,
    lookup: async (userId: string) => {
      lookups.push(userId);
      return admins.includes(userId);
    },
  };
}

test("never calls Slack while disabled", async () => {
  const { lookup, lookups } = tracked(["admin"]);
  const admins = new WorkspaceAdmins(lookup, { enabled: false });
  expect(await admins.resolve("admin")).toBe(false);
  expect(admins.isAdmin("admin")).toBe(false);
  expect(lookups).toEqual([]);
});

test("resolves once and answers later checks from the cache", async () => {
  const { lookup, lookups } = tracked(["admin"]);
  const admins = new WorkspaceAdmins(lookup, { enabled: true });
  expect(admins.isAdmin("admin")).toBe(false);
  expect(await admins.resolve("admin")).toBe(true);
  expect(admins.isAdmin("admin")).toBe(true);
  expect(await admins.resolve("admin")).toBe(true);
  expect(await admins.resolve("guest")).toBe(false);
  expect(admins.isAdmin("guest")).toBe(false);
  expect(lookups).toEqual(["admin", "guest"]);
});

test("shares one lookup between concurrent checks", async () => {
  const { lookup, lookups } = tracked(["admin"]);
  const admins = new WorkspaceAdmins(lookup, { enabled: true });
  expect(
    await Promise.all([admins.resolve("admin"), admins.resolve("admin")]),
  ).toEqual([true, true]);
  expect(lookups).toEqual(["admin"]);
});

test("refreshes a stale answer in the background", async () => {
  const lookups: string[] = [];
  let admin = true;
  let now = 1_000;
  const admins = new WorkspaceAdmins(
    async (userId) => {
      lookups.push(userId);
      return admin;
    },
    { enabled: true, ttlMs: 60_000, now: () => now },
  );
  expect(await admins.resolve("admin")).toBe(true);
  admin = false;
  now += 60_000;

  // The stale answer still applies to the check that triggers the refresh.
  expect(await admins.resolve("admin")).toBe(true);
  await Bun.sleep(0);
  expect(lookups).toEqual(["admin", "admin"]);
  expect(admins.isAdmin("admin")).toBe(false);
});

test("keeps host powers away when the lookup fails", async () => {
  let failures = 0;
  const admins = new WorkspaceAdmins(
    async () => {
      failures++;
      throw new Error("ratelimited");
    },
    { enabled: true },
  );
  expect(await admins.resolve("admin")).toBe(false);
  expect(admins.isAdmin("admin")).toBe(false);

  // Nothing is cached, so the next check tries again instead of trusting the
  // failure.
  expect(await admins.resolve("admin")).toBe(false);
  expect(failures).toBe(2);
});

test("answers from the last known state when a refresh fails", async () => {
  let fail = false;
  let now = 1_000;
  const admins = new WorkspaceAdmins(
    async () => {
      if (fail) throw new Error("ratelimited");
      return true;
    },
    { enabled: true, ttlMs: 60_000, now: () => now },
  );
  expect(await admins.resolve("admin")).toBe(true);
  fail = true;
  now += 60_000;
  expect(await admins.resolve("admin")).toBe(true);
  await Bun.sleep(0);
  expect(admins.isAdmin("admin")).toBe(true);
});
