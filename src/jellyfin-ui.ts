import { mkdir, writeFile } from "node:fs/promises";
import type { Logger } from "pino";
import {
  actions,
  button,
  confirm,
  context,
  escape,
  input,
  plain,
  section,
  truncate,
  when,
} from "./coordinator-ui.ts";
import {
  episodeNumber,
  isPlayable,
  itemChapters,
  itemTrack,
  Jellyfin,
  JellyfinError,
  musicItemTypes,
  parseJellyfinSource,
  resumeSeconds,
  serverAddress,
  ticksPerSecond,
  videoItemTypes,
  type JellyfinItem,
  type JellyfinLink,
  type JellyfinPlayback,
  type JellyfinServerInfo,
  type LinkedServer,
} from "./jellyfin.ts";
import type { Interaction } from "./slack-app.ts";
import type { Store } from "./store.ts";
import {
  TrackError,
  type MediaStream,
  type PreparedMedia,
  type TrackMetadata,
} from "./tracks.ts";
import { formatClock, shorten, vttToSrt, type Chapter } from "./videos.ts";

/** Every Jellyfin dialog shares this callback, so closing one is noticed. */
export const jellyfinCallback = "jellyfin";
/** The audio and captions picker, which is submitted. */
export const jellyfinTracksCallback = "jellyfin_tracks";
/** The server address form, which is submitted. */
export const jellyfinAddressCallback = "jellyfin_address_form";

// A Quick Connect code lives this long on the server.
const linkTimeoutMs = 10 * 60_000;
// Episodes a season lists at most, within Slack's block limit.
const episodeLimit = 40;
// How often progress goes to the server while an item plays.
const progressEveryMs = 15_000;

/** What a Jellyfin dialog remembers about itself. */
type JellyfinState = {
  baseUrl?: string;
  serverId?: string;
  name?: string;
  /** The item to open once a server is linked. */
  itemId?: string;
  /** Settings under this dialog, to redraw when a server is linked. */
  settingsViewId?: string;
  settings?: unknown;
  seriesId?: string;
};

/** A Jellyfin item queued with where to start it. */
export type QueuedItem = TrackMetadata & { startAt?: number };

/**
 * What picking something for a client mod did: said how it went, gave more
 * to pick from, or failed. `linkNeeded` is a link to a server not linked yet.
 */
export type JellyfinPick = {
  message?: string;
  choices?: { label: string; reference: string }[];
  error?: string;
  linkNeeded?: boolean;
};

/** What the Jellyfin dialogs need from the session they belong to. */
export type JellyfinHost = {
  sessionId: string;
  slack: {
    modal(
      triggerId: string,
      view: unknown,
    ): Promise<{ id?: string } | undefined>;
    pushModal(
      triggerId: string,
      view: unknown,
    ): Promise<{ id?: string } | undefined | void>;
    updateModal(
      viewId: string,
      hash: string | undefined,
      view: unknown,
    ): Promise<unknown>;
  };
  store: Pick<
    Store,
    | "jellyfinServers"
    | "jellyfinServer"
    | "saveJellyfinServer"
    | "removeJellyfinServer"
    | "revokeJellyfinServer"
  >;
  jellyfin: Jellyfin;
  log: Pick<Logger, "info" | "warn" | "debug">;
  videoMode(): boolean;
  /** Whether the user may use the session's dialogs at all. */
  canUse(userId: string): boolean;
  notice(userId: string, text: string): Promise<void>;
  /**
   * Queues items for the user, with what they may add checked as usual.
   * Says whether they went on the queue.
   */
  queue(
    interaction: Interaction,
    capability: "add" | "add-bulk",
    items: QueuedItem[],
  ): Promise<boolean>;
  /** Redraws Settings under a dialog opened from it. */
  refreshSettings(
    userId: string,
    viewId: string,
    settings: unknown,
  ): Promise<void>;
  audit(event: string, userId: string, fields: Record<string, unknown>): void;
  /** The user's servers changed: one was linked, unlinked or let go. */
  serversChanged?(userId: string): void;
};

// Slack refuses private metadata longer than this.
const metadataLimit = 3000;

function metadata(sessionId: string, state: JellyfinState = {}) {
  const full = JSON.stringify({ sessionId, jellyfin: state });
  if (full.length <= metadataLimit) return full;
  // Settings' unsaved edits are let go before Settings itself.
  const settings =
    state.settings && typeof state.settings === "object"
      ? { ...state.settings, draft: {} }
      : undefined;
  const trimmed = JSON.stringify({
    sessionId,
    jellyfin: { ...state, settings },
  });
  if (trimmed.length <= metadataLimit) return trimmed;
  const { settings: _settings, ...rest } = state;
  return JSON.stringify({ sessionId, jellyfin: rest });
}

function readState(interaction: Interaction): JellyfinState {
  try {
    const value = JSON.parse(interaction.metadata || "{}").jellyfin;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function dialog(
  sessionId: string,
  title: string,
  blocks: unknown[],
  state: JellyfinState = {},
  extra: Record<string, unknown> = {},
) {
  return {
    type: "modal",
    callback_id: jellyfinCallback,
    notify_on_close: true,
    private_metadata: metadata(sessionId, state),
    title: plain(title),
    close: plain("Close"),
    blocks,
    ...extra,
  };
}

function host(baseUrl: string) {
  return URL.parse(baseUrl)?.host ?? baseUrl;
}

function slackDate(at: number) {
  const seconds = Math.floor(at / 1000);
  return `<!date^${seconds}^{date_short_pretty}|${new Date(at).toISOString().slice(0, 10)}>`;
}

/** A line naming an item: what it is, and how long. */
export function itemLabel(item: JellyfinItem) {
  const minutes = item.RunTimeTicks
    ? Math.round(item.RunTimeTicks / ticksPerSecond / 60)
    : undefined;
  const kind =
    item.Type === "Series"
      ? "Show"
      : item.Type === "MusicAlbum"
        ? "Album"
        : item.Type === "Audio"
          ? "Song"
          : item.Type === "Episode"
            ? `${item.SeriesName ?? "Episode"}${episodeNumber(item) ? ` ${episodeNumber(item)}` : ""}`
            : (item.Type ?? "Item");
  return [
    `${item.Name ?? "Untitled"}${item.ProductionYear && item.Type !== "Episode" ? ` (${item.ProductionYear})` : ""}`,
    kind,
    item.Type === "Audio" ? (item.AlbumArtist ?? item.Artists?.[0]) : undefined,
    minutes && item.Type !== "Series" && item.Type !== "MusicAlbum"
      ? `${minutes}m`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A value that names an item on a server, for a button or option. */
export function itemValue(action: string, serverId: string, itemId: string) {
  return `${action}:${serverId}:${itemId}`;
}

export function parseItemValue(value: string) {
  const match = /^(open|start|resume):([0-9a-f]{32}):([0-9a-f]{32})$/.exec(
    value,
  );
  return match
    ? {
        action: match[1] as "open" | "start" | "resume",
        serverId: match[2]!,
        itemId: match[3]!,
      }
    : undefined;
}

/**
 * Jellyfin for one session: linking servers with Quick Connect, searching
 * and browsing them, playing their items as streams, and reporting what
 * plays back to them. Each user only ever sees and uses their own servers.
 */
export class JellyfinUi {
  // Quick Connect codes being waited on, by the dialog that shows them.
  private attempts = new Map<string, { cancelled: boolean }>();
  private reported?: {
    entryId: string;
    server: LinkedServer;
    playback: JellyfinPlayback;
    at: number;
    paused: boolean;
    /** Where it last was, for a stop no one gave a position for. */
    position: number;
  };

  constructor(
    private host: JellyfinHost,
    private options: { pollMs?: number } = {},
  ) {}

  private get id() {
    return this.host.sessionId;
  }

  /** The user's servers that still take their tokens. */
  servers(userId: string) {
    return this.host.store
      .jellyfinServers(userId)
      .filter((server) => !server.revoked);
  }

  hasServers(userId: string) {
    return this.servers(userId).length > 0;
  }

  /** What the You tab says about the user's servers. */
  summary(userId: string) {
    const servers = this.host.store.jellyfinServers(userId);
    return {
      linked: servers.length,
      needsLink: servers.filter((server) => server.revoked).length,
    };
  }

  /** Search results from all of the user's servers, as select options. */
  async search(userId: string, query: string) {
    const servers = this.servers(userId);
    const types = this.host.videoMode() ? videoItemTypes : musicItemTypes;
    const results = await Promise.allSettled(
      servers.map(async (server) => ({
        server,
        items: await this.host.jellyfin.search(server, query, types),
      })),
    );
    const options: { text: { type: string; text: string }; value: string }[] =
      [];
    for (const result of results) {
      if (result.status === "rejected") {
        this.host.log.warn(
          { event: "jellyfin_search_failed", err: result.reason },
          "Jellyfin search failed",
        );
        continue;
      }
      const { server, items } = result.value;
      for (const item of items) {
        const where = servers.length > 1 ? ` · ${server.name}` : "";
        options.push({
          text: plain(shorten(`${itemLabel(item)}${where}`, 75)),
          value: itemValue("open", server.serverId, item.Id),
        });
      }
    }
    return options.slice(0, 20);
  }

  /** Whether an action or dialog is one of these. */
  handles(interaction: Interaction) {
    if (interaction.type === "view_submission")
      return interaction.actionId === jellyfinAddressCallback;
    return (
      interaction.actionId.startsWith("jellyfin_") ||
      interaction.actionId === jellyfinCallback
    );
  }

  /** Handles an action in a Jellyfin dialog, or one that opens it. */
  async action(interaction: Interaction) {
    if (interaction.type === "view_closed") {
      if (interaction.viewId) this.cancel(interaction.viewId);
      return;
    }
    if (!this.host.canUse(interaction.userId)) return;
    if (interaction.type === "view_submission")
      return this.submitAddressForm(interaction);
    const handlers: Record<string, () => Promise<void>> = {
      jellyfin_open_link: () => this.openAddress(interaction),
      jellyfin_view_servers: () => this.openServers(interaction),
      jellyfin_link_another: () => this.showAddress(interaction),
      jellyfin_address: () => this.submitAddress(interaction),
      jellyfin_new_code: () => this.newCode(interaction),
      jellyfin_unlink: () => this.unlink(interaction),
      jellyfin_season: () => this.chooseSeason(interaction),
      jellyfin_item: () => this.chooseItem(interaction),
      jellyfin_episode: () => this.chooseItem(interaction),
      jellyfin_next_up: () => this.nextUp(interaction),
      jellyfin_whole_season: () => this.wholeSeason(interaction),
    };
    await handlers[interaction.actionId]?.();
  }

  /** Stops waiting on a dialog that was closed. */
  cancel(viewId: string) {
    const attempt = this.attempts.get(viewId);
    if (attempt) attempt.cancelled = true;
    this.attempts.delete(viewId);
  }

  /** Stops every wait, when the session ends. */
  close() {
    for (const viewId of [...this.attempts.keys()]) this.cancel(viewId);
  }

  private update(viewId: string, view: unknown) {
    return this.host.slack
      .updateModal(viewId, undefined, view)
      .catch((error) =>
        this.host.log.warn(
          { event: "jellyfin_dialog_update_failed", err: error },
          "Could not update the Jellyfin dialog",
        ),
      );
  }

  private messageView(
    text: string,
    state: JellyfinState = {},
    title = "Jellyfin",
  ) {
    return dialog(this.id, title, [section(text)], state);
  }

  /**
   * A pasted Jellyfin link, from the add dialog: queues or opens the item
   * when its server is linked, and links the server first when it is not.
   * The add dialog has closed, so a dialog of its own says how it went.
   */
  async openLink(interaction: Interaction, link: JellyfinLink) {
    if (!interaction.triggerId) return;
    const view = await this.host.slack
      .modal(
        interaction.triggerId,
        this.messageView("Opening Jellyfin…", { baseUrl: link.baseUrl }),
      )
      .catch((error) => {
        this.host.log.warn(
          { event: "jellyfin_dialog_failed", err: error },
          "Could not open the Jellyfin dialog",
        );
        return undefined;
      });
    const viewId = view?.id;
    if (!viewId) return;
    let info: JellyfinServerInfo;
    try {
      info = await this.host.jellyfin.publicInfo(link.baseUrl);
    } catch (error) {
      await this.update(viewId, this.messageView(errorText(error)));
      return;
    }
    if (link.serverId && link.serverId !== info.id) {
      await this.update(
        viewId,
        this.messageView(
          "That link names a different server from the one it points to.",
        ),
      );
      return;
    }
    const server = this.host.store.jellyfinServer(interaction.userId, info.id);
    if (server && !server.revoked)
      return this.open(viewId, interaction, server, link.itemId);
    await this.link(viewId, interaction, link.baseUrl, info, {
      itemId: link.itemId,
    });
  }

  private async openAddress(interaction: Interaction) {
    if (!interaction.triggerId) return;
    await this.host.slack.pushModal(
      interaction.triggerId,
      this.addressView(this.fromSettings(interaction)),
    );
  }

  private async openServers(interaction: Interaction) {
    if (!interaction.triggerId) return;
    await this.host.slack.pushModal(
      interaction.triggerId,
      this.serversView(interaction.userId, this.fromSettings(interaction)),
    );
  }

  // A dialog pushed over Settings keeps Settings' own metadata, to redraw
  // it once something is linked or unlinked.
  private fromSettings(interaction: Interaction): JellyfinState {
    let settings: unknown;
    try {
      settings = JSON.parse(interaction.metadata || "{}");
    } catch {
      settings = undefined;
    }
    return {
      ...(interaction.viewId ? { settingsViewId: interaction.viewId } : {}),
      ...(settings ? { settings } : {}),
    };
  }

  private addressView(state: JellyfinState, notice?: string) {
    return dialog(
      this.id,
      "Link Jellyfin",
      [
        ...when(notice, context("jellyfin_notice", notice ?? "")),
        {
          ...input(
            "jellyfin_address",
            "Server address",
            {
              type: "plain_text_input",
              action_id: "jellyfin_address",
              placeholder: plain("jellyfin.example.com"),
              dispatch_action_config: {
                trigger_actions_on: ["on_enter_pressed"],
              },
            },
            {
              hint: "The address you open Jellyfin at. It has to be reachable from the internet.",
            },
          ),
          dispatch_action: true,
        },
        context(
          "jellyfin_about",
          "HuddleFM signs in with Quick Connect, so your password never goes through Slack. Only you can use what you link, and you can unlink it any time.",
        ),
      ],
      state,
      // Slack only shows a form with an input when it can be submitted.
      { callback_id: jellyfinAddressCallback, submit: plain("Continue") },
    );
  }

  private serversView(userId: string, state: JellyfinState, notice?: string) {
    const servers = this.host.store.jellyfinServers(userId);
    return dialog(
      this.id,
      "Jellyfin servers",
      [
        ...when(notice, context("jellyfin_notice", notice ?? "")),
        ...servers.map((server) => ({
          type: "section",
          block_id: `jellyfin_server_${server.serverId}`,
          text: {
            type: "mrkdwn",
            text: `*${escape(server.name)}* · ${escape(host(server.baseUrl))} · linked ${slackDate(server.linkedAt)}${server.revoked ? "\nStopped working; link it again to use it." : ""}`,
          },
          accessory: button("jellyfin_unlink", plain("Unlink"), {
            style: "danger",
            value: server.serverId,
            confirm: confirm(
              `Unlink ${truncate(server.name, 60)}?`,
              "HuddleFM signs out of it, and anything you queued from it stops playing.",
              "Unlink",
            ),
          }),
        })),
        ...when(!servers.length, section("No servers linked.")),
        actions("jellyfin_servers_actions", [
          button(
            "jellyfin_link_another",
            plain(servers.length ? "Link another server" : "Link a server"),
            { value: this.id },
          ),
        ]),
      ],
      state,
    );
  }

  private async showAddress(interaction: Interaction) {
    if (!interaction.viewId) return;
    await this.update(
      interaction.viewId,
      this.addressView(readState(interaction)),
    );
  }

  // Continue closes the form, so linking carries on in a dialog of its own.
  private async submitAddressForm(interaction: Interaction) {
    if (!interaction.triggerId) return;
    const view = await this.host.slack
      .pushModal(
        interaction.triggerId,
        this.messageView(
          "Finding the server…",
          readState(interaction),
          "Link Jellyfin",
        ),
      )
      .catch(() => undefined);
    if (!view?.id) return;
    await this.submitAddress({ ...interaction, viewId: view.id });
  }

  private async submitAddress(interaction: Interaction) {
    if (!interaction.viewId) return;
    const state = readState(interaction);
    const typed =
      interaction.state.jellyfin_address?.jellyfin_address?.value ?? "";
    const baseUrl = serverAddress(typed);
    if (!baseUrl) {
      await this.update(
        interaction.viewId,
        this.addressView(state, "Type the address you open Jellyfin at."),
      );
      return;
    }
    await this.update(
      interaction.viewId,
      this.messageView("Finding the server…", state, "Link Jellyfin"),
    );
    let info: JellyfinServerInfo;
    try {
      info = await this.host.jellyfin.publicInfo(baseUrl);
    } catch (error) {
      await this.update(
        interaction.viewId,
        this.addressView(state, errorText(error)),
      );
      return;
    }
    await this.link(interaction.viewId, interaction, baseUrl, info, state);
  }

  private async newCode(interaction: Interaction) {
    if (!interaction.viewId) return;
    const state = readState(interaction);
    if (!state.baseUrl || !state.serverId) return;
    await this.link(
      interaction.viewId,
      interaction,
      state.baseUrl,
      { id: state.serverId, name: state.name ?? host(state.baseUrl) },
      state,
    );
  }

  /**
   * Links a server with Quick Connect: shows a code to approve in Jellyfin,
   * waits for the approval, and then carries on with what the user was
   * doing.
   */
  private async link(
    viewId: string,
    interaction: Interaction,
    baseUrl: string,
    info: JellyfinServerInfo,
    then: JellyfinState,
  ) {
    this.cancel(viewId);
    const attempt = { cancelled: false };
    this.attempts.set(viewId, attempt);
    const state: JellyfinState = {
      ...then,
      baseUrl,
      serverId: info.id,
      name: info.name,
    };
    const { jellyfin } = this.host;
    try {
      if (!(await jellyfin.quickConnectEnabled(baseUrl))) {
        await this.update(
          viewId,
          this.messageView(
            `Quick Connect is off on *${escape(info.name)}*, which HuddleFM links with. Its admin can turn it on in Dashboard › General.`,
            state,
            "Link Jellyfin",
          ),
        );
        return;
      }
      const deviceId = crypto.randomUUID().replaceAll("-", "");
      const { code, secret } = await jellyfin.initiateQuickConnect(
        baseUrl,
        deviceId,
      );
      if (attempt.cancelled) return;
      await this.update(viewId, this.codeView(info, baseUrl, code, state));
      const deadline = Date.now() + linkTimeoutMs;
      while (Date.now() < deadline) {
        await Bun.sleep(this.options.pollMs ?? 3_000);
        if (attempt.cancelled) return;
        const status = await jellyfin
          .quickConnectState(baseUrl, deviceId, secret)
          .catch(() => "waiting" as const);
        if (attempt.cancelled) return;
        if (status === "expired") break;
        if (status !== "approved") continue;
        const signedIn = await jellyfin.authenticateQuickConnect(
          baseUrl,
          deviceId,
          secret,
        );
        const server: LinkedServer = {
          userId: interaction.userId,
          serverId: info.id,
          baseUrl,
          name: info.name,
          accessToken: signedIn.accessToken,
          jellyfinUserId: signedIn.userId.replaceAll("-", ""),
          ...(signedIn.userName ? { jellyfinUserName: signedIn.userName } : {}),
          deviceId,
          linkedAt: Date.now(),
        };
        this.attempts.delete(viewId);
        this.host.store.saveJellyfinServer(server);
        this.host.serversChanged?.(interaction.userId);
        this.host.audit("jellyfin.linked", interaction.userId, {
          sessionId: this.id,
          serverId: server.serverId,
        });
        void jellyfin
          .capabilities(server)
          .catch((error) =>
            this.host.log.debug(
              { event: "jellyfin_capabilities_failed", err: error },
              "Could not tell Jellyfin what HuddleFM plays",
            ),
          );
        const linked = `Linked ${server.name} ✓`;
        if (then.settingsViewId)
          await this.host.refreshSettings(
            interaction.userId,
            then.settingsViewId,
            then.settings,
          );
        if (then.itemId)
          return this.open(viewId, interaction, server, then.itemId, linked);
        await this.update(
          viewId,
          this.serversView(interaction.userId, then, linked),
        );
        return;
      }
      if (attempt.cancelled) return;
      this.attempts.delete(viewId);
      await this.update(
        viewId,
        dialog(
          this.id,
          "Link Jellyfin",
          [
            section("That code expired before it was approved."),
            actions("jellyfin_expired", [
              button("jellyfin_new_code", plain("New code"), {
                style: "primary",
                value: this.id,
              }),
            ]),
          ],
          state,
        ),
      );
    } catch (error) {
      this.attempts.delete(viewId);
      if (attempt.cancelled) return;
      this.host.log.warn(
        { event: "jellyfin_link_failed", serverId: info.id, err: error },
        "Could not link the Jellyfin server",
      );
      await this.update(
        viewId,
        this.messageView(
          `Couldn’t link *${escape(info.name)}*: ${escape(errorText(error))}`,
          state,
          "Link Jellyfin",
        ),
      );
    }
  }

  private codeView(
    info: JellyfinServerInfo,
    baseUrl: string,
    code: string,
    state: JellyfinState,
  ) {
    return dialog(
      this.id,
      "Link Jellyfin",
      [
        section(
          `Link *${escape(info.name)}*${state.itemId ? " to watch this" : ""}. Approve this code in Jellyfin:`,
        ),
        { type: "header", text: plain(code) },
        actions("jellyfin_approve", [
          button("jellyfin_approve_link", plain("Open Jellyfin to approve"), {
            style: "primary",
            url: `${baseUrl}/web/#/quickconnect?code=${encodeURIComponent(code)}`,
          }),
        ]),
        context(
          "jellyfin_waiting",
          "Waiting for approval… You’ll need an account on this server. If the code isn’t filled in for you, type it in Quick Connect under your profile in Jellyfin.",
        ),
      ],
      state,
    );
  }

  private async unlink(interaction: Interaction) {
    if (!interaction.viewId) return;
    const state = readState(interaction);
    const server = this.host.store.jellyfinServer(
      interaction.userId,
      interaction.value,
    );
    if (!server) return;
    this.host.store.removeJellyfinServer(interaction.userId, server.serverId);
    this.host.serversChanged?.(interaction.userId);
    this.host.audit("jellyfin.unlinked", interaction.userId, {
      sessionId: this.id,
      serverId: server.serverId,
    });
    // Signing out on the server too is a courtesy; the token is gone here
    // whether or not it answers.
    void this.host.jellyfin.logout(server).catch(() => {});
    await this.update(
      interaction.viewId,
      this.serversView(interaction.userId, state, `Unlinked ${server.name}.`),
    );
    if (state.settingsViewId)
      await this.host.refreshSettings(
        interaction.userId,
        state.settingsViewId,
        state.settings,
      );
  }

  /** Signs out of every server the user linked, for Delete everything. */
  async forget(userId: string) {
    for (const server of this.host.store.jellyfinServers(userId))
      void this.host.jellyfin.logout(server).catch(() => {});
  }

  /** A search result or button: queues the item, or opens it to pick. */
  async choose(interaction: Interaction, value: string) {
    const parsed = parseItemValue(value);
    if (!parsed) return false;
    const server = this.host.store.jellyfinServer(
      interaction.userId,
      parsed.serverId,
    );
    if (!interaction.triggerId) return true;
    const view = await this.host.slack
      .modal(interaction.triggerId, this.messageView("Opening Jellyfin…"))
      .catch(() => undefined);
    if (!view?.id) return true;
    if (!server || server.revoked) {
      await this.update(view.id, this.messageView(relinkText));
      return true;
    }
    await this.open(view.id, interaction, server, parsed.itemId);
    return true;
  }

  /**
   * A search result or choice from a client mod, which has no dialog to
   * browse in: plays what plays, adds an album's or folder's items, and for
   * the rest answers with what to pick from next, as the dialogs would show
   * it: where to start something left part way, a show's seasons, a season's
   * episodes. What the queue says goes in notices, as for the dialogs.
   */
  async pick(interaction: Interaction, value: string): Promise<JellyfinPick> {
    const parsed = parseItemValue(value);
    if (!parsed) return { error: "That Jellyfin item can't be found." };
    const server = this.host.store.jellyfinServer(
      interaction.userId,
      parsed.serverId,
    );
    if (!server || server.revoked)
      return {
        error:
          "That server isn’t linked any more. Link it again under Accounts and more in Slack.",
        linkNeeded: true,
      };
    try {
      return await this.pickItem(interaction, server, parsed);
    } catch (error) {
      if (error instanceof JellyfinError && error.status === 403)
        return {
          error: "Your Jellyfin account isn’t allowed to play that.",
        };
      if (error instanceof JellyfinError && error.unauthorized) {
        this.host.store.revokeJellyfinServer(server.userId, server.serverId);
        this.host.serversChanged?.(server.userId);
        return {
          error: `HuddleFM’s link to ${server.name} stopped working. Link it again under Accounts and more in Slack.`,
          linkNeeded: true,
        };
      }
      this.host.log.warn(
        {
          event: "jellyfin_open_failed",
          serverId: server.serverId,
          err: error,
        },
        "Could not open the Jellyfin item",
      );
      return { error: errorText(error) };
    }
  }

  /**
   * A pasted Jellyfin link from a client mod: its item, when its server is
   * linked. Linking shows a code to approve, which stays in Slack's own
   * dialogs: everyone in the huddle hears the data channel.
   */
  async pickLink(
    interaction: Interaction,
    link: JellyfinLink,
  ): Promise<JellyfinPick> {
    let serverId = link.serverId;
    if (!serverId)
      try {
        serverId = (await this.host.jellyfin.publicInfo(link.baseUrl)).id;
      } catch (error) {
        return { error: errorText(error) };
      }
    const server = this.host.store.jellyfinServer(interaction.userId, serverId);
    if (!server || server.revoked)
      return {
        error:
          "Link this Jellyfin server first, under Accounts and more in Slack.",
        linkNeeded: true,
      };
    return this.pick(interaction, itemValue("open", serverId, link.itemId));
  }

  private async pickItem(
    interaction: Interaction,
    server: LinkedServer,
    parsed: NonNullable<ReturnType<typeof parseItemValue>>,
  ): Promise<JellyfinPick> {
    const { jellyfin } = this.host;
    const item = await jellyfin.item(server, parsed.itemId);
    const choice = (action: string, label: string, of: JellyfinItem) => ({
      label: shorten(label, 75),
      reference: itemValue(action, server.serverId, of.Id),
    });
    const queue = async (
      capability: "add" | "add-bulk",
      items: QueuedItem[],
      text: string,
    ) =>
      (await this.host.queue(interaction, capability, items))
        ? { message: text }
        : {};
    if (item.Type === "Series") {
      const seasons = await jellyfin.seasons(server, item.Id);
      if (!seasons.length) return { error: "That show has no seasons yet." };
      // one season is its episodes
      if (seasons.length > 1)
        return {
          choices: seasons
            .slice(0, 100)
            .map((season) =>
              choice(
                "open",
                season.Name ?? `Season ${season.IndexNumber ?? ""}`,
                season,
              ),
            ),
        };
      return this.episodeChoices(server, item.Id, seasons[0]!.Id, choice);
    }
    if (item.Type === "Season" && item.SeriesId)
      return this.episodeChoices(server, item.SeriesId, item.Id, choice);
    if (isPlayable(item)) {
      const resume = resumeSeconds(item);
      if (parsed.action === "open" && resume)
        return {
          choices: [
            choice("resume", `Resume from ${formatClock(resume)}`, item),
            choice("start", "Start from the beginning", item),
          ],
        };
      const startAt = parsed.action === "resume" ? resume : undefined;
      return queue(
        "add",
        [
          {
            ...itemTrack(server.serverId, item),
            ...(startAt ? { startAt } : {}),
          },
        ],
        `Added ${item.Name ?? "it"} to the queue${startAt ? `, from ${formatClock(startAt)}` : ""}.`,
      );
    }
    const children = (await jellyfin.children(server, item.Id)).filter(
      isPlayable,
    );
    if (!children.length) return { error: "There’s nothing in that to play." };
    return queue(
      "add-bulk",
      children.map((child) => itemTrack(server.serverId, child)),
      `Added ${children.length} ${children.length === 1 ? "item" : "items"} from ${item.Name ?? "it"} to the queue.`,
    );
  }

  private async episodeChoices(
    server: LinkedServer,
    seriesId: string,
    seasonId: string,
    choice: (
      action: string,
      label: string,
      of: JellyfinItem,
    ) => { label: string; reference: string },
  ): Promise<JellyfinPick> {
    const episodes = await this.host.jellyfin.episodes(
      server,
      seriesId,
      seasonId,
    );
    if (!episodes.length) return { error: "That season has no episodes yet." };
    return {
      choices: episodes
        .slice(0, episodeLimit)
        .map((episode) => choice("open", itemLabel(episode), episode)),
    };
  }

  private async chooseItem(interaction: Interaction) {
    if (!interaction.viewId) return;
    const parsed = parseItemValue(interaction.value);
    if (!parsed) return;
    const server = this.host.store.jellyfinServer(
      interaction.userId,
      parsed.serverId,
    );
    if (!server || server.revoked) {
      await this.update(interaction.viewId, this.messageView(relinkText));
      return;
    }
    if (parsed.action === "open")
      return this.open(interaction.viewId, interaction, server, parsed.itemId);
    try {
      const item = await this.host.jellyfin.item(server, parsed.itemId);
      const startAt =
        parsed.action === "resume" ? resumeSeconds(item) : undefined;
      const added = await this.host.queue(interaction, "add", [
        {
          ...itemTrack(server.serverId, item),
          ...(startAt ? { startAt } : {}),
        },
      ]);
      // In a show, the dialog stays for more episodes.
      const state = readState(interaction);
      if (state.seriesId && item.SeasonId)
        return this.showSeries(
          interaction.viewId,
          interaction,
          server,
          state.seriesId,
          item.SeasonId,
          added
            ? `Added ${item.Name ?? "the episode"} to the queue.`
            : undefined,
        );
      if (added)
        await this.update(
          interaction.viewId,
          this.messageView(addedText(item, startAt)),
        );
      else await this.closeWith(interaction.viewId);
    } catch (error) {
      await this.failed(interaction.viewId, server, error);
    }
  }

  /** Opens an item: plays it, asks where to start it, or lists what it holds. */
  private async open(
    viewId: string,
    interaction: Interaction,
    server: LinkedServer,
    itemId: string,
    notice?: string,
  ) {
    const prefix = notice ? `${notice} — ` : "";
    try {
      const item = await this.host.jellyfin.item(server, itemId);
      if (item.Type === "Series")
        return this.showSeries(
          viewId,
          interaction,
          server,
          item.Id,
          undefined,
          notice,
        );
      if (item.Type === "Season" && item.SeriesId)
        return this.showSeries(
          viewId,
          interaction,
          server,
          item.SeriesId,
          item.Id,
          notice,
        );
      if (isPlayable(item)) {
        const resume = resumeSeconds(item);
        if (resume) {
          await this.update(
            viewId,
            this.resumeView(server, item, resume, notice),
          );
          return;
        }
        const added = await this.host.queue(interaction, "add", [
          itemTrack(server.serverId, item),
        ]);
        if (added)
          await this.update(
            viewId,
            this.messageView(`${prefix}${addedText(item)}`),
          );
        else await this.closeWith(viewId, notice);
        return;
      }
      const children = (
        await this.host.jellyfin.children(server, item.Id)
      ).filter(isPlayable);
      if (!children.length) {
        await this.update(
          viewId,
          this.messageView(`${prefix}There’s nothing in that to play.`),
        );
        return;
      }
      const added = await this.host.queue(
        interaction,
        "add-bulk",
        children.map((child) => itemTrack(server.serverId, child)),
      );
      if (added)
        await this.update(
          viewId,
          this.messageView(
            `${prefix}Added ${children.length} ${children.length === 1 ? "item" : "items"} from ${escape(item.Name ?? "it")} to the queue.`,
          ),
        );
      else await this.closeWith(viewId, notice);
    } catch (error) {
      await this.failed(viewId, server, error, notice);
    }
  }

  // A queue refusal was already said in a notice, so the dialog has nothing
  // left to show, unless it has news of its own.
  private async closeWith(viewId: string, notice?: string) {
    await this.update(
      viewId,
      this.messageView(notice ? `${notice}.` : "Nothing was added."),
    );
  }

  private async failed(
    viewId: string,
    server: LinkedServer,
    error: unknown,
    notice?: string,
  ) {
    if (error instanceof JellyfinError && error.status === 403) {
      await this.update(
        viewId,
        this.messageView(
          `${notice ? `${notice}, but your` : "Your"} Jellyfin account isn’t allowed to play that.`,
        ),
      );
      return;
    }
    if (error instanceof JellyfinError && error.unauthorized) {
      this.host.store.revokeJellyfinServer(server.userId, server.serverId);
      this.host.serversChanged?.(server.userId);
      await this.update(
        viewId,
        this.messageView(
          `HuddleFM’s link to *${escape(server.name)}* stopped working. Link it again under Settings › You.`,
        ),
      );
      return;
    }
    this.host.log.warn(
      { event: "jellyfin_open_failed", serverId: server.serverId, err: error },
      "Could not open the Jellyfin item",
    );
    await this.update(
      viewId,
      this.messageView(
        `${notice ? `${notice}, but ` : ""}${escape(
          error instanceof JellyfinError && error.status === 404
            ? "That item isn’t there any more."
            : `${server.name} didn’t answer. Try again in a moment.`,
        )}`,
      ),
    );
  }

  private resumeView(
    server: LinkedServer,
    item: JellyfinItem,
    seconds: number,
    notice?: string,
  ) {
    return dialog(
      this.id,
      "Jellyfin",
      [
        ...when(notice, context("jellyfin_notice", `${notice}`)),
        section(
          `*${escape(item.Name ?? "Untitled")}* was left at ${formatClock(seconds)}.`,
        ),
        actions("jellyfin_resume", [
          button(
            "jellyfin_episode",
            plain(`Resume from ${formatClock(seconds)}`),
            {
              style: "primary",
              value: itemValue("resume", server.serverId, item.Id),
            },
          ),
          button("jellyfin_episode", plain("Start over"), {
            value: itemValue("start", server.serverId, item.Id),
          }),
        ]),
      ],
      {},
    );
  }

  private async chooseSeason(interaction: Interaction) {
    if (!interaction.viewId) return;
    const state = readState(interaction);
    const server =
      state.serverId &&
      this.host.store.jellyfinServer(interaction.userId, state.serverId);
    if (!server || !state.seriesId) return;
    await this.showSeries(
      interaction.viewId,
      interaction,
      server,
      state.seriesId,
      interaction.value,
    );
  }

  /** A show: its seasons to pick from, and the chosen season's episodes. */
  private async showSeries(
    viewId: string,
    _interaction: Interaction,
    server: LinkedServer,
    seriesId: string,
    seasonId?: string,
    notice?: string,
  ) {
    try {
      const { jellyfin } = this.host;
      const [series, seasons, next] = await Promise.all([
        jellyfin.item(server, seriesId),
        jellyfin.seasons(server, seriesId),
        jellyfin.nextUp(server, seriesId).catch(() => undefined),
      ]);
      const season =
        seasons.find((item) => item.Id === seasonId) ??
        seasons.find((item) => item.Id === next?.SeasonId) ??
        seasons[0];
      const episodes = season
        ? await jellyfin.episodes(server, seriesId, season.Id)
        : [];
      const state: JellyfinState = {
        serverId: server.serverId,
        seriesId,
      };
      const seasonOption = (item: JellyfinItem) => ({
        text: plain(
          shorten(item.Name ?? `Season ${item.IndexNumber ?? ""}`, 75),
        ),
        value: item.Id,
      });
      const shown = episodes.slice(0, episodeLimit);
      await this.update(
        viewId,
        dialog(
          this.id,
          "Jellyfin",
          [
            ...when(notice, context("jellyfin_notice", notice ?? "")),
            section(`*${escape(series.Name ?? "Show")}*`),
            actions("jellyfin_series_actions", [
              ...when(seasons.length > 1, {
                type: "static_select",
                action_id: "jellyfin_season",
                placeholder: plain("Season"),
                options: seasons.slice(0, 100).map(seasonOption),
                ...(season ? { initial_option: seasonOption(season) } : {}),
              }),
              ...when(
                next,
                button(
                  "jellyfin_next_up",
                  plain("Add next unwatched episode"),
                  {
                    style: "primary",
                    value: itemValue("start", server.serverId, next?.Id ?? ""),
                  },
                ),
              ),
              ...when(
                season && episodes.length,
                button("jellyfin_whole_season", plain("Add whole season"), {
                  value: season?.Id ?? "",
                }),
              ),
            ]),
            ...shown.map((episode) => {
              const resume = resumeSeconds(episode);
              const minutes = episode.RunTimeTicks
                ? `${Math.round(episode.RunTimeTicks / ticksPerSecond / 60)}m`
                : undefined;
              const status = episode.UserData?.Played
                ? "Watched"
                : resume
                  ? `Left at ${formatClock(resume)}`
                  : undefined;
              return {
                type: "section",
                block_id: `jellyfin_episode_${episode.Id}`,
                text: {
                  type: "mrkdwn",
                  text: `*${escape(`${episode.IndexNumber ? `${episode.IndexNumber}. ` : ""}${episode.Name ?? "Episode"}`)}*${[minutes, status].filter(Boolean).length ? `\n${[minutes, status].filter(Boolean).join(" · ")}` : ""}`,
                },
                accessory: resume
                  ? {
                      type: "overflow",
                      action_id: "jellyfin_episode",
                      options: [
                        {
                          text: plain(`Resume from ${formatClock(resume)}`),
                          value: itemValue(
                            "resume",
                            server.serverId,
                            episode.Id,
                          ),
                        },
                        {
                          text: plain("Start over"),
                          value: itemValue(
                            "start",
                            server.serverId,
                            episode.Id,
                          ),
                        },
                      ],
                    }
                  : button("jellyfin_episode", plain("Add"), {
                      value: itemValue("start", server.serverId, episode.Id),
                    }),
              };
            }),
            ...when(!episodes.length, section("No episodes.")),
            ...when(
              episodes.length > shown.length,
              context(
                "jellyfin_more",
                `Showing the first ${shown.length} of ${episodes.length} episodes.`,
              ),
            ),
          ],
          state,
        ),
      );
    } catch (error) {
      await this.failed(viewId, server, error, notice);
    }
  }

  private async nextUp(interaction: Interaction) {
    return this.chooseItem(interaction);
  }

  private async wholeSeason(interaction: Interaction) {
    if (!interaction.viewId) return;
    const state = readState(interaction);
    const server =
      state.serverId &&
      this.host.store.jellyfinServer(interaction.userId, state.serverId);
    if (!server || !state.seriesId) return;
    try {
      const episodes = await this.host.jellyfin.episodes(
        server,
        state.seriesId,
        interaction.value,
      );
      const added = await this.host.queue(
        interaction,
        "add-bulk",
        episodes
          .filter(isPlayable)
          .map((episode) => itemTrack(server.serverId, episode)),
      );
      await this.showSeries(
        interaction.viewId,
        interaction,
        server,
        state.seriesId,
        interaction.value,
        added ? "Added the season to the queue." : undefined,
      );
    } catch (error) {
      await this.failed(interaction.viewId, server, error);
    }
  }

  /**
   * Play something, in video mode: what the user was watching and what is
   * new on their servers, to start in two clicks.
   */
  async openPlaySomething(interaction: Interaction) {
    if (!interaction.triggerId) return;
    const servers = this.servers(interaction.userId);
    const view = await this.host.slack
      .modal(interaction.triggerId, this.messageView("Looking in Jellyfin…"))
      .catch(() => undefined);
    if (!view?.id) return;
    const lists = await Promise.all(
      servers.map(async (server) => ({
        server,
        resume: await this.host.jellyfin.resumeItems(server).catch(() => []),
        latest: await this.host.jellyfin.latestItems(server).catch(() => []),
      })),
    );
    const many = servers.length > 1;
    const rows = (pick: "resume" | "latest") =>
      lists
        .flatMap(({ server, ...items }) =>
          items[pick].map((item) => ({ server, item })),
        )
        .slice(0, 10)
        .map(({ server, item }) => ({
          type: "section",
          block_id: `jellyfin_${pick}_${item.Id}`,
          text: {
            type: "mrkdwn",
            text: `${escape(itemLabel(item))}${many ? ` · ${escape(server.name)}` : ""}`,
          },
          accessory: button(
            "jellyfin_item",
            plain(
              item.Type === "Series"
                ? "Open"
                : pick === "resume"
                  ? "Resume"
                  : "Add",
            ),
            { value: itemValue("open", server.serverId, item.Id) },
          ),
        }));
    const resume = rows("resume");
    const latest = rows("latest");
    await this.update(
      view.id,
      dialog(this.id, "Play something", [
        { type: "header", text: plain("Continue watching") },
        ...(resume.length
          ? resume
          : [context("jellyfin_resume_none", "Nothing part-watched.")]),
        { type: "header", text: plain("Recently added") },
        ...(latest.length
          ? latest
          : [context("jellyfin_latest_none", "Nothing new.")]),
      ]),
    );
  }

  /** The audio and captions to pick from, for the playing Jellyfin item. */
  tracksView(playback: JellyfinPlayback, captions: boolean) {
    const audio = playback.audioTracks.slice(0, 100).map((track) => ({
      text: plain(shorten(track.label, 75)),
      value: String(track.index),
    }));
    const subtitles = [
      { text: plain("Off"), value: "off" },
      ...playback.subtitleTracks.slice(0, 99).map((track) => ({
        text: plain(shorten(track.label, 75)),
        value: String(track.index),
      })),
    ];
    const audioNow = audio.find(
      (option) => option.value === String(playback.audioStreamIndex),
    );
    const subtitlesNow = captions
      ? subtitles.find(
          (option) => option.value === String(playback.subtitleStreamIndex),
        )
      : subtitles[0];
    return {
      type: "modal",
      callback_id: jellyfinTracksCallback,
      private_metadata: JSON.stringify({
        sessionId: this.id,
        itemId: playback.itemId,
      }),
      title: plain("Audio and captions"),
      submit: plain("Done"),
      close: plain("Cancel"),
      blocks: [
        ...when(
          audio.length > 1,
          input("audio", "Audio", {
            type: "static_select",
            action_id: "track",
            options: audio,
            ...(audioNow ? { initial_option: audioNow } : {}),
          }),
        ),
        input("subtitles", "Captions", {
          type: "static_select",
          action_id: "track",
          options: subtitles,
          ...(subtitlesNow ? { initial_option: subtitlesNow } : {}),
        }),
      ],
    };
  }

  /**
   * Prepares a Jellyfin item to stream for whoever queued it: the address
   * to play, its captions and poster saved next to the session's media, and
   * its chapters. The address carries the token, so it only ever goes to
   * the media process.
   */
  async prepare(
    entry: TrackMetadata & { id: string; requesterId: string },
    options: {
      video: boolean;
      directory: string;
      audioStreamIndex?: number;
      subtitleStreamIndex?: number;
    },
  ): Promise<PreparedMedia & { chapters: Chapter[] }> {
    const source = parseJellyfinSource(entry.sourceId);
    const server =
      source &&
      this.host.store.jellyfinServer(entry.requesterId, source.serverId);
    if (!source || !server || server.revoked)
      throw new TrackError("No longer available");
    const { jellyfin } = this.host;
    try {
      const item = await jellyfin.item(server, source.itemId);
      const play = await jellyfin.playback(server, item, options);
      await mkdir(options.directory, { recursive: true });
      const stream: MediaStream = {
        url: play.url,
        ...(play.videoUrl ? { videoUrl: play.videoUrl } : {}),
        ...(play.audioStream === undefined
          ? {}
          : { audioStream: play.audioStream }),
        jellyfin: play.playback,
      };
      const subtitle = play.playback.subtitleStreamIndex;
      if (play.form === "video" && subtitle !== undefined) {
        try {
          const text = await jellyfin.subtitles(
            server,
            item.Id,
            play.playback.mediaSourceId,
            subtitle,
          );
          // Some servers hand back WebVTT whatever was asked for.
          const srt = /^﻿?WEBVTT/.test(text) ? vttToSrt(text) : text;
          if (srt.trim()) {
            stream.subtitles = `${options.directory}/${entry.id}.jellyfin.srt`;
            await writeFile(stream.subtitles, srt);
          }
        } catch (error) {
          this.host.log.warn(
            {
              event: "jellyfin_captions_failed",
              entryId: entry.id,
              err: error,
            },
            "Playing the Jellyfin item without captions",
          );
        }
      }
      try {
        const cover = `${options.directory}/${entry.id}.jellyfin.jpg`;
        await writeFile(cover, await jellyfin.poster(server, item.Id));
        stream.cover = cover;
      } catch {
        // The card shows without a poster.
      }
      return { stream, form: play.form, chapters: itemChapters(item) };
    } catch (error) {
      if (error instanceof JellyfinError && error.unauthorized) {
        this.host.store.revokeJellyfinServer(server.userId, server.serverId);
        this.host.serversChanged?.(server.userId);
        throw new TrackError("No longer available");
      }
      if (
        error instanceof JellyfinError &&
        (error.status === 404 || error.status === 403)
      )
        throw new TrackError("No longer available");
      if (error instanceof JellyfinError)
        throw new TrackError(`${server.name} stopped responding`, {
          detail: error.message,
        });
      throw error;
    }
  }

  /**
   * Keeps the server told what plays: started, where it is every so often,
   * paused or not, and stopped, against the account of whoever queued it.
   */
  playing(
    entry: { id: string; requesterId: string; stream?: MediaStream },
    position: number,
    paused: boolean,
    force = false,
  ) {
    const playback = entry.stream?.jellyfin;
    const reported = this.reported;
    // Something else took over, without the item being stopped: it stopped
    // where it last was, not where the new one starts.
    if (
      reported &&
      (reported.entryId !== entry.id || reported.playback !== playback)
    )
      this.stopped(
        reported.entryId,
        reported.entryId === entry.id ? position : reported.position,
      );
    if (!playback) return;
    const server = this.host.store.jellyfinServer(
      entry.requesterId,
      playback.serverId,
    );
    if (!server || server.revoked) return;
    const now = Date.now();
    const current = this.reported;
    if (!current) {
      this.reported = {
        entryId: entry.id,
        server,
        playback,
        at: now,
        paused,
        position,
      };
      this.send(server, "start", playback, position, paused);
      return;
    }
    current.position = position;
    if (
      !force &&
      current.paused === paused &&
      now - current.at < progressEveryMs
    )
      return;
    current.at = now;
    current.paused = paused;
    this.send(server, "progress", playback, position, paused);
  }

  /** The item stopped playing, at `position` when it is known. */
  stopped(entryId: string, position?: number) {
    const reported = this.reported;
    if (!reported || reported.entryId !== entryId) return;
    this.reported = undefined;
    this.send(
      reported.server,
      "stop",
      reported.playback,
      position ?? reported.position,
      false,
    );
  }

  private send(
    server: LinkedServer,
    event: "start" | "progress" | "stop",
    playback: JellyfinPlayback,
    position: number,
    paused: boolean,
  ) {
    void this.host.jellyfin
      .report(server, event, playback, position, paused)
      .catch((error) => {
        if (error instanceof JellyfinError && error.unauthorized)
          this.host.store.revokeJellyfinServer(server.userId, server.serverId);
        this.host.serversChanged?.(server.userId);
        this.host.log.debug(
          { event: "jellyfin_report_failed", report: event, err: error },
          "Could not report playback to Jellyfin",
        );
      });
  }
}

const relinkText =
  "That server isn’t linked any more. Link it again under Settings › You.";

function addedText(item: JellyfinItem, startAt?: number) {
  return `Added *${escape(item.Name ?? "it")}* to the queue${startAt ? `, from ${formatClock(startAt)}` : ""}.`;
}

function errorText(error: unknown) {
  if (error instanceof TrackError) return error.message;
  if (error instanceof JellyfinError)
    return error.status
      ? "The server turned HuddleFM away."
      : "The server didn’t answer.";
  return "Something went wrong.";
}
