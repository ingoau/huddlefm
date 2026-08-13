import { rm } from "node:fs/promises";
import type { AuditLog } from "./audit-log.ts";
import type { JoinedHuddle } from "./slack-huddle.ts";
import type { Interaction, SlackAppAdapter } from "./slack-app.ts";
import { capabilities, Store } from "./store.ts";
import { TrackCatalog, type TrackMetadata } from "./tracks.ts";

type Entry = TrackMetadata & {
  id: string;
  requesterId: string;
  status: string;
  filePath?: string;
};

export class Coordinator {
  readonly id = crypto.randomUUID();
  readonly participants = new Set<string>();
  private queue: Entry[] = [];
  private history: Entry[] = [];
  private current?: Entry;
  private state = "ready";
  private volume: number;
  private revision = 0;
  private uiTs = "";
  private hostId: string | undefined;
  private allowed = new Set(["add", "remove-own"]);
  private serial = Promise.resolve();
  private preparationSerial = Promise.resolve();
  private preparations = new Map<string, AbortController>();
  private anchorTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private lastSearch = new Map<string, number>();

  constructor(
    readonly room: JoinedHuddle,
    hostId: string,
    private botUserId: string,
    private slack: SlackAppAdapter,
    private store: Store,
    private tracks: TrackCatalog,
    private audit: AuditLog,
    private config: { queueLimit: number; initialVolume: number; idleMs: number; port: number; managerUserId: string },
    private mediaToken: string,
    private sendMedia: (message: unknown) => void,
    private leaveMedia: () => Promise<void>,
  ) {
    this.hostId = hostId;
    this.volume = config.initialVolume;
    this.participants.add(hostId);
    this.participants.add(botUserId);
    for (const id of room.participantIds) this.participants.add(id);
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
  }

  suggestions(interaction: Interaction) {
    if (!this.can(interaction.userId, "add")) return Promise.resolve([]);
    const now = Date.now();
    if (now - (this.lastSearch.get(interaction.userId) ?? 0) < 400) return Promise.resolve([]);
    this.lastSearch.set(interaction.userId, now);
    return this.tracks.suggestions(interaction.value);
  }

  action(interaction: Interaction) {
    if (interaction.actionId === "add_track_to_queue") return this.add(interaction);
    const currentId = this.current?.id;
    return this.enqueue(async () => {
      if (interaction.type === "view_submission") return this.settingsSubmission(interaction);
      if (interaction.messageTs && interaction.messageTs !== this.uiTs)
        return this.notice(interaction.userId, "That player is stale; use the newest one.");
      const handlers: Record<string, () => Promise<void> | void> = {
        remove_queue_track: () => this.remove(interaction),
        previous_track: () => this.previous(interaction),
        toggle_playback: () => this.toggle(interaction),
        next_track: () => this.next(interaction, currentId),
        volume_down: () => this.changeVolume(interaction, -0.05),
        volume_up: () => this.changeVolume(interaction, 0.05),
        queue_move_up: () => this.reorder(interaction, -1),
        queue_move_down: () => this.reorder(interaction, 1),
        clear_queue: () => this.clear(interaction),
        view_full_queue: () => this.queueModal(interaction),
        open_settings: () => this.settingsModal(interaction),
        end_session: () => this.end(interaction.userId, "ended by host"),
        claim_host: () => this.claimHost(interaction),
      };
      await handlers[interaction.actionId]?.();
    });
  }

  mediaEvent(type: string, details?: { entryId?: string }) {
    if (type === "track_ended" || type === "track_error" || type === "stalled")
      return this.enqueue(() => this.advance(type, details?.entryId));
    if (type === "fatal" || type === "ended")
      return this.enqueue(() => this.end(undefined, "media connection ended"));
  }

  threadActivity(userId: string) {
    if (userId === this.botUserId || this.state === "ended") return;
    clearTimeout(this.anchorTimer);
    this.anchorTimer = setTimeout(() => void this.enqueue(() => this.reanchor()), 5_000);
  }

  memberJoined(userId: string) {
    this.participants.add(userId);
    this.refreshIdle();
  }

  memberLeft(userId: string) {
    this.participants.delete(userId);
    const changed = userId === this.botUserId
      ? this.enqueue(() => this.end(undefined, "removed from Huddle"))
      : userId === this.hostId
      ? this.enqueue(() => this.hostLeft())
      : Promise.resolve();
    this.refreshIdle();
    return changed;
  }

  endFromSlack() {
    return this.enqueue(() => this.end(this.hostId, "Huddle ended"));
  }

  private enqueue<T>(work: () => Promise<T> | T) {
    const next = this.serial.then(work, work);
    this.serial = next.then(() => undefined, () => undefined);
    return next;
  }

  private can(userId: string, capability: string) {
    return userId === this.config.managerUserId || userId === this.hostId || this.allowed.has(capability);
  }

  private async require(interaction: Interaction, capability: string) {
    if (this.can(interaction.userId, capability)) return true;
    this.audit.record("action.denied", interaction.userId, { sessionId: this.id, capability });
    await this.notice(interaction.userId, "You do not have permission for that.");
    return false;
  }

  private async add(interaction: Interaction) {
    const accepted = await this.enqueue(async () => {
      if (this.state === "ended") return false;
      if (interaction.messageTs && interaction.messageTs !== this.uiTs) {
        await this.notice(interaction.userId, "That player is stale; use the newest one.");
        return false;
      }
      return this.require(interaction, "add");
    });
    if (!accepted) return;
    let metadata: TrackMetadata;
    try {
      metadata = await this.tracks.resolve(interaction.value);
    } catch (error) {
      return this.notice(interaction.userId, message(error));
    }
    const pending = await this.enqueue(async () => {
      if (this.state === "ended" || !(await this.require(interaction, "add"))) return;
      if (this.queue.length + Number(Boolean(this.current)) >= this.config.queueLimit) {
        await this.notice(interaction.userId, "The queue is full.");
        return;
      }
      const entry: Entry = { ...metadata, id: crypto.randomUUID(), requesterId: interaction.userId, status: "preparing" };
      const controller = new AbortController();
      this.preparations.set(entry.id, controller);
      this.queue.push(entry);
      this.store.addTrack({ ...entry, sessionId: this.id, status: entry.status });
      this.audit.record("track.added", interaction.userId, { sessionId: this.id, ...auditTrack(entry) });
      await this.render();
      return { entry, controller };
    });
    if (!pending) return;
    const { entry, controller } = pending;
    const prepared = this.preparationSerial.then(() =>
      this.tracks.prepare(entry, `data/media/${this.id}`, entry.id, controller.signal),
    );
    this.preparationSerial = prepared.then(() => undefined, () => undefined);
    try {
      const filePath = await prepared;
      await this.enqueue(async () => {
        this.preparations.delete(entry.id);
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
        if (this.state === "ended" || !this.queue.includes(entry)) return;
        entry.status = "failed";
        this.queue = this.queue.filter(item => item !== entry);
        this.store.setTrack(entry.id, { status: "failed" });
        this.audit.record("track.failed", undefined, { sessionId: this.id, ...auditTrack(entry), reason: safeAuditError(error) });
        await this.notice(entry.requesterId, `Could not prepare ${entry.title}: ${message(error)}`);
        if (!this.current) await this.startNext();
        else {
          await this.render();
          this.syncPreloads();
        }
      });
    }
  }

  private async startNext() {
    const next = this.queue.find(track => track.status === "ready");
    if (!next) {
      this.current = undefined;
      this.state = "ready";
      this.sendMedia({ type: "stop" });
      await this.render();
      return this.refreshIdle();
    }
    this.queue.splice(this.queue.indexOf(next), 1);
    this.current = next;
    next.status = "playing";
    this.state = "playing";
    this.store.setTrack(next.id, { status: "playing" });
    this.store.setSession(this.id, { status: "playing" });
    this.audit.record("track.started", undefined, { sessionId: this.id, ...auditTrack(next) });
    this.sendMedia({
      type: "play",
      entryId: next.id,
      url: this.mediaUrl(next),
    });
    this.syncPreloads();
    await this.render();
    this.refreshIdle();
  }

  audioPath(entryId: string, token: string) {
    if (token !== this.mediaToken) return;
    return [this.current, ...this.queue, ...this.history]
      .find(entry => entry?.id === entryId)?.filePath;
  }

  private mediaUrl(entry: Entry) {
    return `http://127.0.0.1:${this.config.port}/audio/${entry.id}?token=${encodeURIComponent(this.mediaToken)}`;
  }

  private syncPreloads() {
    const entries = [
      this.queue.find(entry => entry.status === "ready" && entry.filePath),
      this.history.at(-1),
    ].filter((entry, index, all): entry is Entry =>
      Boolean(entry?.filePath) && all.findIndex(other => other?.id === entry?.id) === index,
    );
    this.sendMedia({
      type: "preload",
      entries: entries.map(entry => ({ entryId: entry.id, url: this.mediaUrl(entry) })),
    });
  }

  private async advance(reason = "played", expectedId?: string) {
    if (expectedId && this.current?.id !== expectedId) return;
    if (this.current) {
      this.current.status = reason === "played" || reason === "track_ended" ? "played" : "failed";
      if (reason === "played" || reason === "track_ended") this.history.push(this.current);
      this.store.setTrack(this.current.id, { status: this.current.status });
      if (reason === "track_ended")
        this.audit.record("track.finished", undefined, { sessionId: this.id, ...auditTrack(this.current) });
      if (reason === "track_error" || reason === "stalled")
        this.audit.record("track.failed", undefined, { sessionId: this.id, ...auditTrack(this.current), reason });
    }
    this.current = undefined;
    await this.startNext();
  }

  private async next(interaction: Interaction, expectedId?: string) {
    if (!(await this.require(interaction, "skip"))) return;
    if (!expectedId || this.current?.id !== expectedId)
      return this.notice(interaction.userId, "Nothing was playing when you pressed Next.");
    this.audit.record("track.skipped", interaction.userId, { sessionId: this.id, ...auditTrack(this.current) });
    await this.advance();
  }

  private async previous(interaction: Interaction) {
    if (!(await this.require(interaction, "skip")) || !this.history.length) return;
    const prior = this.history.pop()!;
    this.audit.record("track.previous", interaction.userId, { sessionId: this.id, ...auditTrack(prior) });
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

  private async toggle(interaction: Interaction) {
    if (!(await this.require(interaction, "pause")) || !this.current) return;
    this.state = this.state === "paused" ? "playing" : "paused";
    this.sendMedia({ type: this.state === "paused" ? "pause" : "resume" });
    this.store.setSession(this.id, { status: this.state });
    this.audit.record(`playback.${this.state === "paused" ? "paused" : "resumed"}`, interaction.userId, { sessionId: this.id, trackId: this.current.id });
    await this.render();
  }

  private async changeVolume(interaction: Interaction, delta: number) {
    if (!(await this.require(interaction, "volume"))) return;
    const previous = this.volume;
    this.volume = Math.max(0, Math.min(1, Math.round((this.volume + delta) * 10_000) / 10_000));
    this.sendMedia({ type: "volume", value: this.volume });
    this.store.setSession(this.id, { volume: this.volume });
    this.audit.record("volume.changed", interaction.userId, { sessionId: this.id, previous, volume: this.volume });
    await this.render();
  }

  private async remove(interaction: Interaction) {
    if (interaction.metadata && !this.validQueueView(interaction))
      return this.notice(interaction.userId, "That queue view is stale; reopen it.");
    const entry = this.queue.find(track => track.id === interaction.value);
    if (!entry) return;
    if (!this.can(interaction.userId, "manage-queue") &&
      !(entry.requesterId === interaction.userId && this.can(interaction.userId, "remove-own")))
      return this.notice(interaction.userId, "You do not have permission for that.");
    this.queue.splice(this.queue.indexOf(entry), 1);
    this.preparations.get(entry.id)?.abort();
    this.store.removeTrack(entry.id);
    this.audit.record("track.removed", interaction.userId, { sessionId: this.id, ...auditTrack(entry) });
    if (entry.filePath) await rm(entry.filePath, { force: true });
    await this.render();
    this.syncPreloads();
    this.refreshIdle();
    await this.updateQueueModal(interaction);
  }

  private async reorder(interaction: Interaction, direction: number) {
    if (!this.validQueueView(interaction))
      return this.notice(interaction.userId, "That queue view is stale; reopen it.");
    if (!(await this.require(interaction, "manage-queue"))) return;
    const index = this.queue.findIndex(track => track.id === interaction.value);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= this.queue.length) return;
    [this.queue[index], this.queue[target]] = [this.queue[target]!, this.queue[index]!];
    this.audit.record("queue.reordered", interaction.userId, { sessionId: this.id, trackId: interaction.value, from: index, to: target });
    await this.render();
    this.syncPreloads();
    await this.updateQueueModal(interaction);
  }

  private async clear(interaction: Interaction) {
    if (!(await this.require(interaction, "clear"))) return;
    const count = this.queue.length;
    for (const entry of this.queue) {
      this.preparations.get(entry.id)?.abort();
      this.store.removeTrack(entry.id);
      if (entry.filePath) await rm(entry.filePath, { force: true });
    }
    this.queue = [];
    this.audit.record("queue.cleared", interaction.userId, { sessionId: this.id, count });
    await this.render();
    this.syncPreloads();
    this.refreshIdle();
  }

  private async queueModal(interaction: Interaction) {
    if (!interaction.triggerId) return;
    await this.slack.modal(interaction.triggerId, this.queueView(interaction.userId));
  }

  private queueView(userId: string) {
    return {
      type: "modal",
      callback_id: "manage_queue",
      private_metadata: JSON.stringify({ sessionId: this.id }),
      title: plain("HuddleFM queue"),
      close: plain("Close"),
      blocks: this.queue.length ? this.queue.flatMap((track, index) => {
        const manages = this.can(userId, "manage-queue");
        const controls = [
          ...(manages && index ? [{ type: "button", action_id: "queue_move_up", text: plain("Up"), value: track.id }] : []),
          ...(manages && index < this.queue.length - 1 ? [{ type: "button", action_id: "queue_move_down", text: plain("Down"), value: track.id }] : []),
          ...(manages || (track.requesterId === userId && this.can(userId, "remove-own"))
            ? [{ type: "button", action_id: "remove_queue_track", text: plain("Remove"), style: "danger", value: track.id }]
            : []),
        ];
        return [
          { type: "section", block_id: `queue_item_${track.id}`, text: { type: "mrkdwn", text: `*${index + 1}. ${escape(track.title)}* — ${escape(track.artist)}\nAdded by <@${track.requesterId}>` } },
          ...(controls.length ? [{ type: "actions", block_id: `queue_actions_${track.id}`, elements: controls }] : []),
        ];
      }) : [{ type: "section", text: { type: "mrkdwn", text: "The queue is empty." } }],
    };
  }

  private validQueueView(interaction: Interaction) {
    try {
      return interaction.viewId && JSON.parse(interaction.metadata).sessionId === this.id;
    } catch {
      return false;
    }
  }

  private async updateQueueModal(interaction: Interaction) {
    if (interaction.viewId && interaction.viewHash)
      await this.slack.updateModal(interaction.viewId, interaction.viewHash, this.queueView(interaction.userId));
  }

  private async settingsModal(interaction: Interaction) {
    if (interaction.userId !== this.hostId && interaction.userId !== this.config.managerUserId)
      return this.notice(interaction.userId, "Only the host can change settings.");
    await this.slack.modal(interaction.triggerId, {
      type: "modal",
      callback_id: "save_settings",
      private_metadata: JSON.stringify({ sessionId: this.id, hostId: this.hostId }),
      title: plain("HuddleFM settings"),
      submit: plain("Save"),
      close: plain("Cancel"),
      blocks: [
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
          block_id: "permissions",
          optional: true,
          label: plain("Everyone else may"),
          element: {
            type: "checkboxes",
            action_id: "selected",
            options: capabilities.map(value => ({ text: plain(value), value })),
            initial_options: [...this.allowed].map(value => ({ text: plain(value), value })),
          },
        },
      ],
    });
  }

  private async settingsSubmission(interaction: Interaction) {
    if (interaction.actionId !== "save_settings") return;
    const metadata = JSON.parse(interaction.metadata || "{}") as { sessionId?: string; hostId?: string };
    if (
      metadata.sessionId !== this.id || metadata.hostId !== this.hostId ||
      (interaction.userId !== this.hostId && interaction.userId !== this.config.managerUserId)
    )
      return this.notice(interaction.userId, "Settings are stale; reopen them.");
    const nextHost = interaction.state.host?.user?.selected_user;
    if (nextHost === this.botUserId)
      return this.notice(interaction.userId, "HuddleFM cannot be the host.");
    if (nextHost && !this.participants.has(nextHost))
      return this.notice(interaction.userId, "The selected host is not in this Huddle.");
    const value = interaction.state.volume?.percent?.value?.trim();
    const percent = Number(value);
    if (!value || !Number.isFinite(percent) || percent < 0 || percent > 100)
      return this.notice(interaction.userId, "Volume must be between 0 and 100.");
    const previous = { hostId: this.hostId, volume: this.volume, permissions: [...this.allowed] };
    this.volume = Math.round(percent * 100) / 10_000;
    this.sendMedia({ type: "volume", value: this.volume });
    this.store.setSession(this.id, { volume: this.volume });
    const selected = interaction.state.permissions?.selected?.selected_options ?? [];
    this.allowed = new Set(selected.map(option => option.value).filter(Boolean) as string[]);
    for (const capability of capabilities)
      this.store.setPermission(this.id, capability, this.allowed.has(capability));
    if (nextHost) {
      this.hostId = nextHost;
      this.store.setSession(this.id, { hostId: nextHost });
    }
    this.audit.record("settings.changed", interaction.userId, {
      sessionId: this.id,
      previous,
      hostId: this.hostId,
      volume: this.volume,
      permissions: [...this.allowed],
    });
    await this.render();
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
    if (this.hostId) return this.notice(interaction.userId, "Host already claimed.");
    if (interaction.userId === this.botUserId || !this.participants.has(interaction.userId))
      return this.notice(interaction.userId, "Join the Huddle before taking over.");
    this.hostId = interaction.userId;
    this.store.setSession(this.id, { hostId: interaction.userId });
    this.audit.record("host.claimed", interaction.userId, { sessionId: this.id });
    await this.render();
  }

  private async render() {
    if (!this.uiTs || this.state === "ended") return;
    this.revision++;
    await this.slack.update(this.room.uiChannelId, this.uiTs, "HuddleFM player", this.blocks());
    this.store.setUi(this.id, this.uiTs, this.revision);
  }

  private async reanchor() {
    if (this.state === "ended") return;
    const revision = ++this.revision;
    const old = this.uiTs;
    const current = await this.slack.post(this.room.uiChannelId, this.room.uiThreadTs, "HuddleFM player", this.blocks());
    this.uiTs = current;
    this.store.setUi(this.id, current, revision);
    await this.slack.delete(this.room.uiChannelId, old).catch(error =>
      console.error(`[ui] orphan ${old}: ${message(error)}`),
    );
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
      subtitle: plain(current ? `${current.album ? `${current.album} · ` : ""}${current.artist}` : "Ready for music"),
      ...(current?.artwork ? { icon: { type: "image", image_url: current.artwork, alt_text: `${current.title} artwork` } } : {}),
      child_blocks: [
        { type: "actions", block_id: `playback_${id}`, elements: [
          { type: "button", action_id: "previous_track", text: plain("Previous"), value: this.id },
          { type: "button", action_id: "toggle_playback", text: plain(this.state === "paused" ? "Resume" : "Pause"), style: "primary", value: this.id },
          { type: "button", action_id: "next_track", text: plain("Next"), value: this.id },
        ] },
        { type: "actions", block_id: `volume_${id}`, elements: [
          { type: "button", action_id: "volume_down", text: plain("Volume -"), value: this.id },
          { type: "button", action_id: "volume_up", text: plain("Volume +"), value: this.id },
        ] },
        { type: "context", block_id: `volume_status_${id}`, elements: [{ type: "mrkdwn", text: `Volume: ${Math.round(this.volume * 10_000) / 100}%${this.hostId ? ` · Host: <@${this.hostId}>` : " · No host"}` }] },
      ],
    },
    {
      type: "container",
      block_id: `next_${id}`,
      title: plain(next ? `Next: ${next.title}` : "Nothing queued"),
      subtitle: plain(next ? `${next.album ? `${next.album} · ` : ""}${next.artist}${next.status === "preparing" ? " · preparing" : ""}` : "Add a song to keep the music going"),
      ...(next?.artwork ? { icon: { type: "image", image_url: next.artwork, alt_text: `${next.title} artwork` } } : {}),
      child_blocks: [{
        type: "context",
        block_id: `queue_status_${id}`,
        elements: [{ type: "mrkdwn", text: `${next ? `Added by <@${next.requesterId}> · ` : ""}${this.queue.length} ${this.queue.length === 1 ? "song" : "songs"} in queue` }],
      }],
    },
    {
      type: "container",
      block_id: `queue_controls_${id}`,
      title: plain("Controls"),
      child_blocks: [
        { type: "actions", block_id: `add_${id}`, elements: [
          { type: "external_select", action_id: "add_track_to_queue", placeholder: plain("Add to queue"), min_query_length: 3 },
        ] },
        { type: "actions", block_id: `actions_${id}`, elements: [
          { type: "button", action_id: "view_full_queue", text: plain("View queue"), value: this.id },
          { type: "button", action_id: "clear_queue", text: plain("Clear"), value: this.id, confirm: confirm("Clear queue?", "This removes every upcoming track.", "Clear") },
          ...(!this.hostId ? [{ type: "button", action_id: "claim_host", text: plain("Take over"), value: this.id }] : []),
          { type: "button", action_id: "open_settings", text: plain("Settings"), value: this.id },
          { type: "button", action_id: "end_session", text: plain("End"), style: "danger", value: this.id, confirm: confirm("End playback?", "This stops playback and ends the session.", "End") },
        ] },
      ],
    }];
  }

  private async notice(user: string, text: string) {
    await this.slack.ephemeral(this.room.uiChannelId, user, text, this.room.uiThreadTs);
  }

  private refreshIdle() {
    clearTimeout(this.idleTimer);
    if (this.state === "ended") return;
    const idle = (!this.current && !this.queue.length) || ![...this.participants].some(id => id !== this.botUserId);
    if (idle) this.idleTimer = setTimeout(() => void this.enqueue(async () => {
      const stillIdle = (!this.current && !this.queue.length) || ![...this.participants].some(id => id !== this.botUserId);
      if (stillIdle) await this.end(this.hostId, "idle timeout");
    }), this.config.idleMs);
  }

  private async end(userId: string | undefined, reason: string) {
    if (this.state === "ended") return;
    if (userId && !this.can(userId, "end-session")) {
      this.audit.record("action.denied", userId, { sessionId: this.id, capability: "end-session" });
      return this.notice(userId, "Only the host can end this session.");
    }
    this.state = "ended";
    for (const controller of this.preparations.values()) controller.abort();
    this.preparations.clear();
    clearTimeout(this.idleTimer);
    clearTimeout(this.anchorTimer);
    this.store.setSession(this.id, { status: "ended" });
    this.audit.record("session.ended", userId, { sessionId: this.id, reason });
    this.sendMedia({ type: "leave" });
    await this.leaveMedia();
    await rm(`data/media/${this.id}`, { recursive: true, force: true });
    if (this.uiTs)
      await this.slack.update(this.room.uiChannelId, this.uiTs, `HuddleFM ended: ${reason}`, [{ type: "section", text: { type: "mrkdwn", text: `*HuddleFM ended* — ${reason}` } }]);
  }
}

function auditTrack(track: Entry) {
  return { trackId: track.id, title: track.title, artist: track.artist, requesterId: track.requesterId };
}

function safeAuditError(error: unknown) {
  return message(error).replace(/(xox[acpbrs]-|token|cookie|authorization|JoinToken)[^\s,]*/gi, "$1[redacted]");
}

function plain(text: string) {
  return { type: "plain_text", text: text.slice(0, 150) };
}

function confirm(title: string, text: string, confirmText: string) {
  return { title: plain(title), text: { type: "mrkdwn", text }, confirm: plain(confirmText), deny: plain("Cancel") };
}

function duration(seconds?: number) {
  if (!seconds) return "";
  return ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
