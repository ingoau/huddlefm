import { expect, test } from "bun:test";
import { CompanionChannels } from "./companion-channels.ts";
import { Store } from "./store.ts";

function setup(accessible = false) {
  const store = new Store(":memory:");
  const invited: string[] = [];
  const removed: string[] = [];
  const deleted: string[] = [];
  const slack = {
    ensureChannelAccess: async () => accessible,
    createCompanionChannel: async () => "companion",
    restrictCompanionPosting: async () => {},
    inviteToChannel: async (_channelId: string, userId: string) => {
      invited.push(userId);
    },
    removeFromChannel: async (_channelId: string, userId: string) => {
      removed.push(userId);
    },
    channelMembers: async () => ["bot", "host", "stale"],
  };
  const messages = {
    dm: async () => {},
    delete: async (_channelId: string, messageTs: string) => {
      deleted.push(messageTs);
    },
  };
  return {
    store,
    invited,
    removed,
    deleted,
    manager: new CompanionChannels(store, slack, messages, "bot"),
  };
}

test("creates and reconciles a companion channel", async () => {
  const { store, manager, invited, removed } = setup();
  expect(await manager.prepare("source", "host")).toBe("companion");
  expect(store.companionChannel("source")).toBe("companion");
  await manager.activate("companion", ["host", "guest"]);
  expect(invited).toEqual(["host", "host", "guest"]);
  expect(removed).toEqual(["stale"]);
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
  const { store, manager, removed, deleted } = setup();
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
  store.close();
});

test("reinvites a participant who rejoins during an in-flight removal", async () => {
  const store = new Store(":memory:");
  const operations: string[] = [];
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
    },
    channelMembers: async () => [],
  };
  const manager = new CompanionChannels(
    store,
    slack,
    { dm: async () => {}, delete: async () => {} },
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
