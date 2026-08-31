import { expect, test } from "bun:test";
import {
  CompanionChannels,
  companionRemovalNotice,
} from "./companion-channels.ts";
import { Store } from "./store.ts";

function setup(accessible = false, restrictionFails = false) {
  const store = new Store(":memory:");
  const invited: string[] = [];
  const removed: string[] = [];
  const deleted: string[] = [];
  const restricted: string[] = [];
  const dms: string[] = [];
  const slack = {
    ensureChannelAccess: async () => accessible,
    createCompanionChannel: async () => "companion",
    restrictCompanionPosting: async (channelId: string, userId: string) => {
      restricted.push(`${channelId}:${userId}`);
      if (restrictionFails) throw new Error("failed");
    },
    inviteToChannel: async (_channelId: string, userId: string) => {
      invited.push(userId);
    },
    removeFromChannel: async (_channelId: string, userId: string) => {
      removed.push(userId);
      return true;
    },
  };
  const messages = {
    channelMembers: async () => ["bot", "host", "stale"],
    dm: async (userId: string, text: string) => {
      dms.push(`${userId}:${text}`);
    },
    delete: async (_channelId: string, messageTs: string) => {
      deleted.push(messageTs);
    },
  };
  return {
    store,
    invited,
    removed,
    deleted,
    restricted,
    dms,
    manager: new CompanionChannels(store, slack, messages, "bot"),
  };
}

test("creates and reconciles a companion channel", async () => {
  const { store, manager, invited, removed, restricted, dms } = setup();
  expect(await manager.prepare("source", "host")).toBe("companion");
  expect(store.companionChannel("source")).toBe("companion");
  expect(restricted).toEqual(["companion:bot"]);
  await manager.activate("companion", ["host", "guest"]);
  expect(invited).toEqual(["host", "host", "guest"]);
  expect(removed).toEqual(["stale"]);
  expect(dms).toEqual(["stale:" + companionRemovalNotice("companion")]);
  store.close();
});

test("continues when companion posting restrictions fail", async () => {
  const { store, manager, invited } = setup(false, true);
  expect(await manager.prepare("source", "host")).toBe("companion");
  expect(invited).toEqual(["host"]);
  store.close();
});

test("uses an accessible source channel without creating a companion", async () => {
  const { store, manager, invited } = setup(true);
  expect(await manager.prepare("source", "host")).toBeUndefined();
  expect(invited).toEqual([]);
  store.close();
});

test("forces a companion channel for an accessible source", async () => {
  const { store, manager, invited } = setup(true);
  expect(await manager.prepare("source", "host", true)).toBe("companion");
  expect(invited).toEqual(["host"]);
  store.close();
});

test("cleans tracked members and messages after their deadlines", async () => {
  const { store, manager, removed, deleted, dms } = setup();
  store.createSession({
    id: "session",
    huddleId: "huddle",
    callId: "call",
    channelId: "companion",
    threadTs: "",
    creatorId: "creator",
    volume: 0.6,
  });
  manager.recordMessage("session", "companion", "1.0");
  manager.removeLater("companion", "guest", 0);
  manager.endSession("session", "companion", ["host"]);
  manager.recordMessage("session", "companion", "2.0");
  const deadline = Date.now() + 10 * 60_000;
  await (manager as unknown as { cleanup(now: number): Promise<void> }).cleanup(
    deadline,
  );
  expect(removed).toEqual(["guest", "host"]);
  expect(deleted).toEqual(["1.0", "2.0"]);
  expect(dms).toEqual([
    "guest:" + companionRemovalNotice("companion"),
    "host:" + companionRemovalNotice("companion"),
  ]);
  store.close();
});

test("does not explain a removal that did not actually kick the member", async () => {
  const store = new Store(":memory:");
  const dms: string[] = [];
  const manager = new CompanionChannels(
    store,
    {
      ensureChannelAccess: async () => false,
      createCompanionChannel: async () => "companion",
      restrictCompanionPosting: async () => {},
      inviteToChannel: async () => {},
      removeFromChannel: async () => false,
    },
    {
      dm: async (userId: string, text: string) => {
        dms.push(`${userId}:${text}`);
      },
      delete: async () => {},
      channelMembers: async () => [],
    },
    "bot",
  );
  manager.removeLater("companion", "guest", 0);
  await (manager as unknown as { cleanup(now: number): Promise<void> }).cleanup(
    10 * 60_000,
  );
  expect(dms).toEqual([]);
  store.close();
});

test("reinvites a participant who rejoins during an in-flight removal", async () => {
  const store = new Store(":memory:");
  const operations: string[] = [];
  const dms: string[] = [];
  const kickStarted = Promise.withResolvers<void>();
  const releaseKick = Promise.withResolvers<void>();
  const slack = {
    ensureChannelAccess: async () => false,
    createCompanionChannel: async () => "companion",
    restrictCompanionPosting: async () => {},
    inviteToChannel: async () => {
      operations.push("invite");
    },
    removeFromChannel: async () => {
      operations.push("kick");
      kickStarted.resolve();
      await releaseKick.promise;
      return true;
    },
  };
  const manager = new CompanionChannels(
    store,
    slack,
    {
      dm: async (userId: string, text: string) => {
        dms.push(`${userId}:${text}`);
      },
      delete: async () => {},
      channelMembers: async () => [],
    },
    "bot",
  );
  manager.removeLater("companion", "user", 0);
  const cleanup = (
    manager as unknown as { cleanup(now: number): Promise<void> }
  ).cleanup(10 * 60_000);
  await kickStarted.promise;
  const rejoin = manager.add("companion", "user");
  releaseKick.resolve();
  await Promise.all([cleanup, rejoin]);
  expect(operations).toEqual(["kick", "invite", "invite"]);
  expect(dms).toEqual([]);
  expect(store.companionRemovalDeadline("companion", "user")).toBeUndefined();
  store.close();
});

test("schedules persisted participants when abandoning a session", () => {
  const { store, manager } = setup();
  store.createSession({
    id: "session",
    huddleId: "huddle",
    callId: "call",
    channelId: "companion",
    threadTs: "",
    companionChannelId: "companion",
    creatorId: "creator",
    volume: 0.6,
  });
  store.setSessionParticipants("session", ["bot", "host", "guest"]);
  manager.abandonSession("session");
  expect(
    store
      .dueCompanionRemovals(Date.now() + 10 * 60_000)
      .map(({ userId }) => userId)
      .sort(),
  ).toEqual(["guest", "host"]);
  store.close();
});
