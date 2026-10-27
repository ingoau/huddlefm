import {
  actions,
  button,
  confirm,
  context,
  escape,
  input,
  plain,
  section,
  songCount,
  staticSelect,
  toggle,
  when,
} from "./coordinator-ui.ts";
import {
  integrationSettingsBlocks,
  slackModalBlockLimit,
} from "./integration.ts";
import {
  scrobbleServices,
  settingFields,
  videoAutoplayModes,
  type ScrobbleService,
  type SessionSettingsView,
  type SettingField,
  type SettingFieldValue,
  type UserSettingsView,
} from "./settings-schema.ts";
import type { Interaction } from "./slack-app.ts";
import { huddleMixSources, type HuddleMixSource } from "./store.ts";

export {
  scrobbleServices,
  type ScrobbleService,
  type UserSettingsView,
} from "./settings-schema.ts";

/** What a modal's inputs hold, by block and then action ID. */
export type FormState = Interaction["state"];
type InputState = FormState[string][string];

// The option a select block holds, when it is one of `modes`.
export function selected<Mode extends string>(
  state: InputState | undefined,
  modes: readonly Mode[],
) {
  const value = state?.selected_option?.value as Mode | undefined;
  return value && modes.includes(value) ? value : undefined;
}

// Whether video mode's autoplay select is on, or undefined when it was not
// part of the submission.
export function videoAutoplaySelected(state: InputState | undefined) {
  const mode = selected(state, videoAutoplayModes);
  return mode && mode !== "off";
}

// Whether a single-option checkbox block is ticked, or undefined when the
// block was not part of the submission.
export function checked(state: InputState | undefined) {
  if (!state) return undefined;
  return (
    state.selected_options?.some((option) => option.value === "enabled") ??
    false
  );
}

// The settings modal's Huddle mix checkboxes name the sources they offer in
// their action ID. Only those sources are saved, so a service the user had
// not connected keeps its choice for when they do, and a refreshed modal
// that offers a different set starts from the saved ticks rather than Slack
// carrying over the old ones.
const huddleMixActionPrefix = "sources:";

// The services a user scrobbles to, named in the checkboxes' action ID as the
// Huddle mix sources are, so only the services the form offered are saved.
const scrobbleServicesPrefix = "services:";

// The choice a settings form makes for each Huddle mix source it offered, or
// undefined when the checkboxes were not part of it.
export function submittedHuddleMixSources(
  block: Record<string, InputState> | undefined,
) {
  const [actionId, state] =
    Object.entries(block ?? {}).find(([actionId]) =>
      actionId.startsWith(huddleMixActionPrefix),
    ) ?? [];
  if (!actionId || !state) return undefined;
  const offered = new Set(
    actionId.slice(huddleMixActionPrefix.length).split(","),
  );
  const ticked = new Set(
    state.selected_options?.map((option) => option.value) ?? [],
  );
  return Object.fromEntries(
    huddleMixSources
      .filter((source) => offered.has(source))
      .map((source) => [source, ticked.has(source)]),
  ) as Partial<Record<HuddleMixSource, boolean>>;
}

export const settingsTabs = ["you", "session", "channel", "host"] as const;
export type SettingsTab = (typeof settingsTabs)[number];
const tabLabels: Record<SettingsTab, string> = {
  you: "You",
  session: "Session",
  channel: "Channel",
  host: "Host",
};
// Each tab's button is its own action, as Slack wants the IDs in a block to
// differ.
export const settingsTabActionPrefix = "settings_tab_";

export function settingsTabFromAction(actionId: string) {
  const tab = actionId.slice(settingsTabActionPrefix.length);
  return actionId.startsWith(settingsTabActionPrefix) &&
    settingsTabs.includes(tab as SettingsTab)
    ? (tab as SettingsTab)
    : undefined;
}

// Inputs whose values never go into a draft, which Slack hands back to every
// later interaction with the modal. Settings no longer asks for a token
// itself, but a token form's state must not be carried either, and a preset
// is only ever a way to fill in the permissions.
const undraftedBlocks = new Set(["listenbrainz_token", "permission_preset"]);

// Inputs whose block IDs change when Settings refills them, which the form
// reads back under their usual ID.
const versionedBlocks = ["permissions", "permission_preset"];

function versionedBlockId(blockId: string, revision: number) {
  return revision ? `${blockId}.${revision}` : blockId;
}

function unversionedBlockId(blockId: string) {
  const [base, revision] = blockId.split(".");
  return revision && versionedBlocks.includes(base!) ? base! : blockId;
}

/**
 * The meaningful part of a form, without the labels Slack echoes back, so a
 * draft of it fits in a modal's private metadata. Anything that is not a
 * form value is dropped, which also makes it safe to read one back.
 */
export function compactForm(state: unknown): FormState {
  const form: FormState = {};
  if (!isRecord(state)) return form;
  for (const [versionedId, block] of Object.entries(state)) {
    const blockId = unversionedBlockId(versionedId);
    if (undraftedBlocks.has(blockId) || !isRecord(block)) continue;
    for (const [actionId, value] of Object.entries(block)) {
      if (!isRecord(value)) continue;
      const input: InputState = {};
      if (typeof value.value === "string") input.value = value.value;
      if (typeof value.selected_user === "string")
        input.selected_user = value.selected_user;
      if (
        isRecord(value.selected_option) &&
        typeof value.selected_option.value === "string"
      )
        input.selected_option = { value: value.selected_option.value };
      if (Array.isArray(value.selected_options))
        input.selected_options = value.selected_options.flatMap((option) =>
          isRecord(option) && typeof option.value === "string"
            ? [{ value: option.value }]
            : [],
        );
      (form[blockId] ??= {})[actionId] = input;
    }
  }
  return form;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What Settings keeps in its private metadata between interactions. */
export type SettingsMetadata = {
  sessionId?: string;
  hostId?: string;
  tab?: SettingsTab;
  integrationPage: number;
  // How many times a preset has refilled the permissions.
  revision: number;
  // Edits not yet saved, from tabs no longer on screen.
  draft: FormState;
};

// Reads Settings' metadata, as Slack hands it back or as a dialog opened
// over Settings keeps it.
export function parseSettingsMetadata(metadata: unknown): SettingsMetadata {
  let parsed = metadata;
  if (typeof metadata === "string" || metadata === undefined)
    try {
      parsed = JSON.parse(metadata || "{}");
    } catch {
      parsed = {};
    }
  const value = isRecord(parsed) ? parsed : {};
  const page = value.integrationPage;
  return {
    ...(typeof value.sessionId === "string"
      ? { sessionId: value.sessionId }
      : {}),
    ...(typeof value.hostId === "string" ? { hostId: value.hostId } : {}),
    ...(settingsTabs.includes(value.tab) ? { tab: value.tab } : {}),
    integrationPage:
      typeof page === "number" && Number.isInteger(page) && page > 0 ? page : 0,
    revision:
      typeof value.revision === "number" &&
      Number.isInteger(value.revision) &&
      value.revision > 0
        ? value.revision
        : 0,
    draft: compactForm(value.draft),
  };
}

// The You tab's inputs, which no longer hold once the user's data is deleted.
const userFormBlocks = [
  "huddle_mix",
  "session_scrobbling",
  "scrobbling_mode",
  "scrobble_to",
];

/**
 * The metadata of a dialog opened over Settings, carrying Settings' own to
 * redraw it with. A draft that would not fit is let go.
 */
export function dialogMetadata(sessionId: string, settings: unknown) {
  const metadata = JSON.stringify({ sessionId, settings });
  if (metadata.length <= metadataLimit || !isRecord(settings)) return metadata;
  return JSON.stringify({ sessionId, settings: { ...settings, draft: {} } });
}

/** The draft without the You tab's edits. */
export function withoutUserForm(draft: FormState): FormState {
  return Object.fromEntries(
    Object.entries(draft).filter(
      ([blockId]) => !userFormBlocks.includes(blockId),
    ),
  );
}

/** The draft with the inputs on screen, which are newer, laid over it. */
export function mergeForm(draft: FormState, state: FormState): FormState {
  return { ...draft, ...compactForm(state) };
}

// Slack refuses private metadata over this many characters.
const metadataLimit = 3000;

export const defaultUserSettings: UserSettingsView = {
  lastFmAvailable: false,
  lastFmConnected: false,
  lastFmEnabled: false,
  listenBrainzConnected: false,
  listenBrainzEnabled: false,
  huddleMixSources: ["added"],
  huddleMixUsable: ["added"],
  mode: "always",
  configured: false,
  sessionEnabled: false,
};

/** A session saved to the channel, as the Channel tab lists it. */
export type ChannelSaveView = {
  id: string;
  name: string;
  savedBy: string;
  savedAt: number;
  songs: number;
};

export type SettingsViewOptions = {
  sessionId: string;
  hostId?: string;
  tab?: SettingsTab;
  integrationPage: number;
  revision?: number;
  draft?: FormState;
  // A word on what just happened, shown once above the tab.
  notice?: string;
  // Whether the viewer can open Your data from here.
  yourData?: boolean;
  // What the viewer may change.
  access: {
    volume: boolean;
    configure: boolean;
    admin: boolean;
    endSession: boolean;
    saveDefaults: boolean;
  };
  session: SessionSettingsView;
  user: UserSettingsView;
  // The viewer's Jellyfin servers, when Jellyfin is available.
  jellyfin?: { linked: number; needsLink: number };
  channel: {
    // Who saved the channel's defaults, when it has any.
    defaults?: { savedBy: string; savedAt: number };
    // The channel's saved sessions the viewer may delete.
    saves: ChannelSaveView[];
  };
  integrations: { userId: string; requestId: string; permissions: string[] }[];
};

/** The tabs the viewer has something on, in order. */
export function visibleSettingsTabs(
  options: Pick<SettingsViewOptions, "access" | "channel">,
) {
  const { access, channel } = options;
  return settingsTabs.filter((tab) =>
    tab === "you"
      ? true
      : tab === "session"
        ? access.volume || access.configure || access.endSession
        : tab === "channel"
          ? access.saveDefaults || channel.saves.length > 0
          : access.admin,
  );
}

// Settings opens on the session's settings for those who can change them,
// and on the viewer's own otherwise.
function activeTab(tabs: SettingsTab[], requested?: SettingsTab) {
  if (requested && tabs.includes(requested)) return requested;
  return tabs.includes("session") ? "session" : "you";
}

// A Slack date, which each viewer sees in their own time zone.
function slackDate(at: number) {
  const seconds = Math.floor(at / 1000);
  const fallback = new Date(at).toISOString().slice(0, 10);
  return `<!date^${seconds}^{date_short_pretty}|${fallback}>`;
}

export function settingsView(options: SettingsViewOptions) {
  const { access } = options;
  const form = options.draft ?? {};
  const tabs = visibleSettingsTabs(options);
  const tab = activeTab(tabs, options.tab);
  const tabBlocks = when(
    tabs.length > 1,
    actions(
      "settings_tabs",
      tabs.map((item) =>
        button(`${settingsTabActionPrefix}${item}`, plain(tabLabels[item]), {
          value: item,
          ...(item === tab ? { style: "primary" } : {}),
        }),
      ),
    ),
  );
  const noticeBlocks = when(
    options.notice,
    context("settings_notice", options.notice ?? ""),
  );
  const content =
    tab === "you"
      ? youBlocks(options, form)
      : tab === "session"
        ? sessionBlocks(options, form)
        : tab === "channel"
          ? channelBlocks(options)
          : hostBlocks(options, form);
  const integrationBlocks =
    tab === "host" && access.admin
      ? integrationSettingsBlocks({
          sessionId: options.sessionId,
          grants: options.integrations,
          maxBlocks: slackModalBlockLimit - tabBlocks.length - content.length,
          page: options.integrationPage,
        })
      : [];
  const metadata = (draft: FormState) =>
    JSON.stringify({
      sessionId: options.sessionId,
      // Kept even when there is no host, so a host set while Settings is
      // open still makes it stale.
      hostId: options.hostId ?? "",
      tab,
      integrationPage: options.integrationPage,
      revision: options.revision ?? 0,
      draft,
    });
  // A draft too large to keep is let go rather than the modal refused.
  let privateMetadata = metadata(form);
  if (privateMetadata.length > metadataLimit) privateMetadata = metadata({});
  return {
    type: "modal",
    callback_id: "save_settings",
    private_metadata: privateMetadata,
    title: plain("HuddleFM settings"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [...tabBlocks, ...noticeBlocks, ...content, ...integrationBlocks],
  };
}

// The action ID of each setting's input. Selects are `mode` and toggles
// `enabled` unless named here; the Huddle mix and scrobbling checkboxes name
// what they offer after their prefix.
const actionIds: Record<string, string> = {
  volume: "percent",
  host: "user",
  permissions: "selected",
};
const offeringPrefixes: Record<string, string> = {
  huddle_mix: huddleMixActionPrefix,
  scrobble_to: scrobbleServicesPrefix,
};

function actionId(field: SettingField) {
  const prefix = offeringPrefixes[field.id];
  if (prefix && field.kind === "multi")
    return `${prefix}${field.options.map((option) => option.value).join(",")}`;
  return (
    actionIds[field.id] ??
    (field.kind === "toggle"
      ? "enabled"
      : field.kind === "user"
        ? "user"
        : "mode")
  );
}

// What a draft holds for a setting, or undefined when it holds nothing
// that applies, read as each input reads back.
function draftValue(
  field: SettingField,
  form: FormState,
): SettingFieldValue | undefined {
  const block = form[field.id];
  if (!block) return undefined;
  switch (field.kind) {
    case "select": {
      const value = block[actionId(field)]?.selected_option?.value;
      if (value === undefined) return undefined;
      // The volume keeps whatever it was, as its steps grow to include it.
      return field.id === "volume" ||
        field.options.some((option) => option.value === value)
        ? value
        : undefined;
    }
    case "toggle":
      return checked(block.enabled);
    case "user":
      return block.user?.selected_user;
    case "multi": {
      const prefix = offeringPrefixes[field.id];
      if (!prefix) {
        const ticked = block[actionId(field)]?.selected_options;
        if (!ticked) return undefined;
        const values = new Set(ticked.map((option) => option.value));
        return field.options
          .map((option) => option.value)
          .filter((value) => values.has(value));
      }
      // Only what the form offered is its choice; the rest keep theirs.
      const [offeredBy, state] =
        Object.entries(block).find(([id]) => id.startsWith(prefix)) ?? [];
      if (!offeredBy || !state) return undefined;
      const offered = new Set(offeredBy.slice(prefix.length).split(","));
      const ticked = new Set(
        state.selected_options?.map((option) => option.value) ?? [],
      );
      return field.options
        .map((option) => option.value)
        .filter((value) =>
          offered.has(value) ? ticked.has(value) : field.value.includes(value),
        );
    }
  }
}

// The settings the viewer may change, with the draft's edits in them.
function fieldsFor(options: SettingsViewOptions, form: FormState) {
  const { access, session, user } = options;
  const context = {
    access: {
      volume: access.volume,
      configure: access.configure,
      admin: access.admin,
    },
    session,
    user,
  };
  const overrides: Record<string, SettingFieldValue> = {};
  for (const field of settingFields(context)) {
    const value = draftValue(field, form);
    if (value !== undefined) overrides[field.id] = value;
  }
  return settingFields(context, overrides);
}

function settingInput(field: SettingField, revision: number) {
  const id = actionId(field);
  const options = { optional: field.optional, hint: field.hint };
  switch (field.kind) {
    case "select":
      return input(
        field.id,
        field.label,
        staticSelect(
          id,
          field.options.map((option) => ({
            text: plain(option.label),
            value: option.value,
            ...(option.description
              ? { description: plain(option.description) }
              : {}),
          })),
          field.value,
        ),
        options,
      );
    case "toggle":
      return input(
        field.id,
        field.label,
        toggle(id, field.text, field.value),
        options,
      );
    case "user":
      return input(
        field.id,
        field.label,
        {
          type: "users_select",
          action_id: id,
          ...(field.value ? { initial_user: field.value } : {}),
        },
        options,
      );
    case "multi": {
      const all = field.options.map((option) => ({
        text: plain(option.label),
        value: option.value,
      }));
      return input(
        field.id === "permissions"
          ? versionedBlockId(field.id, revision)
          : field.id,
        field.label,
        {
          type: "checkboxes",
          action_id: id,
          options: all,
          initial_options: all.filter((option) =>
            field.value.includes(option.value),
          ),
        },
        options,
      );
    }
  }
}

// A tab's settings, each under the heading it starts, and the permissions
// after the presets that fill them in.
function settingBlocks(
  options: SettingsViewOptions,
  form: FormState,
  tab: SettingField["tab"],
) {
  const revision = options.revision ?? 0;
  return fieldsFor(options, form)
    .filter((field) => field.tab === tab)
    .flatMap((field) => [
      ...when(field.section, {
        type: "header",
        text: plain(field.section ?? ""),
      }),
      ...(field.kind === "multi" && field.presets
        ? [presetInput(field.presets, revision)]
        : []),
      settingInput(field, revision),
    ]);
}

// A preset fills in the checkboxes when picked. Slack keeps what an input
// showed across a redraw unless its block ID changes, so each fill gives
// both inputs new ones.
function presetInput(
  presets: { value: string; label: string }[],
  revision: number,
) {
  return {
    ...input(
      versionedBlockId("permission_preset", revision),
      "Start from a preset",
      {
        type: "static_select",
        action_id: "apply_permission_preset",
        placeholder: plain("Choose a preset"),
        options: presets.map((preset) => ({
          text: plain(preset.label),
          value: preset.value,
        })),
      },
      {
        optional: true,
        hint: "Fills in the permissions below. Nothing changes until you save.",
      },
    ),
    dispatch_action: true,
  };
}

function sessionBlocks(options: SettingsViewOptions, form: FormState) {
  const { access, sessionId: value } = options;
  return [
    ...settingBlocks(options, form, "session"),
    ...when(
      access.endSession,
      { type: "divider" },
      actions("session_actions", [
        // Ending asks in a dialog of its own rather than a confirmation,
        // which cannot carry the choice to save the session.
        button("open_end_session", plain("End session"), {
          style: "danger",
          value,
        }),
      ]),
    ),
  ];
}

function channelBlocks(options: SettingsViewOptions) {
  const { access, channel, sessionId: value } = options;
  const defaults = channel.defaults;
  return [
    ...when(
      access.saveDefaults,
      { type: "header", text: plain("Channel defaults") },
      context(
        "channel_defaults_saved",
        defaults
          ? `Saved by <@${defaults.savedBy}> ${slackDate(defaults.savedAt)}. New sessions in this channel start with them.`
          : "None saved. New sessions in this channel start with the usual settings.",
      ),
      actions("channel_defaults_actions", [
        button("save_channel_defaults", plain("Save current settings"), {
          value,
          confirm: confirm(
            "Save channel defaults?",
            "New sessions in this channel will start with the settings and permissions shown in Settings, including changes not saved yet.",
            "Save",
          ),
        }),
        ...when(
          defaults,
          button("clear_channel_defaults", plain("Clear"), {
            value,
            confirm: confirm(
              "Clear channel defaults?",
              "New sessions in this channel will start with the usual settings.",
              "Clear",
            ),
          }),
        ),
      ]),
    ),
    ...when(channel.saves.length, {
      type: "header",
      text: plain("Saved sessions"),
    }),
    ...channel.saves.map((save) => ({
      type: "section",
      block_id: `channel_save_${save.id}`,
      text: {
        type: "mrkdwn",
        text: `*${escape(save.name)}*\n${songCount(save.songs)} · saved by <@${save.savedBy}> ${slackDate(save.savedAt)}`,
      },
      accessory: button("delete_channel_save", plain("Delete"), {
        style: "danger",
        value: save.id,
        confirm: confirm(
          "Delete saved session?",
          "Nobody in this channel will be able to load it any more.",
          "Delete",
        ),
      }),
    })),
  ];
}

// Whether the form ticks each scrobbling service it offered, or undefined
// when the checkboxes were not part of it.
export function submittedScrobbleServices(
  block: Record<string, InputState> | undefined,
) {
  const [actionId, state] =
    Object.entries(block ?? {}).find(([actionId]) =>
      actionId.startsWith(scrobbleServicesPrefix),
    ) ?? [];
  if (!actionId || !state) return undefined;
  const offered = new Set(
    actionId.slice(scrobbleServicesPrefix.length).split(","),
  );
  const ticked = new Set(
    state.selected_options?.map((option) => option.value) ?? [],
  );
  return Object.fromEntries(
    scrobbleServices
      .filter((service) => offered.has(service))
      .map((service) => [service, ticked.has(service)]),
  ) as Partial<Record<ScrobbleService, boolean>>;
}

function hostBlocks(options: SettingsViewOptions, form: FormState) {
  return settingBlocks(options, form, "host");
}

function youBlocks(options: SettingsViewOptions, form: FormState) {
  const { user: settings, sessionId: value } = options;
  const lastFm = settings.lastFmConnected
    ? `Connected as ${escape(settings.lastFmUsername ?? "unknown")}`
    : "Not connected";
  const listenBrainz = settings.listenBrainzConnected
    ? settings.listenBrainzUsername
      ? `Connected as ${escape(settings.listenBrainzUsername)}`
      : "Token saved"
    : "Not connected";
  return [
    ...settingBlocks(options, form, "you"),

    { type: "header", text: plain("Accounts") },
    ...when(settings.lastFmConnected || settings.lastFmAvailable, {
      type: "section",
      block_id: "lastfm_account",
      text: { type: "mrkdwn", text: `*Last.fm*\n${lastFm}` },
      accessory: settings.lastFmConnected
        ? button("disconnect_lastfm", plain("Disconnect"), {
            style: "danger",
            value,
            confirm: confirm(
              "Disconnect Last.fm?",
              "This removes your saved Last.fm login and stops scrobbling to it.",
              "Disconnect",
            ),
          })
        : button("connect_lastfm", plain("Connect"), { value }),
    }),
    {
      type: "section",
      block_id: "listenbrainz_account",
      text: { type: "mrkdwn", text: `*ListenBrainz*\n${listenBrainz}` },
      accessory: settings.listenBrainzConnected
        ? button("disconnect_listenbrainz", plain("Remove"), {
            style: "danger",
            value,
            confirm: confirm(
              "Remove ListenBrainz token?",
              "This removes your saved token and stops scrobbling to ListenBrainz.",
              "Remove",
            ),
          })
        : button("open_listenbrainz_token", plain("Add token"), { value }),
    },
    ...when(options.jellyfin, {
      type: "section",
      block_id: "jellyfin_account",
      text: {
        type: "mrkdwn",
        text: `*Jellyfin*\n${jellyfinSummary(options.jellyfin ?? { linked: 0, needsLink: 0 })}`,
      },
      accessory: options.jellyfin?.linked
        ? button("jellyfin_view_servers", plain("View"), { value })
        : button("jellyfin_open_link", plain("Link"), { value }),
    }),
    ...when(
      options.yourData,
      { type: "header", text: plain("Your data") },
      {
        type: "section",
        block_id: "your_data",
        text: {
          type: "mrkdwn",
          text: "See and delete the songs and saved sessions HuddleFM keeps about you.",
        },
        accessory: button("open_your_data", plain("Manage"), { value }),
      },
    ),
  ];
}

function jellyfinSummary(jellyfin: { linked: number; needsLink: number }) {
  if (!jellyfin.linked) return "Not linked";
  const linked = `${jellyfin.linked} ${jellyfin.linked === 1 ? "server" : "servers"} linked`;
  return jellyfin.needsLink
    ? `${linked} · ${jellyfin.needsLink} ${jellyfin.needsLink === 1 ? "needs" : "need"} linking again`
    : linked;
}

/** The form a ListenBrainz token is pasted into, over Settings. */
export function listenBrainzTokenView(sessionId: string, settings: unknown) {
  return {
    type: "modal",
    callback_id: "listenbrainz_token",
    private_metadata: dialogMetadata(sessionId, settings),
    title: plain("Connect ListenBrainz"),
    submit: plain("Connect"),
    close: plain("Cancel"),
    blocks: [
      section(
        "Paste your user token from <https://listenbrainz.org/settings/|your ListenBrainz settings>. HuddleFM checks it with ListenBrainz before saving it.",
      ),
      input("listenbrainz_token", "User token", {
        type: "plain_text_input",
        action_id: "value",
        placeholder: plain("Paste token"),
      }),
    ],
  };
}

/** A kind of song a user is kept with, as Your data lists and deletes it. */
export const userSongKinds = ["added", "plays", "likes", "skips"] as const;
export type UserSongKind = (typeof userSongKinds)[number];
const userSongLabels: Record<UserSongKind, { title: string; effect: string }> =
  {
    added: {
      title: "Songs you added",
      effect:
        "Your name comes off the songs you added that have finished, and the Huddle mix stops drawing on them. Songs still queued or playing keep it.",
    },
    plays: {
      title: "Songs you heard",
      effect: "The Huddle mix forgets what you have listened to.",
    },
    likes: {
      title: "Songs you liked",
      effect: "Autoplay forgets the songs you asked for more of.",
    },
    skips: {
      title: "Autoplay picks you skipped",
      effect: "Autoplay forgets what you skipped.",
    },
  };

// Your data lists this many of the channel saves a user made, at most, so
// the modal stays within Slack's block limit.
const yourDataChannelSaveLimit = 40;

export type YourDataOptions = {
  sessionId: string;
  // The metadata of Settings under Your data, kept to redraw it.
  settings?: unknown;
  notice?: string;
  added: { count: number; recent: { title: string; artist: string }[] };
  plays: YourDataOptions["added"];
  likes: YourDataOptions["added"];
  skips: YourDataOptions["added"];
  scrobbles: number;
  saves: ChannelSaveView[];
  // Sessions the user saved to a channel, with the channel they are in.
  channelSaves: (ChannelSaveView & { channelId: string })[];
  // Jellyfin servers the user linked.
  jellyfinServers?: { name: string; host: string; linkedAt: number }[];
};

/** What HuddleFM keeps about the user, each kind with a way to delete it. */
export function yourDataView(options: YourDataOptions) {
  const deleteButton = (
    actionId: string,
    value: string,
    title: string,
    text: string,
  ) =>
    button(actionId, plain("Delete"), {
      style: "danger",
      value,
      confirm: confirm(title, text, "Delete"),
    });
  const saveBlock = (
    save: ChannelSaveView,
    actionId: string,
    where: string,
    effect: string,
  ) => ({
    type: "section",
    block_id: `${actionId}_${save.id}`,
    text: {
      type: "mrkdwn",
      text: `*${escape(save.name)}*${where}\n${songCount(save.songs)} · saved ${slackDate(save.savedAt)}`,
    },
    accessory: deleteButton(actionId, save.id, "Delete saved session?", effect),
  });
  const channelSaves = options.channelSaves.slice(0, yourDataChannelSaveLimit);
  const hidden = options.channelSaves.length - channelSaves.length;
  const songs = (kind: UserSongKind) => {
    const { count, recent } = options[kind];
    const label = userSongLabels[kind];
    const lines = recent.map(
      (song) => `${escape(song.title)} — ${escape(song.artist)}`,
    );
    const more = count > recent.length ? "\n…" : "";
    return {
      type: "section",
      block_id: `data_${kind}`,
      text: {
        type: "mrkdwn",
        text: `*${label.title}* · ${count}${lines.length ? `\n${lines.join("\n")}${more}` : ""}`,
      },
      ...(count
        ? {
            accessory: deleteButton(
              `delete_data_${kind}`,
              options.sessionId,
              `Delete ${label.title.toLowerCase()}?`,
              label.effect,
            ),
          }
        : {}),
    };
  };
  return {
    type: "modal",
    callback_id: "your_data",
    private_metadata: dialogMetadata(options.sessionId, options.settings),
    title: plain("Your data"),
    close: plain("Done"),
    blocks: [
      context(
        "data_about",
        "These are the saved sessions, songs and scrobbles HuddleFM keeps about you. Deleting takes effect straight away. HuddleFM also keeps which sessions you were in and hosted, to run them, and an audit log of who did what, which is never deleted.",
      ),
      ...when(options.notice, context("data_notice", options.notice ?? "")),
      { type: "header", text: plain("Saved sessions") },
      ...options.saves.map((save) =>
        saveBlock(
          save,
          "delete_own_save",
          "",
          "You will not be able to load it again.",
        ),
      ),
      ...channelSaves.map((save) =>
        saveBlock(
          save,
          "delete_my_channel_save",
          ` in <#${save.channelId}>`,
          "Nobody in the channel will be able to load it again.",
        ),
      ),
      ...when(
        hidden > 0,
        context(
          "data_saves_more",
          `And ${hidden} more saved to channels, which you can delete from Settings there.`,
        ),
      ),
      ...when(
        !options.saves.length && !options.channelSaves.length,
        context("data_saves_none", "None."),
      ),
      { type: "header", text: plain("Listening") },
      ...userSongKinds.map(songs),
      {
        type: "section",
        block_id: "data_scrobbles",
        text: {
          type: "mrkdwn",
          text: `*Scrobbles* · ${options.scrobbles}\nListens waiting for, or already sent to, Last.fm and ListenBrainz.`,
        },
        ...(options.scrobbles
          ? {
              accessory: deleteButton(
                "delete_data_scrobbles",
                options.sessionId,
                "Delete scrobbles?",
                "Listens not yet sent to Last.fm or ListenBrainz will not be sent. Those already sent stay with them.",
              ),
            }
          : {}),
      },
      ...when(
        options.jellyfinServers?.length,
        { type: "header", text: plain("Jellyfin") },
        section(
          [
            ...(options.jellyfinServers ?? []).map(
              (server) =>
                `*${escape(server.name)}* · ${escape(server.host)} · linked ${slackDate(server.linkedAt)}`,
            ),
            "HuddleFM keeps its sign-in to each, which you can unlink under Settings › You.",
          ].join("\n"),
          "data_jellyfin",
        ),
      ),
      { type: "divider" },
      actions("data_everything", [
        button("delete_all_data", plain("Delete everything"), {
          style: "danger",
          value: options.sessionId,
          confirm: confirm(
            "Delete everything?",
            "This deletes your saved sessions and listening history above, disconnects Last.fm and ListenBrainz, unlinks Jellyfin, and resets your choices. Sessions you saved to channels belong to them, so they stay unless you delete them yourself.",
            "Delete everything",
          ),
        }),
      ]),
    ],
  };
}
