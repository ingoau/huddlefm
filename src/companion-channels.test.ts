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
  const deadline = Date.now() + 10 * 60_000;
  await (manager as unknown as { cleanup(now: number): Promise<void> }).cleanup(
    deadline,
  );
  expect(removed).toEqual(["guest", "host"]);
  expect(deleted).toEqual(["1.0"]);
  store.close();
});
