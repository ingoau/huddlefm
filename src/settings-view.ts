import {
  actions,
  button,
  capitalize,
  confirm,
  escape,
  input,
  modeSelect,
  permissionLabels,
  plain,
  section,
  toggle,
  when,
} from "./coordinator-ui.ts";
import {
  integrationSettingsBlocks,
  slackModalBlockLimit,
} from "./integration.ts";
import {
  autoplayModeLabels,
  autoplayModes,
  capabilities,
  displayModes,
  duckingModeLabels,
  duckingModes,
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

// The settings modal's Huddle mix checkboxes name the sources they offer in
// their action ID. Only those sources are saved, so a service the user had
// not connected keeps its choice for when they do, and a refreshed modal
// that offers a different set starts from the saved ticks rather than Slack
// carrying over the old ones.
export const huddleMixActionPrefix = "sources:";

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

export type SettingsViewOptions = {
  sessionId: string;
  hostId?: string;
  integrationPage: number;
  // What the viewer may change.
  access: {
    volume: boolean;
    configure: boolean;
    admin: boolean;
    endSession: boolean;
    saveDefaults: boolean;
    hasChannelDefaults: boolean;
  };
  session: {
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
  integrations: { userId: string; requestId: string; permissions: string[] }[];
};

export function settingsView(options: SettingsViewOptions) {
  const { access, session, user: settings, sessionId: value } = options;
  const sessionBlocks = [
    { type: "header", text: plain("Session") },
    ...when(
      access.volume,
      input("volume", "Volume (%)", {
        type: "plain_text_input",
        action_id: "percent",
        initial_value: String(Math.round(session.volume * 10_000) / 100),
      }),
    ),
    ...when(
      access.configure,
      input(
        "display",
        "Display mode",
        modeSelect(displayModes, session.displayMode, capitalize),
      ),
      input(
        "autoplay",
        "Autoplay",
        modeSelect(
          autoplayModes,
          session.autoplayMode,
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
          session.loopMode,
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
        modeSelect(transitionModes, session.transitionMode, (mode) =>
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
          session.duckingMode,
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
          session.anchorEnabled,
        ),
        { optional: true },
      ),
    ),
    ...when(
      access.saveDefaults || access.endSession,
      actions("session_actions", [
        ...when(
          access.saveDefaults,
          button(
            "save_channel_defaults",
            plain("Save as defaults for this channel"),
            {
              value,
              confirm: confirm(
                "Save channel defaults?",
                "New sessions in this channel will start with the settings shown here.",
                "Save",
              ),
            },
          ),
        ),
        ...when(
          access.saveDefaults && access.hasChannelDefaults,
          button("clear_channel_defaults", plain("Clear channel defaults"), {
            value,
            confirm: confirm(
              "Clear channel defaults?",
              "New sessions in this channel will start with the usual settings.",
              "Clear",
            ),
          }),
        ),
        ...when(
          access.endSession,
          // Ending asks in a dialog of its own rather than a confirmation,
          // which cannot carry the choice to save the session.
          button("open_end_session", plain("End session"), {
            style: "danger",
            value,
          }),
        ),
      ]),
    ),
    ...when(
      access.admin,
      { type: "header", text: plain("Permissions") },
      input(
        "host",
        "Transfer host",
        {
          type: "users_select",
          action_id: "user",
          ...(options.hostId ? { initial_user: options.hostId } : {}),
        },
        { optional: true },
      ),
      input(
        "permission_preset",
        "Apply permission preset",
        {
          type: "static_select",
          action_id: "selected",
          placeholder: plain("Choose a preset"),
          options: (
            [
              ["default", "Default"],
              ["host-only", "Host only"],
              ["collaborative", "Collaborative"],
              ["communism", "Communism"],
            ] satisfies [string, string][]
          ).map(([value, label]) => ({ text: plain(label), value })),
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
            .filter((value) => session.allowed.has(value))
            .map((value) => ({
              text: plain(permissionLabels[value]),
              value,
            })),
        },
        { optional: true },
      ),
    ),
  ];
  const userBlocks = [
    { type: "header", text: plain("User settings") },
    input(
      "huddle_mix",
      "Include in Huddle mix",
      huddleMixSourceInput(settings.huddleMixUsable, settings.huddleMixSources),
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
        modeSelect(scrobblingModes, settings.mode, (mode) =>
          mode === "ask" ? "Ask every time" : capitalize(mode),
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
            toggle("enabled", "Enabled", settings.lastFmEnabled),
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
      toggle("enabled", "Enabled", settings.listenBrainzEnabled),
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
  const integrationBlocks = access.admin
    ? integrationSettingsBlocks({
        sessionId: options.sessionId,
        grants: options.integrations,
        maxBlocks:
          slackModalBlockLimit - sessionBlocks.length - userBlocks.length,
        page: options.integrationPage,
      })
    : [];
  return {
    type: "modal",
    callback_id: "save_settings",
    private_metadata: JSON.stringify({
      sessionId: options.sessionId,
      hostId: options.hostId,
      integrationPage: options.integrationPage,
    }),
    title: plain("HuddleFM settings"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [...sessionBlocks, ...integrationBlocks, ...userBlocks],
  };
}
