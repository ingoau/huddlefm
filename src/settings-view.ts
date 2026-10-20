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
  staticSelect,
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
  mediaModes,
  scrobblingModes,
  transitionModes,
  type AutoplayMode,
  type DisplayMode,
  type DuckingMode,
  type HuddleMixSource,
  type LoopMode,
  type MediaMode,
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
const mediaModeLabels: Record<MediaMode, string> = {
  music: "Music",
  video: "Video",
};
const mediaModeDescriptions: Record<MediaMode, string> = {
  music: "Listen together, with autoplay, lyrics and crossfades",
  video: "Watch YouTube videos together on a screen share",
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
  session: {
    hostId?: string;
    mediaMode: MediaMode;
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

function sessionBlocks(options: SettingsViewOptions, form: FormState) {
  const { access, session, sessionId: value } = options;
  const volume =
    form.volume?.percent?.selected_option?.value ??
    String(Math.round(session.volume * 10_000) / 100);
  // Video mode has no use for the music's own settings, so they are left
  // out, and left as they are for when the music comes back.
  const music = session.mediaMode === "music";
  return [
    ...when(
      access.admin,
      input(
        "media_mode",
        "Mode",
        modeSelect(
          mediaModes,
          selected(form.media_mode?.mode, mediaModes) ?? session.mediaMode,
          (mode) => mediaModeLabels[mode],
          mediaModeDescriptions,
        ),
        { hint: "Only the host can switch modes" },
      ),
    ),
    ...when(access.volume, input("volume", "Volume", volumeSelect(volume))),
    ...when(
      access.configure && music,
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
    ),
    ...when(
      access.configure,
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
    ),
    ...when(
      access.configure && music,
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
    ),
    ...when(
      access.configure,
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

// Volume in the player's steps of 5%, and the current volume when it falls
// between them, as from an older default or a channel's.
function volumeSelect(current: string) {
  const steps = Array.from({ length: 21 }, (_, index) => String(index * 5));
  const values = steps.includes(current)
    ? steps
    : [...steps, current].sort((a, b) => Number(a) - Number(b));
  return staticSelect(
    "percent",
    values.map((value) => ({ text: plain(`${value}%`), value })),
    current,
  );
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
  // A preset fills in the checkboxes when picked. Slack keeps what an input
  // showed across a redraw unless its block ID changes, so each fill gives
  // both inputs new ones.
  const revision = options.revision ?? 0;
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
    {
      ...input(
        versionedBlockId("permission_preset", revision),
        "Start from a preset",
        {
          type: "static_select",
          action_id: "apply_permission_preset",
          placeholder: plain("Choose a preset"),
          options: presets,
        },
        {
          optional: true,
          hint: "Fills in the permissions below. Nothing changes until you save.",
        },
      ),
      dispatch_action: true,
    },
    input(
      versionedBlockId("permissions", revision),
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

// The services a user scrobbles to, named in the checkboxes' action ID as the
// Huddle mix sources are, so only the services the form offered are saved.
const scrobbleServicesPrefix = "services:";
export const scrobbleServices = ["lastfm", "listenbrainz"] as const;
export type ScrobbleService = (typeof scrobbleServices)[number];
const scrobbleServiceLabels: Record<ScrobbleService, string> = {
  lastfm: "Last.fm",
  listenbrainz: "ListenBrainz",
};

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

function youBlocks(options: SettingsViewOptions, form: FormState) {
  const { user: settings, sessionId: value } = options;
  const mix = submittedHuddleMixSources(form.huddle_mix);
  const chosen = settings.huddleMixUsable.filter(
    (source) => mix?.[source] ?? settings.huddleMixSources.includes(source),
  );
  const connected = scrobbleServices.filter((service) =>
    service === "lastfm"
      ? settings.lastFmConnected
      : settings.listenBrainzConnected,
  );
  const services = submittedScrobbleServices(form.scrobble_to);
  const serviceOption = (service: ScrobbleService) => ({
    text: plain(scrobbleServiceLabels[service]),
    value: service,
  });
  const scrobblingTo = connected.filter(
    (service) =>
      services?.[service] ??
      (service === "lastfm"
        ? settings.lastFmEnabled
        : settings.listenBrainzEnabled),
  );
  const lastFm = settings.lastFmConnected
    ? `Connected as ${escape(settings.lastFmUsername ?? "unknown")}`
    : "Not connected";
  const listenBrainz = settings.listenBrainzConnected
    ? settings.listenBrainzUsername
      ? `Connected as ${escape(settings.listenBrainzUsername)}`
      : "Token saved"
    : "Not connected";
  return [
    // The mix is autoplay's, which video mode does without.
    ...when(
      options.session.mediaMode === "music",
      input(
        "huddle_mix",
        "Include in Huddle mix",
        huddleMixSourceInput(settings.huddleMixUsable, chosen),
        {
          optional: true,
          hint: "Only used while you're in the huddle, and never shown as yours. Untick everything to opt out of the mix.",
        },
      ),
    ),
    ...when(
      settings.configured,
      { type: "header", text: plain("Scrobbling") },
      input(
        "session_scrobbling",
        "This session",
        toggle(
          "enabled",
          "Scrobble what I listen to here",
          checked(form.session_scrobbling?.enabled) ??
            Boolean(settings.sessionEnabled),
        ),
        { optional: true },
      ),
      input(
        "scrobbling_mode",
        "Default for new Huddles",
        modeSelect(
          scrobblingModes,
          selected(form.scrobbling_mode?.mode, scrobblingModes) ??
            settings.mode,
          scrobblingModeLabel,
        ),
      ),
      input(
        "scrobble_to",
        "Scrobble to",
        {
          type: "checkboxes",
          action_id: `${scrobbleServicesPrefix}${connected.join(",")}`,
          options: connected.map(serviceOption),
          initial_options: scrobblingTo.map(serviceOption),
        },
        { optional: true },
      ),
    ),
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

function scrobblingModeLabel(mode: ScrobblingMode) {
  if (mode === "ask") return "Ask every Huddle";
  if (mode === "ask_track") return "Ask for every track";
  return capitalize(mode);
}
