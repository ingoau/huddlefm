import {
  actions,
  button,
  capitalize,
  confirm,
  context,
  escape,
  input,
  modeSelect,
  permissionLabels,
  plain,
  section,
  songCount,
  toggle,
  when,
} from "./coordinator-ui.ts";
import {
  integrationSettingsBlocks,
  slackModalBlockLimit,
} from "./integration.ts";
import type { Interaction } from "./slack-app.ts";
import {
  autoplayModeLabels,
  autoplayModes,
  capabilities,
  displayModes,
  duckingModeLabels,
  duckingModes,
  huddleMixSources,
  loopModeLabels,
  loopModes,
  scrobblingModes,
  transitionModes,
  type AutoplayMode,
  type DisplayMode,
  type DuckingMode,
  type HuddleMixSource,
  type LoopMode,
  type ScrobblingMode,
  type TransitionMode,
} from "./store.ts";

const autoplayDescriptions: Record<AutoplayMode, string> = {
  off: "Do not queue recommendations",
  related: "Continue from songs requested in this huddle",
  huddle: "Mix what people in this huddle listen to",
};
const loopDescriptions: Record<LoopMode, string> = {
  off: "Do not repeat",
  track: "Restart the current song when it ends",
  queue: "Move finished songs back to the end of the queue",
};
const duckingDescriptions: Record<DuckingMode, string> = {
  off: "Keep playing at full volume",
  gentle: "Dip the music under the conversation",
  strong: "Drop the music well back while people talk",
};

const huddleMixSourceLabels: Record<HuddleMixSource, string> = {
  added: "Songs I've added or liked",
  lastfm: "My Last.fm listening",
  listenbrainz: "My ListenBrainz listening",
};

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

function huddleMixSourceInput(
  offered: readonly HuddleMixSource[],
  chosen: readonly HuddleMixSource[],
) {
  const option = (source: HuddleMixSource) => ({
    text: plain(huddleMixSourceLabels[source]),
    value: source,
  });
  return {
    type: "checkboxes",
    action_id: `${huddleMixActionPrefix}${offered.join(",")}`,
    options: offered.map(option),
    initial_options: offered
      .filter((source) => chosen.includes(source))
      .map(option),
  };
}

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
// later interaction with the modal.
const undraftedBlocks = new Set(["listenbrainz_token"]);

/**
 * The meaningful part of a form, without the labels Slack echoes back, so a
 * draft of it fits in a modal's private metadata. Anything that is not a
 * form value is dropped, which also makes it safe to read one back.
 */
export function compactForm(state: unknown): FormState {
  const form: FormState = {};
  if (!isRecord(state)) return form;
  for (const [blockId, block] of Object.entries(state)) {
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
    draft: compactForm(value.draft),
  };
}

/** The draft with the inputs on screen, which are newer, laid over it. */
export function mergeForm(draft: FormState, state: FormState): FormState {
  return { ...draft, ...compactForm(state) };
}

// Slack refuses private metadata over this many characters.
const metadataLimit = 3000;

/** A user's own settings, as Settings shows them. */
export type UserSettingsView = {
  lastFmAvailable: boolean;
  lastFmConnected: boolean;
  lastFmUsername?: string;
  lastFmEnabled: boolean;
  listenBrainzConnected: boolean;
  listenBrainzUsername?: string;
  listenBrainzEnabled: boolean;
  huddleMixSources: readonly HuddleMixSource[];
  huddleMixUsable: readonly HuddleMixSource[];
  mode: ScrobblingMode;
  configured: boolean;
  sessionEnabled?: boolean;
};

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
  draft?: FormState;
  // What the viewer may change.
  access: {
    volume: boolean;
    configure: boolean;
    admin: boolean;
    endSession: boolean;
    saveDefaults: boolean;
  };
  session: {
    hostId?: string;
    volume: number;
    displayMode: DisplayMode;
    autoplayMode: AutoplayMode;
    loopMode: LoopMode;
    transitionMode: TransitionMode;
    duckingMode: DuckingMode;
    anchorEnabled: boolean;
    allowed: ReadonlySet<string>;
  };
  user: UserSettingsView;
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
      hostId: options.hostId,
      tab,
      integrationPage: options.integrationPage,
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
    blocks: [...tabBlocks, ...content, ...integrationBlocks],
  };
}

function sessionBlocks(options: SettingsViewOptions, form: FormState) {
  const { access, session, sessionId: value } = options;
  const volumeText =
    form.volume?.percent?.value ??
    String(Math.round(session.volume * 10_000) / 100);
  return [
    ...when(
      access.volume,
      input("volume", "Volume (%)", {
        type: "plain_text_input",
        action_id: "percent",
        initial_value: volumeText,
      }),
    ),
    ...when(
      access.configure,
      input(
        "display",
        "Display mode",
        modeSelect(
          displayModes,
          selected(form.display?.mode, displayModes) ?? session.displayMode,
          capitalize,
        ),
      ),
      input(
        "autoplay",
        "Autoplay",
        modeSelect(
          autoplayModes,
          selected(form.autoplay?.mode, autoplayModes) ?? session.autoplayMode,
          (mode) => autoplayModeLabels[mode],
          autoplayDescriptions,
        ),
        {
          optional: true,
          hint: "Play recommendations when the queue is empty",
        },
      ),
      input(
        "loop",
        "Loop",
        modeSelect(
          loopModes,
          selected(form.loop?.mode, loopModes) ?? session.loopMode,
          (mode) => loopModeLabels[mode],
          loopDescriptions,
        ),
        {
          optional: true,
          hint: "Repeat the current track or cycle the queue",
        },
      ),
      input(
        "transition",
        "Transitions",
        modeSelect(
          transitionModes,
          selected(form.transition?.mode, transitionModes) ??
            session.transitionMode,
          (mode) =>
            mode === "none"
              ? "Disabled"
              : mode === "adaptive"
                ? "Adaptive crossfade"
                : capitalize(mode),
        ),
      ),
      input(
        "ducking",
        "Auto-duck",
        modeSelect(
          duckingModes,
          selected(form.ducking?.mode, duckingModes) ?? session.duckingMode,
          (mode) => duckingModeLabels[mode],
          duckingDescriptions,
        ),
        { hint: "Lower the music while someone is speaking" },
      ),
      input(
        "anchor",
        "Thread position",
        toggle(
          "enabled",
          "Keep player at bottom of thread",
          checked(form.anchor?.enabled) ?? session.anchorEnabled,
        ),
        { optional: true },
      ),
    ),
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
          `Nobody in this channel will be able to load *${escape(save.name)}* any more.`,
          "Delete",
        ),
      }),
    })),
  ];
}

function hostBlocks(options: SettingsViewOptions, form: FormState) {
  const { session } = options;
  const allowed = new Set(
    form.permissions?.selected?.selected_options?.map(
      (option) => option.value,
    ) ?? session.allowed,
  );
  const hostId = form.host?.user?.selected_user ?? session.hostId;
  const presets = (
    [
      ["default", "Default"],
      ["host-only", "Host only"],
      ["collaborative", "Collaborative"],
      ["communism", "Communism"],
    ] satisfies [string, string][]
  ).map(([value, label]) => ({ text: plain(label), value }));
  const preset = presets.find(
    (option) =>
      option.value === form.permission_preset?.selected?.selected_option?.value,
  );
  return [
    input(
      "host",
      "Transfer host",
      {
        type: "users_select",
        action_id: "user",
        ...(hostId ? { initial_user: hostId } : {}),
      },
      { optional: true },
    ),
    { type: "header", text: plain("Permissions") },
    input(
      "permission_preset",
      "Apply permission preset",
      {
        type: "static_select",
        action_id: "selected",
        placeholder: plain("Choose a preset"),
        options: presets,
        ...(preset ? { initial_option: preset } : {}),
      },
      {
        optional: true,
        hint: "Saving overwrites the custom permissions below.",
      },
    ),
    input(
      "permissions",
      "Everyone else may",
      {
        type: "checkboxes",
        action_id: "selected",
        options: capabilities.map((value) => ({
          text: plain(permissionLabels[value]),
          value,
        })),
        initial_options: capabilities
          .filter((value) => allowed.has(value))
          .map((value) => ({
            text: plain(permissionLabels[value]),
            value,
          })),
      },
      { optional: true },
    ),
  ];
}

function youBlocks(options: SettingsViewOptions, form: FormState) {
  const { user: settings, sessionId: value } = options;
  const mix = submittedHuddleMixSources(form.huddle_mix);
  const chosen = settings.huddleMixUsable.filter(
    (source) => mix?.[source] ?? settings.huddleMixSources.includes(source),
  );
  return [
    input(
      "huddle_mix",
      "Include in Huddle mix",
      huddleMixSourceInput(settings.huddleMixUsable, chosen),
      {
        optional: true,
        hint: "Only used while you're in the huddle, and never shown as yours. Untick everything to opt out of the mix.",
      },
    ),
    ...when(
      settings.configured,
      input(
        "scrobbling_mode",
        "Scrobbling mode",
        modeSelect(
          scrobblingModes,
          selected(form.scrobbling_mode?.mode, scrobblingModes) ??
            settings.mode,
          (mode) => (mode === "ask" ? "Ask every time" : capitalize(mode)),
        ),
        { hint: "Sets the default for each Huddle" },
      ),
      actions("session_scrobbling", [
        button(
          "toggle_session_scrobbling",
          plain(
            `${settings.sessionEnabled ? "Disable" : "Enable"} scrobbling for this session`,
          ),
          { value },
        ),
      ]),
    ),
    section(
      settings.lastFmConnected
        ? `*Last.fm*\nConnected as ${escape(settings.lastFmUsername ?? "unknown")}`
        : `*Last.fm*\n${settings.lastFmAvailable ? "Disconnected" : "Unavailable until the app API key is configured"}`,
    ),
    ...(settings.lastFmConnected
      ? [
          input(
            "lastfm_scrobbling",
            "Last.fm scrobbling",
            toggle(
              "enabled",
              "Enabled",
              checked(form.lastfm_scrobbling?.enabled) ??
                settings.lastFmEnabled,
            ),
            { optional: true },
          ),
          actions("lastfm_actions", [
            button("disconnect_lastfm", plain("Disconnect"), {
              style: "danger",
              value,
              confirm: confirm(
                "Disconnect Last.fm?",
                "This removes your saved Last.fm login.",
                "Disconnect",
              ),
            }),
          ]),
        ]
      : when(
          settings.lastFmAvailable,
          actions("lastfm_actions", [
            button("connect_lastfm", plain("Log in to Last.fm"), { value }),
          ]),
        )),
    input(
      "listenbrainz_scrobbling",
      "ListenBrainz scrobbling",
      toggle(
        "enabled",
        "Enabled",
        checked(form.listenbrainz_scrobbling?.enabled) ??
          settings.listenBrainzEnabled,
      ),
      {
        optional: true,
        hint: settings.listenBrainzConnected
          ? `Token saved${settings.listenBrainzUsername ? ` for ${settings.listenBrainzUsername}` : ""}`
          : "Uses your ListenBrainz user token",
      },
    ),
    input(
      "listenbrainz_token",
      "ListenBrainz API key / user token",
      {
        type: "plain_text_input",
        action_id: "value",
        placeholder: plain(
          settings.listenBrainzConnected ? "Saved" : "Paste token",
        ),
      },
      {
        optional: true,
        hint: settings.listenBrainzConnected
          ? "Leave blank to keep the saved token"
          : "Find it in ListenBrainz settings",
      },
    ),
    ...when(
      settings.listenBrainzConnected,
      actions("listenbrainz_actions", [
        button("disconnect_listenbrainz", plain("Remove token"), {
          style: "danger",
          value,
          confirm: confirm(
            "Remove ListenBrainz token?",
            "This disables ListenBrainz scrobbling and removes your saved token.",
            "Remove",
          ),
        }),
      ]),
    ),
  ];
}
