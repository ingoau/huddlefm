import { expect, test } from "bun:test";
import {
  compactForm,
  defaultUserSettings,
  dialogMetadata,
  mergeForm,
  parseSettingsMetadata,
  settingsView,
  visibleSettingsTabs,
  yourDataView,
  type SettingsViewOptions,
} from "./settings-view.ts";

const access = {
  volume: false,
  configure: false,
  admin: false,
  endSession: false,
  saveDefaults: false,
};

function options(
  change: Partial<SettingsViewOptions> = {},
): SettingsViewOptions {
  return {
    sessionId: "session",
    hostId: "host",
    integrationPage: 0,
    access: { ...access, volume: true, configure: true },
    session: {
      hostId: "host",
      volume: 0.6,
      displayMode: "default",
      autoplayMode: "off",
      loopMode: "off",
      transitionMode: "none",
      duckingMode: "gentle",
      anchorEnabled: false,
      allowed: new Set(["add"]),
    },
    user: defaultUserSettings,
    channel: { saves: [] },
    integrations: [],
    ...change,
  };
}

type View = ReturnType<typeof settingsView>;
const block = (view: View, id: string) =>
  view.blocks.find(
    (item) => (item as { block_id?: string }).block_id === id,
  ) as Record<string, any> | undefined;
const tabsOf = (view: View) =>
  (block(view, "settings_tabs")?.elements ?? []).map(
    (element: { value: string }) => element.value,
  );

test("each tab shows only to those who can change something on it", () => {
  const save = { id: "s", name: "Mix", savedBy: "U", savedAt: 0, songs: 1 };
  expect(visibleSettingsTabs({ access, channel: { saves: [] } })).toEqual([
    "you",
  ]);
  expect(
    visibleSettingsTabs({
      access: { ...access, endSession: true },
      channel: { saves: [] },
    }),
  ).toEqual(["you", "session"]);
  expect(visibleSettingsTabs({ access, channel: { saves: [save] } })).toEqual([
    "you",
    "channel",
  ]);
  expect(
    visibleSettingsTabs({
      access: { ...access, saveDefaults: true, admin: true },
      channel: { saves: [] },
    }),
  ).toEqual(["you", "channel", "host"]);
});

test("Settings opens on the session's tab, and a lone tab has no tab bar", () => {
  const view = settingsView(options());
  expect(tabsOf(view)).toEqual(["you", "session"]);
  expect(block(view, "volume")).toBeDefined();
  const selected = block(view, "settings_tabs")!.elements.find(
    (element: { style?: string }) => element.style === "primary",
  );
  expect(selected.value).toBe("session");

  const own = settingsView(options({ access }));
  expect(block(own, "settings_tabs")).toBeUndefined();
  expect(block(own, "huddle_mix")).toBeDefined();
  // A tab the viewer cannot see falls back to the one they can.
  expect(
    block(settingsView(options({ access, tab: "host" })), "huddle_mix"),
  ).toBeDefined();
});

test("a tab shows the edits a draft kept for it", () => {
  const view = settingsView(
    options({
      access: { ...access, volume: true, configure: true, admin: true },
      tab: "host",
      draft: {
        permissions: {
          selected: {
            selected_options: [{ value: "skip" }, { value: "pause" }],
          },
        },
        host: { user: { selected_user: "guest" } },
      },
    }),
  );
  expect(
    block(view, "permissions")!.element.initial_options.map(
      (option: { value: string }) => option.value,
    ),
  ).toEqual(["skip", "pause"]);
  expect(block(view, "host")!.element.initial_user).toBe("guest");

  const session = settingsView(
    options({
      draft: {
        autoplay: { mode: { selected_option: { value: "huddle" } } },
        anchor: { enabled: { selected_options: [{ value: "enabled" }] } },
        volume: { percent: { selected_option: { value: "35" } } },
      },
    }),
  );
  expect(block(session, "autoplay")!.element.initial_option.value).toBe(
    "huddle",
  );
  expect(block(session, "anchor")!.element.initial_options).toHaveLength(1);
  expect(block(session, "volume")!.element.initial_option.value).toBe("35");
  // The draft goes with the modal, for the next interaction to hand back.
  expect(parseSettingsMetadata(session.private_metadata)).toEqual({
    sessionId: "session",
    hostId: "host",
    tab: "session",
    integrationPage: 0,
    revision: 0,
    draft: {
      autoplay: { mode: { selected_option: { value: "huddle" } } },
      anchor: { enabled: { selected_options: [{ value: "enabled" }] } },
      volume: { percent: { selected_option: { value: "35" } } },
    },
  });
});

test("a draft keeps only form values, and never a token", () => {
  expect(
    compactForm({
      autoplay: {
        mode: {
          type: "static_select",
          selected_option: {
            text: { type: "plain_text", text: "Huddle mix" },
            value: "huddle",
          },
        },
      },
      listenbrainz_token: { value: { type: "plain_text_input", value: "x" } },
      broken: "not a block",
      odd: { action: { selected_options: [{ value: 3 }, { value: "ok" }] } },
    }),
  ).toEqual({
    autoplay: { mode: { selected_option: { value: "huddle" } } },
    odd: { action: { selected_options: [{ value: "ok" }] } },
  });
  // What is on screen replaces what the draft held for the same block.
  expect(
    mergeForm(
      {
        autoplay: { mode: { selected_option: { value: "huddle" } } },
        loop: { mode: { selected_option: { value: "track" } } },
      },
      { autoplay: { mode: { selected_option: { value: "off" } } } },
    ),
  ).toEqual({
    autoplay: { mode: { selected_option: { value: "off" } } },
    loop: { mode: { selected_option: { value: "track" } } },
  });
});

test("malformed metadata reads as none", () => {
  expect(parseSettingsMetadata("{")).toEqual({
    integrationPage: 0,
    revision: 0,
    draft: {},
  });
  expect(
    parseSettingsMetadata(
      JSON.stringify({
        tab: "elsewhere",
        integrationPage: -1,
        revision: 1.5,
        draft: [],
      }),
    ),
  ).toEqual({ integrationPage: 0, revision: 0, draft: {} });
});

test("a draft too large for the modal is let go", () => {
  const view = settingsView(
    options({
      draft: {
        padding: { value: { value: "x".repeat(3000) } },
        autoplay: { mode: { selected_option: { value: "huddle" } } },
      },
    }),
  );
  expect(view.private_metadata.length).toBeLessThanOrEqual(3000);
  expect(parseSettingsMetadata(view.private_metadata).draft).toEqual({});
});

test("the Channel tab says who saved the defaults and lists saves to delete", () => {
  const view = settingsView(
    options({
      access: { ...access, saveDefaults: true },
      tab: "channel",
      channel: {
        defaults: { savedBy: "U1", savedAt: Date.UTC(2026, 9, 1) },
        saves: [
          {
            id: "save-1",
            name: "Friday <mix>",
            savedBy: "U2",
            savedAt: Date.UTC(2026, 9, 2),
            songs: 3,
          },
        ],
      },
    }),
  );
  expect(block(view, "channel_defaults_saved")!.elements[0].text).toContain(
    "Saved by <@U1> <!date^1790812800^{date_short_pretty}|2026-10-01>",
  );
  const save = block(view, "channel_save_save-1")!;
  expect(save.text.text).toContain("*Friday &lt;mix&gt;*\n3 songs");
  expect(save.accessory).toMatchObject({
    action_id: "delete_channel_save",
    value: "save-1",
  });
});

test("volume is picked in the player's steps, keeping a volume between them", () => {
  const values = (view: View) =>
    block(view, "volume")!.element.options.map(
      (option: { value: string }) => option.value,
    );
  const stepped = settingsView(options());
  expect(values(stepped)).toHaveLength(21);
  expect(block(stepped, "volume")!.element.initial_option).toEqual({
    text: { type: "plain_text", text: "60%" },
    value: "60",
  });
  const between = settingsView(
    options({ session: { ...options().session, volume: 0.625 } }),
  );
  expect(values(between).slice(12, 15)).toEqual(["60", "62.5", "65"]);
  expect(block(between, "volume")!.element.initial_option.value).toBe("62.5");
});

test("a preset's refill gives the permission inputs new block IDs", () => {
  const view = settingsView(
    options({
      access: { ...access, admin: true },
      tab: "host",
      revision: 2,
      draft: {
        permissions: { selected: { selected_options: [{ value: "skip" }] } },
      },
    }),
  );
  expect(block(view, "permissions.2")!.element.initial_options).toHaveLength(1);
  expect(block(view, "permission_preset.2")).toMatchObject({
    dispatch_action: true,
    element: { action_id: "apply_permission_preset" },
  });
  expect(block(view, "permission_preset.2")!.element.initial_option).toBe(
    undefined,
  );
  // Read back, the form is under the usual IDs, and a preset is not kept.
  expect(
    compactForm({
      "permissions.2": {
        selected: { selected_options: [{ value: "pause" }] },
      },
      "permission_preset.2": {
        apply_permission_preset: { selected_option: { value: "default" } },
      },
    }),
  ).toEqual({
    permissions: { selected: { selected_options: [{ value: "pause" }] } },
  });
});

test("Your data stays within Slack's block limit however much was saved", () => {
  const save = (index: number) => ({
    id: `s${index}`,
    name: `Save ${index}`,
    savedBy: "U1",
    savedAt: 0,
    songs: 1,
  });
  const songs = { count: 0, recent: [] };
  const view = yourDataView({
    sessionId: "session",
    added: songs,
    plays: songs,
    likes: songs,
    skips: songs,
    scrobbles: 0,
    saves: Array.from({ length: 25 }, (_, index) => save(index)),
    channelSaves: Array.from({ length: 60 }, (_, index) => ({
      ...save(100 + index),
      channelId: "C1",
    })),
  });
  expect(view.blocks.length).toBeLessThanOrEqual(100);
  expect(JSON.stringify(view)).toContain("And 20 more saved to channels");
  // Nothing to delete has no Delete button.
  expect(
    view.blocks.find(
      (block) => (block as { block_id?: string }).block_id === "data_plays",
    ),
  ).not.toHaveProperty("accessory");
});

test("a dialog over Settings lets go of a draft too large to carry", () => {
  const settings = {
    tab: "you",
    draft: { padding: { value: { value: "x".repeat(3000) } } },
  };
  const metadata = dialogMetadata("session", settings);
  expect(metadata.length).toBeLessThanOrEqual(3000);
  expect(JSON.parse(metadata)).toEqual({
    sessionId: "session",
    settings: { tab: "you", draft: {} },
  });
  expect(
    JSON.parse(dialogMetadata("session", { tab: "you", draft: {} })),
  ).toEqual({ sessionId: "session", settings: { tab: "you", draft: {} } });
});
