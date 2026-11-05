import { expect, test } from "bun:test";
import { logger } from "./logger.ts";
import { ScrobbleDispatcher } from "./scrobbling.ts";
import type { Interaction, SlackAppAdapter } from "./slack-app.ts";
import { Store } from "./store.ts";
import type { AuditLog } from "./audit-log.ts";
import {
  openPersonalSettingsAction,
  personalSettingsId,
  UserSettings,
} from "./user-settings.ts";

type View = {
  callback_id?: string;
  private_metadata?: string;
  blocks: {
    block_id?: string;
    elements?: { action_id?: string }[];
    accessory?: { action_id?: string };
  }[];
};

function setup() {
  const store = new Store(":memory:");
  const scrobbling = new ScrobbleDispatcher(store, {});
  const calls: { method: string; view?: View; viewId?: string }[] = [];
  const slack = {
    modal: async (_trigger: string, view: View) => {
      calls.push({ method: "modal", view });
      return { id: "settings" };
    },
    pushModal: async (_trigger: string, view: View) => {
      calls.push({ method: "pushModal", view });
      return { id: "dialog" };
    },
    updateModal: async (viewId: string, _hash: string, view: View) => {
      calls.push({ method: "updateModal", viewId, view });
    },
    dm: async () => {
      calls.push({ method: "dm" });
    },
  } as unknown as SlackAppAdapter;
  const audited: string[] = [];
  const audit = {
    record: (event: string) => audited.push(event),
  } as unknown as AuditLog;
  const settings = new UserSettings({
    slack,
    store,
    scrobbling,
    audit,
    log: logger,
  });
  return { store, scrobbling, settings, calls, audited };
}

const interaction = (
  actionId: string,
  fields: Partial<Interaction> = {},
): Interaction =>
  ({
    type: "block_actions",
    userId: "user",
    actionId,
    value: "",
    channelId: "D1",
    messageTs: "1",
    triggerId: "trigger",
    metadata: "",
    state: {},
    ...fields,
  }) as Interaction;

const blockIds = (view: View | undefined) =>
  (view?.blocks ?? []).map((block) => block.block_id ?? "");

test("routes only interactions from Settings outside a session", () => {
  const { settings } = setup();
  expect(settings.handles(interaction(openPersonalSettingsAction))).toBe(true);
  expect(
    settings.handles(
      interaction("connect_lastfm", {
        value: personalSettingsId,
        metadata: JSON.stringify({ sessionId: personalSettingsId }),
      }),
    ),
  ).toBe(true);
  // What someone types in a session's dialog is not a way in.
  expect(
    settings.handles(
      interaction("jellyfin_address", {
        value: personalSettingsId,
        metadata: JSON.stringify({ sessionId: "session" }),
      }),
    ),
  ).toBe(false);
  expect(
    settings.handles(
      interaction("save_settings", {
        type: "view_submission",
        metadata: JSON.stringify({ sessionId: personalSettingsId }),
      }),
    ),
  ).toBe(true);
  expect(
    settings.handles(
      interaction("open_settings", {
        value: "session",
        metadata: JSON.stringify({ sessionId: "session" }),
      }),
    ),
  ).toBe(false);
});

test("opens just the You tab, without this session's scrobbling", async () => {
  const { store, settings, calls } = setup();
  store.connectLastFm("user", "last-user", "session-key");
  await settings.action(interaction(openPersonalSettingsAction));
  const opened = calls.find((call) => call.method === "modal")?.view;
  expect(opened?.callback_id).toBe("save_settings");
  expect(JSON.parse(opened!.private_metadata!).sessionId).toBe(
    personalSettingsId,
  );
  const ids = blockIds(opened);
  expect(ids).not.toContain("settings_tabs");
  expect(ids.some((id) => id.startsWith("session_scrobbling"))).toBe(false);
  expect(ids.some((id) => id.startsWith("scrobbling_mode"))).toBe(true);
  expect(ids.some((id) => id.startsWith("scrobble_to"))).toBe(true);
  // Every account button finds its way back here.
  const buttons = opened!.blocks.flatMap((block) => [
    ...(block.elements ?? []),
    ...(block.accessory ? [block.accessory] : []),
  ]);
  expect(buttons.some((item) => item.action_id === "open_your_data")).toBe(
    true,
  );
});

test("saves the user's own scrobbling settings", async () => {
  const { store, scrobbling, settings, audited } = setup();
  store.connectLastFm("user", "last-user", "session-key");
  const before = scrobbling.settings("user");
  const mode = before.mode === "always" ? "disabled" : "always";
  await settings.action(
    interaction("save_settings", {
      type: "view_submission",
      metadata: JSON.stringify({ sessionId: personalSettingsId }),
      state: {
        scrobbling_mode: { mode: { selected_option: { value: mode } } },
        scrobble_to: { "services:lastfm": { selected_options: [] } },
      },
    }),
  );
  const after = scrobbling.settings("user");
  expect(after.mode).toBe(mode);
  expect(after.lastFmEnabled).toBe(false);
  expect(audited).toContain("settings.changed");
});

test("disconnecting redraws Settings", async () => {
  const { store, scrobbling, settings, calls } = setup();
  store.connectLastFm("user", "last-user", "session-key");
  await settings.action(
    interaction("disconnect_lastfm", {
      value: personalSettingsId,
      viewId: "settings",
      viewHash: "hash",
      metadata: JSON.stringify({ sessionId: personalSettingsId }),
    }),
  );
  expect(scrobbling.settings("user").lastFmConnected).toBe(false);
  expect(calls.at(-1)).toMatchObject({
    method: "updateModal",
    viewId: "settings",
  });
});

test("Your data opens over Settings and deletes the user's own", async () => {
  const { settings, calls, audited } = setup();
  await settings.action(
    interaction("open_your_data", {
      value: personalSettingsId,
      metadata: JSON.stringify({ sessionId: personalSettingsId }),
    }),
  );
  const dialog = calls.find((call) => call.method === "pushModal")?.view;
  expect(JSON.parse(dialog!.private_metadata!).sessionId).toBe(
    personalSettingsId,
  );
  await settings.action(
    interaction("delete_data_likes", {
      value: personalSettingsId,
      viewId: "dialog",
      previousViewId: "settings",
      metadata: dialog!.private_metadata!,
    }),
  );
  expect(audited).toContain("data.deleted");
  expect(
    calls
      .filter((call) => call.method === "updateModal")
      .map((call) => call.viewId),
  ).toEqual(["dialog", "settings"]);
});

test("tells running sessions what changed", async () => {
  const { store } = setup();
  const events: string[] = [];
  const scrobbling = new ScrobbleDispatcher(store, {});
  store.connectLastFm("user", "last-user", "session-key");
  store.setLastFmEnabled("user", false);
  const settings = new UserSettings({
    slack: { dm: async () => {} } as unknown as SlackAppAdapter,
    store,
    scrobbling,
    audit: { record: () => {} } as unknown as AuditLog,
    log: logger,
    sessions: {
      changed: (userId, change) =>
        events.push(`changed ${userId} ${change.scrobblingEnabled}`),
      keepScrobbling: (userId) => events.push(`keep ${userId}`),
    },
  });
  const mode =
    scrobbling.settings("user").mode === "always" ? "disabled" : "always";
  await settings.action(
    interaction("save_settings", {
      type: "view_submission",
      metadata: JSON.stringify({ sessionId: personalSettingsId }),
      state: {
        scrobbling_mode: { mode: { selected_option: { value: mode } } },
        scrobble_to: {
          "services:lastfm": { selected_options: [{ value: "lastfm" }] },
        },
      },
    }),
  );
  expect(events).toEqual(["keep user", "changed user true"]);
  expect(scrobbling.settings("user").mode).toBe(mode);
});
