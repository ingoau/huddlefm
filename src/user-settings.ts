import type { AuditLog } from "./audit-log.ts";
import {
  actions,
  button,
  escape,
  plain,
  section,
  songCount,
  truncate,
} from "./coordinator-ui.ts";
import { safeError as message } from "./error-message.ts";
import type { Jellyfin } from "./jellyfin.ts";
import { JellyfinUi } from "./jellyfin-ui.ts";
import type { logger } from "./logger.ts";
import type { RecommendationCatalog } from "./recommendations.ts";
import type { ScrobbleDispatcher } from "./scrobbling.ts";
import {
  changedSettings,
  settingsChanges,
  type Settings,
} from "./settings-diff.ts";
import type { SessionSettingsView } from "./settings-schema.ts";
import {
  defaultUserSettings,
  dialogMetadata,
  listenBrainzTokenView,
  mergeForm,
  parseSettingsMetadata,
  selected,
  settingsView,
  submittedHuddleMixSources,
  submittedScrobbleServices,
  withoutUserForm,
  yourDataView,
  type FormState,
} from "./settings-view.ts";
import type { Interaction, SlackAppAdapter } from "./slack-app.ts";
import {
  scrobblingModes,
  type ScrobblingMode,
  type SessionSave,
  type Store,
} from "./store.ts";

/**
 * Stands in for a session ID on Settings opened outside any session, from a
 * DM with the bot, so its dialogs and buttons find their way back here.
 */
export const personalSettingsId = "personal";

/** The button in the bot's DM reply that opens the user's own Settings. */
export const openPersonalSettingsAction = "open_personal_settings";

// What Your data calls each kind of record it deletes.
const deletedNouns = {
  added: ["song", "songs"],
  plays: ["play", "plays"],
  likes: ["like", "likes"],
  skips: ["skip", "skips"],
  scrobbles: ["scrobble", "scrobbles"],
} as const;

export type UserDataKind =
  | "own_save"
  | "channel_save"
  | "added"
  | "plays"
  | "likes"
  | "skips"
  | "scrobbles"
  | "all";

/** The Your data buttons, by the kind of record each deletes. */
export const deleteDataActions: Record<string, UserDataKind> = {
  delete_own_save: "own_save",
  delete_my_channel_save: "channel_save",
  delete_data_added: "added",
  delete_data_plays: "plays",
  delete_data_likes: "likes",
  delete_data_skips: "skips",
  delete_data_scrobbles: "scrobbles",
  delete_all_data: "all",
};

/** What Your data shows about the user, apart from where it is opened. */
export function yourData(store: Store, userId: string) {
  const data = store.userData(userId);
  const save = (save: SessionSave) => ({
    id: save.id,
    name: save.name,
    savedBy: save.savedBy,
    savedAt: save.savedAt,
    songs: save.tracks.length,
  });
  return {
    added: data.added,
    plays: data.plays,
    likes: data.likes,
    skips: data.skips,
    scrobbles: data.scrobbles,
    saves: data.saves.map(save),
    channelSaves: data.channelSaves.map((item) => ({
      ...save(item),
      channelId: item.owner.id,
    })),
    jellyfinServers: store.jellyfinServers(userId).map((server) => ({
      name: server.name,
      host: URL.parse(server.baseUrl)?.host ?? server.baseUrl,
      linkedAt: server.linkedAt,
    })),
  };
}

/**
 * Deletes one kind of what is kept about the user, or all of it. Only ever
 * the user's own: each kind is looked up by their ID. Says how many records
 * went, and what to tell the user.
 */
export async function deleteUserData(
  services: {
    store: Store;
    jellyfinUi?: Pick<JellyfinUi, "forget">;
  },
  userId: string,
  kind: UserDataKind,
  saveId: string,
) {
  const { store } = services;
  if (kind === "own_save" || kind === "channel_save") {
    const data = store.userData(userId);
    const save = (kind === "own_save" ? data.saves : data.channelSaves).find(
      (save) => save.id === saveId,
    );
    if (!save)
      return { count: 0, notice: "That saved session is no longer there." };
    store.deleteSessionSave(save.id);
    return { count: 1, notice: `Deleted “${escape(save.name)}”.` };
  }
  if (kind === "all") {
    await services.jellyfinUi?.forget(userId);
    store.forgetUser(userId);
    return {
      count: 0,
      notice:
        "Deleted everything kept about you, apart from sessions you saved to channels.",
    };
  }
  const count =
    kind === "added"
      ? store.forgetAddedTracks(userId)
      : kind === "plays"
        ? store.deleteUserPlays(userId)
        : kind === "likes"
          ? store.deleteUserLikes(userId)
          : kind === "skips"
            ? store.deleteUserSkips(userId)
            : store.deleteUserScrobbles(userId);
  const [one, many] = deletedNouns[kind];
  return {
    count,
    notice:
      kind === "added"
        ? `Your name is off ${songCount(count)} you added.`
        : `Deleted ${count} ${count === 1 ? one : many}.`,
  };
}

/** The dialog that walks the user through authorizing Last.fm. */
export function lastFmLoginView(
  sessionId: string,
  settings: unknown,
  url: string,
) {
  return {
    type: "modal",
    callback_id: "lastfm_login",
    private_metadata: dialogMetadata(sessionId, settings),
    title: plain("Connect Last.fm"),
    close: plain("Cancel"),
    blocks: [
      section(
        "Authorize HuddleFM in Last.fm, return here, then press Continue.",
      ),
      actions("lastfm_login_actions", [
        button("open_lastfm_authorization", plain("Authorize Last.fm"), {
          url,
        }),
        button("continue_lastfm", plain("Continue"), {
          style: "primary",
          value: sessionId,
        }),
      ]),
    ],
  };
}

/** The Last.fm dialog once the account is connected. */
export function lastFmConnectedView(username: string) {
  return {
    type: "modal",
    title: plain("Connect Last.fm"),
    close: plain("Done"),
    blocks: [section(`Connected as *${escape(username)}*.`)],
  };
}

// Settings outside a session has only the You tab, which reads nothing of a
// session but whether it plays music, for the Huddle mix.
const noSession: SessionSettingsView = {
  mediaMode: "music",
  volume: 1,
  displayMode: "default",
  autoplayMode: "off",
  loopMode: "off",
  transitionMode: "none",
  duckingMode: "off",
  anchorEnabled: false,
  progressBar: false,
  communism: false,
  allowed: new Set(),
};

const noAccess = {
  volume: false,
  configure: false,
  admin: false,
  endSession: false,
  saveDefaults: false,
  autoJoin: false,
};

function parseMetadata(metadata: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(metadata || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

type SettingsMetadata = ReturnType<typeof parseSettingsMetadata>;

/**
 * A user's own settings, opened from a DM with the bot rather than from a
 * session's player: scrobbling, the Huddle mix, linked accounts and Your
 * data, with nothing that belongs to a session.
 */
/** What sessions running meanwhile hear of the user's own settings. */
export type SessionsHook = {
  /** The user changed their settings; whether scrobbling to a service began. */
  changed(userId: string, change: { scrobblingEnabled: boolean }): void;
  /** The user's scrobbling default is about to become `mode`. */
  keepScrobbling(userId: string, mode: ScrobblingMode): void;
};

export class UserSettings {
  private jellyfinUi?: JellyfinUi;

  constructor(
    private services: {
      slack: SlackAppAdapter;
      store: Store;
      scrobbling?: ScrobbleDispatcher;
      jellyfin?: Jellyfin;
      recommendations?: Pick<RecommendationCatalog, "refreshUser">;
      audit: AuditLog;
      log: typeof logger;
      /** The sessions the user may be in while changing these. */
      sessions?: SessionsHook;
    },
  ) {
    const { slack, store, jellyfin, log, audit } = services;
    if (jellyfin)
      this.jellyfinUi = new JellyfinUi({
        sessionId: personalSettingsId,
        slack,
        store,
        jellyfin,
        log,
        videoMode: () => false,
        canUse: () => true,
        notice: (userId, text) => this.notice(userId, text),
        // Nothing to queue onto outside a session; these dialogs only link.
        queue: async () => false,
        refreshSettings: async (userId, viewId, settings) => {
          await slack
            .updateModal(
              viewId,
              undefined,
              this.view(userId, parseSettingsMetadata(settings)),
            )
            .catch((error) =>
              log.debug(
                { event: "settings_refresh_failed", err: error },
                "Could not redraw Settings",
              ),
            );
        },
        audit: (event, userId, fields) => audit.record(event, userId, fields),
        serversChanged: (userId) => this.changed(userId),
      });
  }

  private changed(userId: string, scrobblingEnabled = false) {
    this.services.sessions?.changed(userId, { scrobblingEnabled });
  }

  /** Whether an interaction came from Settings opened outside a session. */
  handles(interaction: Interaction) {
    return (
      interaction.actionId === openPersonalSettingsAction ||
      interaction.value === personalSettingsId ||
      parseMetadata(interaction.metadata).sessionId === personalSettingsId
    );
  }

  async action(interaction: Interaction) {
    if (this.jellyfinUi?.handles(interaction))
      return this.jellyfinUi.action(interaction);
    if (interaction.type === "view_closed") return;
    if (interaction.type === "view_submission") {
      if (interaction.actionId === "listenbrainz_token")
        return this.listenBrainzTokenSubmission(interaction);
      if (interaction.actionId === "save_settings")
        return this.submission(interaction);
      return;
    }
    const kind = deleteDataActions[interaction.actionId];
    if (kind) return this.deleteData(interaction, kind);
    const handlers: Record<string, () => Promise<void>> = {
      [openPersonalSettingsAction]: () => this.open(interaction),
      connect_lastfm: () => this.lastFmModal(interaction),
      continue_lastfm: () => this.continueLastFm(interaction),
      disconnect_lastfm: () => this.disconnect(interaction, "lastfm"),
      disconnect_listenbrainz: () =>
        this.disconnect(interaction, "listenbrainz"),
      open_listenbrainz_token: () => this.listenBrainzTokenModal(interaction),
      open_your_data: () => this.openYourData(interaction),
    };
    await handlers[interaction.actionId]?.();
  }

  close() {
    this.jellyfinUi?.close();
  }

  private view(
    userId: string,
    context: Partial<SettingsMetadata> & { notice?: string } = {},
  ) {
    const { scrobbling } = this.services;
    return settingsView({
      sessionId: personalSettingsId,
      tab: "you",
      integrationPage: 0,
      ...(context.revision === undefined ? {} : { revision: context.revision }),
      ...(context.draft ? { draft: context.draft } : {}),
      ...(context.notice ? { notice: context.notice } : {}),
      access: noAccess,
      session: noSession,
      user: scrobbling?.settings(userId) ?? defaultUserSettings,
      ...(this.jellyfinUi ? { jellyfin: this.jellyfinUi.summary(userId) } : {}),
      yourData: true,
      channel: { saves: [] },
      integrations: [],
    });
  }

  // The Settings an interaction came from, with the inputs on screen laid
  // over its draft. A dialog opened over Settings carries Settings' own.
  private context(interaction: Interaction): SettingsMetadata {
    const parent = parseMetadata(interaction.metadata).settings;
    if (parent) return parseSettingsMetadata(parent);
    const metadata = parseSettingsMetadata(interaction.metadata);
    return { ...metadata, draft: mergeForm(metadata.draft, interaction.state) };
  }

  private metadata(interaction: Interaction) {
    const context = this.context(interaction);
    return {
      sessionId: personalSettingsId,
      hostId: "",
      tab: "you" as const,
      integrationPage: 0,
      revision: context.revision,
      draft: context.draft,
    };
  }

  private async redraw(
    interaction: Interaction,
    viewId: string | undefined,
    change: { notice?: string; draft?: FormState } = {},
  ) {
    if (!viewId) return;
    await this.services.slack.updateModal(
      viewId,
      viewId === interaction.viewId ? interaction.viewHash : undefined,
      this.view(interaction.userId, {
        ...this.context(interaction),
        ...change,
      }),
    );
  }

  // Outside a session there is no thread to answer in, so it's a DM.
  private async notice(userId: string, text: string) {
    await this.services.slack
      .dm(userId, text)
      .catch((error) =>
        this.services.log.warn(
          { event: "personal_settings_notice_failed", userId, err: error },
          "Could not tell the user about their settings",
        ),
      );
  }

  private async open(interaction: Interaction) {
    if (!interaction.triggerId) return;
    await this.services.slack.modal(
      interaction.triggerId,
      this.view(interaction.userId),
    );
  }

  private snapshot(userId: string): Settings {
    const { scrobbling } = this.services;
    if (!scrobbling) return {};
    const settings = scrobbling.settings(userId);
    return {
      scrobblingMode: settings.mode,
      huddleMixSources: settings.huddleMixSources,
      lastFmScrobbling: settings.lastFmEnabled,
      listenBrainzScrobbling: settings.listenBrainzEnabled,
      listenBrainzConnected: settings.listenBrainzConnected,
    };
  }

  private audit(userId: string, source: string, previous: Settings) {
    const changes = settingsChanges(previous, this.snapshot(userId));
    this.services.audit.record("settings.changed", userId, {
      source,
      changed: changedSettings(changes),
      changes,
    });
    this.services.store.incrementUsage("settings");
  }

  private async submission(interaction: Interaction) {
    const { scrobbling, log } = this.services;
    if (!scrobbling) return;
    const { userId } = interaction;
    const state = this.context(interaction).draft;
    const previous = this.snapshot(userId);
    let newlyEnabled = false;
    try {
      const settings = scrobbling.settings(userId);
      const mode = selected(state.scrobbling_mode?.mode, scrobblingModes);
      if (mode && mode !== settings.mode) {
        // It's the default for new Huddles, so one going on stays as it is.
        this.services.sessions?.keepScrobbling(userId, mode);
        scrobbling.setMode(userId, mode);
      }
      const services = submittedScrobbleServices(state.scrobble_to);
      if (services?.lastfm !== undefined && settings.lastFmConnected) {
        newlyEnabled ||= services.lastfm && !settings.lastFmEnabled;
        scrobbling.setLastFmEnabled(userId, services.lastfm);
      }
      if (
        services?.listenbrainz !== undefined &&
        settings.listenBrainzConnected
      ) {
        newlyEnabled ||= services.listenbrainz && !settings.listenBrainzEnabled;
        await scrobbling.setListenBrainz(
          userId,
          undefined,
          services.listenbrainz,
        );
      }
      const sources = submittedHuddleMixSources(state.huddle_mix);
      if (sources) scrobbling.setHuddleMixSources(userId, sources);
    } catch (error) {
      log.error(
        { event: "scrobbling_settings_failed", userId, err: error },
        "Could not change scrobbling settings",
      );
      await this.notice(userId, message(error));
    }
    this.changed(userId, newlyEnabled);
    this.audit(userId, "modal", previous);
  }

  private async lastFmModal(interaction: Interaction) {
    const { scrobbling, slack, log } = this.services;
    if (!scrobbling || !interaction.triggerId) return;
    try {
      const url = await scrobbling.beginLastFm(interaction.userId);
      await slack.pushModal(
        interaction.triggerId,
        lastFmLoginView(personalSettingsId, this.metadata(interaction), url),
      );
    } catch (error) {
      log.error(
        {
          event: "lastfm_auth_start_failed",
          userId: interaction.userId,
          err: error,
        },
        "Could not start Last.fm authorization",
      );
      await this.notice(
        interaction.userId,
        `Could not start Last.fm login: ${message(error)}`,
      );
    }
  }

  private async continueLastFm(interaction: Interaction) {
    const { scrobbling, slack, log } = this.services;
    if (!scrobbling) return;
    try {
      const username = await scrobbling.finishLastFm(interaction.userId);
      this.changed(interaction.userId, true);
      if (interaction.viewId && interaction.viewHash)
        await slack.updateModal(
          interaction.viewId,
          interaction.viewHash,
          lastFmConnectedView(username),
        );
      await this.redraw(interaction, interaction.previousViewId);
    } catch (error) {
      log.error(
        { event: "lastfm_auth_failed", userId: interaction.userId, err: error },
        "Could not finish Last.fm authorization",
      );
      await this.notice(
        interaction.userId,
        `Last.fm login is not complete: ${message(error)}`,
      );
    }
  }

  private async disconnect(
    interaction: Interaction,
    service: "lastfm" | "listenbrainz",
  ) {
    const { scrobbling } = this.services;
    if (!scrobbling) return;
    if (service === "lastfm") scrobbling.disconnectLastFm(interaction.userId);
    else scrobbling.disconnectListenBrainz(interaction.userId);
    this.changed(interaction.userId);
    if (interaction.viewHash)
      await this.redraw(interaction, interaction.viewId);
  }

  private async listenBrainzTokenModal(interaction: Interaction) {
    if (!this.services.scrobbling || !interaction.triggerId) return;
    await this.services.slack.pushModal(
      interaction.triggerId,
      listenBrainzTokenView(personalSettingsId, this.metadata(interaction)),
    );
  }

  // The token form closes when submitted, so Settings under it says how
  // checking the token went.
  private async listenBrainzTokenSubmission(interaction: Interaction) {
    const { scrobbling, log } = this.services;
    if (!scrobbling) return;
    const { userId } = interaction;
    const token = interaction.state.listenbrainz_token?.value?.value?.trim();
    if (!token) return;
    let notice: string;
    try {
      const previous = this.snapshot(userId);
      const wasEnabled = scrobbling.settings(userId).listenBrainzEnabled;
      const username = await scrobbling.setListenBrainz(userId, token, true);
      this.changed(userId, !wasEnabled);
      notice = `ListenBrainz connected${username ? ` as ${escape(username)}` : ""}.`;
      this.audit(userId, "listenbrainz_token", previous);
    } catch (error) {
      log.warn(
        { event: "listenbrainz_connect_failed", userId, err: error },
        "Could not connect ListenBrainz",
      );
      notice = `ListenBrainz was not connected: ${escape(truncate(message(error), 500))}`;
    }
    if (interaction.previousViewId)
      await this.redraw(interaction, interaction.previousViewId, { notice });
    else await this.notice(userId, notice);
  }

  private yourDataView(
    userId: string,
    settings: ReturnType<UserSettings["metadata"]>,
    notice?: string,
  ) {
    return yourDataView({
      sessionId: personalSettingsId,
      settings,
      ...(notice ? { notice } : {}),
      ...yourData(this.services.store, userId),
    });
  }

  private async openYourData(interaction: Interaction) {
    if (!interaction.triggerId) return;
    await this.services.slack.pushModal(
      interaction.triggerId,
      this.yourDataView(interaction.userId, this.metadata(interaction)),
    );
  }

  private async deleteData(interaction: Interaction, kind: UserDataKind) {
    const { store, audit, recommendations, scrobbling, slack } = this.services;
    const { userId } = interaction;
    const { count, notice } = await deleteUserData(
      { store, ...(this.jellyfinUi ? { jellyfinUi: this.jellyfinUi } : {}) },
      userId,
      kind,
      interaction.value,
    );
    audit.record("data.deleted", userId, {
      kind,
      ...(kind === "all" ? {} : { count }),
    });
    if (kind !== "own_save" && kind !== "channel_save")
      void recommendations?.refreshUser(userId);
    if (kind === "all") {
      scrobbling?.syncAnalyticsUser(userId);
      this.changed(userId);
    }
    // Settings under it would otherwise save back what was just deleted.
    const settings = this.metadata(interaction);
    if (kind === "all") settings.draft = withoutUserForm(settings.draft);
    if (interaction.viewId)
      await slack.updateModal(
        interaction.viewId,
        interaction.viewHash,
        this.yourDataView(userId, settings, notice),
      );
    if (interaction.previousViewId)
      await slack.updateModal(
        interaction.previousViewId,
        undefined,
        this.view(userId, settings),
      );
  }
}
