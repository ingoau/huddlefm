import { capitalize, permissionLabels } from "./coordinator-ui.ts";
import {
  autoplayModeLabels,
  autoplayModes,
  capabilities,
  displayModes,
  duckingModeLabels,
  duckingModes,
  loopModeLabels,
  loopModes,
  mediaModes,
  permissionPresets,
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

/*
 * Settings as data: each one's label, choices, and who may change it. The
 * settings modal is drawn from these, and client mods get the same list over
 * the data channel, so a setting added here shows up in both. What only Slack
 * needs, like block and action IDs, stays with the modal.
 */

/** A session's settings, as Settings shows them. */
export type SessionSettingsView = {
  hostId?: string;
  mediaMode: MediaMode;
  volume: number;
  displayMode: DisplayMode;
  autoplayMode: AutoplayMode;
  videoAutoplay?: boolean;
  loopMode: LoopMode;
  transitionMode: TransitionMode;
  duckingMode: DuckingMode;
  anchorEnabled: boolean;
  progressBar: boolean;
  allowed: ReadonlySet<string>;
};

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

export type SettingOption = {
  value: string;
  label: string;
  description?: string;
};

/**
 * What a setting takes to change: the volume permission, the configure
 * permission, host powers, or nothing, for a user's own settings.
 */
export type SettingRequirement = "volume" | "configure" | "admin" | "self";

type FieldBase = {
  id: string;
  tab: "session" | "host" | "you";
  label: string;
  hint?: string;
  optional?: boolean;
  requires: SettingRequirement;
  /** A heading the setting starts a group under. */
  section?: string;
};

/** One setting, with its current value, as the modal and client mods show it. */
export type SettingField = FieldBase &
  (
    | { kind: "select"; options: SettingOption[]; value: string }
    | { kind: "toggle"; text: string; value: boolean }
    | {
        kind: "multi";
        options: SettingOption[];
        value: string[];
        presets?: { value: string; label: string; permissions: string[] }[];
      }
    | { kind: "user"; value: string | null }
  );

export type SettingFieldValue = SettingField["value"];

export type SettingsContext = {
  // Which requirements the viewer meets.
  access: { volume: boolean; configure: boolean; admin: boolean };
  session: SessionSettingsView;
  // The viewer's own settings, for the You tab.
  user?: UserSettingsView;
};

const autoplayDescriptions: Record<AutoplayMode, string> = {
  off: "Do not queue recommendations",
  related: "Continue from songs requested in this huddle",
  huddle: "Mix what people in this huddle listen to",
};
// Video mode's autoplay is on or off: it only ever follows on with related
// videos.
export const videoAutoplayModes = ["off", "related"] as const;
type VideoAutoplayMode = (typeof videoAutoplayModes)[number];
const videoAutoplayLabels: Record<VideoAutoplayMode, string> = {
  off: "Off",
  related: "Related videos",
};
const videoAutoplayDescriptions: Record<VideoAutoplayMode, string> = {
  off: "Do not queue videos",
  related: "Play a video related to what people queued",
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
export const huddleMixSourceLabels: Record<HuddleMixSource, string> = {
  added: "Songs I've added or liked",
  lastfm: "My Last.fm listening",
  listenbrainz: "My ListenBrainz listening",
};
export const scrobbleServices = ["lastfm", "listenbrainz"] as const;
export type ScrobbleService = (typeof scrobbleServices)[number];
export const scrobbleServiceLabels: Record<ScrobbleService, string> = {
  lastfm: "Last.fm",
  listenbrainz: "ListenBrainz",
};
const presetLabels: Record<keyof typeof permissionPresets, string> = {
  default: "Default",
  "host-only": "Host only",
  collaborative: "Collaborative",
  communism: "Communism",
};

export function scrobblingModeLabel(mode: ScrobblingMode) {
  if (mode === "ask") return "Ask every Huddle";
  if (mode === "ask_track") return "Ask for every track";
  return capitalize(mode);
}

function transitionLabel(mode: TransitionMode) {
  if (mode === "none") return "Disabled";
  if (mode === "adaptive") return "Adaptive crossfade";
  return capitalize(mode);
}

function choices<Mode extends string>(
  modes: readonly Mode[],
  label: (mode: Mode) => string,
  descriptions?: Record<Mode, string>,
): SettingOption[] {
  return modes.map((mode) => ({
    value: mode,
    label: label(mode),
    ...(descriptions ? { description: descriptions[mode] } : {}),
  }));
}

/** The volume as Settings shows it, in percent. */
export function volumePercent(volume: number) {
  return String(Math.round(volume * 10_000) / 100);
}

// Volume in the player's steps of 5%, and the current volume when it falls
// between them, as from an older default or a channel's.
function volumeChoices(current: string) {
  const steps = Array.from({ length: 21 }, (_, index) => String(index * 5));
  const values = steps.includes(current)
    ? steps
    : [...steps, current].sort((a, b) => Number(a) - Number(b));
  return values.map((value) => ({ value, label: `${value}%` }));
}

function connectedServices(user: UserSettingsView) {
  return scrobbleServices.filter((service) =>
    service === "lastfm" ? user.lastFmConnected : user.listenBrainzConnected,
  );
}

type Entry = FieldBase & {
  visible(context: SettingsContext): boolean;
} & (
    | {
        kind: "select";
        value(context: SettingsContext): string;
        options(context: SettingsContext, value: string): SettingOption[];
      }
    | { kind: "toggle"; text: string; value(context: SettingsContext): boolean }
    | {
        kind: "multi";
        value(context: SettingsContext): string[];
        options(context: SettingsContext): SettingOption[];
        presets?: { value: string; label: string; permissions: string[] }[];
      }
    | { kind: "user"; value(context: SettingsContext): string | null }
  );

const music = ({ session }: SettingsContext) => session.mediaMode === "music";
const video = ({ session }: SettingsContext) => session.mediaMode !== "music";
const always = () => true;

const entries: Entry[] = [
  {
    id: "media_mode",
    tab: "session",
    label: "Mode",
    hint: "Only the host can switch modes",
    requires: "admin",
    kind: "select",
    visible: always,
    value: ({ session }) => session.mediaMode,
    options: () =>
      choices(
        mediaModes,
        (mode) => mediaModeLabels[mode],
        mediaModeDescriptions,
      ),
  },
  {
    id: "volume",
    tab: "session",
    label: "Volume",
    requires: "volume",
    kind: "select",
    visible: always,
    value: ({ session }) => volumePercent(session.volume),
    options: (_, value) => volumeChoices(value),
  },
  {
    id: "display",
    tab: "session",
    label: "Display mode",
    requires: "configure",
    kind: "select",
    visible: music,
    value: ({ session }) => session.displayMode,
    options: () => choices(displayModes, capitalize),
  },
  {
    id: "autoplay",
    tab: "session",
    label: "Autoplay",
    hint: "Play recommendations when the queue is empty",
    optional: true,
    requires: "configure",
    kind: "select",
    visible: music,
    value: ({ session }) => session.autoplayMode,
    options: () =>
      choices(
        autoplayModes,
        (mode) => autoplayModeLabels[mode],
        autoplayDescriptions,
      ),
  },
  {
    id: "video_autoplay",
    tab: "session",
    label: "Autoplay",
    hint: "Play related videos when the queue is empty",
    optional: true,
    requires: "configure",
    kind: "select",
    visible: video,
    value: ({ session }) => (session.videoAutoplay ? "related" : "off"),
    options: () =>
      choices(
        videoAutoplayModes,
        (mode) => videoAutoplayLabels[mode],
        videoAutoplayDescriptions,
      ),
  },
  {
    id: "loop",
    tab: "session",
    label: "Loop",
    hint: "Repeat the current track or cycle the queue",
    optional: true,
    requires: "configure",
    kind: "select",
    visible: always,
    value: ({ session }) => session.loopMode,
    options: () =>
      choices(loopModes, (mode) => loopModeLabels[mode], loopDescriptions),
  },
  {
    id: "transition",
    tab: "session",
    label: "Transitions",
    requires: "configure",
    kind: "select",
    visible: music,
    value: ({ session }) => session.transitionMode,
    options: () => choices(transitionModes, transitionLabel),
  },
  {
    id: "ducking",
    tab: "session",
    label: "Auto-duck",
    hint: "Lower the music while someone is speaking",
    requires: "configure",
    kind: "select",
    visible: music,
    value: ({ session }) => session.duckingMode,
    options: () =>
      choices(
        duckingModes,
        (mode) => duckingModeLabels[mode],
        duckingDescriptions,
      ),
  },
  {
    id: "progress_bar",
    tab: "session",
    label: "Progress bar",
    optional: true,
    requires: "configure",
    kind: "toggle",
    text: "Show a progress bar on videos",
    visible: video,
    value: ({ session }) => session.progressBar,
  },
  {
    id: "anchor",
    tab: "session",
    label: "Thread position",
    optional: true,
    requires: "configure",
    kind: "toggle",
    text: "Keep player at bottom of thread",
    visible: always,
    value: ({ session }) => session.anchorEnabled,
  },
  {
    id: "host",
    tab: "host",
    label: "Transfer host",
    optional: true,
    requires: "admin",
    kind: "user",
    visible: always,
    value: ({ session }) => session.hostId ?? null,
  },
  {
    id: "permissions",
    tab: "host",
    label: "Everyone else may",
    optional: true,
    requires: "admin",
    section: "Permissions",
    kind: "multi",
    visible: always,
    value: ({ session }) =>
      capabilities.filter((value) => session.allowed.has(value)),
    options: () =>
      capabilities.map((value) => ({ value, label: permissionLabels[value] })),
    presets: Object.entries(presetLabels).map(([value, label]) => ({
      value,
      label,
      permissions: [
        ...permissionPresets[value as keyof typeof permissionPresets],
      ],
    })),
  },
  {
    id: "huddle_mix",
    tab: "you",
    label: "Include in Huddle mix",
    hint: "Only used while you're in the huddle, and never shown as yours. Untick everything to opt out of the mix.",
    optional: true,
    requires: "self",
    kind: "multi",
    // The mix is autoplay's, which video mode does without.
    visible: music,
    value: ({ user }) =>
      user!.huddleMixUsable.filter((source) =>
        user!.huddleMixSources.includes(source),
      ),
    options: ({ user }) =>
      user!.huddleMixUsable.map((value) => ({
        value,
        label: huddleMixSourceLabels[value],
      })),
  },
  {
    id: "session_scrobbling",
    tab: "you",
    label: "This session",
    optional: true,
    requires: "self",
    section: "Scrobbling",
    kind: "toggle",
    text: "Scrobble what I listen to here",
    visible: ({ user }) => Boolean(user?.configured),
    value: ({ user }) => Boolean(user!.sessionEnabled),
  },
  {
    id: "scrobbling_mode",
    tab: "you",
    label: "Default for new Huddles",
    requires: "self",
    kind: "select",
    visible: ({ user }) => Boolean(user?.configured),
    value: ({ user }) => user!.mode,
    options: () => choices(scrobblingModes, scrobblingModeLabel),
  },
  {
    id: "scrobble_to",
    tab: "you",
    label: "Scrobble to",
    optional: true,
    requires: "self",
    kind: "multi",
    visible: ({ user }) => Boolean(user?.configured),
    value: ({ user }) =>
      connectedServices(user!).filter((service) =>
        service === "lastfm" ? user!.lastFmEnabled : user!.listenBrainzEnabled,
      ),
    options: ({ user }) =>
      connectedServices(user!).map((value) => ({
        value,
        label: scrobbleServiceLabels[value],
      })),
  },
];

function allowed(entry: Entry, context: SettingsContext) {
  if (entry.requires === "self") return Boolean(context.user);
  return context.access[entry.requires];
}

/**
 * The settings a viewer may change, in the order Settings shows them, with
 * their current values. `overrides` stands in for some of those values, as a
 * modal's unsaved edits do.
 */
export function settingFields(
  context: SettingsContext,
  overrides: Partial<Record<string, SettingFieldValue>> = {},
): SettingField[] {
  return entries.flatMap((entry): SettingField[] => {
    if (!allowed(entry, context) || !entry.visible(context)) return [];
    const { visible: _visible, ...base } = entry;
    const override = overrides[entry.id];
    switch (base.kind) {
      case "select": {
        const value =
          typeof override === "string" ? override : base.value(context);
        return [{ ...base, value, options: base.options(context, value) }];
      }
      case "toggle":
        return [
          {
            ...base,
            value:
              typeof override === "boolean" ? override : base.value(context),
          },
        ];
      case "multi":
        return [
          {
            ...base,
            value: Array.isArray(override) ? override : base.value(context),
            options: base.options(context),
          },
        ];
      case "user":
        return [
          {
            ...base,
            value:
              typeof override === "string" || override === null
                ? override
                : base.value(context),
          },
        ];
    }
  });
}
