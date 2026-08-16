import { rm } from "node:fs/promises";
import type { AuditLog } from "./audit-log.ts";
import type { JoinedHuddle } from "./slack-huddle.ts";
import type { Interaction, SlackAppAdapter } from "./slack-app.ts";
import { LyricsCatalog, type LyricsPayload } from "./lyrics.ts";
import {
  capabilities,
  displayModes,
  permissionPresets,
  Store,
  type DisplayMode,
  type SavedSession,
} from "./store.ts";
import { type PlaybackScrobbler, ScrobbleDispatcher } from "./scrobbling.ts";
import { TrackCatalog, type TrackMetadata } from "./tracks.ts";
import { errorMessage as message } from "./error-message.ts";
import { firstArtist } from "./artist.ts";
import {
  auditTrack,
  confirm,
  elapsed,
  escape,
  icon,
  permissionLabels,
  plain,
  safeAuditError,
  sectionBlocks,
  songCount,
} from "./coordinator-ui.ts";

const endRestoreMs = 2 * 60_000;

type Entry = TrackMetadata & {
  id: string;
  requesterId: string;
  automatic?: boolean;
  status: string;
  filePath?: string;
  lyrics?: Promise<LyricsPayload | undefined>;
};

export class Coordinator {
  readonly id: string;
  readonly participants = new Set<string>();
  private queue: Entry[] = [];
  private history: Entry[] = [];
  private current?: Entry;
  private state = "ready";
  private playbackSeconds = 0;
  private listenedSeconds = 0;
  private volume: number;
  private displayMode: DisplayMode = "default";
  private autoplayEnabled = false;
  private autoplayGeneration = 0;
  private autoplayPending = false;
  private anchorEnabled = false;
  private revision = 0;
  private uiTs = "";
  private hostId: string | undefined;
  private allowed = new Set<string>(permissionPresets.default);
  private serial = Promise.resolve();
  private preparationSerial = Promise.resolve();
  private preparations = new Map<string, AbortController>();
  private anchorTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleWarningTimer?: ReturnType<typeof setTimeout>;
  private aloneTimer?: ReturnType<typeof setTimeout>;
  private pausedTimer?: ReturnType<typeof setTimeout>;
  private pausedWarningTimer?: ReturnType<typeof setTimeout>;
  private lastSearch = new Map<string, number>();
  private playbackScrobbling?: PlaybackScrobbler;

  constructor(
    readonly room: JoinedHuddle,
    hostId: string,
    private botUserId: string,
    private slack: SlackAppAdapter,
    private store: Store,
    private tracks: TrackCatalog,
    private lyrics: LyricsCatalog,
    private audit: AuditLog,
    private config: {
      queueLimit: number;
      initialVolume: number;
      aloneMs: number;
      idleMs: number;
      pausedMs: number;
      warningMs: number;
      port: number;
      managerUserId?: string;
    },
    private mediaToken: string,
    private sendMedia: (message: unknown) => void,
    private leaveMedia: () => Promise<void>,
    restored?: SavedSession,
    private scrobbling?: ScrobbleDispatcher,
    private sessionChanged = () => {},
    private sessionEnded = (_sessionId: string) => {},
  ) {
    this.id = restored?.id ?? crypto.randomUUID();
    this.playbackScrobbling = scrobbling?.playback(this.id, botUserId);
    this.hostId = restored?.hostId ?? hostId;
    this.volume = restored?.volume ?? config.initialVolume;
    this.participants.add(hostId);
    this.participants.add(botUserId);
    for (const id of room.participantIds) this.participants.add(id);
    if (restored) {
      this.state = restored.state;
      this.playbackSeconds = restored.playbackSeconds;
      this.listenedSeconds = restored.listenedSeconds ?? 0;
      this.autoplayEnabled = restored.autoplay;
      this.displayMode = restored.displayMode;
      this.anchorEnabled = restored.anchorEnabled;
      this.revision = restored.revision;
      this.uiTs = restored.uiTs;
      this.allowed = new Set(restored.permissions);
      const entries = restored.tracks.map((track) => ({
        ...track,
        lyrics: this.lyrics.get(track).catch(() => undefined),
      }));
      this.current = entries.find((track) => track.status === "playing");
      this.history = entries.filter((track) => track.status === "played");
      this.queue = entries.filter(
        (track) => track !== this.current && track.status !== "played",
      );
    }
  }

  async start() {
    this.store.createSession({
      id: this.id,
      huddleId: this.room.huddleId,
      callId: this.room.huddleCallId,
      channelId: this.room.uiChannelId,
      threadTs: this.room.uiThreadTs,
      creatorId: this.room.huddleCreatorId,
      hostId: this.hostId!,
      volume: this.volume,
    });
    this.uiTs = await this.slack.post(
      this.room.uiChannelId,
      this.room.uiThreadTs,
      "HuddleFM player",
      this.blocks(),
    );
    this.store.setUi(this.id, this.uiTs, this.revision);
    this.audit.record("session.started", this.hostId, {
      sessionId: this.id,
      huddleId: this.room.huddleId,
      channelId: this.room.uiChannelId,
    });
    this.refreshIdle();
    this.sessionChanged();
  }

  async resume() {
    const missing = await Promise.all(
      [this.current, ...this.queue]
        .filter(Boolean)
        .map(async (entry) =>
          entry!.filePath && (await Bun.file(entry!.filePath).exists())
            ? undefined
            : entry,
        ),
    );
    if (this.current && missing.includes(this.current)) {
      this.current!.status = "preparing";
      this.queue.unshift(this.current!);
      this.current = undefined;
    }
    const missingEntries = missing.filter(Boolean) as Entry[];
    for (const entry of missingEntries) {
      entry.status = "preparing";
      entry.filePath = undefined;
      this.store.setTrack(entry.id, { status: "preparing", filePath: null });
    }
    this.store.activateSession(this.id, this.state);
    this.audit.record("session.resumed", undefined, {
      sessionId: this.id,
      huddleId: this.room.huddleId,
    });
    this.sessionChanged();
    this.sendMedia({ type: "volume", value: this.volume });
    this.sendMedia({ type: "display_mode", mode: this.displayMode });
    if (!this.current) await this.startNext();
    else {
      this.playbackScrobbling?.start(
        this.current,
        this.participants,
        this.state === "playing",
        this.playbackSeconds,
      );
      this.sendMedia(this.playMessage(this.current));
      if (this.playbackSeconds)
        this.sendMedia({ type: "seek", seconds: this.playbackSeconds });
      if (this.state === "paused") this.sendMedia({ type: "pause" });
      void this.current.lyrics?.then((lyrics) => {
        if (this.current && lyrics)
          this.sendMedia({
            type: "lyrics",
            entryId: this.current.id,
            ...lyrics,
          });
      });
      this.syncPreloads();
      await this.render();
      this.refreshIdle();
      this.scheduleAutoplay();
    }
    for (const entry of missingEntries) void this.prepareRestored(entry);
  }

  private async prepareRestored(entry: Entry) {
    const controller = new AbortController();
    this.preparations.set(entry.id, controller);
    try {
      const prepared = this.preparationSerial.then(() =>
        this.tracks.prepare(
          entry,
          `data/media/${this.id}`,
          entry.id,
          controller.signal,
        ),
      );
      this.preparationSerial = prepared.then(
        () => undefined,
        () => undefined,
      );
      const filePath = await prepared;
      await this.enqueue(async () => {
        this.preparations.delete(entry.id);
        if (
          this.state === "ended" ||
          this.state === "suspended" ||
          !this.queue.includes(entry)
        )
          return;
        entry.filePath = filePath;
        entry.status = "ready";
        this.store.setTrack(entry.id, { status: "ready", filePath });
        if (!this.current) await this.startNext();
        else {
          await this.render();
          this.syncPreloads();
        }
      });
    } catch (error) {
      await this.enqueue(async () => {
        this.preparations.delete(entry.id);
        if (this.state === "suspended" || !this.queue.includes(entry)) return;
        this.queue = this.queue.filter((track) => track !== entry);
        this.store.setTrack(entry.id, { status: "failed" });
        this.audit.record("track.failed", undefined, {
          sessionId: this.id,
          ...auditTrack(entry),
          reason: safeAuditError(error),
        });
        if (!this.current) await this.startNext();
      });
    }
  }

  suggestions(interaction: Interaction) {
    const allowed = {
      songs: this.can(interaction.userId, "add"),
      bulk: this.can(interaction.userId, "add-bulk"),
    };
    if (!allowed.songs && !allowed.bulk) return Promise.resolve([]);
    const now = Date.now();
    if (now - (this.lastSearch.get(interaction.userId) ?? 0) < 400)
      return Promise.resolve([]);
    this.lastSearch.set(interaction.userId, now);
    return this.tracks.suggestions(interaction.value, allowed);
  }

  handles(interaction: Interaction) {
    if (
      interaction.channelId === this.room.uiChannelId &&
      interaction.messageTs === this.uiTs
    )
      return true;
    if (interaction.value === this.id) return true;
    try {
      return JSON.parse(interaction.metadata || "{}").sessionId === this.id;
    } catch {
      return false;
    }
  }

  action(interaction: Interaction) {
    if (interaction.actionId === "add_track_to_queue")
      return this.add(interaction);
    const currentId = this.current?.id;
    return this.enqueue(async () => {
      if (!this.isParticipantOrManager(interaction.userId))
        return this.rejectNonParticipant(interaction);
      if (interaction.type === "view_submission")
        return this.settingsSubmission(interaction);
      if (interaction.messageTs && interaction.messageTs !== this.uiTs)
        return this.notice(
          interaction.userId,
          "That player is stale; use the newest one.",
        );
      const handlers: Record<string, () => Promise<void> | void> = {
        remove_queue_track: () => this.remove(interaction),
        previous_track: () => this.previous(interaction),
        toggle_playback: () => this.toggle(interaction),
        next_track: () => this.next(interaction, currentId),
        seek_back: () => this.seek(interaction, -10),
        seek_forward: () => this.seek(interaction, 10),
        volume_down: () => this.changeVolume(interaction, -0.05),
        volume_up: () => this.changeVolume(interaction, 0.05),
        queue_move_up: () => this.reorder(interaction, -1),
        queue_move_down: () => this.reorder(interaction, 1),
        clear_queue: () => this.clear(interaction),
        view_full_queue: () => this.queueModal(interaction),
        open_settings: () => this.settingsModal(interaction),
        end_session: () => this.end(interaction.userId, "ended by host"),
        claim_host: () => this.claimHost(interaction),
        connect_lastfm: () => this.lastFmModal(interaction),
        continue_lastfm: () => this.continueLastFm(interaction),
        disconnect_lastfm: () => this.disconnectLastFm(interaction),
        disconnect_listenbrainz: () => this.disconnectListenBrainz(interaction),
      };
      await handlers[interaction.actionId]?.();
    });
  }

  mediaEvent(type: string, details?: { entryId?: string; seconds?: number }) {
    if (this.state === "suspended") return;
    if (
      type === "playback_position" &&
      details &&
      details.entryId === this.current?.id &&
      typeof details.seconds === "number" &&
      Number.isFinite(details.seconds)
    ) {
      this.listenedSeconds += Math.max(
        0,
        details.seconds - this.playbackSeconds,
      );
      this.playbackSeconds = details.seconds;
      this.playbackScrobbling?.position(details.seconds);
      this.store.setSession(this.id, {
        playbackSeconds: details.seconds,
        listenedSeconds: this.listenedSeconds,
      });
      return;
    }
    if (type === "track_ended" || type === "track_error" || type === "stalled")
      return this.enqueue(() => this.advance(type, details?.entryId));
    if (type === "fatal" || type === "ended")
      return this.enqueue(() => this.end(undefined, "media connection ended"));
  }

  threadActivity(userId: string) {
    if (
      userId === this.botUserId ||
      this.state === "ended" ||
      !this.anchorEnabled
    )
      return;
    clearTimeout(this.anchorTimer);
    this.anchorTimer = setTimeout(
      () => void this.enqueue(() => this.reanchor()),
      5_000,
    );
  }

  repost() {
    clearTimeout(this.anchorTimer);
    return this.enqueue(() => this.reanchor());
  }

  memberJoined(userId: string) {
    this.participants.add(userId);
    this.playbackScrobbling?.memberJoined(userId);
    this.refreshIdle();
  }

  memberLeft(userId: string) {
    this.participants.delete(userId);
    this.playbackScrobbling?.memberLeft(userId);
    if (this.state === "suspended" || userId === this.botUserId) return;
    const changed =
      userId === this.hostId
        ? this.enqueue(() => this.hostLeft())
        : Promise.resolve();
    this.refreshIdle();
    return changed;
  }

  endFromSlack() {
    return this.enqueue(() => this.end(this.hostId, "huddle ended"));
  }

  suspendForRestart(resumeUntil: number) {
    return this.enqueue(async () => {
      if (this.state === "ended" || this.state === "suspended") return;
      const state = this.state;
      this.state = "suspended";
      this.playbackScrobbling?.pause();
      this.autoplayGeneration++;
      this.autoplayPending = false;
      for (const controller of this.preparations.values()) controller.abort();
      this.preparations.clear();
      clearTimeout(this.idleTimer);
      clearTimeout(this.idleWarningTimer);
      clearTimeout(this.aloneTimer);
      clearTimeout(this.pausedTimer);
      clearTimeout(this.pausedWarningTimer);
      clearTimeout(this.anchorTimer);
      this.store.suspendSession(
        this.id,
        {
          state,
          playbackSeconds: this.playbackSeconds,
          displayMode: this.displayMode,
          anchorEnabled: this.anchorEnabled,
          queue: this.queue.map((track) => track.id),
        },
        resumeUntil,
      );
      this.audit.record("session.suspended", undefined, {
        sessionId: this.id,
        resumeUntil,
      });
      console.log(`[shutdown:${this.id}] leaving media`);
      this.sendMedia({ type: "leave" });
      await this.leaveMedia();
      console.log(`[shutdown:${this.id}] posting restart notice`);
      await this.slack
        .post(
          this.room.uiChannelId,
          this.room.uiThreadTs,
          "HuddleFM is restarting. Playback should resume shortly.",
        )
        .catch((error) =>
          console.error(`[restart] could not post notice: ${message(error)}`),
        );
      console.log(`[shutdown:${this.id}] suspended`);
    });
  }

  private enqueue<T>(work: () => Promise<T> | T) {
    const next = this.serial.then(work, work);
    this.serial = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private can(userId: string, capability: string) {
    return (
      userId === this.config.managerUserId ||
      (this.participants.has(userId) &&
        (userId === this.hostId || this.allowed.has(capability)))
    );
  }

  private settingsAdmin(userId: string) {
    return userId === this.hostId || userId === this.config.managerUserId;
  }

  private canOpenSettings(userId: string) {
    return (
      this.isParticipantOrManager(userId) ||
      this.settingsAdmin(userId) ||
      ["volume", "configure-settings", "end-session"].some((capability) =>
        this.can(userId, capability),
      )
    );
  }

  private async require(interaction: Interaction, capability: string) {
    if (this.can(interaction.userId, capability)) return true;
    if (!this.isParticipantOrManager(interaction.userId)) {
      await this.rejectNonParticipant(interaction);
      return false;
    }
    this.audit.record("action.denied", interaction.userId, {
      sessionId: this.id,
      capability,
    });
    await this.notice(
      interaction.userId,
      "You do not have permission for that.",
    );
    return false;
  }

  private isParticipantOrManager(userId: string) {
    return (
      userId === this.config.managerUserId || this.participants.has(userId)
    );
  }

  private rejectNonParticipant(interaction: Interaction) {
    this.audit.record("action.denied", interaction.userId, {
      sessionId: this.id,
      actionId: interaction.actionId,
      reason: "not in huddle",
    });
    return this.notice(
      interaction.userId,
      "Join the huddle before using the player.",
    );
  }

  private async add(interaction: Interaction) {
    const accepted = await this.enqueue(async () => {
      if (this.state === "ended" || this.state === "suspended") return false;
      if (interaction.messageTs && interaction.messageTs !== this.uiTs) {
        await this.notice(
          interaction.userId,
          "That player is stale; use the newest one.",
        );
        return false;
      }
      return this.require(
        interaction,
        interaction.value.startsWith("bulkref_") ? "add-bulk" : "add",
      );
    });
    if (!accepted) return;
    let selection: TrackMetadata | TrackMetadata[];
    try {
      selection = await this.tracks.resolve(interaction.value);
    } catch (error) {
      return this.notice(interaction.userId, message(error));
    }
    const tracks = Array.isArray(selection) ? selection : [selection];
    const capability = Array.isArray(selection) ? "add-bulk" : "add";
    const pending = await this.enqueue(async () => {
      if (
        this.state === "ended" ||
        this.state === "suspended" ||
        !(await this.require(interaction, capability))
      )
        return;
      await this.removeQueuedAutoplay();
      const available =
        this.config.queueLimit -
        this.queue.length -
        Number(Boolean(this.current));
      if (tracks.length > available) {
        await this.notice(
          interaction.userId,
          available
            ? `The queue only has room for ${available} more songs.`
            : "The queue is full.",
        );
        return;
      }
      const entries = tracks.map((metadata) => ({
        ...metadata,
        id: crypto.randomUUID(),
        requesterId: interaction.userId,
        status: "preparing",
        lyrics: this.lyrics.get(metadata).catch((error) => {
          console.warn(`[lyrics] ${message(error)}`);
          return undefined;
        }),
      }));
      const pending = entries.map((entry) => {
        const controller = new AbortController();
        this.preparations.set(entry.id, controller);
        this.queue.push(entry);
        this.store.addTrack({
          ...entry,
          sessionId: this.id,
          status: entry.status,
        });
        this.audit.record("track.added", interaction.userId, {
          sessionId: this.id,
          ...auditTrack(entry),
        });
        this.store.incrementUsage("added");
        return { entry, controller };
      });
      await this.render();
      return pending;
    });
    if (!pending) return;
    await Promise.all(
      pending.map(({ entry, controller }) =>
        this.prepareManual(entry, controller),
      ),
    );
  }

  private async prepareManual(entry: Entry, controller: AbortController) {
    const prepared = this.preparationSerial.then(() =>
      this.tracks.prepare(
        entry,
        `data/media/${this.id}`,
        entry.id,
        controller.signal,
      ),
    );
    this.preparationSerial = prepared.then(
      () => undefined,
      () => undefined,
    );
    try {
      const filePath = await prepared;
      await this.enqueue(async () => {
        this.preparations.delete(entry.id);
        if (this.state === "suspended") return;
        if (this.state === "ended" || !this.queue.includes(entry))
          return rm(filePath, { force: true });
        entry.filePath = filePath;
        entry.status = "ready";
        this.store.setTrack(entry.id, { status: "ready", filePath });
        if (!this.current) await this.startNext();
        else {
          await this.render();
          this.syncPreloads();
        }
      });
    } catch (error) {
      await this.enqueue(async () => {
        this.preparations.delete(entry.id);
        if (
          this.state === "ended" ||
          this.state === "suspended" ||
          !this.queue.includes(entry)
        )
          return;
        entry.status = "failed";
        this.queue = this.queue.filter((item) => item !== entry);
        this.store.setTrack(entry.id, { status: "failed" });
        this.audit.record("track.failed", undefined, {
          sessionId: this.id,
          ...auditTrack(entry),
          reason: safeAuditError(error),
        });
        await this.notice(
          entry.requesterId,
          `Could not prepare ${entry.title}: ${message(error)}`,
        );
        if (!this.current) await this.startNext();
        else {
          await this.render();
          this.syncPreloads();
        }
        this.scheduleAutoplay();
      });
    }
  }

  private scheduleAutoplay() {
    const seed = this.current?.sourceId ?? this.history.at(-1)?.sourceId;
    if (
      !seed ||
      !this.autoplayEnabled ||
      this.autoplayPending ||
      this.state === "ended" ||
      this.state === "suspended" ||
      this.queue.some((track) => !track.automatic) ||
      this.queue.some((track) => track.automatic) ||
      this.queue.length + Number(Boolean(this.current)) >=
        this.config.queueLimit
    )
      return;
    const generation = this.autoplayGeneration;
    this.autoplayPending = true;
    void this.recommend(seed, generation).finally(() => {
      if (generation === this.autoplayGeneration) this.autoplayPending = false;
    });
  }

  private async recommend(seed: string, generation: number) {
    try {
      const ids = [...new Set(await this.tracks.upNextIds(seed))];
      const excluded = new Set([
        this.current?.sourceId,
        ...this.queue.map((track) => track.sourceId),
        ...this.history.slice(-20).map((track) => track.sourceId),
      ]);
      for (const id of ids) {
        if (excluded.has(id)) continue;
        let metadata: TrackMetadata;
        try {
          metadata = await this.tracks.resolveVideoId(id);
        } catch {
          continue;
        }
        const pending = await this.enqueue(async () => {
          if (!this.canAddAutoplay(seed, generation)) return;
          const currentIds = new Set([
            this.current?.sourceId,
            ...this.queue.map((track) => track.sourceId),
            ...this.history.slice(-20).map((track) => track.sourceId),
          ]);
          if (currentIds.has(metadata.sourceId)) return false;
          const entry = {
            ...metadata,
            id: crypto.randomUUID(),
            requesterId: this.botUserId,
            automatic: true,
            status: "preparing",
            lyrics: this.lyrics.get(metadata).catch(() => undefined),
          };
          const controller = new AbortController();
          this.preparations.set(entry.id, controller);
          this.queue.push(entry);
          this.store.addTrack({
            ...entry,
            sessionId: this.id,
            status: entry.status,
          });
          this.audit.record("track.autoplay_added", undefined, {
            sessionId: this.id,
            seedSourceId: seed,
            ...auditTrack(entry),
          });
          await this.render();
          return { entry, controller };
        });
        if (pending === undefined) return;
        if (pending === false) continue;
        if (await this.prepareAutoplay(pending.entry, pending.controller))
          return;
        if (!this.canAddAutoplay(seed, generation)) return;
      }
      this.audit.record("autoplay.recommendation_failed", undefined, {
        sessionId: this.id,
        seedSourceId: seed,
        reason: "no usable recommendations",
      });
    } catch (error) {
      this.audit.record("autoplay.recommendation_failed", undefined, {
        sessionId: this.id,
        seedSourceId: seed,
        reason: safeAuditError(error),
      });
    }
  }

  private canAddAutoplay(seed: string, generation: number) {
    return (
      this.autoplayEnabled &&
      generation === this.autoplayGeneration &&
      this.state !== "ended" &&
      this.state !== "suspended" &&
      (this.current?.sourceId ?? this.history.at(-1)?.sourceId) === seed &&
      !this.queue.some((track) => !track.automatic) &&
      !this.queue.some((track) => track.automatic) &&
      this.queue.length + Number(Boolean(this.current)) < this.config.queueLimit
    );
  }

  private async prepareAutoplay(entry: Entry, controller: AbortController) {
    const prepared = this.preparationSerial.then(() =>
      this.tracks.prepare(
        entry,
        `data/media/${this.id}`,
        entry.id,
        controller.signal,
      ),
    );
    this.preparationSerial = prepared.then(
      () => undefined,
      () => undefined,
    );
    try {
      const filePath = await prepared;
      return await this.enqueue(async () => {
        this.preparations.delete(entry.id);
        if (this.state === "suspended") return false;
        if (this.state === "ended" || !this.queue.includes(entry)) {
          await rm(filePath, { force: true });
          return false;
        }
        entry.filePath = filePath;
        entry.status = "ready";
        this.store.setTrack(entry.id, { status: "ready", filePath });
        if (!this.current) await this.startNext();
        else {
          await this.render();
          this.syncPreloads();
        }
        return true;
      });
    } catch (error) {
      return this.enqueue(async () => {
        this.preparations.delete(entry.id);
        if (!this.queue.includes(entry)) return false;
        entry.status = "failed";
        this.queue = this.queue.filter((track) => track !== entry);
        this.store.setTrack(entry.id, { status: "failed" });
        this.audit.record("track.failed", undefined, {
          sessionId: this.id,
          ...auditTrack(entry),
          reason: safeAuditError(error),
        });
        if (!this.current) await this.startNext();
        else await this.render();
        return false;
      });
    }
  }

  private async removeQueuedAutoplay() {
    this.autoplayGeneration++;
    this.autoplayPending = false;
    const automatic = this.queue.filter((track) => track.automatic);
    this.queue = this.queue.filter((track) => !track.automatic);
    for (const entry of automatic) {
      this.preparations.get(entry.id)?.abort();
      this.store.removeTrack(entry.id);
      if (entry.filePath) await rm(entry.filePath, { force: true });
    }
  }

  private async startNext() {
    const manual = this.queue.some((track) => !track.automatic);
    const next =
      this.queue.find(
        (track) => !track.automatic && track.status === "ready",
      ) ??
      (!manual
        ? this.queue.find((track) => track.status === "ready")
        : undefined);
    if (!next) {
      this.playbackScrobbling?.finish();
      this.current = undefined;
      this.state = "ready";
      this.sendMedia({ type: "stop" });
      await this.render();
      return this.refreshIdle();
    }
    this.queue.splice(this.queue.indexOf(next), 1);
    this.current = next;
    this.playbackSeconds = 0;
    next.status = "playing";
    this.state = "playing";
    this.store.setTrack(next.id, { status: "playing" });
    this.store.setSession(this.id, { status: "playing", playbackSeconds: 0 });
    this.audit.record("track.started", undefined, {
      sessionId: this.id,
      ...auditTrack(next),
    });
    this.playbackScrobbling?.start(next, this.participants);
    this.sendMedia(this.playMessage(next));
    void next.lyrics?.then((lyrics) => {
      if (this.current !== next) return;
      if (lyrics) {
        console.log(
          `[lyrics] ${next.title}: ${lyrics.source}, ${lyrics.lines.length} lines`,
        );
        this.sendMedia({ type: "lyrics", entryId: next.id, ...lyrics });
      } else this.sendMedia({ type: "lyrics_unavailable", entryId: next.id });
    });
    this.syncPreloads();
    await this.render();
    this.refreshIdle();
    this.scheduleAutoplay();
  }

  audioPath(entryId: string, token: string) {
    if (token !== this.mediaToken) return;
    return [this.current, ...this.queue, ...this.history].find(
      (entry) => entry?.id === entryId,
    )?.filePath;
  }

  private mediaUrl(entry: Entry) {
    return `http://127.0.0.1:${this.config.port}/audio/${entry.id}?token=${encodeURIComponent(this.mediaToken)}`;
  }

  private playMessage(entry: Entry) {
    return {
      type: "play",
      entryId: entry.id,
      url: this.mediaUrl(entry),
      title: entry.title,
      artist: entry.artist,
      album: entry.album,
      artwork: entry.artwork,
      duration: entry.duration,
      sourceId: entry.sourceId,
    };
  }

  private syncPreloads() {
    const entries = [
      this.queue.find((entry) => entry.status === "ready" && entry.filePath),
      this.history.at(-1),
    ].filter(
      (entry, index, all): entry is Entry =>
        Boolean(entry?.filePath) &&
        all.findIndex((other) => other?.id === entry?.id) === index,
    );
    this.sendMedia({
      type: "preload",
      entries: entries.map((entry) => ({
        entryId: entry.id,
        url: this.mediaUrl(entry),
      })),
    });
  }

  private async advance(reason = "played", expectedId?: string) {
    if (expectedId && this.current?.id !== expectedId) return;
    if (this.current) {
      this.playbackScrobbling?.finish();
      if (reason === "track_ended" && this.current.duration)
        this.listenedSeconds += Math.max(
          0,
          this.current.duration - this.playbackSeconds,
        );
      this.current.status =
        reason === "played" || reason === "track_ended" ? "played" : "failed";
      if (reason === "played" || reason === "track_ended")
        this.history.push(this.current);
      this.store.setTrack(this.current.id, { status: this.current.status });
      if (reason === "track_ended")
        this.audit.record("track.finished", undefined, {
          sessionId: this.id,
          ...auditTrack(this.current),
        });
      if (reason === "track_error" || reason === "stalled")
        this.audit.record("track.failed", undefined, {
          sessionId: this.id,
          ...auditTrack(this.current),
          reason,
        });
    }
    this.store.setSession(this.id, { listenedSeconds: this.listenedSeconds });
    this.current = undefined;
    await this.startNext();
  }

  private async next(interaction: Interaction, expectedId?: string) {
    if (!(await this.require(interaction, "skip"))) return;
    if (!expectedId || this.current?.id !== expectedId)
      return this.notice(
        interaction.userId,
        "Nothing was playing when you pressed Next.",
      );
    this.audit.record("track.skipped", interaction.userId, {
      sessionId: this.id,
      ...auditTrack(this.current),
    });
    this.store.incrementUsage("next");
    await this.advance();
  }

  private async previous(interaction: Interaction) {
    if (!(await this.require(interaction, "skip"))) return;
    if (this.current && this.playbackSeconds > 5) {
      this.audit.record("track.previous", interaction.userId, {
        sessionId: this.id,
        ...auditTrack(this.current),
        restarted: true,
      });
      this.store.incrementUsage("previous");
      this.playbackSeconds = 0;
      this.sendMedia({ type: "seek", seconds: 0 });
      return;
    }
    if (!this.history.length) return;
    const prior = this.history.pop()!;
    this.audit.record("track.previous", interaction.userId, {
      sessionId: this.id,
      ...auditTrack(prior),
    });
    this.store.incrementUsage("previous");
    if (this.current) {
      this.current.status = "ready";
      this.queue.unshift(this.current);
      this.store.setTrack(this.current.id, { status: "ready" });
    }
    this.current = undefined;
    prior.status = "ready";
    this.queue.unshift(prior);
    this.store.setTrack(prior.id, { status: "ready" });
    await this.startNext();
  }

  private async seek(interaction: Interaction, offset: number) {
    if (!(await this.require(interaction, "skip")) || !this.current) return;
    const previous = this.playbackSeconds;
    this.playbackSeconds = Math.max(0, previous + offset);
    this.sendMedia({ type: "seek", offset });
    this.audit.record("playback.seeked", interaction.userId, {
      sessionId: this.id,
      trackId: this.current.id,
      previous,
      seconds: this.playbackSeconds,
    });
    this.store.incrementUsage(offset > 0 ? "forward" : "back");
  }

  private async toggle(interaction: Interaction) {
    if (!(await this.require(interaction, "pause")) || !this.current) return;
    this.state = this.state === "paused" ? "playing" : "paused";
    if (this.state === "paused") this.playbackScrobbling?.pause();
    else this.playbackScrobbling?.resume();
    this.sendMedia({ type: this.state === "paused" ? "pause" : "resume" });
    this.store.setSession(this.id, { status: this.state });
    this.audit.record(
      `playback.${this.state === "paused" ? "paused" : "resumed"}`,
      interaction.userId,
      { sessionId: this.id, trackId: this.current.id },
    );
    this.store.incrementUsage(this.state === "paused" ? "paused" : "resumed");
    await this.render();
    this.refreshIdle();
  }

  private async changeVolume(interaction: Interaction, delta: number) {
    if (!(await this.require(interaction, "volume"))) return;
    const previous = this.volume;
    this.volume = Math.max(
      0,
      Math.min(1, Math.round((this.volume + delta) * 10_000) / 10_000),
    );
    this.sendMedia({ type: "volume", value: this.volume });
    this.store.setSession(this.id, { volume: this.volume });
    this.audit.record("volume.changed", interaction.userId, {
      sessionId: this.id,
      previous,
      volume: this.volume,
    });
    this.store.incrementUsage("volume");
    await this.render();
  }

  private async remove(interaction: Interaction) {
    if (interaction.metadata && !this.validQueueView(interaction))
      return this.notice(
        interaction.userId,
        "That queue view is stale; reopen it.",
      );
    const entry = this.queue.find((track) => track.id === interaction.value);
    if (!entry) return;
    if (
      !this.can(interaction.userId, "manage-queue") &&
      !(
        entry.requesterId === interaction.userId &&
        this.can(interaction.userId, "remove-own")
      )
    )
      return this.notice(
        interaction.userId,
        "You do not have permission for that.",
      );
    this.queue.splice(this.queue.indexOf(entry), 1);
    this.preparations.get(entry.id)?.abort();
    this.store.removeTrack(entry.id);
    this.audit.record("track.removed", interaction.userId, {
      sessionId: this.id,
      ...auditTrack(entry),
    });
    this.store.incrementUsage("removed");
    if (entry.filePath) await rm(entry.filePath, { force: true });
    await this.render();
    this.syncPreloads();
    this.refreshIdle();
    this.scheduleAutoplay();
    await this.updateQueueModal(interaction);
  }

  private async reorder(interaction: Interaction, direction: number) {
    if (!this.validQueueView(interaction))
      return this.notice(
        interaction.userId,
        "That queue view is stale; reopen it.",
      );
    if (!(await this.require(interaction, "manage-queue"))) return;
    const index = this.queue.findIndex(
      (track) => track.id === interaction.value,
    );
    const target = index + direction;
    if (index < 0 || target < 0 || target >= this.queue.length) return;
    [this.queue[index], this.queue[target]] = [
      this.queue[target]!,
      this.queue[index]!,
    ];
    this.audit.record("queue.reordered", interaction.userId, {
      sessionId: this.id,
      trackId: interaction.value,
      from: index,
      to: target,
    });
    this.store.incrementUsage("reordered");
    await this.render();
    this.syncPreloads();
    await this.updateQueueModal(interaction);
  }

  private async clear(interaction: Interaction) {
    if (!(await this.require(interaction, "clear"))) return;
    this.autoplayGeneration++;
    this.autoplayPending = false;
    const count = this.queue.length;
    for (const entry of this.queue) {
      this.preparations.get(entry.id)?.abort();
      this.store.removeTrack(entry.id);
      if (entry.filePath) await rm(entry.filePath, { force: true });
    }
    this.queue = [];
    this.audit.record("queue.cleared", interaction.userId, {
      sessionId: this.id,
      count,
    });
    this.store.incrementUsage("cleared");
    await this.render();
    this.syncPreloads();
    this.refreshIdle();
    this.scheduleAutoplay();
  }

  private async queueModal(interaction: Interaction) {
    if (!interaction.triggerId) return;
    await this.slack.modal(
      interaction.triggerId,
      this.queueView(interaction.userId),
    );
  }

  private queueView(userId: string) {
    return {
      type: "modal",
      callback_id: "manage_queue",
      private_metadata: JSON.stringify({ sessionId: this.id }),
      title: plain("HuddleFM queue"),
      close: plain("Close"),
      blocks: this.queue.length
        ? this.queue.flatMap((track, index) => {
            const manages = this.can(userId, "manage-queue");
            const controls = [
              ...(manages && index
                ? [
                    {
                      type: "button",
                      action_id: "queue_move_up",
                      text: plain("Up"),
                      value: track.id,
                    },
                  ]
                : []),
              ...(manages && index < this.queue.length - 1
                ? [
                    {
                      type: "button",
                      action_id: "queue_move_down",
                      text: plain("Down"),
                      value: track.id,
                    },
                  ]
                : []),
              ...(manages ||
              (track.requesterId === userId && this.can(userId, "remove-own"))
                ? [
                    {
                      type: "button",
                      action_id: "remove_queue_track",
                      text: plain("Remove"),
                      style: "danger",
                      value: track.id,
                    },
                  ]
                : []),
            ];
            return [
              {
                type: "section",
                block_id: `queue_item_${track.id}`,
                text: {
                  type: "mrkdwn",
                  text: `*${index + 1}. ${escape(track.title)}* — ${escape(track.artist)}\n${track.automatic ? "Autoplay recommendation" : `Added by <@${track.requesterId}>`}`,
                },
              },
              ...(controls.length
                ? [
                    {
                      type: "actions",
                      block_id: `queue_actions_${track.id}`,
                      elements: controls,
                    },
                  ]
                : []),
            ];
          })
        : [
            {
              type: "section",
              text: { type: "mrkdwn", text: "The queue is empty." },
            },
          ],
    };
  }

  private validQueueView(interaction: Interaction) {
    try {
      return (
        interaction.viewId &&
        JSON.parse(interaction.metadata).sessionId === this.id
      );
    } catch {
      return false;
    }
  }

  private async updateQueueModal(interaction: Interaction) {
    if (interaction.viewId && interaction.viewHash)
      await this.slack.updateModal(
        interaction.viewId,
        interaction.viewHash,
        this.queueView(interaction.userId),
      );
  }

  private async settingsModal(interaction: Interaction) {
    if (!this.canOpenSettings(interaction.userId))
      return this.notice(
        interaction.userId,
        "You do not have permission to change settings.",
      );
    await this.slack.modal(
      interaction.triggerId,
      this.settingsView(interaction.userId),
    );
  }

  private settingsView(userId: string) {
    const settings = this.scrobbling?.settings(userId) ?? {
      lastFmAvailable: false,
      lastFmConnected: false,
      lastFmEnabled: false,
      listenBrainzConnected: false,
      listenBrainzEnabled: false,
    };
    const admin = this.settingsAdmin(userId);
    const canChangeVolume = this.can(userId, "volume");
    const canConfigure = this.can(userId, "configure-settings");
    const canEnd = this.can(userId, "end-session");
    return {
      type: "modal",
      callback_id: "save_settings",
      private_metadata: JSON.stringify({
        sessionId: this.id,
        hostId: this.hostId,
      }),
      title: plain("HuddleFM settings"),
      submit: plain("Save"),
      close: plain("Cancel"),
      blocks: [
        { type: "header", text: plain("Session") },
        ...(canChangeVolume
          ? [
              {
                type: "input",
                block_id: "volume",
                label: plain("Volume (%)"),
                element: {
                  type: "plain_text_input",
                  action_id: "percent",
                  initial_value: String(Math.round(this.volume * 10_000) / 100),
                },
              },
            ]
          : []),
        ...(canConfigure
          ? [
              {
                type: "input",
                block_id: "display",
                label: plain("Display mode"),
                element: {
                  type: "static_select",
                  action_id: "mode",
                  options: displayModes.map((mode) => ({
                    text: plain(mode[0]!.toUpperCase() + mode.slice(1)),
                    value: mode,
                  })),
                  initial_option: {
                    text: plain(
                      this.displayMode[0]!.toUpperCase() +
                        this.displayMode.slice(1),
                    ),
                    value: this.displayMode,
                  },
                },
              },
              {
                type: "input",
                block_id: "autoplay",
                optional: true,
                label: plain("Autoplay"),
                hint: plain("Play recommendations when queue is empty"),
                element: {
                  type: "checkboxes",
                  action_id: "enabled",
                  options: [{ text: plain("Enabled"), value: "enabled" }],
                  initial_options: this.autoplayEnabled
                    ? [{ text: plain("Enabled"), value: "enabled" }]
                    : [],
                },
              },
              {
                type: "input",
                block_id: "anchor",
                optional: true,
                label: plain("Thread position"),
                element: {
                  type: "checkboxes",
                  action_id: "enabled",
                  options: [
                    {
                      text: plain("Keep player at bottom of thread"),
                      value: "enabled",
                    },
                  ],
                  initial_options: this.anchorEnabled
                    ? [
                        {
                          text: plain("Keep player at bottom of thread"),
                          value: "enabled",
                        },
                      ]
                    : [],
                },
              },
            ]
          : []),
        ...(canEnd
          ? [
              {
                type: "actions",
                block_id: "session_actions",
                elements: [
                  {
                    type: "button",
                    action_id: "end_session",
                    text: plain("End session"),
                    style: "danger",
                    value: this.id,
                    confirm: confirm(
                      "End playback?",
                      "This stops playback and ends the session.",
                      "End",
                    ),
                  },
                ],
              },
            ]
          : []),
        ...(admin
          ? [
              { type: "header", text: plain("Permissions") },
              {
                type: "input",
                block_id: "host",
                optional: true,
                label: plain("Transfer host"),
                element: {
                  type: "users_select",
                  action_id: "user",
                  ...(this.hostId ? { initial_user: this.hostId } : {}),
                },
              },
              {
                type: "input",
                block_id: "permission_preset",
                optional: true,
                label: plain("Apply permission preset"),
                hint: plain("Saving overwrites the custom permissions below."),
                element: {
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
              },
              {
                type: "input",
                block_id: "permissions",
                optional: true,
                label: plain("Everyone else may"),
                element: {
                  type: "checkboxes",
                  action_id: "selected",
                  options: capabilities.map((value) => ({
                    text: plain(permissionLabels[value]),
                    value,
                  })),
                  initial_options: capabilities
                    .filter((value) => this.allowed.has(value))
                    .map((value) => ({
                      text: plain(permissionLabels[value]),
                      value,
                    })),
                },
              },
            ]
          : []),
        { type: "header", text: plain("User settings") },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: settings.lastFmConnected
              ? `*Last.fm*\nConnected as ${escape(settings.lastFmUsername ?? "unknown")}`
              : `*Last.fm*\n${settings.lastFmAvailable ? "Disconnected" : "Unavailable until the app API key is configured"}`,
          },
        },
        ...(settings.lastFmConnected
          ? [
              {
                type: "input",
                block_id: "lastfm_scrobbling",
                optional: true,
                label: plain("Last.fm scrobbling"),
                element: {
                  type: "checkboxes",
                  action_id: "enabled",
                  options: [{ text: plain("Enabled"), value: "enabled" }],
                  initial_options: settings.lastFmEnabled
                    ? [{ text: plain("Enabled"), value: "enabled" }]
                    : [],
                },
              },
              {
                type: "actions",
                block_id: "lastfm_actions",
                elements: [
                  {
                    type: "button",
                    action_id: "disconnect_lastfm",
                    text: plain("Disconnect"),
                    style: "danger",
                    value: this.id,
                    confirm: confirm(
                      "Disconnect Last.fm?",
                      "This removes your saved Last.fm login.",
                      "Disconnect",
                    ),
                  },
                ],
              },
            ]
          : settings.lastFmAvailable
            ? [
                {
                  type: "actions",
                  block_id: "lastfm_actions",
                  elements: [
                    {
                      type: "button",
                      action_id: "connect_lastfm",
                      text: plain("Log in to Last.fm"),
                      value: this.id,
                    },
                  ],
                },
              ]
            : []),
        {
          type: "input",
          block_id: "listenbrainz_scrobbling",
          optional: true,
          label: plain("ListenBrainz scrobbling"),
          hint: plain(
            settings.listenBrainzConnected
              ? `Token saved${settings.listenBrainzUsername ? ` for ${settings.listenBrainzUsername}` : ""}`
              : "Uses your ListenBrainz user token",
          ),
          element: {
            type: "checkboxes",
            action_id: "enabled",
            options: [{ text: plain("Enabled"), value: "enabled" }],
            initial_options: settings.listenBrainzEnabled
              ? [{ text: plain("Enabled"), value: "enabled" }]
              : [],
          },
        },
        {
          type: "input",
          block_id: "listenbrainz_token",
          optional: true,
          label: plain("ListenBrainz API key / user token"),
          hint: plain(
            settings.listenBrainzConnected
              ? "Leave blank to keep the saved token"
              : "Find it in ListenBrainz settings",
          ),
          element: {
            type: "plain_text_input",
            action_id: "value",
            placeholder: plain(
              settings.listenBrainzConnected ? "Saved" : "Paste token",
            ),
          },
        },
        ...(settings.listenBrainzConnected
          ? [
              {
                type: "actions",
                block_id: "listenbrainz_actions",
                elements: [
                  {
                    type: "button",
                    action_id: "disconnect_listenbrainz",
                    text: plain("Remove token"),
                    style: "danger",
                    value: this.id,
                    confirm: confirm(
                      "Remove ListenBrainz token?",
                      "This disables ListenBrainz scrobbling and removes your saved token.",
                      "Remove",
                    ),
                  },
                ],
              },
            ]
          : []),
      ],
    };
  }

  private async lastFmModal(interaction: Interaction) {
    if (!this.scrobbling || !interaction.triggerId) return;
    try {
      const url = await this.scrobbling.beginLastFm(interaction.userId);
      await this.slack.pushModal(interaction.triggerId, {
        type: "modal",
        callback_id: "lastfm_login",
        private_metadata: JSON.stringify({ sessionId: this.id }),
        title: plain("Connect Last.fm"),
        close: plain("Cancel"),
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Authorize HuddleFM in Last.fm, return here, then press Continue.",
            },
          },
          {
            type: "actions",
            block_id: "lastfm_login_actions",
            elements: [
              {
                type: "button",
                action_id: "open_lastfm_authorization",
                text: plain("Authorize Last.fm"),
                url,
              },
              {
                type: "button",
                action_id: "continue_lastfm",
                text: plain("Continue"),
                style: "primary",
                value: this.id,
              },
            ],
          },
        ],
      });
    } catch (error) {
      await this.notice(
        interaction.userId,
        `Could not start Last.fm login: ${message(error)}`,
      );
    }
  }

  private async continueLastFm(interaction: Interaction) {
    if (!this.scrobbling) return;
    try {
      const username = await this.scrobbling.finishLastFm(interaction.userId);
      if (interaction.viewId && interaction.viewHash)
        await this.slack.updateModal(interaction.viewId, interaction.viewHash, {
          type: "modal",
          title: plain("Connect Last.fm"),
          close: plain("Done"),
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Connected as *${escape(username)}*.`,
              },
            },
          ],
        });
      if (interaction.previousViewId)
        await this.slack.updateModal(
          interaction.previousViewId,
          undefined,
          this.settingsView(interaction.userId),
        );
      this.playbackScrobbling?.settingsEnabled(interaction.userId);
    } catch (error) {
      await this.notice(
        interaction.userId,
        `Last.fm login is not complete: ${message(error)}`,
      );
    }
  }

  private async disconnectLastFm(interaction: Interaction) {
    if (!this.scrobbling) return;
    this.scrobbling.disconnectLastFm(interaction.userId);
    if (interaction.viewId && interaction.viewHash)
      await this.slack.updateModal(
        interaction.viewId,
        interaction.viewHash,
        this.settingsView(interaction.userId),
      );
  }

  private async disconnectListenBrainz(interaction: Interaction) {
    if (!this.scrobbling) return;
    this.scrobbling.disconnectListenBrainz(interaction.userId);
    if (interaction.viewId && interaction.viewHash)
      await this.slack.updateModal(
        interaction.viewId,
        interaction.viewHash,
        this.settingsView(interaction.userId),
      );
  }

  private async settingsSubmission(interaction: Interaction) {
    if (interaction.actionId !== "save_settings") return;
    const metadata = JSON.parse(interaction.metadata || "{}") as {
      sessionId?: string;
      hostId?: string;
    };
    if (
      metadata.sessionId !== this.id ||
      metadata.hostId !== this.hostId ||
      !this.canOpenSettings(interaction.userId)
    )
      return this.notice(
        interaction.userId,
        "Settings are stale; reopen them.",
      );
    const admin = this.settingsAdmin(interaction.userId);
    const nextHost = admin
      ? interaction.state.host?.user?.selected_user
      : undefined;
    if (nextHost === this.botUserId)
      return this.notice(interaction.userId, "HuddleFM cannot be the host.");
    if (nextHost && !this.participants.has(nextHost))
      return this.notice(
        interaction.userId,
        "The selected host is not in this huddle.",
      );
    const previous = {
      hostId: this.hostId,
      volume: this.volume,
      autoplay: this.autoplayEnabled,
      anchorEnabled: this.anchorEnabled,
      permissions: [...this.allowed],
    };
    const value = interaction.state.volume?.percent?.value?.trim();
    if (value !== undefined && this.can(interaction.userId, "volume")) {
      const percent = Number(value);
      if (!value || !Number.isFinite(percent) || percent < 0 || percent > 100)
        return this.notice(
          interaction.userId,
          "Volume must be between 0 and 100.",
        );
      this.volume = Math.round(percent * 100) / 10_000;
      this.sendMedia({ type: "volume", value: this.volume });
      this.store.setSession(this.id, { volume: this.volume });
    }
    if (this.can(interaction.userId, "configure-settings")) {
      const displayMode = interaction.state.display?.mode?.selected_option
        ?.value as DisplayMode | undefined;
      if (
        displayMode &&
        displayModes.includes(displayMode) &&
        displayMode !== this.displayMode
      ) {
        this.displayMode = displayMode;
        this.sendMedia({ type: "display_mode", mode: displayMode });
        this.store.setSession(this.id, { displayMode });
      }
      const autoplayState = interaction.state.autoplay?.enabled;
      if (autoplayState) {
        const autoplayEnabled =
          autoplayState.selected_options?.some(
            (option) => option.value === "enabled",
          ) ?? false;
        if (autoplayEnabled !== this.autoplayEnabled) {
          this.autoplayEnabled = autoplayEnabled;
          this.store.setSession(this.id, { autoplay: autoplayEnabled });
          if (!autoplayEnabled) await this.removeQueuedAutoplay();
        }
      }
      const anchorState = interaction.state.anchor?.enabled;
      if (anchorState) {
        const anchorEnabled =
          anchorState.selected_options?.some(
            (option) => option.value === "enabled",
          ) ?? false;
        if (!anchorEnabled) clearTimeout(this.anchorTimer);
        this.anchorEnabled = anchorEnabled;
        this.store.setSession(this.id, { anchorEnabled });
      }
    }
    const preset = admin
      ? interaction.state.permission_preset?.selected?.selected_option?.value
      : undefined;
    const selected = admin
      ? interaction.state.permissions?.selected?.selected_options
      : undefined;
    if (preset || selected) {
      this.allowed = new Set(
        preset
          ? permissionPresets[preset as keyof typeof permissionPresets]
          : (selected!
              .map((option) => option.value)
              .filter(Boolean) as string[]),
      );
      for (const capability of capabilities)
        this.store.setPermission(
          this.id,
          capability,
          this.allowed.has(capability),
        );
    }
    if (nextHost) {
      this.hostId = nextHost;
      this.store.setSession(this.id, { hostId: nextHost });
    }
    if (this.scrobbling) {
      try {
        const userSettings = this.scrobbling.settings(interaction.userId);
        let newlyEnabled = false;
        const lastFmState = interaction.state.lastfm_scrobbling?.enabled;
        if (lastFmState) {
          const enabled =
            lastFmState.selected_options?.some(
              (option) => option.value === "enabled",
            ) ?? false;
          newlyEnabled ||= enabled && !userSettings.lastFmEnabled;
          this.scrobbling.setLastFmEnabled(interaction.userId, enabled);
        }
        const listenBrainzState =
          interaction.state.listenbrainz_scrobbling?.enabled;
        const listenBrainzToken =
          interaction.state.listenbrainz_token?.value?.value?.trim();
        if (listenBrainzState) {
          const enabled =
            listenBrainzState.selected_options?.some(
              (option) => option.value === "enabled",
            ) ?? false;
          newlyEnabled ||=
            enabled &&
            (!userSettings.listenBrainzEnabled || Boolean(listenBrainzToken));
          await this.scrobbling.setListenBrainz(
            interaction.userId,
            listenBrainzToken || undefined,
            enabled,
          );
        }
        if (newlyEnabled)
          this.playbackScrobbling?.settingsEnabled(interaction.userId);
      } catch (error) {
        await this.notice(interaction.userId, message(error));
      }
    }
    this.audit.record("settings.changed", interaction.userId, {
      sessionId: this.id,
      previous,
      hostId: this.hostId,
      volume: this.volume,
      autoplay: this.autoplayEnabled,
      displayMode: this.displayMode,
      anchorEnabled: this.anchorEnabled,
      permissions: [...this.allowed],
    });
    this.store.incrementUsage("settings");
    await this.render();
    this.scheduleAutoplay();
  }

  private async hostLeft() {
    const hostId = this.hostId;
    this.hostId = undefined;
    this.store.setSession(this.id, { hostId: null });
    this.audit.record("host.left", hostId, { sessionId: this.id });
    await this.render();
  }

  private async claimHost(interaction: Interaction) {
    if (interaction.value !== this.id || interaction.messageTs !== this.uiTs)
      return this.notice(interaction.userId, "That takeover request is stale.");
    if (this.hostId)
      return this.notice(interaction.userId, "Host already claimed.");
    if (
      interaction.userId === this.botUserId ||
      !this.participants.has(interaction.userId)
    )
      return this.notice(
        interaction.userId,
        "Join the huddle before taking over.",
      );
    this.hostId = interaction.userId;
    this.store.setSession(this.id, { hostId: interaction.userId });
    this.audit.record("host.claimed", interaction.userId, {
      sessionId: this.id,
    });
    await this.render();
  }

  private async render() {
    if (!this.uiTs || this.state === "ended" || this.state === "suspended")
      return;
    this.revision++;
    await this.slack.update(
      this.room.uiChannelId,
      this.uiTs,
      "HuddleFM player",
      this.blocks(),
    );
    this.store.setUi(this.id, this.uiTs, this.revision);
  }

  private async reanchor() {
    if (this.state === "ended" || this.state === "suspended") return;
    const revision = ++this.revision;
    const old = this.uiTs;
    const current = await this.slack.post(
      this.room.uiChannelId,
      this.room.uiThreadTs,
      "HuddleFM player",
      this.blocks(),
    );
    this.uiTs = current;
    this.store.setUi(this.id, current, revision);
    await this.slack
      .delete(this.room.uiChannelId, old)
      .catch((error) => console.error(`[ui] orphan ${old}: ${message(error)}`));
  }

  private blocks() {
    const id = `${this.id}_${this.revision}`;
    const current = this.current;
    const next = this.queue[0];
    return [
      {
        type: "container",
        block_id: `player_${id}`,
        title: plain(current?.title ?? "Nothing playing"),
        subtitle: plain(
          current
            ? `${current.automatic ? "Autoplay · " : ""}${current.album ? `${current.album} · ` : ""}${current.artist}`
            : "Ready for music",
        ),
        ...(current?.artwork
          ? {
              icon: {
                type: "image",
                image_url: current.artwork,
                alt_text: `${current.title} artwork`,
              },
            }
          : {}),
        child_blocks: [
          ...(current
            ? [
                {
                  type: "context",
                  block_id: `current_status_${id}`,
                  elements: [
                    {
                      type: "mrkdwn",
                      text: current.automatic
                        ? "Autoplay recommendation"
                        : `Added by <@${current.requesterId}>`,
                    },
                  ],
                },
              ]
            : []),
          {
            type: "actions",
            block_id: `playback_${id}`,
            elements: [
              {
                type: "button",
                action_id: "previous_track",
                text: icon(":ms-skip-back:"),
                value: this.id,
              },
              {
                type: "button",
                action_id: "toggle_playback",
                text: icon(
                  this.state === "paused" ? ":ms-play:" : ":ms-pause:",
                ),
                style: "primary",
                value: this.id,
              },
              {
                type: "button",
                action_id: "next_track",
                text: icon(":ms-skip-forward:"),
                value: this.id,
              },
            ],
          },
          {
            type: "actions",
            block_id: `volume_${id}`,
            elements: [
              {
                type: "button",
                action_id: "volume_down",
                text: icon(":ms-speaker-low-volume:"),
                value: this.id,
              },
              {
                type: "button",
                action_id: "volume_up",
                text: icon(":ms-speaker-loud-volume:"),
                value: this.id,
              },
            ],
          },
          {
            type: "actions",
            block_id: `seek_${id}`,
            elements: [
              {
                type: "button",
                action_id: "seek_back",
                text: icon(":ms-rewind:"),
                value: this.id,
              },
              {
                type: "button",
                action_id: "seek_forward",
                text: icon(":ms-fast-forward:"),
                value: this.id,
              },
            ],
          },
          {
            type: "context",
            block_id: `volume_status_${id}`,
            elements: [
              {
                type: "mrkdwn",
                text: `Volume: ${Math.round(this.volume * 10_000) / 100}%${this.hostId ? ` · Host: <@${this.hostId}>` : " · No host"}`,
              },
            ],
          },
        ],
      },
      {
        type: "container",
        block_id: `next_${id}`,
        title: plain(next ? `Next: ${next.title}` : "Nothing queued"),
        subtitle: plain(
          next
            ? `${next.status === "preparing" ? "Preparing · " : ""}${next.automatic ? "Autoplay · " : ""}${next.album ? `${next.album} · ` : ""}${next.artist}`
            : "Add a song to keep the music going",
        ),
        ...(next?.artwork
          ? {
              icon: {
                type: "image",
                image_url: next.artwork,
                alt_text: `${next.title} artwork`,
              },
            }
          : {}),
        child_blocks: [
          {
            type: "context",
            block_id: `queue_status_${id}`,
            elements: [
              {
                type: "mrkdwn",
                text: `${next ? `${next.automatic ? "Autoplay recommendation" : `Added by <@${next.requesterId}>`} · ` : ""}${this.queue.length} ${this.queue.length === 1 ? "song" : "songs"} in queue`,
              },
            ],
          },
          {
            type: "actions",
            block_id: `add_${id}`,
            elements: [
              {
                type: "external_select",
                action_id: "add_track_to_queue",
                placeholder: plain("Add to queue"),
                min_query_length: 3,
              },
            ],
          },
          {
            type: "actions",
            block_id: `actions_${id}`,
            elements: [
              {
                type: "button",
                action_id: "view_full_queue",
                text: plain("Queue"),
                value: this.id,
              },
              {
                type: "button",
                action_id: "clear_queue",
                text: plain("Clear"),
                value: this.id,
                confirm: confirm(
                  "Clear queue?",
                  "This removes every upcoming track.",
                  "Clear",
                ),
              },
              ...(!this.hostId
                ? [
                    {
                      type: "button",
                      action_id: "claim_host",
                      text: plain("Take over"),
                      value: this.id,
                    },
                  ]
                : []),
              {
                type: "button",
                action_id: "open_settings",
                text: plain("Settings"),
                value: this.id,
              },
            ],
          },
        ],
      },
    ];
  }

  private async notice(user: string, text: string) {
    await this.slack.ephemeral(
      this.room.uiChannelId,
      user,
      text,
      this.room.uiThreadTs,
    );
  }

  private refreshIdle() {
    if (this.state === "ended" || this.state === "suspended") return;
    const alone = ![...this.participants].some((id) => id !== this.botUserId);
    if (alone && !this.aloneTimer) {
      void this.slack
        .post(
          this.room.uiChannelId,
          this.room.uiThreadTs,
          "I’m alone in the Huddle, so I’ll leave in 2 minutes.",
        )
        .catch((error) =>
          console.error(
            `[idle] could not post leave notice: ${message(error)}`,
          ),
        );
      this.aloneTimer = setTimeout(
        () =>
          void this.enqueue(async () => {
            this.aloneTimer = undefined;
            if (![...this.participants].some((id) => id !== this.botUserId))
              await this.end(undefined, "alone timeout");
          }),
        this.config.aloneMs,
      );
    } else if (!alone) {
      clearTimeout(this.aloneTimer);
      this.aloneTimer = undefined;
    }

    if (!this.current && !this.idleTimer) {
      this.idleWarningTimer = setTimeout(
        () => {
          this.idleWarningTimer = undefined;
          if (!this.current)
            void this.slack
              .post(
                this.room.uiChannelId,
                this.room.uiThreadTs,
                "Nothing is playing, so I’ll leave in 2 minutes.",
              )
              .catch((error) =>
                console.error(
                  `[idle] could not post leave notice: ${message(error)}`,
                ),
              );
        },
        Math.max(0, this.config.idleMs - this.config.warningMs),
      );
      this.idleTimer = setTimeout(
        () =>
          void this.enqueue(async () => {
            this.idleTimer = undefined;
            if (!this.current) await this.end(undefined, "idle timeout");
          }),
        this.config.idleMs,
      );
    } else if (this.current) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      clearTimeout(this.idleWarningTimer);
      this.idleWarningTimer = undefined;
    }

    if (this.state === "paused" && !this.pausedTimer) {
      this.pausedWarningTimer = setTimeout(
        () => {
          this.pausedWarningTimer = undefined;
          if (this.state === "paused")
            void this.slack
              .post(
                this.room.uiChannelId,
                this.room.uiThreadTs,
                "Playback is paused, so I’ll leave in 2 minutes.",
              )
              .catch((error) =>
                console.error(
                  `[paused] could not post leave notice: ${message(error)}`,
                ),
              );
        },
        Math.max(0, this.config.pausedMs - this.config.warningMs),
      );
      this.pausedTimer = setTimeout(
        () =>
          void this.enqueue(async () => {
            this.pausedTimer = undefined;
            if (this.state === "paused")
              await this.end(undefined, "paused timeout");
          }),
        this.config.pausedMs,
      );
    } else if (this.state !== "paused") {
      clearTimeout(this.pausedTimer);
      this.pausedTimer = undefined;
      clearTimeout(this.pausedWarningTimer);
      this.pausedWarningTimer = undefined;
    }
  }

  private async end(userId: string | undefined, reason: string) {
    if (this.state === "ended") return;
    if (userId && !this.can(userId, "end-session")) {
      this.audit.record("action.denied", userId, {
        sessionId: this.id,
        capability: "end-session",
      });
      return this.notice(userId, "Only the host can end this session.");
    }
    const state = this.state;
    this.state = "ended";
    this.playbackScrobbling?.finish();
    this.autoplayGeneration++;
    this.autoplayPending = false;
    for (const controller of this.preparations.values()) controller.abort();
    this.preparations.clear();
    clearTimeout(this.idleTimer);
    clearTimeout(this.idleWarningTimer);
    clearTimeout(this.aloneTimer);
    clearTimeout(this.pausedTimer);
    clearTimeout(this.pausedWarningTimer);
    clearTimeout(this.anchorTimer);
    this.store.endSession(
      this.id,
      {
        state,
        playbackSeconds: this.playbackSeconds,
        listenedSeconds: this.listenedSeconds,
        displayMode: this.displayMode,
        anchorEnabled: this.anchorEnabled,
        queue: this.queue.map((entry) => entry.id),
      },
      Date.now() + endRestoreMs,
    );
    this.audit.record("session.ended", userId, { sessionId: this.id, reason });
    this.sessionChanged();
    this.sendMedia({ type: "leave" });
    await this.leaveMedia();
    try {
      if (this.uiTs) {
        await this.slack
          .delete(this.room.uiChannelId, this.uiTs)
          .catch((error) =>
            console.error(
              `[ui] could not delete ended player ${this.uiTs}: ${message(error)}`,
            ),
          );
        const text = `Session ended: ${reason}`;
        const blocks = this.recapBlocks(text);
        const timestamp = await this.slack.post(
          this.room.uiChannelId,
          this.room.uiThreadTs,
          text,
          blocks,
        );
        this.uiTs = timestamp;
        this.store.setEndMessage(this.id, timestamp, text, blocks);
      }
    } finally {
      this.sessionEnded(this.id);
    }
  }

  private recapBlocks(text: string) {
    const songs = [...this.history, ...(this.current ? [this.current] : [])];
    const blocks: unknown[] = [
      { type: "section", text: { type: "mrkdwn", text } },
    ];
    if (!songs.length) return [...blocks, this.restoreBlock()];
    const autoplay = songs.filter((song) => song.automatic).length;
    const artists = Map.groupBy(songs, (song) => firstArtist(song.artist));
    const [topArtist, topSongs] = [...artists].sort(
      (a, b) => b[1].length - a[1].length,
    )[0]!;
    const requesters = Map.groupBy(
      songs.filter((song) => !song.automatic),
      (song) => song.requesterId,
    );
    const topRequester = [...requesters].sort(
      (a, b) => b[1].length - a[1].length,
    )[0];
    const timed = songs.filter((song) => song.duration);
    const longest = [...timed].sort((a, b) => b.duration! - a.duration!)[0];
    const average =
      timed.reduce((total, song) => total + song.duration!, 0) / timed.length;
    blocks.push({
      type: "container",
      block_id: `recap_${this.id}`,
      title: plain("Session recap"),
      is_collapsible: true,
      default_collapsed: true,
      child_blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              `*Listening time:* ${elapsed(this.listenedSeconds)}`,
              `*Songs played:* ${songs.length}`,
              `*Mix:* ${songs.length - autoplay} requested · ${autoplay} autoplay`,
              `*Autoplay percentage:* ${Math.round((autoplay / songs.length) * 100)}%`,
              `*Unique artists:* ${artists.size}`,
              `*Most frequent requester:* ${topRequester ? `<@${topRequester[0]}> (${songCount(topRequester[1].length)})` : "None"}`,
              `*Most repeated artist:* ${escape(topArtist)} (${songCount(topSongs.length)})`,
              `*Longest song:* ${longest ? `${escape(longest.title)} · ${elapsed(longest.duration!)}` : "Unknown"}`,
              `*Average song length:* ${timed.length ? elapsed(average) : "Unknown"}`,
              `*Session host:* ${this.hostId ? `<@${this.hostId}>` : "None"}`,
            ].join("\n"),
          },
        },
        ...sectionBlocks(
          "*Songs*",
          songs.map(
            (song, index) =>
              `${index + 1}. *${escape(song.title)}* — ${escape(song.artist)}${song.automatic ? " · Autoplay" : ` · <@${song.requesterId}>`}`,
          ),
        ),
      ],
    });
    blocks.push(this.restoreBlock());
    return blocks;
  }

  private restoreBlock() {
    return {
      type: "actions",
      block_id: `restore_${this.id}`,
      elements: [
        {
          type: "button",
          action_id: "restore_session",
          text: plain("Restore session"),
          style: "primary",
          value: this.id,
        },
      ],
    };
  }
}
