import { AsyncLocalStorage } from "node:async_hooks";
import { capture as captureAnalytics } from "./analytics.ts";
import type { AuditLog } from "./audit-log.ts";
import { loadFatigue, skipBystanderShare } from "./fatigue.ts";
import type { JoinedHuddle } from "./slack-huddle.ts";
import {
  slackErrorCode,
  slackRetryDelay,
  type Interaction,
  type SlackAppAdapter,
} from "./slack-app.ts";
import { LyricsCatalog, type LyricsPayload } from "./lyrics.ts";
import { rm } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import {
  capabilities,
  displayModes,
  duckingModes,
  mediaModes,
  type MediaMode,
  permissionPresets,
  recentTrackLimit,
  scrobblingModes,
  Store,
  transitionModes,
  autoplayModes,
  parseAutoplayMode,
  loopModes,
  type AutoplayMode,
  type ChannelDefaults,
  type DisplayMode,
  type DuckingMode,
  type LoopMode,
  sessionSaveNameLength,
  type SavedSession,
  type SessionSave,
  type SessionSaveOwner,
  type SessionSaveSettings,
  type SessionSaveTrack,
  type TransitionMode,
} from "./store.ts";
import {
  type PlaybackScrobbler,
  ScrobbleDispatcher,
  type ScrobbleTrack,
} from "./scrobbling.ts";
import {
  embeddedArtworkPath,
  isExpectedTrackFailure,
  isYoutubeVideoId,
  removePreparedMedia,
  parseBulkLinkList,
  normalizeToken,
  TrackCatalog,
  TrackError,
  trackFailureDetail,
  trackKind,
  type MediaForm,
  type MediaStream,
  type PreparedMedia,
  type TrackMetadata,
} from "./tracks.ts";
import {
  captionsPath,
  formatClock,
  type Chapter,
  isVideoLink,
  parseClock,
  readChapters,
  shorten,
} from "./videos.ts";
import { safeError as message } from "./error-message.ts";
import { firstArtist } from "./artist.ts";
import { logger } from "./logger.ts";
import type { ChannelManagers } from "./channel-managers.ts";
import type { RolePermissions } from "./config.ts";
import type { WorkspaceAdmins } from "./workspace-admins.ts";
import {
  actions,
  addedBy,
  artworkIcon,
  auditTrack,
  button,
  capitalize,
  confirm,
  context,
  elapsed,
  escape,
  footerContext,
  icon,
  input,
  likeValue,
  plain,
  safeAuditError,
  section,
  sectionBlocks,
  settingsMessageView,
  songCount,
  toggle,
  truncate,
  when,
} from "./coordinator-ui.ts";
import {
  eventGroup,
  integrationEventMessage,
  integrationGrantedBlocks,
  integrationGrantTimeoutMs,
  integrationReply,
  integrationRequestBlocks,
  parseIntegrationActionValue,
  parseIntegrationSettingsPage,
  sessionMatchesChannel,
  wrapIntegrationResult,
  type IntegrationCommand,
} from "./integration.ts";
import { RecommendationCatalog } from "./recommendations.ts";
import {
  isJellyfinStreamLink,
  parseJellyfinLink,
  parseJellyfinSource,
  type Jellyfin,
} from "./jellyfin.ts";
import {
  JellyfinUi,
  jellyfinTracksCallback,
  type QueuedItem,
} from "./jellyfin-ui.ts";
import {
  checked,
  defaultUserSettings,
  dialogMetadata,
  mergeForm,
  parseSettingsMetadata,
  listenBrainzTokenView,
  selected,
  settingsTabActionPrefix,
  settingsTabFromAction,
  settingsTabs,
  settingsView,
  submittedHuddleMixSources,
  submittedScrobbleServices,
  fieldFormState,
  videoAutoplaySelected,
  withoutUserForm,
  yourDataView,
  type FormState,
  type SettingsTab,
} from "./settings-view.ts";
import {
  changedSettings,
  settingsChanges,
  type Settings,
} from "./settings-diff.ts";
import {
  settingFields,
  type SessionSettingsView,
  type SettingFieldValue,
} from "./settings-schema.ts";
import {
  PluginChannel,
  type AgentResult,
  type PluginCommand,
  type PluginSettingChange,
} from "./plugin-channel.ts";

// What Your data calls each kind of record it deletes.
const deletedNouns = {
  added: ["song", "songs"],
  plays: ["play", "plays"],
  likes: ["like", "likes"],
  skips: ["skip", "skips"],
  scrobbles: ["scrobble", "scrobbles"],
} as const;

// What redrawing Settings may change about it.
type SettingsChange = {
  tab?: SettingsTab;
  integrationPage?: number;
  notice?: string;
  revision?: number;
  draft?: FormState;
};

const endRestoreMs = 2 * 60_000;
// The longest a search waits for the same user's last one to finish.
const searchDebounceMs = 300;
// How long, and how many, search results are kept for the same words typed
// again.
const searchCacheMs = 60_000;
const searchCacheSize = 100;
// How many of the last played tracks keep their files and lyrics, for
// Previous; going back further prepares a track again.
const keptHistory = 5;
// How long nobody may ask the host for video mode after they said not now.
const videoRequestPauseMs = 15 * 60_000;
// Slack allows this many screen shares at once in a huddle.
const screenShareSlots = 2;
// A stream playing this long after it was picked up again has recovered.
const streamRecoveredMs = 2 * 60_000;
// The most options a Slack select menu takes.
const selectOptionLimit = 100;

// A request to the host for video mode, in a direct message to them.
type VideoRequest = {
  userIds: string[];
  // What the first to ask wanted to watch, when it is known.
  title?: string;
  hostId: string;
  message?: Promise<{ channelId: string; ts: string } | undefined>;
};

type Entry = TrackMetadata & {
  id: string;
  requesterId: string;
  automatic?: boolean;
  // Video mode's autoplay picked it from YouTube's related videos.
  relatedVideo?: boolean;
  // Autoplay provenance; not persisted.
  autoplayMode?: AutoplayMode;
  discovery?: boolean;
  autoplaySources?: string[];
  listenerIds?: string[];
  counted?: boolean;
  status: string;
  filePath?: string;
  /** Where a track that plays as it arrives comes from; never persisted. */
  stream?: MediaStream;
  /** When the live stream playing started, for the player. */
  liveSince?: number;
  /** Times the playing stream has been picked up again after failing. */
  streamRetries?: number;
  streamRetriedAt?: number;
  /** A video YouTube kept failing to stream, so it is downloaded instead. */
  download?: boolean;
  /** Where to start playing, when not from the top: a resumed item. */
  startAt?: number;
  /** The audio and captions picked for a Jellyfin item. */
  jellyfinTracks?: { audioStreamIndex?: number; subtitleStreamIndex?: number };
  /** What the prepared file holds. */
  form?: MediaForm;
  /** Prepared in video mode, so a song's video has been looked for. */
  videoChecked?: boolean;
  /** What a video's sound is turned by to reach the loudness target. */
  gainDb?: number;
  /** Watched as a video, which keeps it out of the music stats. */
  isVideo?: boolean;
  /** A prepared video's chapters, once read. */
  chapters?: Chapter[];
  lyrics?: Promise<LyricsPayload | undefined>;
  introSeconds?: number;
  outroSeconds?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
};

// A choice in a search's results.
type SearchOption = { value?: string };

// Actions on messages other than the player, which are not stale for it: the
// scrobbling prompts, and the host's request for video mode.
const offPlayerActions = new Set([
  "toggle_session_scrobbling",
  "enable_session_scrobbling",
  "scrobble_track",
  "approve_video_request",
  "decline_video_request",
]);

// The actions that need to know whether the user manages the channel: those
// that show or change the Channel tab of Settings, and loading a save, which
// a channel manager may delete as they load it. Opening the load dialog is
// not one: its trigger ID would expire while Slack is asked.
const channelRoleActions = new Set([
  "open_settings",
  "save_channel_defaults",
  "clear_channel_defaults",
  "delete_channel_save",
  "load_session_save",
  ...settingsTabs.map((tab) => `${settingsTabActionPrefix}${tab}`),
]);

// The object without its undefined fields, for spreading into records that
// distinguish an absent field from an unset one.
function defined<Value extends object>(value: Value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<Value>;
}

// A modal's private metadata, or nothing when it is missing or malformed.
function parseMetadata(metadata: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(metadata || "{}");
  } catch {
    return {};
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("This operation was aborted", "AbortError");
}

// What the person who pressed the like button hears back. Nobody else sees it,
// so it says what the like is for rather than announcing it to the room.
const likedNotice = "This will be recommended to you more";

// Hosts song.link can match to other streaming services. Of the sources the
// bot plays, that is YouTube and SoundCloud.
const songLinkHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "soundcloud.com",
  "www.soundcloud.com",
  "m.soundcloud.com",
]);

/**
 * Where a saved song points: a song.link page when song.link can match the
 * source, otherwise the source itself. A Navidrome share's URL is a bearer
 * token for its audio, so it gets no link at all.
 */
function savedLink(entry: { sourceId: string; canonicalUrl: string }) {
  if (entry.sourceId.startsWith("navidrome:")) return undefined;
  const url = URL.parse(entry.canonicalUrl);
  if (url?.protocol !== "https:" && url?.protocol !== "http:") return undefined;
  return songLinkHosts.has(url.hostname)
    ? `https://song.link/${url.href}`
    : url.href;
}

const autoplayDiscoveryEvery = 4;
const autoplayDiscoveryMaxInterval = 16;
const autoplayCreditWindow = 10;
// How far back in this session's history autoplay looks when deciding a
// track has been heard too recently to come round again.
const autoplayRecentWindow = 100;
// How many random popular songs Play something tries before giving up.
const autoplayPopularAttempts = 5;
// Where video mode's autoplay picks come from, as recorded on each pick.
const relatedVideosSource = "related_videos";

// A track's title for the player: a video's long title is cut short at a
// word, which a song's never needs.
function displayTitle(track: Pick<Entry, "title" | "kind" | "canonicalUrl">) {
  return trackKind(track) === "video" ? shorten(track.title, 100) : track.title;
}

// The player's word on a live stream: that it is live, and since when, in
// each viewer's own time.
function liveStatus(entry: Pick<Entry, "live" | "liveSince">) {
  if (!entry.live) return "";
  if (!entry.liveSince) return "🔴 LIVE · ";
  const seconds = Math.floor(entry.liveSince / 1_000);
  return `🔴 LIVE · watching since <!date^${seconds}^{time}|${new Date(entry.liveSince).toISOString().slice(11, 16)} UTC> · `;
}

function shuffle<T>(items: T[]) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }
  return shuffled;
}

// A fair shuffle can hand back the order it was given, which reads as a
// button that did nothing. A few retries make a click visibly change the
// queue without biasing short queues much.
function reshuffle<T>(items: T[]) {
  let shuffled = shuffle(items);
  for (
    let attempt = 0;
    attempt < 4 && shuffled.every((item, index) => item === items[index]);
    attempt++
  )
    shuffled = shuffle(items);
  return shuffled;
}

/**
 * Work a client mod asked for over the huddle's data channel: the notices
 * the player would have sent, which answer it instead.
 */
type DataChannelRun = {
  /** who asked: only what is done as them is theirs */
  userId: string;
  notices: string[];
  /** notices that tell how it went, not that it failed */
  info: string[];
  done: boolean;
  post: boolean;
};

/** The most of the queue a client mod's `state` carries. */
const pluginQueueMax = 100;

export class Coordinator {
  readonly id: string;
  readonly participants = new Set<string>();
  // Bumped whenever tracked membership actually changes, so a reconciliation
  // can tell that its snapshot of Slack's participant list went stale while
  // it was in flight.
  private participantsRevision = 0;
  private queue: Entry[] = [];
  private history: Entry[] = [];
  private current?: Entry;
  private state = "ready";
  private playbackSeconds = 0;
  /** What client mods asked for, while it runs. */
  private dataChannelRuns = new AsyncLocalStorage<DataChannelRun>();
  /** The audit log, noting what came over the huddle's data channel. */
  private audit: Pick<AuditLog, "record">;
  /** The media process's last position report, and when it came. */
  private positionReport: { seconds: number; at: number } | undefined;
  private listenedSeconds = 0;
  private volume: number;
  private displayMode: DisplayMode = "default";
  private autoplayMode: AutoplayMode = "off";
  // Video mode's own autoplay, of related videos; the music's is left as it
  // is for when music comes back.
  private videoAutoplay = false;
  private loopMode: LoopMode = "off";
  private transitionMode: TransitionMode = "none";
  private duckingMode: DuckingMode;
  // Music, or video mode's screen share. Video mode leaves the music
  // settings as they are and only stops applying them.
  private mediaMode: MediaMode = "music";
  private captions = false;
  // The bar along the bottom of a playing video, in video mode.
  private progressBar = true;
  private watchedSeconds = 0;
  // Other people's screen shares in the huddle, as media last counted them.
  private contentShares = 0;
  // Preparations of tracks already prepared, for the other mode.
  private reprepares = new Map<string, AbortController>();
  // The open request for video mode, in a message to the host.
  private videoRequest?: VideoRequest;
  private videoRequestsPausedUntil = 0;
  // Whether each add dialog shows the video hint, so typing only redraws a
  // dialog when the hint comes or goes.
  private hintedViews = new Map<string, boolean>();
  // Jellyfin, for whoever in the session has linked a server.
  private jellyfinUi?: JellyfinUi;
  private autoplayGeneration = 0;
  // Discovery turns come every `autoplayDiscoveryInterval` picks; a skipped
  // discovery backs the interval off, one that plays through restores it.
  private autoplayDiscoveryInterval = autoplayDiscoveryEvery;
  private autoplaySinceDiscovery = 0;
  // Listeners whose taste fed each of the last few autoplay picks, so the
  // mix can favour whoever has been underserved.
  private autoplayCredits: string[][] = [];
  private autoplayPending = false;
  private autoplayRejected: string[] = [];
  private autoplayRejectedArtists: string[] = [];
  private anchorEnabled = false;
  // Whether this new session took its settings from its channel's defaults.
  private channelDefaultsApplied = false;
  private revision = 0;
  private uiTs = "";
  private hostId: string | undefined;
  private allowed = new Set<string>(permissionPresets.default);
  private serial = Promise.resolve();
  private preparations = new Map<string, AbortController>();
  /** What was playing before a restart, which plays first once it is back. */
  private interrupted?: Entry;
  private anchorTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleWarningTimer?: ReturnType<typeof setTimeout>;
  private aloneTimer?: ReturnType<typeof setTimeout>;
  private pausedTimer?: ReturnType<typeof setTimeout>;
  private pausedWarningTimer?: ReturnType<typeof setTimeout>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  // The player's newest blocks not yet sent to Slack, and the sending of
  // them; a retry waiting out a rate limit can be woken.
  private playerBlocks?: unknown[];
  private playerSending?: Promise<void>;
  private playerWake?: () => void;
  private playerSettling = false;
  private queueModalTimer?: ReturnType<typeof setTimeout>;
  private queueViews = new Map<
    string,
    { userId: string; hash: string | undefined }
  >();
  private lastSearch = new Map<string, number>();
  // Each user's running search, and recent results by what was typed.
  private searches = new Map<string, Promise<SearchOption[]>>();
  private searchCache = new Map<
    string,
    { options: SearchOption[]; expiresAt: number }
  >();
  private playbackScrobbling?: PlaybackScrobbler;
  private log = logger.child({ component: "coordinator" });
  // Client mods on the data channel; see docs/data-channel.md.
  private plugins: PluginChannel;
  private integrations = new Map<
    string,
    {
      permissions: Set<string>;
      events: Set<string>;
      channel: string;
      dmChannelId: string;
      requestTs: string;
      requestId: string;
    }
  >();
  private pendingIntegrations = new Map<
    string,
    {
      id: string;
      userId: string;
      permissions: string[];
      events: string[];
      dmChannelId: string;
      requestTs: string;
      channel: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    readonly room: JoinedHuddle,
    hostId: string,
    private botUserId: string,
    private slack: SlackAppAdapter,
    private store: Store,
    private tracks: TrackCatalog,
    private lyrics: LyricsCatalog,
    auditLog: AuditLog,
    private config: {
      queueLimit: number;
      initialVolume: number;
      duckingMode: DuckingMode;
      aloneMs: number;
      idleMs: number;
      pausedMs: number;
      warningMs: number;
      port: number;
      managerUserId?: string;
      excludedUserIds: Set<string>;
      footer?: string;
      video?: { sessionLimit: number };
    },
    private mediaToken: string,
    private sendMedia: (message: unknown) => void,
    private leaveMedia: () => Promise<void>,
    restored?: SavedSession,
    private scrobbling?: ScrobbleDispatcher,
    private sessionChanged = () => {},
    private sessionEnded = (
      _sessionId: string,
      _participantIds: string[],
    ) => {},
    private messagePosted = (
      _sessionId: string,
      _channelId: string,
      _messageTs: string,
    ) => {},
    private recommendations?: RecommendationCatalog,
    private workspaceAdmins?: WorkspaceAdmins,
    private channelManagers?: ChannelManagers,
    /** How many sessions, this one included, are in video mode. */
    private videoSessions: () => number = () => 0,
    jellyfin?: Jellyfin,
  ) {
    this.audit = {
      record: (event, actorId, details = {}) =>
        auditLog.record(
          event,
          actorId,
          this.fromDataChannel(actorId)
            ? { ...details, via: "data_channel" }
            : details,
        ),
    };
    this.id = restored?.id ?? crypto.randomUUID();
    this.log = logger.child({
      component: "coordinator",
      sessionId: this.id,
      huddleId: room.huddleId,
      channelId: room.uiChannelId,
    });
    this.plugins = new PluginChannel(
      {
        snapshot: () => this.pluginSnapshot(),
        you: (userId) => this.pluginYou(userId),
        command: (userId, command) => this.pluginCommand(userId, command),
        setting: (userId, setting, change) =>
          this.pluginSetting(userId, setting, change),
        send: (payload) => this.sendMedia({ type: "data_broadcast", payload }),
      },
      {
        log: (event, fields) =>
          this.log.warn({ event, ...fields }, "Client mod message failed"),
      },
    );
    if (jellyfin)
      this.jellyfinUi = new JellyfinUi({
        sessionId: this.id,
        slack,
        store,
        jellyfin,
        log: this.log,
        videoMode: () => this.videoMode,
        canUse: (userId) => this.isParticipantOrManager(userId),
        notice: (userId, text) => this.notice(userId, text),
        queue: (interaction, capability, items) =>
          this.queueItems(interaction, capability, items),
        refreshSettings: async (userId, viewId, settings) => {
          await this.slack
            .updateModal(
              viewId,
              undefined,
              this.settingsView(userId, parseSettingsMetadata(settings)),
            )
            .catch((error) =>
              this.log.debug(
                { event: "settings_refresh_failed", err: error },
                "Could not redraw Settings",
              ),
            );
        },
        audit: (event, userId, fields) =>
          this.audit.record(event, userId, fields),
      });
    this.playbackScrobbling = scrobbling?.playback(
      this.id,
      botUserId,
      (userId, track) => void this.promptTrackScrobbling(userId, track),
    );
    const requestedHost = restored?.hostId ?? hostId;
    this.hostId = this.isExcluded(requestedHost)
      ? room.participantIds.find(
          (id) => id !== botUserId && !this.isExcluded(id),
        )
      : requestedHost;
    this.volume = restored?.volume ?? config.initialVolume;
    this.duckingMode = restored?.duckingMode ?? config.duckingMode;
    if (!this.isExcluded(hostId)) this.participants.add(hostId);
    this.participants.add(botUserId);
    for (const id of room.participantIds)
      if (!this.isExcluded(id)) this.participants.add(id);
    if (restored) {
      this.state = restored.state;
      this.playbackSeconds = restored.playbackSeconds;
      this.listenedSeconds = restored.listenedSeconds ?? 0;
      this.autoplayMode = restored.autoplay;
      this.videoAutoplay = restored.videoAutoplay ?? false;
      this.loopMode = restored.loopMode;
      this.transitionMode = restored.transitionMode;
      this.displayMode = restored.displayMode;
      this.anchorEnabled = restored.anchorEnabled;
      this.mediaMode = restored.mediaMode ?? "music";
      this.captions = restored.captions ?? false;
      this.progressBar = restored.progressBar ?? true;
      this.watchedSeconds = restored.watchedSeconds ?? 0;
      this.revision = restored.revision;
      this.uiTs = restored.uiTs;
      this.allowed = new Set(restored.permissions);
      const entries = restored.tracks.map((track) => ({ ...track }));
      for (const entry of entries)
        if (entry.filePath) this.loadChapters(entry, entry.filePath);
      this.current = entries.find((track) => track.status === "playing");
      this.history = entries.filter((track) => track.status === "played");
      this.queue = entries.filter(
        (track) => track !== this.current && track.status !== "played",
      );
    } else {
      const defaults = store.channelDefaults(this.roomId);
      if (defaults) this.applyChannelDefaults(defaults);
    }
    this.log.info(
      {
        event: "created",
        restored: Boolean(restored),
        state: this.state,
        participants: this.participants.size,
        queuedTracks: this.queue.length,
        historyTracks: this.history.length,
      },
      "Session coordinator created",
    );
  }

  async start() {
    const startedAt = Date.now();
    this.log.info({ event: "start_started" }, "Starting session");
    this.store.createSession({
      id: this.id,
      huddleId: this.room.huddleId,
      callId: this.room.huddleCallId,
      channelId: this.room.uiChannelId,
      threadTs: this.room.uiThreadTs,
      sourceChannelId: this.room.sourceChannelId,
      huddleThreadTs: this.room.huddleThreadTs,
      companionChannelId: this.room.companionChannelId,
      creatorId: this.room.huddleCreatorId,
      hostId: this.hostId,
      volume: this.volume,
      duckingMode: this.duckingMode,
    });
    if (this.channelDefaultsApplied) {
      this.store.setSession(this.id, {
        autoplay: this.autoplayMode,
        videoAutoplay: this.videoAutoplay,
        loopMode: this.loopMode,
        transitionMode: this.transitionMode,
        displayMode: this.displayMode,
        anchorEnabled: this.anchorEnabled,
        progressBar: this.progressBar,
      });
      this.setPermissions(this.allowed);
      // Media joined with the configured volume and ducking, and its own
      // display and transition modes, before the defaults were known.
      this.sendMediaSettings();
    }
    this.uiTs = await this.post(
      this.room.uiChannelId,
      this.room.uiThreadTs,
      "HuddleFM player",
      this.blocks(),
    );
    this.store.setUi(this.id, this.uiTs, this.revision);
    await Promise.all(
      [...this.participants].map((userId) => this.promptScrobbling(userId)),
    );
    this.prefetchRecommendations();
    this.audit.record("session.started", this.hostId, {
      sessionId: this.id,
      huddleId: this.room.huddleId,
      channelId: this.room.uiChannelId,
    });
    this.refreshIdle();
    this.sessionChanged();
    this.log.info(
      { event: "started", durationMs: Date.now() - startedAt },
      "Session started",
    );
  }

  async resume(actorId?: string) {
    const startedAt = Date.now();
    this.log.info({ event: "resume_started" }, "Resuming session");
    // The player names who added each song; asked now, beside the checks
    // below, so the first song does not wait on it.
    for (const entry of [this.current, ...this.queue])
      if (
        entry?.requesterId &&
        !entry.automatic &&
        entry.requesterId !== this.botUserId
      )
        void this.slack.userName(entry.requesterId);
    const missingEntries = (
      await Promise.all(
        [this.current, ...this.queue].map(async (entry) =>
          entry &&
          !(entry.filePath && (await Bun.file(entry.filePath).exists()))
            ? entry
            : undefined,
        ),
      )
    ).filter((entry): entry is Entry => Boolean(entry));
    if (this.current && missingEntries.includes(this.current)) {
      // A stream is fetched again, and a Jellyfin item or a video goes on
      // from where it was; anything else that had to be prepared again
      // starts over.
      if (
        parseJellyfinSource(this.current.sourceId) ||
        (this.videoMode &&
          !this.current.live &&
          (this.current.form === "video" ||
            this.current.form === "music_video"))
      )
        this.current.startAt = this.playbackSeconds;
      this.current.status = "preparing";
      this.queue.unshift(this.current);
      this.interrupted = this.current;
      this.current = undefined;
    }
    for (const entry of missingEntries) {
      entry.status = "preparing";
      entry.filePath = undefined;
      this.store.setTrack(entry.id, { status: "preparing", filePath: null });
    }
    this.store.activateSession(this.id, this.state);
    this.audit.record("session.resumed", actorId, {
      sessionId: this.id,
      huddleId: this.room.huddleId,
    });
    this.sessionChanged();
    this.sendMediaSettings();
    this.prefetchRecommendations();
    if (!this.current) await this.startNext();
    else {
      // Listeners were already asked about this track before the restart,
      // and that prompt still answers for it.
      this.startScrobbling(this.current, this.playbackSeconds, false);
      await this.sendCurrent(this.current);
      await this.render();
      this.refreshIdle();
      this.scheduleAutoplay();
    }
    this.syncForms();
    void this.releaseHistory();
    for (const entry of missingEntries) void this.prepareRestored(entry);
    this.log.info(
      {
        event: "resumed",
        state: this.state,
        missingTracks: missingEntries.length,
        durationMs: Date.now() - startedAt,
      },
      "Session resumed",
    );
  }

  private applyChannelDefaults(defaults: ChannelDefaults) {
    this.volume = defaults.volume ?? this.volume;
    this.autoplayMode = defaults.autoplay ?? this.autoplayMode;
    this.videoAutoplay = defaults.videoAutoplay ?? this.videoAutoplay;
    this.loopMode = defaults.loopMode ?? this.loopMode;
    this.displayMode = defaults.displayMode ?? this.displayMode;
    this.transitionMode = defaults.transitionMode ?? this.transitionMode;
    this.duckingMode = defaults.duckingMode ?? this.duckingMode;
    this.anchorEnabled = defaults.anchorEnabled ?? this.anchorEnabled;
    this.progressBar = defaults.progressBar ?? this.progressBar;
    if (defaults.permissions) this.allowed = new Set(defaults.permissions);
    this.channelDefaultsApplied = true;
    this.log.info(
      { event: "channel_defaults_applied", defaults },
      "Session started with the channel's saved settings",
    );
  }

  /** Whether the session is in video mode. */
  get videoMode() {
    return this.mediaMode === "video";
  }

  // Video mode stops applying the music settings without changing them: no
  // lyrics, no crossfades, and no ducking under the conversation.
  private mediaDisplayMode(): DisplayMode {
    return this.videoMode ? "default" : this.displayMode;
  }

  private sendMediaSettings() {
    this.sendMedia({ type: "volume", value: this.volume });
    this.sendMedia({ type: "display_mode", mode: this.mediaDisplayMode() });
    this.sendMedia({
      type: "transition_mode",
      mode: this.videoMode ? "none" : this.transitionMode,
    });
    this.sendMedia({
      type: "ducking_mode",
      mode: this.videoMode ? "off" : this.duckingMode,
    });
    this.sendMedia({ type: "captions", on: this.captions });
    this.sendMedia({ type: "progress_bar", on: this.progressBar });
    this.sendMedia({ type: "video_mode", on: this.videoMode });
  }

  // Picks the current song back up where it was, for a media backend that
  // has just joined: after a restart, or in place of one that failed.
  private async sendCurrent(entry: Entry) {
    this.sendMedia(await this.playMessage(entry));
    // A live stream picks up where it is now, not where it was.
    if (this.playbackSeconds && !entry.live)
      this.sendMedia({ type: "seek", seconds: this.playbackSeconds });
    if (this.state === "paused") this.sendMedia({ type: "pause" });
    this.jellyfinUi?.playing(
      entry,
      this.playbackSeconds,
      this.state === "paused",
      true,
    );
    this.sendLyrics(entry);
    this.syncPreloads();
  }

  // Lyrics for the playing song, which video mode does without.
  private sendLyrics(entry: Entry) {
    if (this.videoMode) return;
    if (entry.live) {
      this.sendMedia({ type: "lyrics_unavailable", entryId: entry.id });
      return;
    }
    void this.loadLyrics(entry).then((lyrics) => {
      if (this.current !== entry || this.videoMode) return;
      if (lyrics)
        this.sendMedia({ type: "lyrics", entryId: entry.id, ...lyrics });
      else this.sendMedia({ type: "lyrics_unavailable", entryId: entry.id });
    });
  }

  private async prepareRestored(entry: Entry) {
    const startedAt = Date.now();
    this.log.info(
      { event: "restored_track_preparation_started", entryId: entry.id },
      "Preparing restored track",
    );
    const controller = new AbortController();
    this.preparations.set(entry.id, controller);
    try {
      const media = await this.download(entry, controller);
      await this.enqueue(async () => {
        this.preparations.delete(entry.id);
        if (this.inactive() || !this.queue.includes(entry)) return;
        this.prepared(entry, media);
        if (!this.current) await this.startNext();
        else {
          this.queueRender();
          this.syncPreloads();
        }
        this.log.info(
          {
            event: "restored_track_prepared",
            entryId: entry.id,
            durationMs: Date.now() - startedAt,
          },
          "Restored track prepared",
        );
      });
    } catch (error) {
      this.logTrackFailure(
        {
          event: "restored_track_preparation_failed",
          entryId: entry.id,
          sourceId: entry.sourceId,
          durationMs: Date.now() - startedAt,
        },
        error,
        "Restored track preparation failed",
      );
      await this.enqueue(async () => {
        if (this.dropFailed(entry, error) && !this.current)
          await this.startNext();
      });
    }
  }

  async suggestions(interaction: Interaction): Promise<unknown[]> {
    const allowed = {
      songs: this.can(interaction.userId, "add"),
      bulk: this.can(interaction.userId, "add-bulk"),
    };
    if (!allowed.songs && !allowed.bulk) return [];
    const userId = interaction.userId;
    const jellyfin =
      this.jellyfinUi &&
      parseMetadata(interaction.metadata).source === "jellyfin";
    // Each user's results are their own: picking one uses it up.
    const key = JSON.stringify([
      userId,
      interaction.value,
      allowed,
      this.videoMode,
    ]);
    const cached = () => {
      const hit = jellyfin ? undefined : this.searchCache.get(key);
      return hit && hit.expiresAt > Date.now() ? hit.options : undefined;
    };
    // Slack sends a request per keystroke. A user's search starts at once
    // when none of theirs is running; one typed while it runs waits for it
    // to finish, but never longer than the pause searches always used to
    // wait, and only the newest of those is searched, so the results match
    // what the user finished typing. Slack shows only the newest answer, so
    // the ones passed over answer with nothing.
    const generation = (this.lastSearch.get(userId) ?? 0) + 1;
    this.lastSearch.set(userId, generation);
    const known = cached();
    if (known) return known;
    const running = this.searches.get(userId);
    if (running)
      await Promise.race([
        running.catch(() => {}),
        Bun.sleep(searchDebounceMs),
      ]);
    if (this.lastSearch.get(userId) !== generation) return [];
    const ready = cached();
    if (ready) return ready;
    const search: Promise<SearchOption[]> = jellyfin
      ? this.jellyfinUi!.search(userId, interaction.value)
      : this.tracks.suggestions(interaction.value, allowed, this.videoMode);
    this.searches.set(userId, search);
    try {
      const options = await search;
      if (!jellyfin) this.cacheSearch(key, options);
      return options;
    } finally {
      if (this.searches.get(userId) === search) this.searches.delete(userId);
    }
  }

  // Keeps a search's results a short while, for the same words typed again,
  // as when deleting back to them.
  private cacheSearch(key: string, options: SearchOption[]) {
    this.searchCache.delete(key);
    this.searchCache.set(key, {
      options,
      expiresAt: Date.now() + searchCacheMs,
    });
    for (const [stale, { expiresAt }] of this.searchCache)
      if (this.searchCache.size > searchCacheSize || expiresAt <= Date.now())
        this.searchCache.delete(stale);
  }

  handles(interaction: Interaction) {
    if (
      interaction.channelId === this.room.uiChannelId &&
      interaction.messageTs === this.uiTs
    )
      return true;
    if (interaction.value === this.id) return true;
    if (this.promptedTrackId(interaction.value)) return true;
    const action = parseIntegrationActionValue(interaction.value);
    if (action?.sessionId === this.id) return true;
    return parseMetadata(interaction.metadata).sessionId === this.id;
  }

  // The actions that open a dialog, which only read the session.
  private dialogOpeners(
    interaction: Interaction,
    loading?: { id: string; hash?: string },
  ): Record<string, () => Promise<void>> {
    return {
      open_add_to_queue: () => this.addModal(interaction),
      open_load_session: () => this.loadModal(interaction),
      open_jump_to: () => this.jumpToModal(interaction),
      queue_move_to_position: () => this.queuePositionModal(interaction),
      view_full_queue: () => this.queueModal(interaction),
      open_settings: () => this.settingsModal(interaction, loading),
      open_end_session: () => this.endModal(interaction),
      connect_lastfm: () => this.lastFmModal(interaction),
      open_listenbrainz_token: () => this.listenBrainzTokenModal(interaction),
      open_your_data: () => this.openYourData(interaction),
    };
  }

  // Whether the user is neither in the huddle nor allowed in from outside.
  private outsider(interaction: Interaction, ending: boolean) {
    return (
      !this.isParticipantOrManager(interaction.userId) &&
      !(ending && this.canEndFromOutside(interaction.userId))
    );
  }

  // Whether the click came from a player message since replaced.
  private stalePlayer(interaction: Interaction) {
    return Boolean(
      interaction.messageTs &&
      interaction.messageTs !== this.uiTs &&
      !offPlayerActions.has(interaction.actionId),
    );
  }

  async action(interaction: Interaction) {
    this.scrobbling?.syncAnalyticsUser(interaction.userId);
    const ending = this.endingAction(interaction);
    // Settings opens with a trigger ID that expires after three seconds, which
    // a role lookup can outlast. When one has to ask Slack, a loading view
    // opens first and Settings replaces it, as updates need no trigger ID.
    const loading =
      interaction.actionId === "open_settings" &&
      this.roleLookups(interaction.userId, ending, true).length
        ? await this.openSettingsLoading(interaction)
        : undefined;
    await this.primeRoles(
      interaction.userId,
      ending,
      channelRoleActions.has(interaction.actionId),
    );
    this.log.debug(
      {
        event: "action_received",
        actionId: interaction.actionId,
        interactionType: interaction.type,
        userId: interaction.userId,
      },
      "Session action received",
    );
    if (interaction.actionId === "add_track_to_queue")
      return this.add(interaction);
    // Jellyfin's dialogs wait on far servers, so they run beside the
    // session's queue of actions rather than in it.
    if (this.jellyfinUi?.handles(interaction))
      return this.jellyfinUi.action(interaction);
    if (interaction.actionId === "bulk_add_to_queue")
      return this.bulkAddLinks(interaction);
    if (
      interaction.type === "view_submission" &&
      interaction.actionId === "load_session_save"
    )
      return this.loadSubmission(interaction);
    // A dialog opens with a trigger ID that expires three seconds after the
    // click, so it opens from the session as it is now rather than waiting
    // behind other actions; what is done in it goes through the queue.
    const dialog =
      interaction.type === "block_actions"
        ? this.dialogOpeners(interaction, loading)[interaction.actionId]
        : undefined;
    if (dialog) {
      if (this.outsider(interaction, ending))
        return this.rejectNonParticipant(interaction, loading);
      if (this.stalePlayer(interaction))
        return this.settingsNotice(
          interaction.userId,
          "That player is stale; use the newest one.",
          loading,
        );
      return dialog();
    }
    const currentId = this.current?.id;
    return this.enqueue(async () => {
      if (interaction.type === "view_closed") {
        if (interaction.viewId) this.queueViews.delete(interaction.viewId);
        if (!this.queueViews.size) {
          clearTimeout(this.queueModalTimer);
          this.queueModalTimer = undefined;
        }
        return;
      }
      if (this.isIntegrationAction(interaction.actionId))
        return this.integrationAction(interaction);
      if (this.outsider(interaction, ending))
        return this.rejectNonParticipant(interaction, loading);
      if (interaction.type === "view_submission") {
        if (interaction.actionId === "move_queue_track")
          return this.queuePositionSubmission(interaction);
        if (interaction.actionId === "jump_to_time")
          return this.jumpToSubmission(interaction);
        if (interaction.actionId === "end_session_confirm")
          return this.endSubmission(interaction);
        if (interaction.actionId === "listenbrainz_token")
          return this.listenBrainzTokenSubmission(interaction);
        if (interaction.actionId === jellyfinTracksCallback)
          return this.jellyfinTracksSubmission(interaction);
        return this.settingsSubmission(interaction);
      }
      if (this.stalePlayer(interaction))
        return this.settingsNotice(
          interaction.userId,
          "That player is stale; use the newest one.",
          loading,
        );
      const handlers: Record<string, () => Promise<void> | void> = {
        open_bulk_add: () => this.openBulkAdd(interaction),
        remove_queue_track: () => this.remove(interaction),
        previous_track: () => this.previous(interaction),
        toggle_playback: () => this.toggle(interaction),
        play_something: () => this.playSomething(interaction),
        next_track: () => this.next(interaction, currentId),
        seek_back: () => this.seek(interaction, -10),
        seek_forward: () => this.seek(interaction, 10),
        toggle_captions: () => this.toggleCaptions(interaction),
        // The add dialogs' search and links, which say what was picked or
        // pasted in music mode; nothing else sends these.
        selection: () => this.videoLinkHint(interaction),
        text: () => this.videoLinkHint(interaction),
        add_with_video_mode: () => this.addWithVideoMode(interaction),
        add_source: () => this.switchAddSource(interaction),
        approve_video_request: () => this.answerVideoRequest(interaction, true),
        decline_video_request: () =>
          this.answerVideoRequest(interaction, false),
        volume_down: () => this.changeVolume(interaction, -0.05),
        volume_up: () => this.changeVolume(interaction, 0.05),
        like_track: () => this.like(interaction),
        save_track: () => this.save(interaction),
        queue_move_up: () => this.reorder(interaction, -1),
        queue_move_down: () => this.reorder(interaction, 1),
        queue_play_next: () => this.playNext(interaction),
        queue_keep_autoplay: () => this.keepAutoplay(interaction),
        shuffle_queue: () => this.shuffleQueue(interaction),
        clear_queue: () => this.clear(interaction),
        end_session: async () => {
          await this.end(interaction.userId, "ended by host");
        },
        save_channel_defaults: () => this.saveChannelDefaults(interaction),
        clear_channel_defaults: () => this.clearChannelDefaults(interaction),
        claim_host: () => this.claimHost(interaction),
        continue_lastfm: () => this.continueLastFm(interaction),
        disconnect_lastfm: () => this.disconnectLastFm(interaction),
        disconnect_listenbrainz: () => this.disconnectListenBrainz(interaction),
        delete_own_save: () => this.deleteYourData(interaction, "own_save"),
        delete_my_channel_save: () =>
          this.deleteYourData(interaction, "channel_save"),
        delete_data_added: () => this.deleteYourData(interaction, "added"),
        delete_data_plays: () => this.deleteYourData(interaction, "plays"),
        delete_data_likes: () => this.deleteYourData(interaction, "likes"),
        delete_data_skips: () => this.deleteYourData(interaction, "skips"),
        delete_data_scrobbles: () =>
          this.deleteYourData(interaction, "scrobbles"),
        delete_all_data: () => this.deleteYourData(interaction, "all"),
        toggle_session_scrobbling: () =>
          this.toggleSessionScrobbling(interaction),
        enable_session_scrobbling: () =>
          this.enableSessionScrobbling(interaction),
        scrobble_track: () => this.scrobbleTrack(interaction),
        delete_channel_save: () => this.deleteChannelSave(interaction),
        apply_permission_preset: () => this.applyPermissionPreset(interaction),
        ...Object.fromEntries(
          settingsTabs.map((tab) => [
            `${settingsTabActionPrefix}${tab}`,
            () => this.switchSettingsTab(interaction),
          ]),
        ),
        integration_grants_prev: () => this.integrationGrantsPage(interaction),
        integration_grants_next: () => this.integrationGrantsPage(interaction),
      };
      await handlers[interaction.actionId]?.();
    });
  }

  mediaEvent(
    type: string,
    details?: {
      entryId?: string;
      seconds?: number;
      count?: number;
      reason?: string;
    },
  ) {
    if (this.state === "suspended") return;
    if (
      type === "playback_position" &&
      details &&
      details.entryId === this.current?.id &&
      typeof details.seconds === "number" &&
      Number.isFinite(details.seconds)
    ) {
      this.countTime(details.seconds - this.playbackSeconds);
      // A report away from where clients count to, after a seek it clamped
      // say, is sent on to them.
      const expected = this.playbackPosition();
      this.playbackSeconds = details.seconds;
      this.positionReport = { seconds: details.seconds, at: Date.now() };
      if (Math.abs(expected - details.seconds) > 1.5) this.plugins.changed();
      this.playbackScrobbling?.position(details.seconds);
      const current = this.current;
      if (current) {
        this.jellyfinUi?.playing(
          current,
          details.seconds,
          this.state === "paused",
        );
        // A stream that has played on well since it was picked up again
        // gets its retries back, for the next drop.
        if (
          current.streamRetries &&
          Date.now() - (current.streamRetriedAt ?? 0) > streamRecoveredMs
        )
          current.streamRetries = 0;
      }
      this.store.setSession(this.id, {
        playbackSeconds: details.seconds,
        listenedSeconds: this.listenedSeconds,
        watchedSeconds: this.watchedSeconds,
      });
      this.log.trace(
        {
          event: "playback_position",
          entryId: details.entryId,
          seconds: details.seconds,
        },
        "Playback position updated",
      );
      return;
    }
    if (type === "content_shares") {
      // Other people's screen shares, which video mode needs a slot beside.
      this.contentShares = Math.max(0, Number(details?.count) || 0);
      return;
    }
    this.log.info(
      { event: "media_event", mediaEvent: type, entryId: details?.entryId },
      "Media event received",
    );
    if (type === "share_failed" || type === "video_failed")
      return this.enqueue(() => this.videoFailed(type, details?.entryId));
    if (type === "track_error" || type === "stalled")
      return this.enqueue(() => this.streamFailed(type, details?.entryId));
    if (type === "track_ended" || type === "transition")
      return this.enqueue(() => this.advance(type, details?.entryId));
    if (type === "fatal" || type === "ended")
      return this.enqueue(() => this.end(undefined, "media connection ended"));
  }

  threadActivity(userId: string) {
    if (
      userId === this.botUserId ||
      this.isExcluded(userId) ||
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

  agentStatus(userId: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    if (!this.canUsePlayer(userId))
      return {
        ok: false as const,
        error: "Join the huddle before using the player.",
      };
    const host = this.hostId === userId || this.isManager(userId);
    const grant = this.integrations.get(userId);
    const scrobbling = this.scrobbling?.settings(userId, this.id);
    const current = this.current;
    const showing =
      this.videoMode &&
      (current?.form === "video" || current?.form === "music_video");
    return {
      ok: true as const,
      mode: this.mediaMode,
      state: this.state,
      volumePercent: Math.round(this.volume * 100),
      playbackSeconds: this.playbackSeconds,
      // Video mode leaves the music's own settings out, as Settings does.
      ...(this.videoMode
        ? {
            captions: this.captions,
            progressBar: this.progressBar,
            autoplay: this.videoAutoplay ? "related videos" : "off",
            videoRequest: "not needed, video mode is on",
          }
        : {
            displayMode: this.displayMode,
            autoplay: this.autoplayMode,
            transitionMode: this.transitionMode,
            duckingMode: this.duckingMode,
            videoRequest: this.videoRequest
              ? "waiting for the host"
              : Date.now() < this.videoRequestsPausedUntil
                ? "paused: the host said not now"
                : "none",
          }),
      loopMode: this.loopMode,
      anchorEnabled: this.anchorEnabled,
      hostId: this.hostId ?? null,
      youAreHost: host,
      yourCapabilities: host
        ? "all (host/manager)"
        : grant
          ? [...grant.permissions]
          : [...this.allowed],
      nowPlaying: current
        ? {
            id: current.id,
            title: current.title,
            artist: current.artist,
            album: current.album,
            kind: trackKind(current),
            playingAs: showing ? "video" : "audio",
            ...(current.live ? { live: true } : {}),
            durationSeconds: current.duration,
            status: current.status,
            automatic: Boolean(current.automatic),
            addedBy: current.requesterId,
            ...(showing && current.chapters?.length
              ? {
                  chapters: current.chapters.map((chapter) => ({
                    title: chapter.title,
                    startSeconds: chapter.start,
                  })),
                }
              : {}),
          }
        : null,
      queue: this.queue.map((track, index) => ({
        position: index + 1,
        id: track.id,
        title: track.title,
        artist: track.artist,
        kind: trackKind(track),
        ...(track.live ? { live: true } : {}),
        status: track.status,
        automatic: Boolean(track.automatic),
        addedBy: track.requesterId,
      })),
      queueLimit: this.config.queueLimit,
      scrobbling: scrobbling
        ? {
            configured: scrobbling.configured,
            sessionEnabled: Boolean(scrobbling.sessionEnabled),
            mode: scrobbling.mode,
          }
        : { available: false as const },
    };
  }

  async agentSearch(userId: string, query: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    if (!this.canUsePlayer(userId))
      return {
        ok: false as const,
        error: "Join the huddle before using the player.",
      };
    const allowed = {
      songs: this.can(userId, "add"),
      bulk: this.can(userId, "add-bulk"),
    };
    if (!allowed.songs && !allowed.bulk)
      return {
        ok: false as const,
        error: "You do not have permission to add tracks.",
      };
    try {
      const options = await this.tracks.suggestions(
        query,
        allowed,
        this.videoMode,
      );
      throwIfAborted(signal);
      return {
        ok: true as const,
        results: options.map((option) => ({
          label: option.text.text,
          reference: option.value,
        })),
      };
    } catch (error) {
      throwIfAborted(signal);
      return { ok: false as const, error: message(error) };
    }
  }

  async agentAdd(
    userId: string,
    reference: string,
    signal?: AbortSignal,
    options: { awaitPreparation?: boolean; withVideoMode?: boolean } = {},
  ) {
    throwIfAborted(signal);
    if (!this.canUsePlayer(userId))
      return {
        ok: false as const,
        error: "Join the huddle before using the player.",
      };
    const capability = reference.startsWith("bulkref_") ? "add-bulk" : "add";
    if (!this.can(userId, capability))
      return {
        ok: false as const,
        error: "You do not have permission to add that.",
      };
    if (this.inactive())
      return { ok: false as const, error: "This session is not active." };
    // Like the add dialog's button: the host switches to video mode first,
    // and anyone else asks them to once the track is queued.
    let askHost = false;
    if (options.withVideoMode && !this.videoMode) {
      if (this.settingsAdmin(userId)) {
        const blocked = await this.enqueue(() =>
          this.switchMediaMode(userId, "video", "agent"),
        );
        if (blocked) return { ok: false as const, error: blocked };
      } else if (!this.hostId)
        return {
          ok: false as const,
          error: "There is no host to ask for video mode.",
        };
      else if (Date.now() < this.videoRequestsPausedUntil)
        return {
          ok: false as const,
          error: "The host said not now; nobody can ask again for a while.",
        };
      else askHost = true;
    }
    let selection: TrackMetadata | TrackMetadata[];
    try {
      selection = await this.tracks.resolve(reference, this.videoMode);
    } catch (error) {
      try {
        selection = await this.tracks.resolveUrl(reference, this.videoMode);
      } catch (urlError) {
        return { ok: false as const, error: message(urlError) };
      }
    }
    throwIfAborted(signal);
    const tracks = Array.isArray(selection) ? selection : [selection];
    const needed = Array.isArray(selection) ? "add-bulk" : "add";
    if (!this.can(userId, needed))
      return {
        ok: false as const,
        error: "You do not have permission to add that.",
      };
    const committed = await this.enqueue(async () => {
      throwIfAborted(signal);
      if (this.inactive() || !this.can(userId, needed)) return;
      const heldAutoplay = this.takeQueuedAutoplay();
      let pending: { entry: Entry; controller: AbortController }[] = [];
      try {
        // Yield so an abort can land after autoplay is detached and before we
        // commit manual queue entries (same window as removeQueuedAutoplay's awaits).
        await Promise.resolve();
        throwIfAborted(signal);
        const fit = this.fitBatchToQueue(tracks);
        if ("error" in fit) {
          this.restoreQueuedAutoplay(heldAutoplay);
          return { error: fit.error };
        }
        pending = this.stageEntries(userId, fit.items);
        await this.render();
        this.queueChanged();
        throwIfAborted(signal);
        if (pending.length) void this.recommendations?.refreshUser(userId);
        return { pending, heldAutoplay, omitted: fit.omitted };
      } catch (error) {
        for (const { entry, controller } of pending) {
          controller.abort();
          this.preparations.delete(entry.id);
          this.queue = this.queue.filter((item) => item !== entry);
          this.store.removeTrack(entry.id);
        }
        this.restoreQueuedAutoplay(heldAutoplay);
        if (pending.length) {
          this.queueChanged();
          await this.render();
        }
        throw error;
      }
    });
    if (!committed)
      return { ok: false as const, error: "Could not add tracks." };
    if ("error" in committed)
      return { ok: false as const, error: committed.error };
    if (askHost)
      await this.enqueue(() =>
        this.requestVideoMode(userId, committed.pending[0]?.entry.title),
      );
    const abortPreparations = () => {
      for (const { controller } of committed.pending) controller.abort();
    };
    const rollback = async () => {
      abortPreparations();
      await this.rollbackAgentAdd(committed.pending, committed.heldAutoplay);
    };
    if (signal?.aborted) {
      await rollback();
      throwIfAborted(signal);
    }
    signal?.addEventListener("abort", abortPreparations, { once: true });
    const settled = this.settleAgentAdd(
      committed,
      signal,
      abortPreparations,
      rollback,
    );
    if (options.awaitPreparation !== false) return settled;
    // Downloads can take minutes, so a caller that opts out gets its answer
    // once the songs are queued; a song that later fails to prepare leaves the
    // queue with a `queue.removed` event instead.
    void settled.catch((error) =>
      this.log.warn(
        { event: "agent_add_settle_failed", userId, err: error },
        "Could not finish adding tracks",
      ),
    );
    return {
      ok: true as const,
      added: committed.pending.map(({ entry }) => ({
        id: entry.id,
        title: entry.title,
        artist: entry.artist,
      })),
      ...(committed.omitted ? { omitted: committed.omitted } : {}),
    };
  }

  private async settleAgentAdd(
    committed: {
      pending: { entry: Entry; controller: AbortController }[];
      heldAutoplay: Entry[];
      omitted?: number;
    },
    signal: AbortSignal | undefined,
    abortPreparations: () => void,
    rollback: () => Promise<void>,
  ) {
    try {
      await Promise.all(
        committed.pending.map(({ entry, controller }) =>
          this.prepareManual(entry, controller),
        ),
      );
      throwIfAborted(signal);
      return await this.enqueue(async () => {
        const remaining = committed.pending
          .map(({ entry }) => entry)
          .filter((entry) => this.queue.includes(entry));
        if (!remaining.length) {
          this.restoreQueuedAutoplay(committed.heldAutoplay);
          await this.render();
          return {
            ok: false as const,
            error: "Could not prepare that track.",
          };
        }
        await this.destroyQueuedAutoplay(committed.heldAutoplay);
        return {
          ok: true as const,
          added: remaining.map((track) => ({
            title: track.title,
            artist: track.artist,
          })),
          ...(committed.omitted ? { omitted: committed.omitted } : {}),
        };
      });
    } catch (error) {
      await rollback();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortPreparations);
    }
  }

  async agentRemove(userId: string, trackId: string, signal?: AbortSignal) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (!this.canUsePlayer(userId))
        return {
          ok: false as const,
          error: "Join the huddle before using the player.",
        };
      const entry = this.queue.find((track) => track.id === trackId);
      if (!entry)
        return { ok: false as const, error: "That track is not in the queue." };
      if (!this.canRemove(userId, entry))
        return {
          ok: false as const,
          error: "You do not have permission for that.",
        };
      await this.removeEntry(userId, entry);
      return {
        ok: true as const,
        removed: { title: entry.title, artist: entry.artist },
      };
    });
  }

  async agentMove(
    userId: string,
    trackId: string,
    options: {
      direction?: "up" | "down";
      playNext?: boolean;
      position?: number;
    },
    signal?: AbortSignal,
  ) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (!this.can(userId, "manage-queue")) return this.denied(userId);
      const index = this.queue.findIndex((track) => track.id === trackId);
      if (index < 0)
        return { ok: false as const, error: "That track is not in the queue." };
      let target = index;
      if (options.playNext) target = 0;
      else if (options.position !== undefined) {
        if (
          !Number.isSafeInteger(options.position) ||
          options.position < 1 ||
          options.position > this.queue.length
        )
          return {
            ok: false as const,
            error: `Position must be between 1 and ${this.queue.length}.`,
          };
        target = options.position - 1;
      } else if (options.direction === "up") target = index - 1;
      else if (options.direction === "down") target = index + 1;
      else
        return {
          ok: false as const,
          error: "Provide direction, playNext, or position.",
        };
      if (target < 0 || target >= this.queue.length)
        return { ok: false as const, error: "Cannot move further that way." };
      if (target === index)
        return {
          ok: true as const,
          position: index + 1,
          title: this.queue[index]!.title,
        };
      const entry = await this.moveEntry(
        userId,
        index,
        target,
        Boolean(options.playNext),
      );
      return {
        ok: true as const,
        position: target + 1,
        title: entry.title,
        artist: entry.artist,
      };
    });
  }

  async agentShuffle(userId: string, signal?: AbortSignal) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (!this.can(userId, "manage-queue")) return this.denied(userId);
      const shuffled = await this.applyShuffle(userId);
      if (!shuffled)
        return {
          ok: false as const,
          error: "There are not enough queued songs to shuffle.",
        };
      return { ok: true as const, shuffled };
    });
  }

  async agentClear(userId: string, signal?: AbortSignal) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (!this.can(userId, "clear")) return this.denied(userId);
      return { ok: true as const, cleared: await this.clearQueue(userId) };
    });
  }

  async agentSkip(userId: string, signal?: AbortSignal) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (!this.can(userId, "skip")) return this.denied(userId);
      if (!this.current)
        return { ok: false as const, error: "Nothing is playing." };
      const skipped = await this.skipCurrent(userId);
      return {
        ok: true as const,
        skipped: { title: skipped.title, artist: skipped.artist },
        nowPlaying: this.current
          ? { title: this.current.title, artist: this.current.artist }
          : null,
      };
    });
  }

  async agentPrevious(userId: string, signal?: AbortSignal) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (!this.can(userId, "skip")) return this.denied(userId);
      const result = await this.goBack(userId);
      if (!result) return { ok: false as const, error: "Nothing is playing." };
      if (result.restarted)
        return {
          ok: true as const,
          restarted: true,
          title: result.restarted.title,
          artist: result.restarted.artist,
        };
      const playing = this.current ?? result.prior;
      return {
        ok: true as const,
        nowPlaying: { title: playing.title, artist: playing.artist },
      };
    });
  }

  async agentToggle(userId: string, signal?: AbortSignal) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      return this.applyPause(
        userId,
        this.state === "paused" ? "playing" : "paused",
      );
    });
  }

  async agentPause(userId: string, signal?: AbortSignal) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      return this.applyPause(userId, "paused");
    });
  }

  async agentResume(userId: string, signal?: AbortSignal) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      return this.applyPause(userId, "playing");
    });
  }

  private async applyPause(userId: string, next: "paused" | "playing") {
    if (!this.can(userId, "pause")) return this.denied(userId);
    if (!this.current)
      return { ok: false as const, error: "Nothing is playing." };
    if (this.state !== next) await this.setPlayback(userId, next);
    return { ok: true as const, state: this.state };
  }

  async agentSeek(userId: string, seconds: number, signal?: AbortSignal) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (!this.can(userId, "skip")) return this.denied(userId);
      if (!this.current)
        return { ok: false as const, error: "Nothing is playing." };
      if (this.current.live)
        return {
          ok: false as const,
          error: "A live stream can't be seeked; it plays where it is now.",
        };
      if (!Number.isFinite(seconds))
        return { ok: false as const, error: "Seconds must be a number." };
      this.seekBy(userId, seconds);
      return {
        ok: true as const,
        playbackSeconds: this.playbackSeconds,
      };
    });
  }

  async agentJumpTo(
    userId: string,
    target: { position?: number; chapter?: string },
    signal?: AbortSignal,
  ) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (!this.can(userId, "skip")) return this.denied(userId);
      const current = this.current;
      if (!current) return { ok: false as const, error: "Nothing is playing." };
      if (current.live)
        return {
          ok: false as const,
          error: "A live stream can't be seeked; it plays where it is now.",
        };
      let seconds = target.position;
      if (target.chapter !== undefined) {
        const wanted = normalizeToken(target.chapter);
        const chapters = current.filePath
          ? await readChapters(current.filePath)
          : (current.chapters ?? []);
        const chapter =
          chapters.find((item) => normalizeToken(item.title) === wanted) ??
          chapters.find((item) => normalizeToken(item.title).includes(wanted));
        if (!chapter)
          return {
            ok: false as const,
            error: chapters.length
              ? "No chapter by that name."
              : "This has no chapters.",
          };
        seconds = chapter.start;
      }
      if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
        return { ok: false as const, error: "Give a time or a chapter." };
      if (current.duration && seconds >= current.duration)
        return {
          ok: false as const,
          error: `That is past the end; it runs ${formatClock(current.duration)}.`,
        };
      const previous = this.playbackSeconds;
      this.playbackSeconds = seconds;
      this.sendMedia({ type: "seek", seconds });
      this.plugins.changed();
      this.audit.record("playback.seeked", userId, {
        sessionId: this.id,
        trackId: current.id,
        previous,
        seconds,
      });
      this.store.incrementUsage(seconds >= previous ? "forward" : "back");
      return { ok: true as const, playbackSeconds: seconds };
    });
  }

  async agentSetCaptions(
    userId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (!this.can(userId, "pause")) return this.denied(userId);
      if (!this.videoMode)
        return { ok: false as const, error: "Captions are for video mode." };
      if (enabled !== this.captions) {
        this.captions = enabled;
        this.store.setSession(this.id, { captions: enabled });
        this.sendMedia({ type: "captions", on: enabled });
        this.audit.record("playback.captions", userId, {
          sessionId: this.id,
          captions: enabled,
        });
        await this.render();
      }
      const current = this.current;
      const available = Boolean(
        current?.filePath &&
        (current.form === "video" || current.form === "music_video") &&
        (await Bun.file(captionsPath(current.filePath)).exists()),
      );
      return {
        ok: true as const,
        captions: this.captions,
        ...(enabled && current && !available
          ? { note: "This video has no captions." }
          : {}),
      };
    });
  }

  async agentSetVolume(userId: string, percent: number, signal?: AbortSignal) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (!this.can(userId, "volume")) return this.denied(userId);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100)
        return {
          ok: false as const,
          error: "Volume must be between 0 and 100.",
        };
      await this.setVolume(userId, Math.round(percent * 100) / 10_000);
      return {
        ok: true as const,
        volumePercent: Math.round(this.volume * 100),
      };
    });
  }

  async agentUpdateSettings(
    userId: string,
    patch: {
      displayMode?: DisplayMode;
      autoplay?: boolean;
      autoplayMode?: AutoplayMode;
      loopMode?: LoopMode;
      transitionMode?: TransitionMode;
      duckingMode?: DuckingMode;
      anchorEnabled?: boolean;
      progressBar?: boolean;
      videoAutoplay?: boolean;
      permissionPreset?: keyof typeof permissionPresets;
      // Exactly what everyone else may do, as Settings' checkboxes say it.
      permissions?: string[];
      hostUserId?: string;
      mode?: MediaMode;
    },
    signal?: AbortSignal,
  ) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      // it may have ended while this waited its turn
      if (this.inactive())
        return { ok: false as const, error: "This session is not active." };
      if (!this.canUsePlayer(userId) && !this.settingsAdmin(userId))
        return {
          ok: false as const,
          error: "Join the huddle before using the player.",
        };
      if (patch.mode !== undefined && !mediaModes.includes(patch.mode))
        return { ok: false as const, error: "Invalid mode." };
      if (patch.mode !== undefined && !this.settingsAdmin(userId))
        return {
          ok: false as const,
          error: "Only the host can switch between music and video mode.",
        };
      // Autoplay in video mode is its related videos, on or off, including
      // when this switches to video mode.
      const video =
        (this.videoMode && patch.mode !== "music") || patch.mode === "video";
      if (
        this.videoMode &&
        patch.mode !== "music" &&
        (patch.displayMode !== undefined ||
          patch.autoplayMode !== undefined ||
          patch.transitionMode !== undefined ||
          patch.duckingMode !== undefined)
      )
        return { ok: false as const, error: "That’s paused in video mode." };
      const before = this.settingsSnapshot();
      if (
        (patch.hostUserId !== undefined ||
          patch.permissionPreset !== undefined ||
          patch.permissions !== undefined) &&
        !this.settingsAdmin(userId)
      )
        return {
          ok: false as const,
          error: "Only the host can change permissions or transfer host.",
        };
      if (
        (patch.displayMode !== undefined ||
          patch.autoplay !== undefined ||
          patch.autoplayMode !== undefined ||
          patch.loopMode !== undefined ||
          patch.transitionMode !== undefined ||
          patch.duckingMode !== undefined ||
          patch.anchorEnabled !== undefined ||
          patch.progressBar !== undefined ||
          patch.videoAutoplay !== undefined) &&
        !this.can(userId, "configure-settings")
      )
        return {
          ok: false as const,
          error: "You do not have permission to change settings.",
        };
      if (
        patch.displayMode !== undefined &&
        !displayModes.includes(patch.displayMode)
      )
        return { ok: false as const, error: "Invalid display mode." };
      if (
        patch.transitionMode !== undefined &&
        !transitionModes.includes(patch.transitionMode)
      )
        return { ok: false as const, error: "Invalid transition mode." };
      if (
        patch.duckingMode !== undefined &&
        !duckingModes.includes(patch.duckingMode)
      )
        return { ok: false as const, error: "Invalid ducking mode." };
      if (patch.loopMode !== undefined && !loopModes.includes(patch.loopMode))
        return { ok: false as const, error: "Invalid loop mode." };
      if (
        patch.autoplayMode !== undefined &&
        !autoplayModes.includes(patch.autoplayMode)
      )
        return { ok: false as const, error: "Invalid autoplay mode." };
      const permissionPreset =
        patch.permissionPreset === undefined ||
        !Object.hasOwn(permissionPresets, patch.permissionPreset)
          ? undefined
          : permissionPresets[patch.permissionPreset];
      if (patch.permissionPreset !== undefined && !permissionPreset)
        return { ok: false as const, error: "Invalid permission preset." };
      if (patch.hostUserId !== undefined) {
        if (patch.hostUserId === this.botUserId)
          return {
            ok: false as const,
            error: "HuddleFM cannot be the host.",
          };
        if (!this.participants.has(patch.hostUserId))
          return {
            ok: false as const,
            error: "That user is not in this huddle.",
          };
      }
      // Back to music first, so the music settings asked for apply.
      if (patch.mode === "music") {
        const blocked = await this.switchMediaMode(userId, "music", "agent");
        if (blocked) return { ok: false as const, error: blocked };
      }
      const changed = await this.applySettings({
        ...patch,
        autoplayMode:
          patch.autoplayMode ??
          (patch.autoplay === undefined || video
            ? undefined
            : parseAutoplayMode(patch.autoplay)),
        videoAutoplay: video
          ? (patch.videoAutoplay ?? patch.autoplay)
          : undefined,
      });
      if (patch.mode === "video" && !this.videoMode) {
        const blocked = await this.switchMediaMode(userId, "video", "agent");
        if (blocked) return { ok: false as const, error: blocked };
        changed.push("mode=video");
        // Video's autoplay applies only once video mode is on.
        changed.push(
          ...(await this.applySettings({
            videoAutoplay: patch.videoAutoplay ?? patch.autoplay,
          })),
        );
      } else if (patch.mode === "music") changed.push("mode=music");
      if (permissionPreset) {
        this.setPermissions(permissionPreset);
        changed.push(`permissions=${patch.permissionPreset}`);
      } else if (patch.permissions) {
        const allowed = capabilities.filter((value) =>
          patch.permissions!.includes(value),
        );
        this.setPermissions(allowed);
        changed.push(`permissions=${allowed.join(",")}`);
      }
      if (patch.hostUserId !== undefined) {
        this.setHost(patch.hostUserId);
        changed.push(`hostId=${patch.hostUserId}`);
      }
      if (changed.length) {
        const changes = settingsChanges(before, this.settingsSnapshot());
        this.audit.record("settings.changed", userId, {
          sessionId: this.id,
          source: "agent",
          changed: changedSettings(changes),
          changes,
        });
        this.store.incrementUsage("settings");
        if (!before.anchorEnabled && this.anchorEnabled) await this.reanchor();
        else await this.render();
        this.scheduleAutoplay();
      }
      return {
        ok: true as const,
        changed,
        mode: this.mediaMode,
        displayMode: this.displayMode,
        autoplay: this.autoplayMode,
        videoAutoplay: this.videoAutoplay,
        loopMode: this.loopMode,
        transitionMode: this.transitionMode,
        duckingMode: this.duckingMode,
        anchorEnabled: this.anchorEnabled,
        hostId: this.hostId ?? null,
        permissions: [...this.allowed],
      };
    });
  }

  async agentClaimHost(userId: string, signal?: AbortSignal) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (this.hostId)
        return { ok: false as const, error: "Host already claimed." };
      if (userId === this.botUserId || !this.participants.has(userId))
        return {
          ok: false as const,
          error: "Join the huddle before taking over.",
        };
      await this.takeHost(userId);
      return { ok: true as const, hostId: userId };
    });
  }

  async agentEnd(userId: string, signal?: AbortSignal) {
    await this.primeRoles(userId, true);
    return this.enqueue(async () => {
      throwIfAborted(signal);
      if (!this.can(userId, "end-session"))
        return {
          ok: false as const,
          error: this.canUsePlayer(userId)
            ? "You do not have permission to end this session."
            : "Join the huddle before using the player.",
        };
      await this.end(userId, "ended by agent");
      return { ok: true as const, ended: true };
    });
  }

  agentSetSessionScrobbling(
    userId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal);
    if (!this.isParticipantOrManager(userId))
      return {
        ok: false as const,
        error: "Join the huddle before using the player.",
      };
    if (!this.scrobbling)
      return {
        ok: false as const,
        error: "Scrobbling is not available on this bot.",
      };
    const settings = this.scrobbling.settings(userId, this.id);
    if (!settings.configured)
      return {
        ok: false as const,
        error:
          "Connect Last.fm or ListenBrainz in Settings before toggling session scrobbling.",
      };
    if (settings.sessionEnabled === enabled)
      return { ok: true as const, sessionEnabled: enabled, unchanged: true };
    this.scrobbling.setSessionEnabled(this.id, userId, enabled);
    if (enabled) this.playbackScrobbling?.sessionEnabled(userId);
    return { ok: true as const, sessionEnabled: enabled };
  }

  /** A message from a client mod on the data channel. */
  dataMessage(details: unknown) {
    this.plugins.receive(details);
  }

  // The session as a `state` message carries it; see docs/data-channel.md.
  private pluginSnapshot() {
    const track = (entry: Entry) => ({
      id: entry.id,
      title: entry.title,
      artist: entry.artist,
      ...(entry.album ? { album: entry.album } : {}),
      // Only public artwork: a file's own is served on loopback.
      ...(entry.artwork?.startsWith("https://")
        ? { artwork: entry.artwork }
        : {}),
      ...(entry.duration ? { duration: entry.duration } : {}),
      kind: trackKind(entry),
      live: Boolean(entry.live),
      automatic: Boolean(entry.automatic),
      addedBy: entry.requesterId,
    });
    return {
      session: {
        id: this.id,
        mode: this.mediaMode,
        state: this.state,
        position: this.playbackPosition(),
        volume: Math.round(this.volume * 100),
        hostId: this.hostId ?? null,
        allowed: capabilities.filter((value) => this.allowed.has(value)),
        loopMode: this.loopMode,
        queueLimit: this.config.queueLimit,
        player: this.uiTs
          ? { channel: this.room.uiChannelId, ts: this.uiTs }
          : null,
      },
      nowPlaying: this.current ? track(this.current) : null,
      // The first of a long queue, so the state stays within its chunks.
      queue: this.queue.slice(0, pluginQueueMax).map((entry) => ({
        ...track(entry),
        status: entry.status,
      })),
      queueLength: this.queue.length,
      participants: [...this.participants].filter(
        (id) => id !== this.botUserId,
      ),
      // Every session and host setting; each client shows the ones its user
      // may change, by `requires`.
      settings: settingFields({
        access: { volume: true, configure: true, admin: true },
        session: this.sessionSettings(),
      }),
    };
  }

  /**
   * Where playback is now. Reports come every two seconds, so time since the
   * last one counts, unless the position has been set since, by a seek say.
   */
  private playbackPosition() {
    const report = this.positionReport;
    if (
      this.state !== "playing" ||
      !report ||
      report.seconds !== this.playbackSeconds
    )
      return this.playbackSeconds;
    const at = report.seconds + (Date.now() - report.at) / 1000;
    return Math.min(this.current?.duration ?? Infinity, at);
  }

  // What one user may do, and their own settings, as `you` carries them.
  private async pluginYou(userId: string) {
    await this.primeManager(userId);
    return {
      capabilities: capabilities.filter((value) => this.can(userId, value)),
      admin: this.settingsAdmin(userId),
      settings: this.scrobbling
        ? settingFields({
            access: { volume: false, configure: false, admin: false },
            session: this.sessionSettings(),
            user: this.scrobbling.settings(userId, this.id),
          })
        : [],
    };
  }

  /** A notice that says how something went, rather than that it failed. */
  private inform(user: string, text: string) {
    return this.notice(user, text, "info");
  }

  /**
   * Whether the work running now came over the huddle's data channel, from
   * a client mod. It is the user's own, as if they had used the player in
   * Slack, and its audit records say how it came.
   */
  private fromDataChannel(actorId?: string) {
    const run = this.dataChannelRuns.getStore();
    return Boolean(
      run && !run.done && (actorId === undefined || actorId === run.userId),
    );
  }

  /**
   * Does what a client mod asks as the player in Slack does it, as its
   * user: the same handler as the button or dialog, with an interaction
   * standing in for Slack's. What the handler would say in an ephemeral
   * notice comes back as the answer instead, unless `notices` says to post
   * them as usual.
   */
  private async viaPlayer(
    userId: string,
    actionId: string,
    options: {
      value?: string;
      submit?: boolean;
      state?: Interaction["state"];
      metadata?: Record<string, unknown>;
      notices?: "post";
    } = {},
  ) {
    const run: DataChannelRun = {
      userId,
      notices: [],
      info: [],
      done: false,
      post: options.notices === "post",
    };
    try {
      await this.dataChannelRuns.run(run, () =>
        this.action(this.playerInteraction(userId, actionId, options)),
      );
    } finally {
      // Timers it started carry on as the session's own.
      run.done = true;
    }
    return run;
  }

  // An interaction as the player, or a dialog over it, would send one.
  private playerInteraction(
    userId: string,
    actionId: string,
    options: {
      value?: string;
      submit?: boolean;
      state?: Interaction["state"];
      metadata?: Record<string, unknown>;
    },
  ): Interaction {
    return {
      type: options.submit ? "view_submission" : "block_actions",
      userId,
      actionId,
      value: options.value ?? "",
      channelId: this.room.uiChannelId,
      // read as it runs, so it's never stale
      messageTs: "",
      triggerId: "",
      // Stands in for the dialog that the queue's buttons and forms are in.
      viewId: `data-channel:${userId}`,
      viewHash: "",
      metadata: JSON.stringify({ sessionId: this.id, ...options.metadata }),
      state: options.state ?? {},
    };
  }

  private answer(run: DataChannelRun): AgentResult {
    if (run.notices.length) return { ok: false, error: run.notices[0]! };
    return run.info.length ? { ok: true, message: run.info[0] } : { ok: true };
  }

  // Runs what a client mod asks, through the player's own handlers.
  private async pluginCommand(
    userId: string,
    command: PluginCommand,
  ): Promise<AgentResult> {
    if (this.inactive())
      return { ok: false, error: "This session is not active." };
    const trackId = typeof command.trackId === "string" ? command.trackId : "";
    const press = async (actionId: string, value?: string) =>
      this.answer(await this.viaPlayer(userId, actionId, { value }));
    // What the player's buttons pass over quietly, as they can't be pressed
    // then, a client mod hears.
    const queued = this.queue.find((entry) => entry.id === trackId);
    const notQueued = { ok: false, error: "That song isn't in the queue." };
    const nothingPlaying = { ok: false, error: "Nothing is playing." };
    switch (command.type) {
      case "search":
        return this.pluginSearch(userId, command.query);
      case "add": {
        const reference =
          typeof command.reference === "string" ? command.reference.trim() : "";
        if (!reference)
          return { ok: false, error: "Search for a song, or paste a link." };
        // Jellyfin's are linked in a dialog only Slack opens
        if (
          parseJellyfinLink(this.tracks.referencedUrl?.(reference) ?? reference)
        )
          return {
            ok: false,
            error: "Add Jellyfin links with Add songs in Slack.",
          };
        return press("add_track_to_queue", reference);
      }
      case "remove":
        return queued ? press("remove_queue_track", trackId) : notQueued;
      case "move":
        return queued ? this.pluginMove(userId, trackId, command) : notQueued;
      case "shuffle":
        return press("shuffle_queue");
      case "clear":
        return press("clear_queue");
      case "skip":
        return press("next_track");
      case "previous":
        return press("previous_track");
      case "toggle":
        return this.current ? press("toggle_playback") : nothingPlaying;
      case "pause":
      case "resume":
        if (!this.current) return nothingPlaying;
        // already as asked, for whoever may pause it
        if (
          this.current &&
          (this.state === "paused") === (command.type === "pause")
        ) {
          await this.primeManager(userId);
          return this.can(userId, "pause") ? { ok: true } : this.denied(userId);
        }
        return press("toggle_playback");
      case "seek":
        return this.pluginSeek(userId, command);
      case "volume":
        return this.pluginSetting(userId, "volume", { value: command.percent });
      case "claim_host":
        return press("claim_host", this.id);
      case "play_something":
        // video mode's suggests from Jellyfin, in a dialog only Slack opens
        if (this.videoMode)
          return {
            ok: false,
            error: "In video mode, Play something is in the player in Slack.",
          };
        if (this.current || this.queue.length || this.autoplayPending)
          return { ok: false, error: "Something is already playing." };
        return press("play_something", this.id);
      case "keep":
        if (!queued?.automatic)
          return { ok: false, error: "That song isn't an autoplay pick." };
        return press("queue_keep_autoplay", trackId);
      case "end":
        return this.pluginEnd(userId, command);
    }
    return { ok: false, error: "That command is not available here." };
  }

  // What Add songs' search offers as the user types.
  private async pluginSearch(
    userId: string,
    query: unknown,
  ): Promise<AgentResult> {
    const text = typeof query === "string" ? query.trim() : "";
    if (!text) return { ok: true, results: [] };
    await this.primeManager(userId);
    if (!this.can(userId, "add") && !this.can(userId, "add-bulk"))
      return this.denied(userId);
    try {
      const options = (await this.suggestions(
        this.playerInteraction(userId, "selection", { value: text }),
      )) as { text: { text: string }; value: string }[];
      return {
        ok: true,
        results: options.map((option) => ({
          label: option.text.text,
          reference: option.value,
        })),
      };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  // The queue's Move up and down and Play next, and Move to's position.
  private async pluginMove(
    userId: string,
    trackId: string,
    command: PluginCommand,
  ) {
    const run = (actionId: string, options = {}) =>
      this.viaPlayer(userId, actionId, { value: trackId, ...options });
    if (command.direction === "up" || command.direction === "down")
      return this.answer(await run(`queue_move_${command.direction}`));
    const position = command.playNext === true ? 1 : Number(command.position);
    if (position === 1) return this.answer(await run("queue_play_next"));
    return this.answer(
      await run("move_queue_track", {
        submit: true,
        metadata: { trackId },
        state: { position: { value: { value: String(command.position) } } },
      }),
    );
  }

  // Jump to's time, from where the client has the slider: `to`, or a
  // relative `seconds`, as the bot API takes it.
  private async pluginSeek(userId: string, command: PluginCommand) {
    const current = this.current;
    if (!current) return { ok: false, error: "Nothing is playing." };
    if (current.live)
      return {
        ok: false,
        error:
          "A live stream plays where it is now, so there is nowhere to jump to.",
      };
    const to =
      typeof command.to === "number"
        ? command.to
        : typeof command.seconds === "number"
          ? this.playbackPosition() + command.seconds
          : undefined;
    if (to === undefined || !Number.isFinite(to))
      return { ok: false, error: "Say where to seek to." };
    return this.answer(
      await this.viaPlayer(userId, "jump_to_time", {
        submit: true,
        metadata: { entryId: current.id },
        state: { time: { value: { value: formatClock(to) } } },
      }),
    );
  }

  // End session's dialog, submitted: maybe saving the session first. Its
  // notice of how that went is posted as usual, since the session it would
  // answer over is over.
  private async pluginEnd(userId: string, command: PluginCommand) {
    await this.primeRoles(userId, true);
    if (!this.can(userId, "end-session")) return this.denied(userId);
    const save =
      command.save === "channel" || command.save === "user"
        ? command.save
        : "none";
    await this.viaPlayer(userId, "end_session_confirm", {
      submit: true,
      notices: "post",
      state: {
        save_to: { choice: { selected_option: { value: save } } },
        save_name: {
          value: {
            value: typeof command.name === "string" ? command.name : "",
          },
        },
      },
    });
    return this.state === "ended"
      ? { ok: true }
      : { ok: false, error: "The session didn't end." };
  }

  // Changes one setting, by its field in settings-schema, as saving Settings
  // with only that field changed does.
  private async pluginSetting(
    userId: string,
    setting: string,
    change: PluginSettingChange,
  ): Promise<AgentResult> {
    if (this.inactive())
      return { ok: false, error: "This session is not active." };
    await this.primeManager(userId);
    if (!this.canOpenSettings(userId)) return this.denied(userId);
    // what Settings shows this user now
    const field = settingFields({
      access: {
        volume: this.can(userId, "volume"),
        configure: this.can(userId, "configure-settings"),
        admin: this.settingsAdmin(userId),
      },
      session: this.sessionSettings(),
      ...(this.scrobbling
        ? { user: this.scrobbling.settings(userId, this.id) }
        : {}),
    }).find((candidate) => candidate.id === setting);
    if (!field)
      return { ok: false, error: "You can't change that setting here." };
    const value =
      "preset" in change
        ? field.kind === "multi"
          ? field.presets?.find((preset) => preset.value === change.preset)
              ?.permissions
          : undefined
        : change.value;
    const invalid = { ok: false as const, error: "That value is invalid." };
    switch (field.kind) {
      case "select":
        // any percent, as its steps grow to include the one it's at
        if (field.id === "volume") {
          const percent =
            typeof value === "number"
              ? value
              : typeof value === "string" && /^\d+(\.\d+)?$/.test(value)
                ? Number(value)
                : NaN;
          if (!(percent >= 0 && percent <= 100)) return invalid;
          break;
        }
        if (
          typeof value !== "string" ||
          !field.options.some((option) => option.value === value)
        )
          return invalid;
        break;
      case "toggle":
        if (typeof value !== "boolean") return invalid;
        break;
      case "user":
        if (typeof value !== "string") return invalid;
        break;
      case "multi":
        if (
          !Array.isArray(value) ||
          !value.every((item) => typeof item === "string")
        )
          return invalid;
    }
    return this.answer(
      await this.viaPlayer(userId, "save_settings", {
        submit: true,
        state: fieldFormState(field, value as SettingFieldValue),
      }),
    );
  }

  participantIds() {
    return [...this.participants];
  }

  /** This session as the stats canvas lists it; undefined once it has ended. */
  canvasSession() {
    if (this.inactive()) return;
    return {
      channelId: this.roomId,
      listeners: [...this.participants].filter((id) => id !== this.botUserId)
        .length,
      state: this.state,
      track: this.current && {
        title: this.current.title,
        artist: this.current.artist,
      },
    };
  }

  hasParticipant(userId: string) {
    return this.participants.has(userId);
  }

  hostUserId() {
    return this.hostId ?? this.room.huddleCreatorId;
  }

  moveControls(channelId: string) {
    return this.enqueue(async () => {
      const previousChannelId = this.room.uiChannelId;
      this.room.uiChannelId = channelId;
      this.room.uiThreadTs = "";
      this.room.companionChannelId = channelId;
      this.store.setUiLocation(this.id, channelId, "", channelId);
      await this.reanchor(previousChannelId);
    });
  }

  memberJoined(userId: string) {
    if (this.isExcluded(userId)) return;
    if (!this.participants.has(userId)) {
      this.participantsRevision++;
      this.sessionChanged();
    }
    this.participants.add(userId);
    this.plugins.changed();
    this.plugins.refreshYouFor(userId);
    this.playbackScrobbling?.memberJoined(userId);
    void this.promptScrobbling(userId);
    this.prefetchRecommendations(userId);
    this.refreshIdle();
    this.log.info(
      { event: "member_joined", userId, participants: this.participants.size },
      "Huddle member joined",
    );
  }

  memberLeft(userId: string) {
    if (this.isExcluded(userId)) return;
    if (this.participants.delete(userId)) {
      this.participantsRevision++;
      this.sessionChanged();
      this.plugins.changed();
      // out of the huddle, they're off its data channel too
      this.plugins.forget(userId);
    }
    this.playbackScrobbling?.memberLeft(userId);
    if (this.state === "suspended" || userId === this.botUserId) return;
    const changed =
      userId === this.hostId
        ? this.enqueue(() => this.hostLeft())
        : Promise.resolve();
    this.refreshIdle();
    this.log.info(
      { event: "member_left", userId, participants: this.participants.size },
      "Huddle member left",
    );
    return changed;
  }

  // Huddle member events arrive over the private realtime gateway, whose
  // socket cycles can drop them, so the tracked set can drift from the actual
  // Huddle. Applying the diff against the authoritative participant list also
  // lets refreshIdle() re-evaluate the alone, idle, and paused timers.
  get participantsVersion() {
    return this.participantsRevision;
  }

  reconcileParticipants(
    userIds: string[],
    version = this.participantsRevision,
  ) {
    return this.enqueue(
      (): { added: string[]; removed: string[] } | undefined => {
        if (this.inactive()) return;
        // Member events apply synchronously, outside this queue, so a
        // snapshot taken before the Slack round trip can already be stale by
        // the time it gets here. Applying it would undo the newer event, so
        // drop it and let the next pass reconcile a fresh snapshot.
        if (version !== this.participantsRevision) {
          this.log.debug(
            { event: "participants_reconcile_stale", version },
            "Discarded a stale Huddle participant snapshot",
          );
          return;
        }
        const actual = new Set(
          userIds.filter((id) => id !== this.botUserId && !this.isExcluded(id)),
        );
        actual.add(this.botUserId);
        const removed = [...this.participants].filter((id) => !actual.has(id));
        const added = [...actual].filter((id) => !this.participants.has(id));
        if (!added.length && !removed.length) return;
        this.log.info(
          { event: "participants_reconciled", added, removed },
          "Reconciled Huddle participants with Slack",
        );
        // Additions go first so a diff that both restores a missed join and
        // removes a stale participant never announces an alone timeout the
        // addition is about to cancel.
        for (const userId of added) this.memberJoined(userId);
        for (const userId of removed) this.memberLeft(userId);
        return { added, removed };
      },
    );
  }

  endFromSlack() {
    return this.enqueue(() => this.end(this.hostId, "huddle ended"));
  }

  suspendForRestart(resumeUntil: number) {
    return this.enqueue(async () => {
      if (this.inactive()) return;
      const startedAt = Date.now();
      this.log.info(
        { event: "suspend_started" },
        "Suspending session for restart",
      );
      const notice = this.post(
        this.room.uiChannelId,
        this.room.uiThreadTs,
        "HuddleFM is restarting. Playback should resume shortly.",
      ).catch((error) =>
        this.log.error(
          { event: "restart_notice_failed", err: error },
          "Could not post restart notice",
        ),
      );
      // The player shows what will resume, which the last click may not have
      // reached Slack with yet.
      await this.settlePlayer();
      const state = this.state;
      this.state = "suspended";
      this.playbackScrobbling?.pause();
      this.stopWork();
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
      this.dropIntegrations("session.suspended");
      this.sendMedia({ type: "leave" });
      await Promise.all([this.leaveMedia(), notice]);
      this.log.info(
        { event: "suspended", durationMs: Date.now() - startedAt },
        "Session suspended for restart",
      );
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

  ownsChannel(channel: string) {
    return sessionMatchesChannel(this.room, channel);
  }

  hasGrant(userId: string) {
    return this.integrations.has(userId);
  }

  private can(userId: string, capability: string) {
    if (this.isExcluded(userId)) return false;
    if (this.integrations.get(userId)?.permissions.has(capability)) return true;
    if (capability === "end-session" && this.canEndFromOutside(userId))
      return true;
    return (
      this.isManager(userId) ||
      (this.participants.has(userId) &&
        (userId === this.hostId || this.allowed.has(capability)))
    );
  }

  // What a user may do in this session without joining the huddle. The
  // configured manager holds host powers; workspace admins and managers of the
  // Huddle's channel hold what WORKSPACE_ADMIN_PERMISSIONS and
  // CHANNEL_MANAGER_PERMISSIONS grant, and someone who is both gets the
  // higher. Exclusion wins over all of them, so the bot and integration
  // accounts cannot let themselves in this way.
  private outsidePermissions(userId: string): RolePermissions {
    if (this.isExcluded(userId)) return "none";
    if (userId === this.config.managerUserId) return "host";
    const granted: RolePermissions[] = [];
    if (this.workspaceAdmins?.isAdmin(userId))
      granted.push(this.workspaceAdmins.permissions);
    if (this.channelManagers?.isManager(this.roomId, userId))
      granted.push(this.channelManagers.permissions);
    if (granted.includes("host")) return "host";
    return granted.includes("end") ? "end" : "none";
  }

  // A manager holds host powers in every session without joining the huddle.
  private isManager(userId: string) {
    return this.outsidePermissions(userId) === "host";
  }

  // Ending the session from outside the huddle takes any granted role.
  private canEndFromOutside(userId: string) {
    return this.outsidePermissions(userId) !== "none";
  }

  // Permission checks are synchronous, so the Slack roles that could make a
  // user a manager have to be in hand before the first one runs.
  primeManager(userId: string) {
    return this.primeRoles(userId, false);
  }

  // Looks up the roles that could matter to what the user is doing, together
  // so that one slow lookup does not wait on another.
  private async primeRoles(
    userId: string,
    ending: boolean,
    channelDefaults = false,
  ) {
    await Promise.all(
      this.roleLookups(userId, ending, channelDefaults).map((lookup) =>
        lookup(),
      ),
    );
  }

  // The role lookups that would have to ask Slack before the user's next
  // permission check. Roles that only end the session matter only for an
  // action that can end it, and only for users who could not end it anyway.
  // Channel managers also save the channel's defaults and delete its saved
  // sessions from Settings, so its Channel tab asks whenever channel managers
  // are granted anything and the user can see settings to save or the
  // channel has saves to delete. A workspace admin lookup still pending could
  // grant them that, so it asks then too.
  private roleLookups(
    userId: string,
    ending: boolean,
    channelDefaults = false,
  ) {
    if (this.isExcluded(userId)) return [];
    const needed: RolePermissions =
      ending && !this.can(userId, "end-session") ? "end" : "host";
    const matters = (permissions: RolePermissions) =>
      permissions === "host" || (permissions === "end" && needed === "end");
    const lookups: (() => Promise<boolean>)[] = [];
    const admins = this.workspaceAdmins;
    if (admins && matters(admins.permissions) && !admins.known(userId))
      lookups.push(() => admins.resolve(userId));
    const managers = this.channelManagers;
    const savesDefaults =
      channelDefaults &&
      managers?.permissions !== "none" &&
      !this.roomId.startsWith("D") &&
      userId !== this.config.managerUserId &&
      (lookups.length > 0 ||
        this.savableDefaults(userId).length > 0 ||
        this.store.sessionSaves([{ type: "channel", id: this.roomId }]).length >
          0);
    if (
      managers &&
      (matters(managers.permissions) || savesDefaults) &&
      !managers.known(this.roomId)
    )
      lookups.push(() => managers.resolve(this.roomId, userId));
    return lookups;
  }

  // Opens Settings in a loading state, or nothing if Slack refuses, in which
  // case Settings tries to open normally once the lookup is done.
  private async openSettingsLoading(interaction: Interaction) {
    try {
      const view = await this.slack.modal(
        interaction.triggerId,
        settingsMessageView("Loading…"),
      );
      return view?.id ? { id: view.id, hash: view.hash } : undefined;
    } catch (error) {
      this.log.warn(
        { event: "settings_loading_failed", err: error },
        "Could not open the Settings loading view",
      );
      return undefined;
    }
  }

  // Tells the user why Settings did not open: in the loading view when one is
  // waiting on the answer, so it is not left loading, and in the thread
  // otherwise.
  private async settingsNotice(
    userId: string,
    text: string,
    loading?: { id: string; hash?: string },
  ) {
    if (!loading) return this.notice(userId, text);
    await this.slack.updateModal(
      loading.id,
      loading.hash,
      settingsMessageView(text),
    );
  }

  // What a user granted only the end permission may do from outside the
  // Huddle: reach Settings and its End session button. A Settings submission
  // changes only what the user is otherwise allowed to change.
  private endingAction(interaction: Interaction) {
    if (interaction.type === "view_submission")
      return interaction.actionId !== "move_queue_track";
    return (
      interaction.actionId === "open_settings" ||
      Boolean(settingsTabFromAction(interaction.actionId)) ||
      interaction.actionId === "delete_channel_save" ||
      interaction.actionId === "end_session" ||
      interaction.actionId === "open_end_session" ||
      interaction.actionId === "save_channel_defaults" ||
      interaction.actionId === "clear_channel_defaults"
    );
  }

  // The session settings the user can see in Settings, which are the only
  // ones they may save as the channel's defaults.
  private savableDefaults(userId: string) {
    const fields: ("volume" | "settings" | "permissions")[] = [];
    if (this.can(userId, "volume")) fields.push("volume");
    if (this.can(userId, "configure-settings")) fields.push("settings");
    if (this.settingsAdmin(userId)) fields.push("permissions");
    return fields;
  }

  // Channel managers, and the configured manager, decide what every session
  // in a channel starts with, from the settings they can see. A direct
  // message has no channel to save for.
  private canSaveChannelDefaults(userId: string) {
    if (this.isExcluded(userId) || this.roomId.startsWith("D")) return false;
    if (!this.savableDefaults(userId).length) return false;
    return (
      userId === this.config.managerUserId ||
      this.channelManagers?.isManager(this.roomId, userId) === true
    );
  }

  private settingsAdmin(userId: string) {
    return (
      !this.isExcluded(userId) &&
      (userId === this.hostId || this.isManager(userId))
    );
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
      !this.isExcluded(userId) &&
      (this.isManager(userId) || this.participants.has(userId))
    );
  }

  private canUsePlayer(userId: string) {
    return this.isParticipantOrManager(userId) || this.integrations.has(userId);
  }

  private inactive() {
    return this.state === "ended" || this.state === "suspended";
  }

  // What an agent hears when it lacks a capability: outsiders are told to
  // join, and everyone else that this is not theirs to do.
  private denied(userId: string) {
    return {
      ok: false as const,
      error: this.canUsePlayer(userId)
        ? "You do not have permission for that."
        : "Join the huddle before using the player.",
    };
  }

  async requestIntegrationControl(options: {
    userId: string;
    channel: string;
    permissions: string[];
    events: string[];
    dmChannelId: string;
    requestTs: string;
  }) {
    if (this.inactive())
      return this.replyIntegration(options, {
        ok: false,
        error: "session_inactive",
      });
    if (!this.hostId)
      return this.replyIntegration(options, {
        ok: false,
        error: "no_host",
        message: "This session has no host to approve the request.",
      });
    const existing = this.pendingIntegrations.get(options.userId);
    if (existing) this.dropPending(existing);
    const requestId = crypto.randomUUID();
    const pending = {
      id: requestId,
      userId: options.userId,
      permissions: options.permissions,
      events: options.events,
      dmChannelId: options.dmChannelId,
      requestTs: options.requestTs,
      channel: options.channel,
      timer: setTimeout(() => {
        const current = this.pendingIntegrations.get(options.userId);
        if (current?.id !== requestId) return;
        this.pendingIntegrations.delete(options.userId);
        void this.replyIntegration(options, {
          ok: true,
          type: "grant_expired",
        }).catch((error) =>
          this.log.warn(
            { event: "integration_expire_notify_failed", err: error },
            "Could not notify expired integration request",
          ),
        );
      }, integrationGrantTimeoutMs),
    };
    this.pendingIntegrations.set(options.userId, pending);
    const text = `<@${options.userId}> wants to control this session.`;
    const blocks = integrationRequestBlocks({
      sessionId: this.id,
      requestId,
      userId: options.userId,
      channel: options.channel,
      permissions: options.permissions,
      events: options.events,
    });
    try {
      await this.slack.ephemeral(
        this.room.uiChannelId,
        this.hostId,
        text,
        this.room.uiThreadTs,
        blocks,
      );
    } catch (error) {
      try {
        await this.slack.dm(this.hostId, text, { blocks });
      } catch (fallbackError) {
        this.dropPending(pending);
        this.log.warn(
          {
            event: "integration_prompt_failed",
            err: fallbackError ?? error,
          },
          "Could not prompt host for integration control",
        );
        return this.replyIntegration(options, {
          ok: false,
          error: "host_unreachable",
        });
      }
    }
  }

  async handleIntegrationCommand(
    userId: string,
    command: IntegrationCommand,
    requestTs: string,
    dmChannelId: string,
  ) {
    const target = { userId, dmChannelId, requestTs };
    if (command.type === "request_control")
      return this.requestIntegrationControl({
        userId,
        channel: command.channel!,
        permissions: command.permissions ?? [],
        events: command.events ?? [],
        dmChannelId,
        requestTs,
      });
    if (command.type === "release_control") {
      const grant = this.integrations.get(userId);
      if (!grant)
        return this.replyIntegration(target, {
          ok: false,
          type: "release_control",
          error: "not_granted",
        });
      this.integrations.delete(userId);
      await this.render();
      return this.replyIntegration(target, {
        ok: true,
        type: "release_control",
        released: true,
      });
    }
    if (!this.integrations.has(userId))
      return this.replyIntegration(target, {
        ok: false,
        type: command.type,
        error: "not_granted",
      });
    if (this.inactive())
      return this.replyIntegration(target, {
        ok: false,
        type: command.type,
        error: "session_inactive",
      });
    let result: Parameters<typeof wrapIntegrationResult>[2];
    try {
      // Commands check permissions synchronously, and a grant holder may also
      // be a workspace admin.
      await this.primeManager(userId);
      result = await this.runIntegrationCommand(userId, command);
    } catch (error) {
      result = { ok: false, error: message(error) };
    }
    return this.slack.dm(
      userId,
      wrapIntegrationResult(command.type, requestTs, result),
      { channelId: dmChannelId, threadTs: requestTs },
    );
  }

  private async runIntegrationCommand(
    userId: string,
    command: IntegrationCommand,
  ) {
    switch (command.type) {
      case "status":
        return this.integrationStatus(userId);
      case "search":
        if (!command.query)
          return { ok: false as const, error: "query is required." };
        return this.agentSearch(userId, command.query);
      case "add":
        if (!command.reference)
          return { ok: false as const, error: "reference is required." };
        return this.agentAdd(userId, command.reference, undefined, {
          awaitPreparation: false,
        });
      case "remove":
        if (!command.trackId)
          return { ok: false as const, error: "trackId is required." };
        return this.agentRemove(userId, command.trackId);
      case "move":
        if (!command.trackId)
          return { ok: false as const, error: "trackId is required." };
        return this.agentMove(userId, command.trackId, {
          direction: command.direction,
          playNext: command.playNext,
          position: command.position,
        });
      case "shuffle":
        return this.agentShuffle(userId);
      case "clear":
        return this.agentClear(userId);
      case "skip":
        return this.agentSkip(userId);
      case "previous":
        return this.agentPrevious(userId);
      case "toggle":
        return this.agentToggle(userId);
      case "pause":
        return this.agentPause(userId);
      case "resume":
        return this.agentResume(userId);
      case "seek":
        if (typeof command.seconds !== "number")
          return { ok: false as const, error: "seconds is required." };
        return this.agentSeek(userId, command.seconds);
      case "volume":
        if (typeof command.percent !== "number")
          return { ok: false as const, error: "percent is required." };
        return this.agentSetVolume(userId, command.percent);
      case "settings":
        return this.agentUpdateSettings(userId, {
          displayMode: command.displayMode,
          autoplay: command.autoplay,
          autoplayMode: command.autoplayMode,
          loopMode: command.loopMode,
          transitionMode: command.transitionMode,
          duckingMode: command.duckingMode,
          anchorEnabled: command.anchorEnabled,
        });
      case "end":
        return this.agentEnd(userId);
      default:
        return { ok: false as const, error: "unknown_type" };
    }
  }

  // The agent status without the fields that only Slack-side agents need.
  private integrationStatus(userId: string) {
    const status = this.agentStatus(userId);
    if (!status.ok) return status;
    const { hostId: _hostId, youAreHost, scrobbling, ...shared } = status;
    return shared;
  }

  private isIntegrationAction(actionId: string) {
    return (
      actionId === "integration_accept" ||
      actionId === "integration_decline" ||
      actionId === "integration_revoke"
    );
  }

  private async integrationAction(interaction: Interaction) {
    const parsed = parseIntegrationActionValue(interaction.value);
    if (!parsed) return;
    if (
      interaction.userId !== this.hostId &&
      !this.isManager(interaction.userId)
    )
      return this.notice(interaction.userId, "Only the host can approve that.");
    if (interaction.actionId === "integration_revoke")
      return this.revokeIntegration(parsed.requestId, interaction);
    const pending = [...this.pendingIntegrations.values()].find(
      (request) => request.id === parsed.requestId,
    );
    if (!pending)
      return this.notice(
        interaction.userId,
        "That control request is no longer pending.",
      );
    this.dropPending(pending);
    if (interaction.actionId === "integration_decline") {
      await this.replyIntegration(pending, {
        ok: true,
        type: "grant_declined",
      });
      return this.replaceOriginal(
        interaction,
        `Declined <@${pending.userId}>'s control request.`,
      );
    }
    this.integrations.set(pending.userId, {
      permissions: new Set(pending.permissions),
      events: new Set(pending.events),
      channel: pending.channel,
      dmChannelId: pending.dmChannelId,
      requestTs: pending.requestTs,
      requestId: pending.id,
    });
    const status = this.integrationStatus(pending.userId);
    await this.replyIntegration(pending, {
      ...(status.ok ? status : {}),
      ok: true,
      type: "grant_accepted",
      permissions: pending.permissions,
      events: pending.events,
    });
    await this.render();
    await this.replaceOriginal(
      interaction,
      `Granted <@${pending.userId}> control of this session.`,
      integrationGrantedBlocks({
        sessionId: this.id,
        requestId: pending.id,
        userId: pending.userId,
        permissions: pending.permissions,
      }),
    );
  }

  // Rewrites the ephemeral a host answered from, when Slack still lets us.
  private async replaceOriginal(
    interaction: Interaction,
    text: string,
    blocks?: unknown[],
  ) {
    if (!interaction.responseUrl) return;
    await this.slack
      .replaceOriginal(interaction.responseUrl, text, blocks)
      .catch(() => {});
  }

  private async revokeIntegration(requestId: string, interaction: Interaction) {
    const entry = [...this.integrations.entries()].find(
      ([, grant]) => grant.requestId === requestId,
    );
    if (!entry)
      return this.notice(
        interaction.userId,
        "That bot is no longer controlling this session.",
      );
    const [userId, grant] = entry;
    this.integrations.delete(userId);
    await this.replyIntegration(
      {
        userId,
        dmChannelId: grant.dmChannelId,
        requestTs: grant.requestTs,
      },
      { ok: true, type: "grant_revoked" },
    );
    await this.render();
    await this.replaceOriginal(
      interaction,
      `Revoked <@${userId}>'s control of this session.`,
    );
    if (interaction.viewId && interaction.viewHash)
      await this.updateSettings(interaction);
  }

  private dropPending(pending: {
    userId: string;
    timer: ReturnType<typeof setTimeout>;
  }) {
    clearTimeout(pending.timer);
    this.pendingIntegrations.delete(pending.userId);
  }

  private replyIntegration(
    target: { userId: string; dmChannelId: string; requestTs: string },
    body: Record<string, unknown>,
  ) {
    return this.slack.dm(
      target.userId,
      integrationReply(target.requestTs, body),
      { channelId: target.dmChannelId, threadTs: target.requestTs },
    );
  }

  private notifyIntegrations(
    event: string,
    payload: Record<string, unknown> = {},
  ) {
    const group = eventGroup(event);
    if (!group) return;
    for (const [userId, grant] of this.integrations) {
      if (!grant.events.has(group)) continue;
      const text = integrationEventMessage(grant.channel, event, payload);
      void this.slack
        .dm(userId, text, { channelId: grant.dmChannelId })
        .catch((error) =>
          this.log.warn(
            {
              event: "integration_event_failed",
              userId,
              integrationEvent: event,
              err: error,
            },
            "Could not send integration event",
          ),
        );
    }
  }

  private notifyTrack(
    event: string,
    entry: Entry,
    extra: Record<string, unknown> = {},
  ) {
    this.notifyIntegrations(event, {
      id: entry.id,
      title: entry.title,
      artist: entry.artist,
      ...extra,
    });
  }

  private dropIntegrations(event: "session.ended" | "session.suspended") {
    this.notifyIntegrations(event);
    for (const pending of this.pendingIntegrations.values()) {
      clearTimeout(pending.timer);
      void this.replyIntegration(pending, {
        ok: true,
        type: "grant_expired",
      }).catch(() => {});
    }
    this.pendingIntegrations.clear();
    this.integrations.clear();
  }

  private isExcluded(userId: string) {
    return this.config.excludedUserIds.has(userId);
  }

  // Video mode has its own autoplay, of related videos.
  // A live stream never ends, so autoplay waits for it to.
  private autoplayOn() {
    return (
      (this.videoMode ? this.videoAutoplay : this.autoplayMode !== "off") &&
      !this.current?.live
    );
  }

  private listenerIds() {
    return [...this.participants].filter(
      (id) => id !== this.botUserId && !this.isExcluded(id),
    );
  }

  private prefetchRecommendations(userId?: string) {
    this.recommendations?.prefetchUsers(userId ? [userId] : this.listenerIds());
  }

  // What this session has already played or queued, so personal
  // recommendations do not offer it and lanes that have run low get topped
  // up in the background rather than on the next modal open.
  private sessionExclusions() {
    return [
      this.current?.sourceId,
      ...this.queue.map((track) => track.sourceId),
      ...this.history.slice(-20).map((track) => track.sourceId),
      ...this.autoplayRejected,
    ];
  }

  private noteSessionRecommendations() {
    if (!this.recommendations) return;
    this.recommendations.noteSessions(
      this.listenerIds(),
      this.sessionExclusions(),
    );
    this.prefetchRecommendations();
  }

  private rejectAutoplayArtist(artist: string) {
    const name = firstArtist(artist);
    this.autoplayRejectedArtists = [
      ...this.autoplayRejectedArtists.filter((value) => value !== name),
      name,
    ].slice(-20);
  }

  // A room in a channel, which is what a recurring Huddle actually is. The
  // companion channel is stable per source channel, so either identifies the
  // same room across Huddles.
  private get roomId() {
    return this.room.sourceChannelId ?? this.room.uiChannelId;
  }

  // Skipping an autoplay pick, or removing one from the queue, keeps the
  // track and artist out of this session's autoplay, pushes them down in the
  // rejecter's own recommendations, and, for a discovery, makes the next
  // discovery turn wait longer. An autoplay pick is also remembered across
  // Huddles, so the mix does not offer it to these listeners again next time.
  private rejectSkipped(skipped: Entry, userId: string) {
    this.autoplayRejected = [
      ...this.autoplayRejected.filter((id) => id !== skipped.sourceId),
      skipped.sourceId,
    ].slice(-20);
    // A related video says nothing about anyone's taste in music.
    if (skipped.relatedVideo) return;
    this.rejectAutoplayArtist(skipped.artist);
    this.recommendations?.penalize(userId, skipped);
    if (skipped.automatic) this.rememberSkip(skipped, userId);
    if (skipped.discovery)
      this.autoplayDiscoveryInterval = Math.min(
        autoplayDiscoveryMaxInterval,
        this.autoplayDiscoveryInterval * 2,
      );
  }

  // A one-way, invisible "more of this". Nothing on the player changes: the
  // button holds no state, so there is nothing for the room to read off it and
  // nothing to re-render. Everyone sees the same card, and only the person who
  // pressed it hears back — in an ephemeral, which is the one message Slack
  // shows to a single person, and so the only place the undo can live.
  //
  // Taking it back is not handled here: a like outlives the session it was
  // made in, and so must its undo.
  private async like(interaction: Interaction) {
    const entry = this.likeable(interaction.value);
    if (!entry)
      return this.notice(interaction.userId, "That song has already finished.");
    this.store.likeTrack({
      userId: interaction.userId,
      title: entry.title,
      artist: entry.artist,
    });
    void this.recommendations?.refreshUser(interaction.userId);
    const discovery =
      entry.discovery === undefined ? {} : { discovery: entry.discovery };
    this.audit.record("track.liked", interaction.userId, {
      sessionId: this.id,
      ...auditTrack(entry),
    });
    this.log.info(
      {
        event: "track_liked",
        entryId: entry.id,
        sourceId: entry.sourceId,
        userId: interaction.userId,
      },
      "Track liked",
    );
    // The row is already written, so a Slack failure here costs the listener
    // their notice and their undo but must not fail the like itself.
    await this.slack
      .ephemeral(
        this.room.uiChannelId,
        interaction.userId,
        likedNotice,
        this.room.uiThreadTs,
        [
          section(likedNotice),
          actions("track_like", [
            button("unlike_track", plain("Undo"), {
              value: likeValue({
                sessionId: this.id,
                title: entry.title,
                artist: entry.artist,
                ...discovery,
              }),
            }),
          ]),
        ],
      )
      .catch((error) =>
        this.log.warn(
          {
            event: "like_notice_failed",
            userId: interaction.userId,
            err: error,
          },
          "Could not post like notice",
        ),
      );
  }

  // DMs the listener a link to the song, so they can find it again on
  // whichever service they use. Like the like button, it refers to the song
  // that was playing when they pressed it.
  private async save(interaction: Interaction) {
    const entry = this.likeable(interaction.value);
    if (!entry)
      return this.notice(interaction.userId, "That song has already finished.");
    const userId = interaction.userId;
    const label = `${escape(entry.title)} — ${escape(entry.artist)}`;
    const link = savedLink(entry);
    // A | in the target would end it early, so it is percent-encoded.
    const text = link
      ? `<${escape(link).replaceAll("|", "%7C")}|${label}>`
      : label;
    // Sending changes nothing in the session, so it does not hold up the
    // actions queued behind it.
    void this.slack.dm(userId, text, { blocks: [section(text)] }).then(
      () => {
        this.audit.record("track.saved", userId, {
          sessionId: this.id,
          ...auditTrack(entry),
        });
        this.log.info(
          {
            event: "track_saved",
            entryId: entry.id,
            sourceId: entry.sourceId,
            userId,
          },
          "Track link sent",
        );
      },
      (error) => {
        this.log.warn(
          { event: "save_dm_failed", userId, err: error },
          "Could not send saved track",
        );
        return this.notice(
          userId,
          "Couldn't send you that song. Try again in a moment.",
        ).catch(() => {});
      },
    );
  }

  // The song a like button refers to. It is only ever rendered for whatever is
  // playing, but a click takes a moment to arrive, by which time the song may
  // have moved into history. A click for a song this session never played, or
  // has long since forgotten, is the one the listener is told about.
  private likeable(id: string) {
    if (!id) return undefined;
    return [this.current, ...this.history].find((entry) => entry?.id === id);
  }

  // Records the skip against the listener who made it, and against everyone
  // else in the room at a fraction of the weight: whoever pressed the button
  // was acting for the room, but only they chose to.
  private rememberSkip(skipped: Entry, userId: string) {
    const optedIn = (listener: string) =>
      this.recommendations?.huddleMixOptedIn(listener) ?? false;
    // Managers and integrations can skip without being in the Huddle, and they
    // never heard the song, so nothing is recorded against them. Only people
    // who were actually listening carry a skip.
    const listeners = this.listenerIds();
    const bystanders = listeners.filter(
      (listener) => listener !== userId && optedIn(listener),
    );
    const skippedAt = Date.now();
    const record = (listener: string, weight: number) =>
      this.store.recordAutoplaySkip({
        sessionId: this.id,
        userId: listener,
        title: skipped.title,
        artist: skipped.artist,
        weight,
        skippedAt,
      });
    if (listeners.includes(userId) && optedIn(userId)) record(userId, 1);
    for (const listener of bystanders) record(listener, skipBystanderShare);
  }

  // How many tracks in a row the current artist has had, counting back
  // through history from the current track.
  private artistRun() {
    const artistOf = (track: Entry) =>
      normalizeToken(firstArtist(track.artist));
    const current = this.current ?? this.history.at(-1);
    if (!current) return 0;
    const artist = artistOf(current);
    let run = 1;
    const previous = this.current ? this.history : this.history.slice(0, -1);
    for (let index = previous.length - 1; index >= 0; index--) {
      if (artistOf(previous[index]!) !== artist) break;
      run++;
    }
    return run;
  }

  private rejectNonParticipant(
    interaction: Interaction,
    loading?: { id: string; hash?: string },
  ) {
    this.audit.record("action.denied", interaction.userId, {
      sessionId: this.id,
      actionId: interaction.actionId,
      reason: "not in huddle",
    });
    return this.settingsNotice(
      interaction.userId,
      "Join the huddle before using the player.",
      loading,
    );
  }

  private async add(interaction: Interaction) {
    const searchValue =
      interaction.state.track?.selection?.selected_option?.value ??
      interaction.value;
    const recommendId = searchValue
      ? undefined
      : interaction.state.recommend?.selection?.selected_option?.value;
    const recentId =
      searchValue || recommendId
        ? undefined
        : interaction.state.recent?.selection?.selected_option?.value;
    const jellyfinValue =
      interaction.state.jellyfin_track?.selection?.selected_option?.value;
    const value = jellyfinValue || searchValue || recommendId || recentId;
    if (!value) return;
    // A search result works once, so results holding it are searched again.
    for (const [key, { options }] of this.searchCache)
      if (options.some((option) => option.value === value))
        this.searchCache.delete(key);
    const accepted = await this.enqueue(async () => {
      if (this.inactive()) return false;
      if (interaction.messageTs && interaction.messageTs !== this.uiTs) {
        await this.notice(
          interaction.userId,
          "That player is stale; use the newest one.",
        );
        return false;
      }
      return this.require(
        interaction,
        value.startsWith("bulkref_") ? "add-bulk" : "add",
      );
    });
    if (!accepted) return;
    if (this.jellyfinUi && (await this.jellyfinUi.choose(interaction, value)))
      return;
    const link = this.tracks.referencedUrl?.(value);
    if (link && isJellyfinStreamLink(link))
      return this.notice(
        interaction.userId,
        "That link has your Jellyfin sign-in in it, so HuddleFM won’t play it. Paste the link from the item’s page in Jellyfin instead, and HuddleFM will link your server.",
      );
    const jellyfinLink = link ? parseJellyfinLink(link) : undefined;
    if (jellyfinLink && this.jellyfinUi)
      return this.jellyfinUi.openLink(interaction, jellyfinLink);
    let selection: TrackMetadata | TrackMetadata[];
    try {
      selection = recommendId
        ? (this.recommendations?.recommendation(recommendId) ??
          (await this.tracks.resolve(value, this.videoMode)))
        : recentId
          ? (this.store
              .recentTracks(interaction.userId, recentTrackLimit)
              .find((track) => track.id === recentId) ??
            (await this.tracks.resolve(value, this.videoMode)))
          : await this.tracks.resolve(value, this.videoMode);
    } catch (error) {
      return this.notice(interaction.userId, message(error));
    }
    const tracks = Array.isArray(selection) ? selection : [selection];
    const capability = Array.isArray(selection) ? "add-bulk" : "add";
    await this.queueRequested(interaction, capability, tracks);
  }

  // Queues what a user asked for, displacing any autoplay pick, and prepares
  // it. `total` is how many songs they asked for, when some were dropped
  // before resolving.
  private async queueRequested(
    interaction: Interaction,
    capability: string,
    tracks: TrackMetadata[],
    total = tracks.length,
  ) {
    const pending = await this.stageRequested(
      interaction,
      capability,
      tracks,
      total,
    );
    if (!pending) return;
    const prepare = () =>
      Promise.all(
        pending.map(({ entry, controller }) =>
          this.prepareManual(entry, controller),
        ),
      );
    // A client mod hears once the songs are queued; downloading them is the
    // session's, and says how it went in Slack, as for anyone.
    if (this.fromDataChannel())
      return this.dataChannelRuns.exit(() => void prepare());
    await prepare();
  }

  // Queues Jellyfin items without waiting for them to be ready, and says
  // whether any went on the queue.
  private async queueItems(
    interaction: Interaction,
    capability: string,
    items: QueuedItem[],
  ) {
    const pending = await this.stageRequested(interaction, capability, items);
    if (!pending?.length) return false;
    void Promise.all(
      pending.map(({ entry, controller }) =>
        this.prepareManual(entry, controller),
      ),
    );
    return true;
  }

  // Puts what a user asked for on the queue, with their permission checked.
  private async stageRequested(
    interaction: Interaction,
    capability: string,
    tracks: QueuedItem[],
    total = tracks.length,
  ) {
    const pending = await this.enqueue(async () => {
      if (this.inactive() || !(await this.require(interaction, capability)))
        return;
      await this.removeQueuedAutoplay();
      const fit = this.fitBatchToQueue(tracks);
      if ("error" in fit) {
        await this.notice(interaction.userId, fit.error);
        return;
      }
      const pending = this.stageEntries(interaction.userId, fit.items);
      if (pending.length)
        void this.recommendations?.refreshUser(interaction.userId);
      await this.render();
      this.queueChanged();
      return pending;
    });
    if (!pending) return;
    if (pending.length < total)
      await this.inform(
        interaction.userId,
        `Added ${pending.length} of ${total} songs; the rest did not fit.`,
      );
    return pending;
  }

  // Puts requested tracks on the queue, recorded and announced, and hands
  // back each with the controller that cancels its preparation.
  private stageEntries(userId: string, items: QueuedItem[]) {
    // The player names who added each song, so the name is looked up while
    // the songs are prepared rather than when the first starts.
    if (items.length && userId !== this.botUserId)
      void this.slack.userName(userId);
    const entries = items.map((metadata): Entry => ({
      ...metadata,
      id: crypto.randomUUID(),
      requesterId: userId,
      status: "preparing",
      // A video queued to watch stays out of the music's history and
      // taste, even before it plays.
      ...(this.videoMode && trackKind(metadata) === "video"
        ? { isVideo: true }
        : {}),
    }));
    // An album or playlist is written in one commit rather than one a song,
    // and joins the queue only once that commit has gone through.
    this.store.transaction(() => {
      for (const entry of entries) {
        this.store.addTrack({
          ...entry,
          sessionId: this.id,
          status: entry.status,
        });
        this.store.incrementUsage("added");
      }
    });
    return entries.map((entry) => {
      const controller = new AbortController();
      this.preparations.set(entry.id, controller);
      this.queue.push(entry);
      this.audit.record("track.added", userId, {
        sessionId: this.id,
        ...auditTrack(entry),
      });
      this.notifyTrack("queue.added", entry);
      return { entry, controller };
    });
  }

  // Media that is removed, private, blocked, or cancelled mid-preparation is an
  // everyday condition rather than a fault, so it is logged as a warning and
  // kept out of error tracking. The extractor's own wording goes in `reason`.
  private logTrackFailure(
    fields: Record<string, unknown>,
    error: unknown,
    text: string,
  ) {
    this.log[isExpectedTrackFailure(error) ? "warn" : "error"](
      { ...fields, reason: trackFailureDetail(error), err: error },
      text,
    );
  }

  private async prepareManual(entry: Entry, controller: AbortController) {
    const startedAt = Date.now();
    this.log.info(
      {
        event: "track_preparation_started",
        entryId: entry.id,
        automatic: false,
      },
      "Preparing queued track",
    );
    const prepared = this.download(entry, controller);
    try {
      const media = await prepared;
      await this.enqueue(async () => {
        if (!(await this.acceptPrepared(entry, media))) return;
        if (!this.current) await this.startNext();
        else {
          this.queueRender();
          this.syncPreloads();
        }
        this.log.info(
          {
            event: "track_prepared",
            entryId: entry.id,
            automatic: false,
            durationMs: Date.now() - startedAt,
          },
          "Queued track prepared",
        );
      });
    } catch (error) {
      // Agent cancellation owns cleanup via rollbackAgentAdd; skip failure
      // notices, audits, and queue/store mutation here.
      if (controller.signal.aborted) return;
      this.logTrackFailure(
        {
          event: "track_preparation_failed",
          entryId: entry.id,
          sourceId: entry.sourceId,
          userId: entry.requesterId,
          automatic: false,
          durationMs: Date.now() - startedAt,
        },
        error,
        "Queued track preparation failed",
      );
      await this.enqueue(async () => {
        if (!this.dropFailed(entry, error)) return;
        this.notifyTrack("queue.removed", entry, { reason: "failed" });
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

  // Prepares a track for the mode the session is in: audio for music, and
  // for video mode a video, a song's video, or audio when there is none.
  private async download(
    entry: Entry,
    controller: AbortController,
  ): Promise<PreparedMedia & { videoChecked?: boolean }> {
    const directory = `data/media/${this.id}`;
    // Read when a preparation slot comes free, so it follows the queue.
    const priority = () => this.preparationPriority(entry);
    if (parseJellyfinSource(entry.sourceId)) {
      if (!this.jellyfinUi) throw new TrackError("No longer available");
      return {
        ...(await this.jellyfinUi.prepare(entry, {
          video: this.videoMode,
          directory,
          ...entry.jellyfinTracks,
        })),
        videoChecked: this.videoMode || undefined,
      };
    }
    if (entry.live)
      return {
        ...(await this.tracks.prepareLive(
          entry,
          this.videoMode,
          controller.signal,
        )),
        videoChecked: this.videoMode || undefined,
      };
    if (this.videoMode)
      return {
        ...(await this.tracks.prepareVideo(
          entry,
          directory,
          entry.id,
          controller.signal,
          priority,
          entry.form === "audio" && entry.filePath
            ? { filePath: entry.filePath, gainDb: entry.gainDb }
            : undefined,
          !entry.download,
        )),
        videoChecked: true,
      };
    const filePath = await this.tracks.prepare(
      entry,
      directory,
      entry.id,
      controller.signal,
      priority,
    );
    return { filePath, form: "audio", gainDb: this.tracks.gain?.(filePath) };
  }

  // Takes in a finished download, or discards it when the session no longer
  // wants the track. A suspended session keeps the file for its resume.
  private async acceptPrepared(
    entry: Entry,
    media: PreparedMedia & { videoChecked?: boolean },
  ) {
    this.preparations.delete(entry.id);
    if (this.state === "suspended") return false;
    if (this.state === "ended" || !this.queue.includes(entry)) {
      if (media.filePath) await removePreparedMedia(media.filePath);
      return false;
    }
    this.prepared(entry, media);
    if (media.fellBack) await this.videoFellBack(entry);
    return true;
  }

  private videoFellBack(entry: Entry) {
    return this.videoNotice(
      entry,
      `Couldn’t download the video for ${entry.title}, so it will play as audio.`,
    );
  }

  // Drops a track whose preparation failed, unless the session has already
  // moved on from it. Says whether it was still queued.
  private dropFailed(entry: Entry, error: unknown) {
    this.preparations.delete(entry.id);
    if (this.inactive() || !this.queue.includes(entry)) return false;
    entry.status = "failed";
    this.queue = this.queue.filter((track) => track !== entry);
    this.queueChanged();
    this.store.setTrack(entry.id, { status: "failed" });
    this.audit.record("track.failed", undefined, {
      sessionId: this.id,
      ...auditTrack(entry),
      reason: safeAuditError(error),
    });
    return true;
  }

  // When someone pressed Play something, a mix that produces nothing falls
  // back to a random currently-popular song, and they hear about it if even
  // that fails.
  private scheduleAutoplay(playSomethingBy?: string) {
    const context = this.autoplayContext();
    const seeds = [this.current, ...[...this.history].reverse()]
      .flatMap((track) => (track && !track.automatic ? [track.sourceId] : []))
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(0, 3);
    if (
      !this.autoplayOn() ||
      this.loopMode !== "off" ||
      this.autoplayPending ||
      this.inactive() ||
      !this.autoplayHasRoom()
    )
      return;
    if (this.videoMode && (!context || !seeds.some(isYoutubeVideoId))) return;
    if (
      !this.videoMode &&
      this.autoplayMode === "related" &&
      (!context || !seeds.length)
    )
      return;
    if (
      !this.videoMode &&
      this.autoplayMode === "huddle" &&
      !this.recommendations
    )
      return;
    const generation = this.autoplayGeneration;
    this.autoplayPending = true;
    this.queueRender();
    // If the current song ends before this recommendation is prepared,
    // startNext() runs inside recommend() while autoplayPending is still true
    // and would otherwise skip queueing the following track.
    void (async () => {
      let added = false;
      let currentGeneration = false;
      try {
        added = await this.recommend(
          context,
          seeds,
          generation,
          playSomethingBy,
        );
      } finally {
        currentGeneration = generation === this.autoplayGeneration;
        if (currentGeneration) {
          this.autoplayPending = false;
          this.queueRender();
        }
      }
      if (added && currentGeneration) this.scheduleAutoplay();
    })();
  }

  private async recommend(
    context: string,
    seeds: string[],
    generation: number,
    playSomethingBy?: string,
  ): Promise<boolean> {
    const startedAt = Date.now();
    // Settings can change the mode while a pick resolves; log the one that
    // found it. Video mode's related videos are its related mode.
    const video = this.videoMode;
    const mode = video ? "related" : this.autoplayMode;
    this.log.debug(
      {
        event: "autoplay_recommendation_started",
        mode,
        video,
        seeds: seeds.length,
      },
      "Finding autoplay recommendation",
    );
    const giveUp = async (reason: string) => {
      this.audit.record("autoplay.recommendation_failed", undefined, {
        sessionId: this.id,
        seedSourceIds: seeds,
        reason,
      });
      if (playSomethingBy)
        await this.notice(
          playSomethingBy,
          "Could not find anything to play; add a song to get started.",
        );
      return false;
    };
    try {
      const recent = this.history.slice(-autoplayRecentWindow);
      const excluded = new Set([
        this.current?.sourceId,
        ...this.queue.map((track) => track.sourceId),
        ...recent.map((track) => track.sourceId),
        ...this.autoplayRejected,
      ]);
      const ranked = new Map<
        string,
        {
          id: string;
          seedCount: number;
          score: number;
          discovery?: boolean;
          listenerIds?: string[];
          sources?: string[];
          metadata?: TrackMetadata;
        }
      >();
      if (video) {
        const recommendations = await Promise.all(
          seeds
            .filter(isYoutubeVideoId)
            .map((seed) => this.tracks.relatedVideos(seed).catch(() => [])),
        );
        for (const videos of recommendations)
          videos.forEach((metadata, rank) => {
            const candidate = ranked.get(metadata.sourceId) ?? {
              id: metadata.sourceId,
              seedCount: 0,
              score: 0,
              sources: [relatedVideosSource],
              metadata,
            };
            candidate.seedCount++;
            candidate.score += 1 / (rank + 1);
            ranked.set(metadata.sourceId, candidate);
          });
      } else if (mode === "related") {
        const recommendations = await Promise.all(
          seeds.map((seed) => this.tracks.upNextIds(seed).catch(() => [])),
        );
        for (const ids of recommendations)
          [...new Set(ids)].forEach((id, rank) => {
            const candidate = ranked.get(id) ?? {
              id,
              seedCount: 0,
              score: 0,
              sources: ["related"],
            };
            candidate.seedCount++;
            candidate.score += 1 / (rank + 1);
            ranked.set(id, candidate);
          });
      } else if (this.recommendations) {
        // Every few picks, lead with something nobody in the huddle has
        // listened to so the mix is not only shared favourites.
        const discover =
          this.autoplaySinceDiscovery >= this.autoplayDiscoveryInterval - 1;
        const credited: Record<string, number> = {};
        for (const listener of this.autoplayCredits.flat())
          credited[listener] = (credited[listener] ?? 0) + 1;
        const listeners = this.listenerIds();
        const nowPlaying = this.current ?? this.history.at(-1);
        const extras = await this.recommendations.autoplayCandidates({
          userIds: listeners,
          nowPlaying,
          // An autoplay pick was for whoever it was credited to; anything
          // else was for whoever queued it.
          nowPlayingListenerIds: nowPlaying?.automatic
            ? (nowPlaying.listenerIds ?? [])
            : nowPlaying
              ? [nowPlaying.requesterId]
              : [],
          recent: [...recent, ...(this.current ? [this.current] : [])],
          exclude: excluded,
          skipped: {
            sourceIds: this.autoplayRejected,
            artists: this.autoplayRejectedArtists,
            tracks: recent,
          },
          discover,
          credited,
          lastCredited: this.autoplayCredits.at(-1),
          artistRun: this.artistRun(),
          fatigue: loadFatigue(this.store, {
            userIds: listeners,
            roomId: this.roomId,
          }),
        });
        // The catalog has already ordered these.
        extras.forEach((extra, index) => {
          ranked.set(extra.sourceId, {
            id: extra.sourceId,
            seedCount: 0,
            score: -index,
            discovery: extra.discovery,
            listenerIds: extra.listenerIds,
            sources: extra.sources,
            metadata: extra.metadata,
          });
        });
      }
      const ids = [...ranked.values()]
        .sort((a, b) => b.seedCount - a.seedCount || b.score - a.score)
        .map(({ id }) => id);
      const added = await this.queueFirstPlayable(
        ids,
        ranked,
        excluded,
        context,
        seeds,
        generation,
        startedAt,
        mode,
      );
      if (added !== undefined) return added;
      if (playSomethingBy && this.canAddAutoplay(context, generation)) {
        const popular = shuffle(await this.tracks.popularTracks()).filter(
          (track) => !excluded.has(track.sourceId),
        );
        this.log.info(
          { event: "autoplay_popular_fallback", candidates: popular.length },
          "Falling back to a popular song",
        );
        const played = await this.queueFirstPlayable(
          popular.slice(0, autoplayPopularAttempts).map((t) => t.sourceId),
          new Map(
            popular.map((metadata) => [
              metadata.sourceId,
              {
                id: metadata.sourceId,
                seedCount: 0,
                score: 0,
                sources: ["popular"],
                metadata,
              },
            ]),
          ),
          excluded,
          context,
          seeds,
          generation,
          startedAt,
          mode,
        );
        if (played !== undefined) return played;
      }
      this.log.warn(
        {
          event: "autoplay_recommendation_unavailable",
          durationMs: Date.now() - startedAt,
        },
        "No usable autoplay recommendation found",
      );
      return await giveUp("no usable recommendations");
    } catch (error) {
      this.logTrackFailure(
        {
          event: "autoplay_recommendation_failed",
          durationMs: Date.now() - startedAt,
        },
        error,
        "Autoplay recommendation failed",
      );
      return giveUp(safeAuditError(error));
    }
  }

  // Queues the first candidate that resolves and prepares. Returns true once
  // one is playing or queued, false when the session no longer wants an
  // autoplay track, and undefined when every candidate was unusable.
  private async queueFirstPlayable(
    ids: string[],
    ranked: Map<
      string,
      {
        id: string;
        seedCount: number;
        score: number;
        discovery?: boolean;
        listenerIds?: string[];
        sources?: string[];
        metadata?: TrackMetadata;
      }
    >,
    excluded: Set<string | undefined>,
    context: string,
    seeds: string[],
    generation: number,
    startedAt: number,
    mode: AutoplayMode,
  ): Promise<boolean | undefined> {
    for (const id of ids) {
      if (excluded.has(id)) continue;
      const discovery = ranked.get(id)?.discovery ?? false;
      const listenerIds = ranked.get(id)?.listenerIds ?? [];
      const autoplaySources = ranked.get(id)?.sources;
      let metadata = ranked.get(id)?.metadata;
      if (!metadata) {
        try {
          metadata = await this.tracks.resolveVideoId(id);
        } catch {
          continue;
        }
      }
      const pending = await this.enqueue(async () => {
        if (!this.canAddAutoplay(context, generation)) return;
        const currentIds = new Set([
          this.current?.sourceId,
          ...this.queue.map((track) => track.sourceId),
          ...this.history
            .slice(-autoplayRecentWindow)
            .map((track) => track.sourceId),
          ...this.autoplayRejected,
        ]);
        if (currentIds.has(metadata.sourceId)) return false;
        const entry: Entry = {
          ...metadata,
          id: crypto.randomUUID(),
          requesterId: this.botUserId,
          automatic: true,
          autoplayMode: mode,
          discovery,
          autoplaySources,
          ...(autoplaySources?.includes(relatedVideosSource)
            ? { relatedVideo: true }
            : {}),
          listenerIds,
          status: "preparing",
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
          seedSourceIds: seeds,
          ...auditTrack(entry),
        });
        this.notifyTrack("queue.added", entry, { automatic: true });
        await this.render();
        this.queueChanged();
        return { entry, controller };
      });
      if (pending === undefined) return false;
      if (pending === false) continue;
      if (await this.prepareAutoplay(pending.entry, pending.controller)) {
        this.log.info(
          {
            event: "autoplay_recommendation_added",
            entryId: pending.entry.id,
            sourceId: pending.entry.sourceId,
            discovery,
            listenerIds,
            durationMs: Date.now() - startedAt,
          },
          "Autoplay recommendation added",
        );
        return true;
      }
      if (!this.canAddAutoplay(context, generation)) return false;
    }
    return undefined;
  }

  private canAddAutoplay(context: string, generation: number) {
    return (
      this.autoplayOn() &&
      generation === this.autoplayGeneration &&
      !this.inactive() &&
      this.autoplayContext() === context &&
      this.autoplayHasRoom()
    );
  }

  // The song an autoplay pick would follow on from.
  private autoplayContext() {
    return this.current?.sourceId ?? this.history.at(-1)?.sourceId ?? "";
  }

  // Autoplay only ever tops up an empty queue, one song at a time.
  private autoplayHasRoom() {
    return (
      !this.queue.length &&
      Number(Boolean(this.current)) < this.config.queueLimit
    );
  }

  private async prepareAutoplay(entry: Entry, controller: AbortController) {
    const startedAt = Date.now();
    const prepared = this.download(entry, controller);
    try {
      const media = await prepared;
      return await this.enqueue(async () => {
        if (!(await this.acceptPrepared(entry, media))) return false;
        if (!this.current) await this.startNext();
        else {
          await this.render();
          this.syncPreloads();
        }
        this.log.debug(
          {
            event: "autoplay_track_prepared",
            entryId: entry.id,
            durationMs: Date.now() - startedAt,
          },
          "Autoplay track prepared",
        );
        return true;
      });
    } catch (error) {
      this.logTrackFailure(
        {
          event: "autoplay_track_preparation_failed",
          entryId: entry.id,
          sourceId: entry.sourceId,
          durationMs: Date.now() - startedAt,
        },
        error,
        "Autoplay track preparation failed",
      );
      return this.enqueue(async () => {
        if (!this.dropFailed(entry, error)) return false;
        // Someone kept this pick while it was still preparing, so it is
        // their song now and they hear why it went.
        if (!entry.automatic) {
          this.notifyTrack("queue.removed", entry, { reason: "failed" });
          await this.notice(
            entry.requesterId,
            `Could not prepare ${entry.title}: ${message(error)}`,
          );
        }
        if (!this.current) await this.startNext();
        else await this.render();
        return false;
      });
    }
  }

  private cancelAutoplay() {
    this.autoplayGeneration++;
    this.autoplayPending = false;
  }

  private takeQueuedAutoplay() {
    this.cancelAutoplay();
    const automatic = this.queue.filter((track) => track.automatic);
    this.queue = this.queue.filter((track) => !track.automatic);
    if (automatic.length) this.queueChanged();
    return automatic;
  }

  private restoreQueuedAutoplay(automatic: Entry[]) {
    if (!automatic.length) return;
    for (const entry of automatic) {
      if (this.queue.some((track) => track.id === entry.id)) continue;
      this.queue.push(entry);
    }
    this.queueChanged();
  }

  /**
   * Drops the prepared media of entries that just left the session. Queue loop
   * hands a finished track's file to its fresh copy, so a file outlives the
   * entry being dropped whenever another entry still plays it.
   */
  private async releaseMedia(...dropped: Entry[]) {
    const paths = new Set(
      dropped
        .map((entry) => entry.filePath)
        .filter((filePath): filePath is string => Boolean(filePath)),
    );
    const subtitles = new Set(
      dropped
        .map((entry) => entry.stream?.subtitles)
        .filter((path): path is string => Boolean(path)),
    );
    if (!paths.size && !subtitles.size) return;
    for (const entry of [this.current, ...this.queue, ...this.history])
      if (entry && !dropped.includes(entry)) {
        if (entry.filePath) paths.delete(entry.filePath);
        if (entry.stream?.subtitles) subtitles.delete(entry.stream.subtitles);
      }
    await Promise.all([
      ...[...paths].map((path) => removePreparedMedia(path)),
      ...[...subtitles].map((path) => rm(path, { force: true })),
    ]);
  }

  // A stream's captions file, once the entry plays something else and no
  // other entry shares it.
  private async releaseSubtitles(path: string) {
    const used = [this.current, ...this.queue, ...this.history].some(
      (entry) => entry?.stream?.subtitles === path,
    );
    if (!used) await rm(path, { force: true });
  }

  private async destroyQueuedAutoplay(automatic: Entry[]) {
    for (const entry of automatic) {
      this.preparations.get(entry.id)?.abort();
      this.store.removeTrack(entry.id);
    }
    await this.releaseMedia(...automatic);
  }

  private async rollbackAgentAdd(
    pending: { entry: Entry; controller: AbortController }[],
    heldAutoplay: Entry[],
  ) {
    for (const { controller } of pending) controller.abort();
    await this.enqueue(async () => {
      for (const { entry } of pending) {
        this.preparations.delete(entry.id);
        if (this.queue.includes(entry)) {
          this.queue = this.queue.filter((item) => item !== entry);
          if (entry.filePath) await removePreparedMedia(entry.filePath);
        }
        // Always drop the staged store row, even if prepareManual already
        // removed the queue entry before abort cleanup ran.
        this.store.removeTrack(entry.id);
      }
      this.restoreQueuedAutoplay(heldAutoplay);
      await this.render();
    });
  }

  private async removeQueuedAutoplay() {
    await this.destroyQueuedAutoplay(this.takeQueuedAutoplay());
  }

  private async startNext() {
    // After a restart, what was playing goes on first once it is ready
    // again, not whatever else was ready sooner.
    const interrupted = this.interrupted;
    if (interrupted?.status === "preparing" && this.queue.includes(interrupted))
      return this.render();
    this.interrupted = undefined;
    const next = this.queue.find((track) => track.status === "ready");
    if (!next) {
      this.playbackScrobbling?.finish();
      this.current = undefined;
      this.state = "ready";
      this.sendMedia({ type: "stop" });
      this.notifyIntegrations("playback.ready", { state: "ready" });
      await this.render();
      this.sessionChanged();
      this.log.info({ event: "queue_idle" }, "No playable track in queue");
      return this.refreshIdle();
    }
    this.queue.splice(this.queue.indexOf(next), 1);
    this.queueChanged();
    this.current = next;
    // A resumed item starts where it was left.
    this.playbackSeconds = next.live ? 0 : (next.startAt ?? 0);
    next.startAt = undefined;
    next.status = "playing";
    next.streamRetries = 0;
    if (next.live) next.liveSince = Date.now();
    await this.useCachedVideo(next);
    // An autoplay pick only counts towards fairness and discovery cadence
    // once it actually plays; a queued pick can still be displaced by a
    // manual add, and Previous can bring a played one back.
    if (next.automatic && !next.counted) {
      next.counted = true;
      if (next.discovery) this.autoplaySinceDiscovery = 0;
      else this.autoplaySinceDiscovery++;
      this.autoplayCredits = [
        ...this.autoplayCredits,
        next.listenerIds ?? [],
      ].slice(-autoplayCreditWindow);
    }
    this.state = "playing";
    this.store.setTrack(next.id, { status: "playing" });
    this.store.setSession(this.id, {
      status: "playing",
      playbackSeconds: this.playbackSeconds,
    });
    this.audit.record("track.started", undefined, {
      sessionId: this.id,
      ...auditTrack(next),
    });
    this.notifyTrack("track.started", next);
    this.notifyIntegrations("playback.playing", { state: "playing" });
    this.sessionChanged();
    this.log.info(
      {
        event: "track_started",
        entryId: next.id,
        sourceId: next.sourceId,
        title: next.title,
        artist: next.artist,
        automatic: Boolean(next.automatic),
        queueLength: this.queue.length,
      },
      "Track started",
    );
    this.startScrobbling(next, 0);
    await this.markWatched(next);
    this.noteSessionRecommendations();
    this.sendMedia(await this.playMessage(next));
    if (this.playbackSeconds)
      this.sendMedia({ type: "seek", seconds: this.playbackSeconds });
    this.jellyfinUi?.playing(next, this.playbackSeconds, false, true);
    if (next.live) this.sendLyrics(next);
    else if (!this.videoMode)
      void this.loadLyrics(next).then((lyrics) => {
        if (this.current !== next || this.videoMode) return;
        captureAnalytics(lyrics ? "lyrics.available" : "lyrics.unavailable", {
          distinctId: next.automatic
            ? undefined
            : next.requesterId || undefined,
          sessionId: this.id,
          properties: {
            trackId: next.id,
            sourceId: next.sourceId,
            origin: next.automatic ? "autoplay" : "manual",
            ...(lyrics
              ? { source: lyrics.source, lines: lyrics.lines.length }
              : {}),
          },
        });
        if (lyrics) {
          this.log.info(
            {
              event: "lyrics_loaded",
              entryId: next.id,
              source: lyrics.source,
              lines: lyrics.lines.length,
            },
            "Track lyrics loaded",
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

  artworkPath(entryId: string, token: string) {
    if (token !== this.mediaToken) return;
    const entry = [this.current, ...this.queue, ...this.history].find(
      (entry) => entry?.id === entryId,
    );
    if (entry?.stream) return entry.stream.cover;
    return entry?.filePath ? embeddedArtworkPath(entry.filePath) : undefined;
  }

  private mediaUrl(entry: Entry) {
    return `http://127.0.0.1:${this.config.port}/audio/${entry.id}?token=${encodeURIComponent(this.mediaToken)}`;
  }

  private mediaArtworkUrl(entry: Entry) {
    return `http://127.0.0.1:${this.config.port}/artwork/${entry.id}?token=${encodeURIComponent(this.mediaToken)}`;
  }

  private async playMessage(entry: Entry) {
    // A listener can take their name off the songs they added.
    const requesterLabel = entry.automatic
      ? "Autoplay recommendation"
      : entry.requesterId === this.botUserId
        ? undefined
        : entry.requesterId
          ? `Added by ${await this.slack.userName(entry.requesterId)}`
          : "Added by a listener";
    const coverPath = entry.stream
      ? entry.stream.cover
      : entry.filePath && embeddedArtworkPath(entry.filePath);
    const localArtwork =
      coverPath && (await Bun.file(coverPath).exists())
        ? this.mediaArtworkUrl(entry)
        : undefined;
    // In video mode a prepared video shows on the screen share, with its
    // captions for when they are on.
    const shown =
      this.videoMode &&
      Boolean(entry.filePath || entry.stream) &&
      (entry.form === "video" || entry.form === "music_video");
    const captionsFile = entry.stream
      ? entry.stream.subtitles
      : entry.filePath && captionsPath(entry.filePath);
    const captions =
      shown && captionsFile && (await Bun.file(captionsFile).exists())
        ? resolvePath(captionsFile)
        : undefined;
    return {
      type: "play",
      entryId: entry.id,
      url: entry.stream?.url ?? this.mediaUrl(entry),
      ...(entry.stream
        ? {
            stream: defined({
              proxy: entry.stream.local ? undefined : this.tracks.streamProxy,
              headers: entry.stream.headers,
              live: entry.stream.live,
              audioStream: entry.stream.audioStream,
            }),
          }
        : {}),
      ...(shown
        ? {
            video: defined({
              subtitles: captions,
              url: entry.stream?.videoUrl,
            }),
          }
        : {}),
      ...(entry.gainDb !== undefined ? { gainDb: entry.gainDb } : {}),
      title: entry.title,
      artist: entry.artist,
      album: entry.album,
      artwork: entry.artwork ?? localArtwork,
      duration: entry.duration,
      sourceId: entry.sourceId,
      introSeconds: entry.introSeconds ?? 0,
      outroSeconds: entry.outroSeconds ?? entry.duration,
      fadeOutSeconds: entry.fadeOutSeconds ?? 0,
      requesterLabel,
    };
  }

  private syncPreloads() {
    const first =
      this.loopMode === "track"
        ? undefined
        : this.queue.find((entry) => entry.status === "ready");
    // A stream is never preloaded, and nothing past it is either: it plays
    // next, so nothing may crossfade in ahead of it.
    const next = first?.filePath ? first : undefined;
    const entries = [next, this.history.at(-1)].filter(
      (entry, index, all): entry is Entry =>
        Boolean(entry?.filePath) &&
        all.findIndex((other) => other?.id === entry?.id) === index,
    );
    if (next && !this.videoMode) void this.loadLyrics(next);
    this.sendMedia({
      type: "preload",
      nextEntryId: next?.id,
      entries: entries.map((entry) => ({
        entryId: entry.id,
        url: this.mediaUrl(entry),
        introSeconds: entry.introSeconds ?? 0,
        fadeInSeconds: entry.fadeInSeconds ?? 0,
        ...(entry.gainDb !== undefined ? { gainDb: entry.gainDb } : {}),
      })),
    });
  }

  private loadLyrics(entry: Entry) {
    return (entry.lyrics ??= this.lyrics.get(entry).catch((error) => {
      this.log.warn(
        { event: "lyrics_failed", entryId: entry.id, err: error },
        "Track lyrics failed",
      );
      return undefined;
    }));
  }

  // Sooner the sooner it plays: the track playing, being prepared again,
  // first, then the queue in order. An autoplay pick only fills an empty
  // queue, so it is what plays next. One no longer wanted comes last.
  private preparationPriority(entry: Entry) {
    if (entry === this.current) return 1;
    const index = this.queue.indexOf(entry);
    return index < 0 ? -Infinity : -index;
  }

  private prepared(
    entry: Entry,
    media: PreparedMedia & { videoChecked?: boolean },
  ) {
    const { filePath, stream, form, gainDb } = media;
    const previousSubtitles = entry.stream?.subtitles;
    const transition = filePath
      ? this.tracks.transition?.(filePath)
      : undefined;
    if (filePath) this.loadChapters(entry, filePath);
    else entry.chapters = media.chapters;
    Object.assign(entry, {
      filePath,
      stream,
      form,
      gainDb,
      videoChecked: media.videoChecked,
      status: entry === this.current ? entry.status : "ready",
      ...transition,
    });
    if (media.leveling) void this.levelLater(entry, media);
    if (previousSubtitles && previousSubtitles !== stream?.subtitles)
      void this.releaseSubtitles(previousSubtitles);
    this.store.setTrack(entry.id, {
      ...(entry === this.current ? {} : { status: "ready" }),
      filePath: filePath ?? null,
      form,
      gainDb: gainDb ?? null,
      title: entry.title,
      artist: entry.artist,
      album: entry.album ?? null,
      duration: entry.duration ?? null,
      artwork: entry.artwork ?? null,
      ...transition,
    });
    // The mode changed while it was being prepared.
    if (!this.formFits(entry)) this.reprepare(entry);
  }

  // Turns a video to its loudness once that has been measured, which
  // glides in when it is already playing.
  private async levelLater(entry: Entry, media: PreparedMedia) {
    const gainDb = await media.leveling;
    if (gainDb === undefined) return;
    await this.enqueue(() => {
      // Prepared again since as something else, such as its audio for music.
      if (this.inactive() || entry.form !== media.form) return;
      entry.gainDb = gainDb;
      this.store.setTrack(entry.id, { gainDb });
      if (this.current === entry)
        this.sendMedia({ type: "gain", entryId: entry.id, gainDb });
      else this.syncPreloads();
    });
  }

  // A streamed video whose download behind it has finished plays from the
  // file, rather than from an address that may since have expired.
  private async useCachedVideo(entry: Entry) {
    const stream = entry.stream;
    if (!stream?.cacheKey) return;
    const filePath = await this.tracks
      .cachedStream(stream, `data/media/${this.id}`, entry.id)
      .catch((error) => {
        this.log.warn(
          { event: "cached_video_failed", entryId: entry.id, err: error },
          "Streaming the video again instead of playing it from the cache",
        );
        return undefined;
      });
    if (!filePath || entry.stream !== stream) return;
    this.prepared(entry, {
      filePath,
      form: entry.form ?? "video",
      videoChecked: entry.videoChecked,
      gainDb: entry.gainDb,
    });
  }

  // Reads a prepared video's chapters onto its entry, for Jump to.
  private loadChapters(entry: Entry, filePath: string) {
    entry.chapters = undefined;
    void readChapters(filePath).then((chapters) => {
      if (entry.filePath === filePath) entry.chapters = chapters;
    });
  }

  // Whether a prepared track suits the mode: music plays a song, not its
  // video; video mode wants a video's picture, and a song's video once it
  // has been looked for.
  private formFits(entry: Entry) {
    if (!entry.filePath && !entry.stream) return true;
    // A live stream's picture is not wanted for music, nor fetched.
    if (!this.videoMode)
      return entry.stream
        ? entry.form === "audio"
        : entry.form !== "music_video";
    if (entry.videoChecked) return true;
    return trackKind(entry) === "video"
      ? entry.form === "video"
      : entry.form === "music_video";
  }

  // Prepares the playing and queued tracks again for the mode, where they
  // were prepared for the other one.
  private syncForms() {
    // Queued tracks still preparing take the mode when they finish.
    const prepared = [
      ...(this.current ? [this.current] : []),
      ...this.queue.filter((entry) => entry.status === "ready"),
    ];
    for (const entry of prepared)
      if (!this.formFits(entry)) this.reprepare(entry);
  }

  /**
   * Prepares a track again for the mode it is now in, keeping what it has
   * until that is ready. The playing track then carries on in the new form:
   * where it was when the source is the same, from the top when a song
   * became its video or went back.
   */
  private reprepare(entry: Entry) {
    if (this.reprepares.has(entry.id) || this.preparations.has(entry.id))
      return;
    const controller = new AbortController();
    this.reprepares.set(entry.id, controller);
    const mode = this.mediaMode;
    const done = () => {
      if (this.reprepares.get(entry.id) === controller)
        this.reprepares.delete(entry.id);
    };
    void this.download(entry, controller).then(
      (media) =>
        this.enqueue(async () => {
          done();
          const wanted = this.current === entry || this.queue.includes(entry);
          if (
            controller.signal.aborted ||
            this.inactive() ||
            mode !== this.mediaMode ||
            !wanted
          ) {
            if (media.filePath) await this.discardMedia(media.filePath);
            return;
          }
          const previous = { filePath: entry.filePath, form: entry.form };
          const sameSource =
            previous.form !== "music_video" && media.form !== "music_video";
          this.prepared(entry, media);
          if (media.fellBack) await this.videoFellBack(entry);
          if (this.current === entry) {
            if (!sameSource) {
              this.playbackSeconds = 0;
              this.store.setSession(this.id, { playbackSeconds: 0 });
            }
            await this.sendCurrent(entry);
            this.startScrobbling(entry);
            await this.markWatched(entry);
          } else this.syncPreloads();
          if (previous.filePath && previous.filePath !== media.filePath)
            await this.discardMedia(previous.filePath);
          this.log.info(
            {
              event: "track_reprepared",
              entryId: entry.id,
              form: media.form,
              mode,
            },
            "Track prepared again for the mode",
          );
          this.queueRender();
        }),
      (error) =>
        this.enqueue(async () => {
          done();
          if (controller.signal.aborted || this.inactive()) return;
          this.logTrackFailure(
            {
              event: "track_reprepare_failed",
              entryId: entry.id,
              sourceId: entry.sourceId,
              mode,
            },
            error,
            "Could not prepare the track again for the mode",
          );
          if (mode !== this.mediaMode) return;
          // It plays as it is rather than not at all, and is not tried again.
          entry.videoChecked = this.videoMode || undefined;
          if (
            this.videoMode &&
            trackKind(entry) === "video" &&
            (this.current === entry || this.queue.includes(entry))
          )
            await this.videoNotice(
              entry,
              `Couldn’t load the video for ${entry.title}, so it will play as audio.`,
            );
        }),
    );
  }

  // Played tracks before the last few give up their files and lyrics, which
  // would otherwise pile up until the session ends; they keep what they
  // were, for the history and autoplay.
  private async releaseHistory() {
    const released: string[] = [];
    for (const entry of this.history.slice(0, -keptHistory)) {
      entry.lyrics = undefined;
      if (!entry.filePath) continue;
      released.push(entry.filePath);
      entry.filePath = undefined;
      entry.chapters = undefined;
      this.store.setTrack(entry.id, { filePath: null });
    }
    try {
      for (const filePath of released) await this.discardMedia(filePath);
    } catch (error) {
      this.log.warn(
        { event: "history_release_failed", err: error },
        "Could not remove a played track's files",
      );
    }
  }

  // Removes a prepared file once no track uses it.
  private async discardMedia(filePath: string) {
    const used = [this.current, ...this.queue, ...this.history].some(
      (other) => other?.filePath === filePath,
    );
    if (!used) await removePreparedMedia(filePath);
  }

  private async advance(reason = "played", expectedId?: string) {
    if (expectedId && this.current?.id !== expectedId) return;
    if (this.current) {
      this.log.info(
        {
          event: "track_advanced",
          entryId: this.current.id,
          reason,
          playbackSeconds: this.playbackSeconds,
          loopMode: this.loopMode,
        },
        "Track advanced",
      );
      const end =
        reason === "transition"
          ? (this.current.outroSeconds ?? this.current.duration)
          : this.current.duration;
      const natural = reason === "track_ended" || reason === "transition";
      if (reason === "track_ended" && this.current.live)
        await this.notice(
          this.current.requesterId,
          `The live stream ${this.current.title} has ended.`,
        );
      if (natural && this.current.discovery)
        this.autoplayDiscoveryInterval = autoplayDiscoveryEvery;
      if (natural && end) {
        this.playbackScrobbling?.position(end);
        this.countTime(end - this.playbackSeconds);
      }
      if (natural && this.loopMode === "track") {
        this.playbackScrobbling?.finish();
        this.audit.record("track.finished", undefined, {
          sessionId: this.id,
          ...auditTrack(this.current),
          looped: "track",
        });
        this.notifyTrack("track.finished", this.current);
        this.playbackSeconds = 0;
        this.store.setSession(this.id, {
          listenedSeconds: this.listenedSeconds,
          playbackSeconds: 0,
        });
        this.sendMedia({
          type: "replay",
          entryId: this.current.id,
          introSeconds: this.current.introSeconds ?? 0,
        });
        this.startScrobbling(this.current, 0);
        this.notifyTrack("track.started", this.current);
        await this.render();
        return;
      }
      this.playbackScrobbling?.finish();
      this.jellyfinUi?.stopped(
        this.current.id,
        natural ? this.current.duration : this.playbackSeconds,
      );
      const played = [
        "played",
        "track_ended",
        "transition",
        "skipped",
      ].includes(reason);
      this.current.status = played ? "played" : "failed";
      if (played) this.history.push(this.current);
      this.store.setTrack(this.current.id, { status: this.current.status });
      if (played) void this.releaseHistory();
      if (natural) {
        this.audit.record("track.finished", undefined, {
          sessionId: this.id,
          ...auditTrack(this.current),
        });
        this.notifyTrack("track.finished", this.current);
      }
      if (reason === "track_error" || reason === "stalled") {
        this.audit.record("track.failed", undefined, {
          sessionId: this.id,
          ...auditTrack(this.current),
          reason,
        });
        this.notifyIntegrations("track.failed", {
          id: this.current.id,
          title: this.current.title,
          artist: this.current.artist,
          reason,
        });
      }
      // A copy needs the finished track's prepared file: nothing schedules
      // preparation for an entry pushed straight onto the queue, so a copy
      // without one could never become playable.
      if (
        natural &&
        this.loopMode === "queue" &&
        played &&
        // A Jellyfin item streams again; a live stream that ended is gone.
        (this.current.filePath || (this.current.stream && !this.current.live))
      ) {
        const finished = this.current;
        const transition = defined({
          introSeconds: finished.introSeconds,
          outroSeconds: finished.outroSeconds,
          fadeInSeconds: finished.fadeInSeconds,
          fadeOutSeconds: finished.fadeOutSeconds,
        });
        const looping: Entry = {
          sourceInput: finished.sourceInput,
          canonicalUrl: finished.canonicalUrl,
          sourceId: finished.sourceId,
          title: finished.title,
          artist: finished.artist,
          ...(finished.album ? { album: finished.album } : {}),
          ...(finished.duration !== undefined
            ? { duration: finished.duration }
            : {}),
          ...(finished.artwork ? { artwork: finished.artwork } : {}),
          id: crypto.randomUUID(),
          requesterId: finished.requesterId,
          ...(finished.automatic
            ? defined({
                automatic: true,
                autoplayMode: finished.autoplayMode,
                discovery: finished.discovery,
                autoplaySources: finished.autoplaySources,
              })
            : {}),
          status: "ready",
          ...defined({
            filePath: finished.filePath,
            stream: finished.stream,
            form: finished.form,
            kind: finished.kind,
            chapters: finished.chapters,
            videoChecked: finished.videoChecked,
            gainDb: finished.gainDb,
          }),
          ...transition,
        };
        this.queue.push(looping);
        this.store.addTrack({
          ...looping,
          sessionId: this.id,
          status: looping.status,
        });
        this.store.setTrack(looping.id, {
          status: "ready",
          ...(looping.filePath ? { filePath: looping.filePath } : {}),
          ...(looping.gainDb !== undefined ? { gainDb: looping.gainDb } : {}),
          ...transition,
        });
        this.queueChanged();
      }
    }
    this.store.setSession(this.id, {
      listenedSeconds: this.listenedSeconds,
      watchedSeconds: this.watchedSeconds,
    });
    this.current = undefined;
    await this.startNext();
  }

  /**
   * A track that stopped playing. A stream is picked up again a couple of
   * times, from where it was or, live, from where it is now, since a far
   * server's hiccup should not cost the room what it was watching. Anything
   * else, or a stream that keeps failing, moves on.
   */
  private async streamFailed(reason: string, entryId?: string) {
    const entry = this.current;
    if (!entry?.stream || entry.id !== entryId)
      return this.advance(reason, entryId);
    // Runs in the session's queue of actions, which this already is in.
    const skip = async (error?: unknown) => {
      if (this.current !== entry) return;
      await this.notice(
        entry.requesterId,
        error && isExpectedTrackFailure(error)
          ? `${entry.title} stopped playing: ${message(error)}`
          : entry.live
            ? `The live stream ${entry.title} stopped working, so it was skipped.`
            : `${entry.title} stopped streaming, so it was skipped.`,
      );
      await this.advance(reason, entry.id);
    };
    if ((entry.streamRetries ?? 0) >= 2) return skip();
    entry.streamRetries = (entry.streamRetries ?? 0) + 1;
    entry.streamRetriedAt = Date.now();
    // A video that would not stream twice is downloaded for its last try,
    // with the download's own retries and its fallback to the sound.
    if (entry.streamRetries === 2 && !entry.live && !entry.stream.jellyfin)
      entry.download = true;
    this.log.warn(
      {
        event: "stream_retry",
        entryId: entry.id,
        reason,
        attempt: entry.streamRetries,
      },
      "Picking the stream up again",
    );
    const controller = new AbortController();
    void this.download(entry, controller).then(
      (media) =>
        this.enqueue(async () => {
          if (this.current !== entry || this.inactive()) return;
          this.prepared(entry, media);
          if (media.fellBack) await this.videoFellBack(entry);
          await this.sendCurrent(entry);
        }),
      (error) => this.enqueue(() => skip(error)),
    );
  }

  private async next(interaction: Interaction, expectedId?: string) {
    if (!(await this.require(interaction, "skip"))) return;
    if (!expectedId || this.current?.id !== expectedId)
      return this.notice(
        interaction.userId,
        "Nothing was playing when you pressed Next.",
      );
    await this.skipCurrent(interaction.userId);
  }

  // Skips the playing track. Callers have checked that one is playing.
  private async skipCurrent(userId: string) {
    const skipped = this.current!;
    this.audit.record("track.skipped", userId, {
      sessionId: this.id,
      ...auditTrack(skipped),
      playedSeconds: Math.round(this.playbackSeconds),
      duration: skipped.duration,
    });
    this.notifyTrack("track.skipped", skipped);
    this.store.incrementUsage("next");
    this.rejectSkipped(skipped, userId);
    await this.advance("skipped");
    this.scheduleAutoplay();
    return skipped;
  }

  private async previous(interaction: Interaction) {
    if (!(await this.require(interaction, "skip"))) return;
    if (!(await this.goBack(interaction.userId)))
      return this.notice(
        interaction.userId,
        "Nothing was playing when you pressed Previous.",
      );
  }

  // Restarts the playing track once it is a few seconds in, and otherwise
  // returns to the one before it. Reports which happened, or nothing when
  // there was nowhere to go back to.
  private async goBack(userId: string) {
    const current = this.current;
    if (current && (this.playbackSeconds > 5 || !this.history.length)) {
      this.audit.record("track.previous", userId, {
        sessionId: this.id,
        ...auditTrack(current),
        restarted: true,
      });
      this.store.incrementUsage("previous");
      this.playbackSeconds = 0;
      this.sendMedia({ type: "seek", seconds: 0 });
      this.plugins.changed();
      return { restarted: current };
    }
    if (!this.history.length) return;
    const prior = this.history.pop()!;
    this.audit.record("track.previous", userId, {
      sessionId: this.id,
      ...auditTrack(prior),
    });
    this.store.incrementUsage("previous");
    if (this.current) this.requeue(this.current);
    this.current = undefined;
    if (prior.filePath || prior.stream) this.requeue(prior);
    else {
      // Played too long ago to have kept its file, so it is prepared again,
      // and plays first once it is ready, as after a restart.
      prior.status = "preparing";
      this.queue.unshift(prior);
      this.store.setTrack(prior.id, { status: "preparing" });
      this.interrupted = prior;
      this.playbackScrobbling?.finish();
      this.sendMedia({ type: "stop" });
      void this.prepareRestored(prior);
    }
    await this.startNext();
    return { prior };
  }

  private requeue(entry: Entry) {
    entry.status = "ready";
    this.queue.unshift(entry);
    this.store.setTrack(entry.id, { status: "ready" });
  }

  private async seek(interaction: Interaction, offset: number) {
    if (!(await this.require(interaction, "skip")) || !this.current) return;
    if (this.current.live)
      return this.notice(
        interaction.userId,
        "A live stream plays where it is now, so it can't be skipped through.",
      );
    this.seekBy(interaction.userId, offset);
  }

  private seekBy(userId: string, offset: number) {
    const previous = this.playbackSeconds;
    this.playbackSeconds = Math.min(
      this.current?.duration ?? Infinity,
      Math.max(0, previous + offset),
    );
    this.sendMedia({ type: "seek", offset });
    this.plugins.changed();
    this.jellyfinUi?.playing(
      this.current!,
      this.playbackSeconds,
      this.state === "paused",
      true,
    );
    this.audit.record("playback.seeked", userId, {
      sessionId: this.id,
      trackId: this.current!.id,
      previous,
      seconds: this.playbackSeconds,
    });
    this.store.incrementUsage(offset > 0 ? "forward" : "back");
  }

  private async toggle(interaction: Interaction) {
    if (!(await this.require(interaction, "pause")) || !this.current) return;
    await this.setPlayback(
      interaction.userId,
      this.state === "paused" ? "playing" : "paused",
    );
  }

  private async setPlayback(userId: string, next: "paused" | "playing") {
    this.state = next;
    const paused = next === "paused";
    const event = `playback.${paused ? "paused" : "resumed"}`;
    if (paused) this.playbackScrobbling?.pause();
    else this.playbackScrobbling?.resume();
    // Falling behind a live stream is rarely what a group wants, so resuming
    // one joins it where it is now.
    if (!paused && this.current?.live)
      this.sendMedia({
        type: "replay",
        entryId: this.current.id,
        introSeconds: 0,
      });
    else this.sendMedia({ type: paused ? "pause" : "resume" });
    if (this.current)
      this.jellyfinUi?.playing(
        this.current,
        this.playbackSeconds,
        paused,
        true,
      );
    this.store.setSession(this.id, { status: next });
    this.audit.record(event, userId, {
      sessionId: this.id,
      trackId: this.current!.id,
    });
    this.store.incrementUsage(paused ? "paused" : "resumed");
    this.notifyIntegrations(event, { state: next });
    this.sessionChanged();
    await this.render();
    this.refreshIdle();
  }

  private async changeVolume(interaction: Interaction, delta: number) {
    if (!(await this.require(interaction, "volume"))) return;
    await this.setVolume(
      interaction.userId,
      Math.max(
        0,
        Math.min(1, Math.round((this.volume + delta) * 10_000) / 10_000),
      ),
    );
  }

  private async setVolume(userId: string, volume: number) {
    const previous = this.volume;
    this.volume = volume;
    this.sendMedia({ type: "volume", value: volume });
    this.store.setSession(this.id, { volume });
    this.audit.record("volume.changed", userId, {
      sessionId: this.id,
      previous,
      volume,
    });
    this.store.incrementUsage("volume");
    this.notifyIntegrations("volume.changed", {
      volumePercent: Math.round(volume * 100),
    });
    await this.render();
  }

  private canRemove(userId: string, entry: Entry) {
    return (
      this.can(userId, "manage-queue") ||
      (entry.requesterId === userId && this.can(userId, "remove-own"))
    );
  }

  private async remove(interaction: Interaction) {
    if (interaction.metadata && !this.validQueueView(interaction))
      return this.notice(
        interaction.userId,
        "That queue view is stale; reopen it.",
      );
    const entry = this.queue.find((track) => track.id === interaction.value);
    if (!entry) return;
    if (!this.canRemove(interaction.userId, entry)) {
      this.audit.record("action.denied", interaction.userId, {
        sessionId: this.id,
        capability: "manage-queue",
      });
      return this.notice(
        interaction.userId,
        "You do not have permission for that.",
      );
    }
    await this.removeEntry(interaction.userId, entry, interaction);
  }

  private async removeEntry(
    userId: string,
    entry: Entry,
    interaction?: Interaction,
  ) {
    this.queue.splice(this.queue.indexOf(entry), 1);
    this.preparations.get(entry.id)?.abort();
    this.store.removeTrack(entry.id);
    if (entry.automatic) this.rejectSkipped(entry, userId);
    this.audit.record("track.removed", userId, {
      sessionId: this.id,
      ...auditTrack(entry),
    });
    this.notifyTrack("queue.removed", entry);
    this.store.incrementUsage("removed");
    this.queueChanged(interaction);
    await this.releaseMedia(entry);
    // The rest were held back for it.
    if (entry === this.interrupted && !this.current) return this.startNext();
    await this.render();
    this.syncPreloads();
    this.refreshIdle();
    this.scheduleAutoplay();
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
    await this.moveEntry(interaction.userId, index, target, false, interaction);
  }

  private async playNext(interaction: Interaction) {
    if (!this.validQueueView(interaction))
      return this.notice(
        interaction.userId,
        "That queue view is stale; reopen it.",
      );
    if (!(await this.require(interaction, "manage-queue"))) return;
    const index = this.queue.findIndex(
      (track) => track.id === interaction.value,
    );
    if (index <= 0) return;
    await this.moveEntry(interaction.userId, index, 0, true, interaction);
  }

  // Turns the queued autoplay pick into a song the user asked for, so it
  // stays put when someone else queues a song and counts as theirs.
  private async keepAutoplay(interaction: Interaction) {
    if (!this.validQueueView(interaction))
      return this.notice(
        interaction.userId,
        "That queue view is stale; reopen it.",
      );
    if (!(await this.require(interaction, "add"))) return;
    await this.keepAutoplayEntry(interaction.userId, interaction.value);
    this.queueChanged(interaction);
  }

  /**
   * Keeps an autoplay pick in the queue as the user's own request. Returns
   * whether there was such a pick.
   */
  private async keepAutoplayEntry(userId: string, trackId: string | undefined) {
    const entry = this.queue.find(
      (track) => track.id === trackId && track.automatic,
    );
    if (!entry) return false;
    entry.automatic = false;
    entry.requesterId = userId;
    void this.slack.userName(userId);
    delete entry.autoplayMode;
    delete entry.discovery;
    delete entry.autoplaySources;
    delete entry.listenerIds;
    this.store.setTrack(entry.id, {
      automatic: false,
      requesterId: userId,
    });
    this.audit.record("track.added", userId, {
      sessionId: this.id,
      ...auditTrack(entry),
      reason: "autoplay_kept",
    });
    this.notifyTrack("queue.added", entry, { reason: "autoplay_kept" });
    this.store.incrementUsage("added");
    void this.recommendations?.refreshUser(userId);
    await this.render();
    return true;
  }

  private async moveEntry(
    userId: string,
    from: number,
    to: number,
    playNext: boolean,
    interaction?: Interaction,
  ) {
    const [entry] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, entry!);
    this.audit.record("queue.reordered", userId, {
      sessionId: this.id,
      trackId: entry!.id,
      from,
      to,
      ...(playNext ? { reason: "play_next" } : {}),
    });
    this.notifyIntegrations("queue.reordered", {
      trackId: entry!.id,
      from,
      to,
    });
    this.store.incrementUsage("reordered");
    this.queueChanged(interaction);
    await this.render();
    this.syncPreloads();
    return entry!;
  }

  private async shuffleQueue(interaction: Interaction) {
    // Older player messages carry no view metadata; the queue dialog does.
    if (interaction.metadata && !this.validQueueView(interaction))
      return this.notice(
        interaction.userId,
        "That queue view is stale; reopen it.",
      );
    if (!(await this.require(interaction, "manage-queue"))) return;
    await this.applyShuffle(interaction.userId, interaction);
  }

  /**
   * Randomizes the pending queue in place. The playing track is not part of
   * the queue and so never moves, and queued autoplay picks keep their slots:
   * the coordinator holds at most one, drops it the moment somebody queues a
   * song of their own, and takes and restores it as a unit, so a shuffle only
   * reorders what people actually asked for.
   */
  private async applyShuffle(actorId: string, interaction?: Interaction) {
    const requested = this.queue.filter((track) => !track.automatic);
    if (requested.length < 2) return 0;
    const shuffled = reshuffle(requested);
    let index = 0;
    this.queue = this.queue.map((track) =>
      track.automatic ? track : shuffled[index++]!,
    );
    this.audit.record("queue.shuffled", actorId, {
      sessionId: this.id,
      count: requested.length,
    });
    this.notifyIntegrations("queue.shuffled", { count: requested.length });
    this.store.incrementUsage("shuffled");
    this.store.setQueueOrder(
      this.id,
      this.queue.map((track) => track.id),
    );
    this.queueChanged(interaction);
    await this.render();
    this.syncPreloads();
    return requested.length;
  }

  private shufflableCount() {
    return this.queue.filter((track) => !track.automatic).length;
  }

  private async clear(interaction: Interaction) {
    if (interaction.metadata && !this.validQueueView(interaction))
      return this.notice(
        interaction.userId,
        "That queue view is stale; reopen it.",
      );
    if (!(await this.require(interaction, "clear"))) return;
    await this.clearQueue(interaction.userId, interaction);
  }

  private async clearQueue(userId: string, interaction?: Interaction) {
    this.cancelAutoplay();
    const cleared = this.queue;
    const count = cleared.length;
    this.queue = [];
    for (const entry of cleared) {
      this.preparations.get(entry.id)?.abort();
      this.store.removeTrack(entry.id);
    }
    await this.releaseMedia(...cleared);
    this.queueChanged(interaction);
    this.audit.record("queue.cleared", userId, { sessionId: this.id, count });
    this.notifyIntegrations("queue.cleared", { count });
    this.store.incrementUsage("cleared");
    await this.render();
    this.syncPreloads();
    this.refreshIdle();
    this.scheduleAutoplay();
    return count;
  }

  private async addModal(interaction: Interaction) {
    if (!interaction.triggerId) return;
    if (
      !this.can(interaction.userId, "add") &&
      !this.can(interaction.userId, "add-bulk")
    ) {
      await this.require(interaction, "add");
      return;
    }
    this.prefetchRecommendations(interaction.userId);
    await this.slack.modal(
      interaction.triggerId,
      await this.addView(interaction.userId),
    );
  }

  // The add dialog, with the video hint under the search when it holds a
  // video link in music mode. Video mode searches YouTube, and leaves out the
  // music recommendations and recent songs.
  private async addView(
    userId: string,
    videoHint = false,
    source: "search" | "jellyfin" = "search",
  ) {
    const jellyfin =
      source === "jellyfin" && Boolean(this.jellyfinUi?.hasServers(userId));
    const recent =
      this.videoMode || jellyfin
        ? []
        : this.store.recentTracks(userId, recentTrackLimit);
    const recommended =
      this.videoMode || jellyfin
        ? undefined
        : this.recommendations?.userRecommendations(
            userId,
            this.sessionExclusions(),
          );
    const recommendedGroups = [
      { label: "Your favourites", tracks: recommended?.favourites ?? [] },
      { label: "Discover", tracks: recommended?.discover ?? [] },
    ]
      .filter((group) => group.tracks.length)
      .map((group) => ({
        label: plain(group.label),
        options: group.tracks.map((track) => ({
          text: plain(shorten(`${track.title} — ${track.artist}`, 75)),
          value: track.id,
        })),
      }));
    // Whoever has linked Jellyfin picks where to search.
    const sourceOption = (value: string, label: string) => ({
      text: plain(label),
      value,
    });
    const sources = [
      sourceOption("search", "YouTube"),
      sourceOption("jellyfin", "Jellyfin"),
    ];
    const sourcePicker = when(
      this.jellyfinUi?.hasServers(userId),
      actions("add_source", [
        {
          type: "static_select",
          action_id: "add_source",
          options: sources,
          initial_option: sources[jellyfin ? 1 : 0],
        },
      ]),
    );
    if (jellyfin)
      return {
        type: "modal",
        callback_id: "add_track_to_queue",
        private_metadata: JSON.stringify({
          sessionId: this.id,
          source: "jellyfin",
        }),
        title: plain("Add to queue"),
        submit: plain("Add"),
        close: plain("Cancel"),
        blocks: [
          ...sourcePicker,
          input(
            "jellyfin_track",
            this.videoMode ? "Movie, show, or video" : "Song or album",
            {
              type: "external_select",
              action_id: "selection",
              placeholder: plain("Search your Jellyfin"),
              min_query_length: 2,
              focus_on_load: true,
            },
          ),
        ],
      };
    return {
      type: "modal",
      callback_id: "add_track_to_queue",
      private_metadata: JSON.stringify({ sessionId: this.id }),
      title: plain("Add to queue"),
      submit: plain("Add"),
      close: plain("Cancel"),
      blocks: [
        ...sourcePicker,
        {
          ...input(
            "track",
            this.videoMode ? "Video or link" : "Song, album, playlist, or link",
            {
              type: "external_select",
              action_id: "selection",
              placeholder: plain(
                this.videoMode
                  ? "Search YouTube or paste a link"
                  : "Search or paste a link",
              ),
              min_query_length: 3,
              focus_on_load: true,
            },
            { optional: Boolean(recent.length || recommendedGroups.length) },
          ),
          // Music mode looks at what was picked, to offer video mode for a
          // video link.
          ...(this.videoMode ? {} : { dispatch_action: true }),
        },
        ...when(videoHint, ...this.videoHintBlocks(userId)),
        ...when(
          recommendedGroups.length,
          input(
            "recommend",
            "Recommended for you",
            {
              type: "static_select",
              action_id: "selection",
              placeholder: plain("Choose a recommendation"),
              option_groups: recommendedGroups,
            },
            { optional: true },
          ),
        ),
        ...when(
          recent.length,
          input(
            "recent",
            "Recent songs",
            {
              type: "static_select",
              action_id: "selection",
              placeholder: plain("Choose a recent song"),
              options: recent.map((track) => ({
                text: plain(shorten(`${track.title} — ${track.artist}`, 75)),
                value: track.id,
              })),
            },
            { optional: true },
          ),
        ),
        ...when(
          this.can(userId, "add-bulk"),
          actions("bulk_add", [button("open_bulk_add", plain("Add in bulk"))]),
        ),
      ],
    };
  }

  // The add dialog's source changed: YouTube's search, or Jellyfin's.
  private async switchAddSource(interaction: Interaction) {
    if (!interaction.viewId) return;
    const source = interaction.value === "jellyfin" ? "jellyfin" : "search";
    this.hintedViews.delete(interaction.viewId);
    await this.slack.updateModal(
      interaction.viewId,
      interaction.viewHash,
      await this.addView(interaction.userId, false, source),
    );
  }

  private async openBulkAdd(interaction: Interaction) {
    if (!interaction.viewId) return;
    if (!(await this.require(interaction, "add-bulk"))) return;
    this.hintedViews.delete(interaction.viewId);
    await this.slack.updateModal(
      interaction.viewId,
      interaction.viewHash,
      this.bulkAddView(),
    );
  }

  // The bulk add dialog, with the video hint for `hintFor` when its links
  // hold a video in music mode.
  private bulkAddView(hintFor?: string) {
    return {
      type: "modal",
      callback_id: "bulk_add_to_queue",
      private_metadata: JSON.stringify({ sessionId: this.id }),
      title: plain("Add in bulk"),
      submit: plain("Add"),
      close: plain("Cancel"),
      blocks: [
        {
          ...input(
            "links",
            "Track links",
            {
              type: "plain_text_input",
              action_id: "text",
              multiline: true,
              focus_on_load: true,
              placeholder: plain(
                "https://example.com/a.mp3\nhttps://example.com/b.mp3",
              ),
              // Music mode looks at the links as they arrive, to offer video
              // mode for a video.
              ...(this.videoMode
                ? {}
                : {
                    dispatch_action_config: {
                      trigger_actions_on: ["on_character_entered"],
                    },
                  }),
            },
            {
              hint: "One HTTP(S) link per line. Blank lines and # comments are ignored.",
            },
          ),
          ...(this.videoMode ? {} : { dispatch_action: true }),
        },
        ...when(hintFor, ...this.videoHintBlocks(hintFor ?? "")),
      ],
    };
  }

  private availableQueueSlots() {
    return (
      this.config.queueLimit - this.queue.length - Number(Boolean(this.current))
    );
  }

  /** Truncate multi-track adds to remaining capacity; reject only when full. */
  private fitBatchToQueue<T>(
    items: T[],
  ): { items: T[]; omitted: number } | { error: string } {
    const available = this.availableQueueSlots();
    if (available <= 0) return { error: "The queue is full." };
    if (items.length <= available) return { items, omitted: 0 };
    return {
      items: items.slice(0, available),
      omitted: items.length - available,
    };
  }

  private async bulkAddLinks(interaction: Interaction) {
    const text = interaction.state.links?.text?.value ?? "";
    const { links, invalid } = parseBulkLinkList(text);
    if (invalid.length) {
      await this.notice(
        interaction.userId,
        `Not a valid HTTP(S) link: ${invalid[0]}`,
      );
      return;
    }
    if (!links.length) {
      await this.notice(
        interaction.userId,
        "Paste at least one track link (one per line).",
      );
      return;
    }
    const capacity = await this.enqueue(async () => {
      if (this.inactive()) return;
      if (!(await this.require(interaction, "add-bulk"))) return;
      const available =
        this.availableQueueSlots() +
        this.queue.filter((track) => track.automatic).length;
      if (available <= 0) {
        await this.notice(interaction.userId, "The queue is full.");
        return;
      }
      return available;
    });
    if (!capacity) return;
    const tracks: TrackMetadata[] = [];
    for (const link of links.slice(0, capacity)) {
      try {
        tracks.push(await this.tracks.resolveUrl(link, this.videoMode));
      } catch (error) {
        return this.notice(
          interaction.userId,
          `Could not add ${link}: ${message(error)}`,
        );
      }
    }
    await this.queueRequested(interaction, "add-bulk", tracks, links.length);
  }

  private async queueModal(interaction: Interaction) {
    if (!interaction.triggerId) return;
    const view = await this.slack.modal(
      interaction.triggerId,
      this.queueView(interaction.userId),
    );
    if (view?.id)
      this.queueViews.set(view.id, {
        userId: interaction.userId,
        hash: view.hash,
      });
  }

  private async queuePositionModal(interaction: Interaction) {
    if (!this.validQueueView(interaction))
      return this.notice(
        interaction.userId,
        "That queue view is stale; reopen it.",
      );
    if (!(await this.require(interaction, "manage-queue"))) return;
    const entry = this.queue.find((track) => track.id === interaction.value);
    if (!entry || !interaction.triggerId) return;
    this.rememberQueueView(interaction);
    const position = this.queue.indexOf(entry) + 1;
    await this.slack.pushModal(interaction.triggerId, {
      type: "modal",
      callback_id: "move_queue_track",
      private_metadata: JSON.stringify({
        sessionId: this.id,
        trackId: entry.id,
      }),
      title: plain("Move queue item"),
      submit: plain("Move"),
      close: plain("Cancel"),
      blocks: [
        input("position", `Position (1–${this.queue.length})`, {
          type: "plain_text_input",
          action_id: "value",
          initial_value: String(position),
          placeholder: plain("For example, 3"),
        }),
      ],
    });
  }

  private async queuePositionSubmission(interaction: Interaction) {
    const metadata = JSON.parse(interaction.metadata || "{}") as {
      sessionId?: string;
      trackId?: string;
    };
    if (metadata.sessionId !== this.id || !metadata.trackId)
      return this.notice(
        interaction.userId,
        "That queue view is stale; reopen it.",
      );
    if (!(await this.require(interaction, "manage-queue"))) return;
    const entry = this.queue.find((track) => track.id === metadata.trackId);
    const raw = interaction.state.position?.value?.value?.trim() ?? "";
    const position = Number(raw);
    if (
      !entry ||
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(position) ||
      position < 1 ||
      position > this.queue.length
    )
      return this.notice(
        interaction.userId,
        `Position must be a whole number between 1 and ${this.queue.length}.`,
      );
    const from = this.queue.indexOf(entry);
    const to = position - 1;
    if (from === to) return this.queueChanged();
    await this.moveEntry(interaction.userId, from, to, false);
  }

  private queueView(userId: string) {
    const manages = this.can(userId, "manage-queue");
    const last = this.queue.length - 1;
    return {
      type: "modal",
      callback_id: "manage_queue",
      notify_on_close: true,
      private_metadata: JSON.stringify({ sessionId: this.id }),
      title: plain("HuddleFM queue"),
      close: plain("Close"),
      blocks: this.queue.length
        ? [
            ...when(
              (manages && this.shufflableCount() > 1) ||
                this.can(userId, "clear"),
              actions("queue_tools", [
                ...when(
                  manages && this.shufflableCount() > 1,
                  button("shuffle_queue", plain("Shuffle"), {
                    value: this.id,
                  }),
                ),
                ...when(
                  this.can(userId, "clear"),
                  button("clear_queue", plain("Clear"), {
                    value: this.id,
                    confirm: confirm(
                      "Clear queue?",
                      "This removes every upcoming track.",
                      "Clear",
                    ),
                  }),
                ),
              ]),
            ),
            ...this.queue.flatMap((track, index) => {
              const value = track.id;
              const controls = [
                ...when(
                  manages && index,
                  button("queue_play_next", plain("Play next"), { value }),
                ),
                ...when(
                  manages && index,
                  button("queue_move_up", plain("Up"), { value }),
                ),
                ...when(
                  manages && index < last,
                  button("queue_move_down", plain("Down"), { value }),
                ),
                ...when(
                  track.automatic && this.can(userId, "add"),
                  button("queue_keep_autoplay", plain("Add to queue"), {
                    value,
                  }),
                ),
                ...when(
                  manages && !track.automatic,
                  button("queue_move_to_position", plain("Move to…"), {
                    value,
                  }),
                ),
                ...when(
                  this.canRemove(userId, track),
                  button("remove_queue_track", plain("Remove"), {
                    style: "danger",
                    value,
                  }),
                ),
              ];
              return [
                section(
                  `*${index + 1}. ${escape(track.title)}* — ${escape(track.artist)}\n${track.live ? "🔴 LIVE · " : ""}${addedBy(track)}`,
                  `queue_item_${track.id}`,
                ),
                ...when(
                  controls.length,
                  actions(`queue_actions_${track.id}`, controls),
                ),
              ];
            }),
          ]
        : [section("The queue is empty.")],
    };
  }

  private validQueueView(interaction: Interaction) {
    return (
      interaction.viewId &&
      parseMetadata(interaction.metadata).sessionId === this.id
    );
  }

  private rememberQueueView(interaction: Interaction) {
    if (interaction.viewId && this.queueViews.has(interaction.viewId))
      this.queueViews.set(interaction.viewId, {
        userId: interaction.userId,
        hash: interaction.viewHash,
      });
  }

  private queueChanged(interaction?: Interaction) {
    if (interaction) this.rememberQueueView(interaction);
    if (!this.queueViews.size) return;
    clearTimeout(this.queueModalTimer);
    this.queueModalTimer = setTimeout(() => {
      this.queueModalTimer = undefined;
      void this.enqueue(() => this.refreshQueueModals());
    }, 100);
  }

  private async refreshQueueModals() {
    await Promise.all(
      [...this.queueViews].map(async ([viewId, current]) => {
        try {
          const view = await this.slack.updateModal(
            viewId,
            current.hash,
            this.queueView(current.userId),
          );
          // A successful update always leaves the cached hash a version
          // behind, so an update Slack answered without a view drops it
          // rather than keeping one that is now certain to conflict.
          if (this.queueViews.get(viewId) === current)
            this.queueViews.set(viewId, {
              userId: current.userId,
              hash: view?.hash,
            });
        } catch (error) {
          // A failed update leaves the cached hash behind the real view, so
          // it is dropped and the next refresh updates whichever version
          // Slack holds. A view Slack has forgotten can never be refreshed
          // again, so it leaves the cache and is not reported as a fault.
          const gone = slackErrorCode(error) === "not_found";
          if (this.queueViews.get(viewId) === current) {
            if (gone) this.queueViews.delete(viewId);
            else
              this.queueViews.set(viewId, {
                userId: current.userId,
                hash: undefined,
              });
          }
          this.log[gone ? "warn" : "error"](
            { event: "queue_modal_update_failed", viewId, err: error },
            "Could not update queue modal",
          );
        }
      }),
    );
  }

  private async settingsModal(
    interaction: Interaction,
    loading?: { id: string; hash?: string },
  ) {
    if (!this.canOpenSettings(interaction.userId)) {
      this.audit.record("action.denied", interaction.userId, {
        sessionId: this.id,
        capability: "settings",
      });
      return this.settingsNotice(
        interaction.userId,
        "You do not have permission to change settings.",
        loading,
      );
    }
    if (loading)
      await this.slack.updateModal(
        loading.id,
        loading.hash,
        this.settingsViewFor(interaction),
      );
    else
      await this.slack.modal(
        interaction.triggerId,
        this.settingsViewFor(interaction),
      );
  }

  // The Settings an interaction came from: its tab, page and unsaved edits,
  // with the inputs on screen laid over the edits from other tabs. A dialog
  // opened over Settings carries Settings' own, so it can redraw it.
  private settingsContext(interaction: Interaction) {
    const parent = parseMetadata(interaction.metadata).settings;
    if (parent) return parseSettingsMetadata(parent);
    const metadata = parseSettingsMetadata(interaction.metadata);
    return {
      ...metadata,
      draft: mergeForm(metadata.draft, interaction.state),
    };
  }

  private settingsViewFor(
    interaction: Interaction,
    change: SettingsChange = {},
  ) {
    const context = this.settingsContext(interaction);
    return this.settingsView(interaction.userId, {
      ...context,
      ...defined(change),
    });
  }

  // Redraws the settings modal an interaction came from.
  private updateSettings(
    interaction: Interaction,
    change: SettingsChange = {},
  ) {
    return this.slack.updateModal(
      interaction.viewId!,
      interaction.viewHash,
      this.settingsViewFor(interaction, change),
    );
  }

  private async switchSettingsTab(interaction: Interaction) {
    const tab = settingsTabFromAction(interaction.actionId);
    if (!tab || !interaction.viewId) return;
    if (!this.canOpenSettings(interaction.userId))
      return this.notice(
        interaction.userId,
        "You do not have permission to change settings.",
      );
    await this.updateSettings(interaction, { tab });
  }

  // Picking a preset ticks its permissions in the form; saving applies them.
  private async applyPermissionPreset(interaction: Interaction) {
    if (!interaction.viewId) return;
    if (!this.settingsAdmin(interaction.userId))
      return this.notice(
        interaction.userId,
        "Only the host can change permissions.",
      );
    const preset = interaction.value;
    if (!Object.hasOwn(permissionPresets, preset)) return;
    const context = this.settingsContext(interaction);
    const allowed = new Set<string>(
      permissionPresets[preset as keyof typeof permissionPresets],
    );
    await this.updateSettings(interaction, {
      revision: context.revision + 1,
      draft: {
        ...context.draft,
        permissions: {
          selected: {
            selected_options: capabilities
              .filter((capability) => allowed.has(capability))
              .map((value) => ({ value })),
          },
        },
      },
    });
  }

  private async integrationGrantsPage(interaction: Interaction) {
    if (!this.settingsAdmin(interaction.userId))
      return this.notice(
        interaction.userId,
        "Only the host can manage integrations.",
      );
    const parsed = parseIntegrationSettingsPage(interaction.value);
    if (!parsed || parsed.sessionId !== this.id) return;
    if (interaction.viewId)
      await this.updateSettings(interaction, {
        integrationPage: parsed.page,
      });
  }

  // Settings opened afresh has no metadata of its own, and keeps the host it
  // opened under after that, so a submission made across a change of host is
  // still caught as stale.
  private settingsView(
    userId: string,
    context: SettingsChange & { hostId?: string } = {},
  ) {
    const saveDefaults = this.canSaveChannelDefaults(userId);
    const saved = saveDefaults
      ? this.store.channelDefaultsSaved(this.roomId)
      : undefined;
    return settingsView({
      sessionId: this.id,
      // An empty host is Settings opened while there was none.
      hostId:
        context.hostId === undefined
          ? this.hostId
          : context.hostId || undefined,
      ...defined({
        tab: context.tab,
        draft: context.draft,
        notice: context.notice,
        revision: context.revision,
      }),
      integrationPage: context.integrationPage ?? 0,
      access: {
        volume: this.can(userId, "volume"),
        configure: this.can(userId, "configure-settings"),
        admin: this.settingsAdmin(userId),
        endSession: this.can(userId, "end-session"),
        saveDefaults,
      },
      session: this.sessionSettings(),
      user: this.scrobbling?.settings(userId, this.id) ?? defaultUserSettings,
      ...(this.jellyfinUi ? { jellyfin: this.jellyfinUi.summary(userId) } : {}),
      yourData: this.isParticipantOrManager(userId),
      channel: {
        ...(saved && this.store.channelDefaults(this.roomId)
          ? { defaults: saved }
          : {}),
        saves: this.store
          .sessionSaves([{ type: "channel", id: this.roomId }])
          .filter((save) => this.canDeleteSave(userId, save))
          .map((save) => ({
            id: save.id,
            name: save.name,
            savedBy: save.savedBy,
            savedAt: save.savedAt,
            songs: save.tracks.length,
          })),
      },
      integrations: [...this.integrations.entries()].map(([userId, grant]) => ({
        userId,
        requestId: grant.requestId,
        permissions: [...grant.permissions],
      })),
    });
  }

  /** The session's settings, as Settings and client mods show them. */
  private sessionSettings(): SessionSettingsView {
    return {
      hostId: this.hostId,
      mediaMode: this.mediaMode,
      volume: this.volume,
      displayMode: this.displayMode,
      autoplayMode: this.autoplayMode,
      videoAutoplay: this.videoAutoplay,
      loopMode: this.loopMode,
      transitionMode: this.transitionMode,
      duckingMode: this.duckingMode,
      anchorEnabled: this.anchorEnabled,
      progressBar: this.progressBar,
      allowed: this.allowed,
    };
  }

  // Settings' metadata as of this interaction, for a dialog opened over it to
  // carry and redraw it with when it is done.
  private settingsMetadata(interaction: Interaction) {
    const context = this.settingsContext(interaction);
    return {
      sessionId: this.id,
      hostId: context.hostId ?? this.hostId ?? "",
      ...defined({ tab: context.tab }),
      integrationPage: context.integrationPage,
      revision: context.revision,
      draft: context.draft,
    };
  }

  // Deletes a session saved to this channel, from the Channel tab.
  private async deleteChannelSave(interaction: Interaction) {
    const { userId } = interaction;
    const save = this.store
      .sessionSaves([{ type: "channel", id: this.roomId }])
      .find((save) => save.id === interaction.value);
    if (!save)
      await this.notice(userId, "That saved session is no longer available.");
    else if (!this.canDeleteSave(userId, save))
      return this.notice(
        userId,
        "Only whoever saved it or a channel manager can delete that saved session.",
      );
    else {
      this.store.deleteSessionSave(save.id);
      this.audit.record("session.save_deleted", userId, {
        sessionId: this.id,
        ownerType: save.owner.type,
        ownerId: save.owner.id,
        saveId: save.id,
        name: save.name,
        songs: save.tracks.length,
      });
    }
    if (interaction.viewId) await this.updateSettings(interaction);
  }

  private async lastFmModal(interaction: Interaction) {
    if (!this.scrobbling || !interaction.triggerId) return;
    try {
      const url = await this.scrobbling.beginLastFm(interaction.userId);
      await this.slack.pushModal(interaction.triggerId, {
        type: "modal",
        callback_id: "lastfm_login",
        private_metadata: dialogMetadata(
          this.id,
          this.settingsMetadata(interaction),
        ),
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
              value: this.id,
            }),
          ]),
        ],
      });
    } catch (error) {
      this.log.error(
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
    if (!this.scrobbling) return;
    try {
      const username = await this.scrobbling.finishLastFm(interaction.userId);
      if (interaction.viewId && interaction.viewHash)
        await this.slack.updateModal(interaction.viewId, interaction.viewHash, {
          type: "modal",
          title: plain("Connect Last.fm"),
          close: plain("Done"),
          blocks: [section(`Connected as *${escape(username)}*.`)],
        });
      if (interaction.previousViewId)
        await this.slack.updateModal(
          interaction.previousViewId,
          undefined,
          this.settingsViewFor(interaction),
        );
      this.playbackScrobbling?.settingsEnabled(interaction.userId);
    } catch (error) {
      this.log.error(
        {
          event: "lastfm_auth_failed",
          userId: interaction.userId,
          err: error,
        },
        "Could not finish Last.fm authorization",
      );
      await this.notice(
        interaction.userId,
        `Last.fm login is not complete: ${message(error)}`,
      );
    }
  }

  // Your data keeps the metadata of Settings under it, to redraw it after a
  // deletion changes what it shows.
  private yourDataView(
    userId: string,
    settings: ReturnType<Coordinator["settingsMetadata"]>,
    notice?: string,
  ) {
    const data = this.store.userData(userId);
    const save = (save: SessionSave) => ({
      id: save.id,
      name: save.name,
      savedBy: save.savedBy,
      savedAt: save.savedAt,
      songs: save.tracks.length,
    });
    return yourDataView({
      sessionId: this.id,
      settings,
      ...defined({ notice }),
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
      jellyfinServers: this.store.jellyfinServers(userId).map((server) => ({
        name: server.name,
        host: URL.parse(server.baseUrl)?.host ?? server.baseUrl,
        linkedAt: server.linkedAt,
      })),
    });
  }

  private async openYourData(interaction: Interaction) {
    if (!interaction.triggerId) return;
    await this.slack.pushModal(
      interaction.triggerId,
      this.yourDataView(interaction.userId, this.settingsMetadata(interaction)),
    );
  }

  // Deletes one kind of what is kept about the user, or all of it, from Your
  // data. Only ever the user's own: each kind is looked up by their ID. The
  // audit log records that it happened, never what was deleted.
  private async deleteYourData(
    interaction: Interaction,
    kind:
      | "own_save"
      | "channel_save"
      | "added"
      | "plays"
      | "likes"
      | "skips"
      | "scrobbles"
      | "all",
  ) {
    const { userId } = interaction;
    let count = 0;
    let notice: string;
    if (kind === "own_save" || kind === "channel_save") {
      const data = this.store.userData(userId);
      const save = (kind === "own_save" ? data.saves : data.channelSaves).find(
        (save) => save.id === interaction.value,
      );
      if (save) {
        this.store.deleteSessionSave(save.id);
        count = 1;
        notice = `Deleted “${escape(save.name)}”.`;
      } else notice = "That saved session is no longer there.";
    } else if (kind === "all") {
      await this.jellyfinUi?.forget(userId);
      this.store.forgetUser(userId);
      notice =
        "Deleted everything kept about you, apart from sessions you saved to channels.";
    } else {
      count =
        kind === "added"
          ? this.store.forgetAddedTracks(userId)
          : kind === "plays"
            ? this.store.deleteUserPlays(userId)
            : kind === "likes"
              ? this.store.deleteUserLikes(userId)
              : kind === "skips"
                ? this.store.deleteUserSkips(userId)
                : this.store.deleteUserScrobbles(userId);
      const [one, many] = deletedNouns[kind];
      notice =
        kind === "added"
          ? `Your name is off ${songCount(count)} you added.`
          : `Deleted ${count} ${count === 1 ? one : many}.`;
    }
    this.audit.record("data.deleted", userId, {
      sessionId: this.id,
      kind,
      ...(kind === "all" ? {} : { count }),
    });
    if (kind !== "own_save" && kind !== "channel_save")
      void this.recommendations?.refreshUser(userId);
    if (kind === "all") this.scrobbling?.syncAnalyticsUser(userId);
    // Settings under it would otherwise save back what was just deleted.
    const settings = this.settingsMetadata(interaction);
    if (kind === "all") settings.draft = withoutUserForm(settings.draft);
    if (interaction.viewId)
      await this.slack.updateModal(
        interaction.viewId,
        interaction.viewHash,
        this.yourDataView(userId, settings, notice),
      );
    if (interaction.previousViewId)
      await this.slack.updateModal(
        interaction.previousViewId,
        undefined,
        this.settingsView(userId, settings),
      );
  }

  private async listenBrainzTokenModal(interaction: Interaction) {
    if (!this.scrobbling || !interaction.triggerId) return;
    await this.slack.pushModal(
      interaction.triggerId,
      listenBrainzTokenView(this.id, this.settingsMetadata(interaction)),
    );
  }

  // The token form closes when submitted, so Settings under it says how
  // checking the token went.
  private async listenBrainzTokenSubmission(interaction: Interaction) {
    if (!this.scrobbling) return;
    const token = interaction.state.listenbrainz_token?.value?.value?.trim();
    if (!token) return;
    let notice: string;
    try {
      const previous = this.scrobblingSnapshot(interaction.userId);
      const wasEnabled = this.scrobbling.settings(
        interaction.userId,
      ).listenBrainzEnabled;
      const username = await this.scrobbling.setListenBrainz(
        interaction.userId,
        token,
        true,
      );
      notice = `ListenBrainz connected${username ? ` as ${escape(username)}` : ""}.`;
      const changes = settingsChanges(
        previous,
        this.scrobblingSnapshot(interaction.userId),
      );
      this.audit.record("settings.changed", interaction.userId, {
        sessionId: this.id,
        source: "listenbrainz_token",
        changed: changedSettings(changes),
        changes,
      });
      this.store.incrementUsage("settings");
      if (
        !wasEnabled &&
        this.scrobbling.sessionEnabled(this.id, interaction.userId)
      )
        this.playbackScrobbling?.settingsEnabled(interaction.userId);
    } catch (error) {
      this.log.warn(
        {
          event: "listenbrainz_connect_failed",
          userId: interaction.userId,
          err: error,
        },
        "Could not connect ListenBrainz",
      );
      notice = `ListenBrainz was not connected: ${escape(truncate(message(error), 500))}`;
    }
    if (interaction.previousViewId)
      await this.slack.updateModal(
        interaction.previousViewId,
        undefined,
        this.settingsViewFor(interaction, { notice }),
      );
    else await this.notice(interaction.userId, notice);
  }

  private async disconnectLastFm(interaction: Interaction) {
    if (!this.scrobbling) return;
    this.scrobbling.disconnectLastFm(interaction.userId);
    if (interaction.viewId && interaction.viewHash)
      await this.updateSettings(interaction);
  }

  private async disconnectListenBrainz(interaction: Interaction) {
    if (!this.scrobbling) return;
    this.scrobbling.disconnectListenBrainz(interaction.userId);
    if (interaction.viewId && interaction.viewHash)
      await this.updateSettings(interaction);
  }

  private async toggleSessionScrobbling(interaction: Interaction) {
    if (!this.scrobbling) return;
    const settings = this.scrobbling.settings(interaction.userId, this.id);
    if (!settings.configured) return;
    const enabled = !settings.sessionEnabled;
    this.setSessionScrobbling(interaction.userId, enabled);
    if (interaction.responseUrl)
      await this.slack.deleteOriginal(interaction.responseUrl);
    if (interaction.viewId) await this.updateSettings(interaction);
    else
      await this.notice(
        interaction.userId,
        `Scrobbling ${enabled ? "enabled" : "disabled"} for this session.`,
      );
  }

  private setSessionScrobbling(userId: string, enabled: boolean) {
    this.scrobbling!.setSessionEnabled(this.id, userId, enabled);
    this.audit.record("settings.changed", userId, {
      sessionId: this.id,
      source: "toggle",
      changed: ["sessionScrobbling"],
      changes: [{ setting: "sessionScrobbling", from: !enabled, to: enabled }],
    });
    this.store.incrementUsage("settings");
    if (enabled) this.playbackScrobbling?.sessionEnabled(userId);
  }

  // Answers "Scrobble everything in this Huddle" on a prompt. Unlike the
  // toggle, an old prompt pressed again never turns scrobbling back off.
  private async enableSessionScrobbling(interaction: Interaction) {
    if (!this.scrobbling) return;
    const settings = this.scrobbling.settings(interaction.userId, this.id);
    if (!settings.configured) return;
    // The track the prompt was about counts from when they started hearing
    // it, not from the press.
    const trackId = this.promptedTrackId(interaction.value);
    if (trackId) this.confirmTrack(interaction.userId, trackId);
    if (!settings.sessionEnabled)
      this.setSessionScrobbling(interaction.userId, true);
    if (interaction.responseUrl)
      await this.slack.deleteOriginal(interaction.responseUrl);
    await this.notice(
      interaction.userId,
      settings.sessionEnabled
        ? "You're already scrobbling this Huddle."
        : "Scrobbling enabled for this session.",
    );
  }

  private async scrobbleTrack(interaction: Interaction) {
    const trackId = this.promptedTrackId(interaction.value);
    if (!this.playbackScrobbling || !trackId) return;
    const result = this.confirmTrack(interaction.userId, trackId);
    if (interaction.responseUrl)
      await this.slack.deleteOriginal(interaction.responseUrl);
    await this.notice(
      interaction.userId,
      result === "scrobbling"
        ? "Scrobbling this track."
        : result === "too_short"
          ? "You didn't hear enough of that track to scrobble it."
          : "That track finished a while ago, so it can't be scrobbled now.",
    );
  }

  private confirmTrack(userId: string, trackId: string) {
    const result = this.playbackScrobbling?.confirm(userId, trackId);
    if (result === "scrobbling")
      this.audit.record("track.scrobble_confirmed", userId, {
        sessionId: this.id,
        entryId: trackId,
      });
    return result;
  }

  /** The session settings, as recorded in audit and analytics events. */
  private settingsSnapshot(): Settings {
    return {
      hostId: this.hostId ?? null,
      volume: this.volume,
      autoplay: this.autoplayMode,
      videoAutoplay: this.videoAutoplay,
      loopMode: this.loopMode,
      displayMode: this.displayMode,
      transitionMode: this.transitionMode,
      duckingMode: this.duckingMode,
      anchorEnabled: this.anchorEnabled,
      progressBar: this.progressBar,
      permissions: [...this.allowed].sort(),
    };
  }

  /** The per-user scrobbling settings reachable from the settings modal. */
  private scrobblingSnapshot(userId: string): Settings {
    if (!this.scrobbling) return {};
    try {
      const settings = this.scrobbling.settings(userId, this.id);
      return {
        scrobblingMode: settings.mode,
        huddleMixSources: settings.huddleMixSources,
        lastFmScrobbling: settings.lastFmEnabled,
        listenBrainzScrobbling: settings.listenBrainzEnabled,
        listenBrainzConnected: settings.listenBrainzConnected,
        sessionScrobbling: settings.sessionEnabled ?? false,
      };
    } catch (error) {
      this.log.error(
        { event: "scrobbling_snapshot_failed", userId, err: error },
        "Could not read scrobbling settings",
      );
      return {};
    }
  }

  private async settingsSubmission(interaction: Interaction) {
    if (interaction.actionId !== "save_settings") return;
    const metadata = JSON.parse(interaction.metadata || "{}") as {
      sessionId?: string;
      hostId?: string;
    };
    if (
      metadata.sessionId !== this.id ||
      // A client mod's change is one field, checked as it applies.
      (!this.fromDataChannel() &&
        (metadata.hostId || undefined) !== this.hostId) ||
      !this.canOpenSettings(interaction.userId)
    )
      return this.notice(
        interaction.userId,
        "Settings are stale; reopen them.",
      );
    // Edits made on other tabs count as much as those on screen.
    const state = this.settingsContext(interaction).draft;
    const admin = this.settingsAdmin(interaction.userId);
    const nextHost = admin ? state.host?.user?.selected_user : undefined;
    if (nextHost === this.botUserId)
      return this.notice(interaction.userId, "HuddleFM cannot be the host.");
    if (nextHost && !this.participants.has(nextHost))
      return this.notice(
        interaction.userId,
        "The selected host is not in this huddle.",
      );
    const previous = this.settingsSnapshot();
    const previousScrobbling = this.scrobblingSnapshot(interaction.userId);
    const value = state.volume?.percent?.selected_option?.value?.trim();
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
    if (this.can(interaction.userId, "configure-settings"))
      await this.applySettings({
        displayMode: selected(state.display?.mode, displayModes),
        autoplayMode: selected(state.autoplay?.mode, autoplayModes),
        videoAutoplay: videoAutoplaySelected(state.video_autoplay?.mode),
        loopMode: selected(state.loop?.mode, loopModes),
        transitionMode: selected(state.transition?.mode, transitionModes),
        duckingMode: selected(state.ducking?.mode, duckingModes),
        anchorEnabled: checked(state.anchor?.enabled),
        progressBar: checked(state.progress_bar?.enabled),
      });
    // A preset only fills in the checkboxes, so they are all that is saved.
    const chosen = admin
      ? state.permissions?.selected?.selected_options
      : undefined;
    if (chosen)
      this.setPermissions(
        chosen.map((option) => option.value).filter(Boolean) as string[],
      );
    // Switching mode last, so it starts from the settings just saved.
    const mode = admin
      ? selected(state.media_mode?.mode, mediaModes)
      : undefined;
    if (mode && mode !== this.mediaMode) {
      const blocked = await this.switchMediaMode(
        interaction.userId,
        mode,
        "modal",
      );
      if (blocked) await this.notice(interaction.userId, blocked);
    }
    if (nextHost) this.setHost(nextHost);
    if (this.scrobbling) {
      try {
        const userSettings = this.scrobbling.settings(
          interaction.userId,
          this.id,
        );
        let newlyEnabled = false;
        // The mode is in every submission, but only a change to it applies:
        // setting it drops pending scrobbles the new mode would not send.
        const mode = selected(state.scrobbling_mode?.mode, scrobblingModes);
        if (mode && mode !== userSettings.mode)
          this.scrobbling.setMode(interaction.userId, mode);
        const services = submittedScrobbleServices(state.scrobble_to);
        // A draft can hold a choice for a service disconnected since, which
        // there is nothing left to apply to.
        if (services?.lastfm !== undefined && userSettings.lastFmConnected) {
          newlyEnabled ||= services.lastfm && !userSettings.lastFmEnabled;
          this.scrobbling.setLastFmEnabled(interaction.userId, services.lastfm);
        }
        if (
          services?.listenbrainz !== undefined &&
          userSettings.listenBrainzConnected
        ) {
          newlyEnabled ||=
            services.listenbrainz && !userSettings.listenBrainzEnabled;
          await this.scrobbling.setListenBrainz(
            interaction.userId,
            undefined,
            services.listenbrainz,
          );
        }
        // The mode is the default for new Huddles, so a change to it leaves
        // this session as the form showed it.
        const session = checked(state.session_scrobbling?.enabled);
        if (
          session !== undefined &&
          userSettings.configured &&
          (session !== userSettings.sessionEnabled ||
            (mode !== undefined && mode !== userSettings.mode))
        )
          this.scrobbling.setSessionEnabled(
            this.id,
            interaction.userId,
            session,
          );
        const sources = submittedHuddleMixSources(state.huddle_mix);
        if (sources)
          this.scrobbling.setHuddleMixSources(interaction.userId, sources);
        const sessionEnabled = this.scrobbling.sessionEnabled(
          this.id,
          interaction.userId,
        );
        if (!userSettings.sessionEnabled && sessionEnabled)
          this.playbackScrobbling?.sessionEnabled(interaction.userId);
        else if (newlyEnabled && sessionEnabled)
          this.playbackScrobbling?.settingsEnabled(interaction.userId);
      } catch (error) {
        this.log.error(
          {
            event: "scrobbling_settings_failed",
            userId: interaction.userId,
            err: error,
          },
          "Could not change scrobbling settings",
        );
        await this.notice(interaction.userId, message(error));
      }
    }
    const current = this.settingsSnapshot();
    const changes = [
      ...settingsChanges(previous, current),
      ...settingsChanges(
        previousScrobbling,
        this.scrobblingSnapshot(interaction.userId),
      ),
    ];
    this.audit.record("settings.changed", interaction.userId, {
      sessionId: this.id,
      source: "modal",
      changed: changedSettings(changes),
      changes,
      previous,
      ...current,
    });
    this.store.incrementUsage("settings");
    if (!previous.anchorEnabled && this.anchorEnabled) await this.reanchor();
    else await this.render();
    this.scheduleAutoplay();
  }

  // Applies the session settings present in `patch`, leaving alone any that
  // already hold that value, and names each one changed as `key=value`.
  private async applySettings(patch: {
    displayMode?: DisplayMode;
    autoplayMode?: AutoplayMode;
    videoAutoplay?: boolean;
    loopMode?: LoopMode;
    transitionMode?: TransitionMode;
    duckingMode?: DuckingMode;
    anchorEnabled?: boolean;
    progressBar?: boolean;
  }) {
    const changed: string[] = [];
    const { loopMode, anchorEnabled, progressBar } = patch;
    // Video mode does not show the music's own settings, and leaves them
    // as they are, and music mode does the same with video's autoplay.
    const { displayMode, autoplayMode, transitionMode, duckingMode } = this
      .videoMode
      ? {}
      : patch;
    const { videoAutoplay } = this.videoMode ? patch : {};
    if (displayMode !== undefined && displayMode !== this.displayMode) {
      this.displayMode = displayMode;
      this.sendMedia({ type: "display_mode", mode: displayMode });
      this.store.setSession(this.id, { displayMode });
      changed.push(`displayMode=${displayMode}`);
    }
    if (autoplayMode !== undefined && autoplayMode !== this.autoplayMode) {
      this.autoplayMode = autoplayMode;
      this.store.setSession(this.id, { autoplay: autoplayMode });
      if (autoplayMode === "off") await this.removeQueuedAutoplay();
      changed.push(`autoplay=${autoplayMode}`);
    }
    if (videoAutoplay !== undefined && videoAutoplay !== this.videoAutoplay) {
      this.videoAutoplay = videoAutoplay;
      this.store.setSession(this.id, { videoAutoplay });
      if (!videoAutoplay) await this.removeQueuedAutoplay();
      changed.push(`videoAutoplay=${videoAutoplay}`);
    }
    if (loopMode !== undefined && loopMode !== this.loopMode) {
      this.loopMode = loopMode;
      this.store.setSession(this.id, { loopMode });
      if (loopMode !== "off") await this.removeQueuedAutoplay();
      this.syncPreloads();
      changed.push(`loopMode=${loopMode}`);
    }
    if (transitionMode !== undefined) {
      this.transitionMode = transitionMode;
      this.sendMedia({ type: "transition_mode", mode: transitionMode });
      this.store.setSession(this.id, { transitionMode });
      changed.push(`transitionMode=${transitionMode}`);
    }
    if (duckingMode !== undefined && duckingMode !== this.duckingMode) {
      this.duckingMode = duckingMode;
      this.sendMedia({ type: "ducking_mode", mode: duckingMode });
      this.store.setSession(this.id, { duckingMode });
      changed.push(`duckingMode=${duckingMode}`);
    }
    if (anchorEnabled !== undefined && anchorEnabled !== this.anchorEnabled) {
      if (!anchorEnabled) clearTimeout(this.anchorTimer);
      this.anchorEnabled = anchorEnabled;
      this.store.setSession(this.id, { anchorEnabled });
      changed.push(`anchorEnabled=${anchorEnabled}`);
    }
    if (progressBar !== undefined && progressBar !== this.progressBar) {
      this.progressBar = progressBar;
      this.sendMedia({ type: "progress_bar", on: progressBar });
      this.store.setSession(this.id, { progressBar });
      changed.push(`progressBar=${progressBar}`);
    }
    return changed;
  }

  // Saves the session settings shown in Settings, including edits not yet
  // saved on any of its tabs, as what new sessions in this channel start with. Only the settings
  // the user can see are saved; the rest keep what was saved before, or the
  // usual default. The session itself is left alone until Settings is saved.
  private async saveChannelDefaults(interaction: Interaction) {
    if (!(await this.channelDefaultsAllowed(interaction))) return;
    const fields = this.savableDefaults(interaction.userId);
    const state = this.settingsContext(interaction).draft;
    const defaults: ChannelDefaults = {
      ...this.store.channelDefaults(this.roomId),
    };
    if (fields.includes("volume")) {
      let volume = this.volume;
      const percentText = state.volume?.percent?.selected_option?.value?.trim();
      if (percentText !== undefined) {
        const percent = Number(percentText);
        if (
          !percentText ||
          !Number.isFinite(percent) ||
          percent < 0 ||
          percent > 100
        )
          return this.notice(
            interaction.userId,
            "Volume must be between 0 and 100.",
          );
        volume = Math.round(percent * 100) / 10_000;
      }
      defaults.volume = volume;
    }
    if (fields.includes("settings")) {
      defaults.autoplay =
        selected(state.autoplay?.mode, autoplayModes) ?? this.autoplayMode;
      defaults.videoAutoplay =
        videoAutoplaySelected(state.video_autoplay?.mode) ?? this.videoAutoplay;
      defaults.loopMode =
        selected(state.loop?.mode, loopModes) ?? this.loopMode;
      defaults.displayMode =
        selected(state.display?.mode, displayModes) ?? this.displayMode;
      defaults.transitionMode =
        selected(state.transition?.mode, transitionModes) ??
        this.transitionMode;
      defaults.duckingMode =
        selected(state.ducking?.mode, duckingModes) ?? this.duckingMode;
      defaults.anchorEnabled =
        checked(state.anchor?.enabled) ?? this.anchorEnabled;
      defaults.progressBar =
        checked(state.progress_bar?.enabled) ?? this.progressBar;
    }
    if (fields.includes("permissions")) {
      const chosen = state.permissions?.selected?.selected_options
        ?.map((option) => option.value)
        .filter((value): value is string => Boolean(value));
      const allowed = new Set<string>(chosen ?? this.allowed);
      defaults.permissions = capabilities.filter((capability) =>
        allowed.has(capability),
      );
    }
    this.store.setChannelDefaults(this.roomId, defaults, interaction.userId);
    this.audit.record("channel_defaults.saved", interaction.userId, {
      sessionId: this.id,
      channelId: this.roomId,
      ...defaults,
    });
    if (interaction.viewId) await this.updateSettings(interaction);
    await this.notice(
      interaction.userId,
      "Saved. New sessions in this channel will start with these settings.",
    );
  }

  private async clearChannelDefaults(interaction: Interaction) {
    if (!(await this.channelDefaultsAllowed(interaction))) return;
    this.store.clearChannelDefaults(this.roomId);
    this.audit.record("channel_defaults.cleared", interaction.userId, {
      sessionId: this.id,
      channelId: this.roomId,
    });
    if (interaction.viewId) await this.updateSettings(interaction);
    await this.notice(
      interaction.userId,
      "Cleared. New sessions in this channel will start with the usual settings.",
    );
  }

  // Saving or clearing the channel's defaults checks again what Settings
  // offered, as the user's roles or the host may have changed since it opened.
  private async channelDefaultsAllowed(interaction: Interaction) {
    if (!this.canSaveChannelDefaults(interaction.userId)) {
      await this.notice(
        interaction.userId,
        "Only channel managers can change defaults for this channel.",
      );
      return false;
    }
    const metadata = parseMetadata(interaction.metadata);
    if (
      metadata.sessionId !== this.id ||
      (metadata.hostId || undefined) !== this.hostId
    ) {
      await this.notice(interaction.userId, "Settings are stale; reopen them.");
      return false;
    }
    return true;
  }

  private setPermissions(allowed: Iterable<string>) {
    this.allowed = new Set(allowed);
    for (const capability of capabilities)
      this.store.setPermission(
        this.id,
        capability,
        this.allowed.has(capability),
      );
    this.plugins.refreshYou();
  }

  private async hostLeft() {
    const hostId = this.hostId;
    this.setHost(undefined);
    this.audit.record("host.left", hostId, { sessionId: this.id });
    await this.render();
  }

  private setHost(hostId: string | undefined) {
    this.hostId = hostId;
    this.store.setSession(this.id, { hostId: hostId ?? null });
    this.plugins.refreshYou();
    // A request asked the host before, who is no longer the one to answer.
    if (this.videoRequest && this.videoRequest.hostId !== hostId)
      void this.closeVideoRequest("You are no longer the host.");
  }

  private async takeHost(userId: string) {
    this.setHost(userId);
    this.audit.record("host.claimed", userId, { sessionId: this.id });
    await this.render();
  }

  // The idle player's one button: turn on Huddle mix and let it pick, with
  // a popular song as the backstop when the mix has nothing to draw on.
  private async playSomething(interaction: Interaction) {
    // Video mode's autoplay needs a video to follow; this suggests from the
    // user's Jellyfin instead.
    if (this.videoMode) {
      if (!(await this.require(interaction, "add"))) return;
      if (this.jellyfinUi?.hasServers(interaction.userId))
        // Jellyfin can be slow; the session carries on meanwhile.
        return void this.jellyfinUi.openPlaySomething(interaction);
      return this.notice(
        interaction.userId,
        "Play something suggests from your Jellyfin in video mode. Link a server under Settings › You.",
      );
    }
    if (!(await this.require(interaction, "configure-settings"))) return;
    if (this.current || this.queue.length || this.autoplayPending) return;
    if (!this.startPlaySomething(interaction.userId))
      await this.notice(
        interaction.userId,
        "Autoplay cannot start right now; add a song instead.",
      );
  }

  /**
   * Turns on the Huddle mix and has autoplay pick a song, for an idle
   * session. Returns whether it started.
   */
  private startPlaySomething(userId: string) {
    if (this.loopMode !== "off") {
      this.loopMode = "off";
      this.store.setSession(this.id, { loopMode: "off" });
    }
    if (this.autoplayMode !== "huddle") {
      this.autoplayMode = "huddle";
      this.store.setSession(this.id, { autoplay: "huddle" });
    }
    this.audit.record("autoplay.play_something", userId, {
      sessionId: this.id,
      autoplayMode: this.autoplayMode,
    });
    this.scheduleAutoplay(userId);
    return this.autoplayPending;
  }

  // The songs a saved session keeps: the one playing and those still to
  // come. Autoplay picks are left out, since the next session picks its own.
  private savableQueue(): SessionSaveTrack[] {
    return [this.current, ...this.queue].flatMap((entry) =>
      entry && !entry.automatic
        ? [
            {
              sourceInput: entry.sourceInput,
              canonicalUrl: entry.canonicalUrl,
              sourceId: entry.sourceId,
              title: entry.title,
              artist: entry.artist,
              ...defined({
                album: entry.album,
                duration: entry.duration,
                artwork: entry.artwork,
                kind: entry.kind,
                live: entry.live,
              }),
            },
          ]
        : [],
    );
  }

  private savableSettings(): SessionSaveSettings {
    return {
      volume: this.volume,
      autoplayMode: this.autoplayMode,
      loopMode: this.loopMode,
      transitionMode: this.transitionMode,
      duckingMode: this.duckingMode,
      displayMode: this.displayMode,
      anchorEnabled: this.anchorEnabled,
    };
  }

  // The saves a user can load here: the channel's, and their own.
  private saveOwners(userId: string): SessionSaveOwner[] {
    return [
      { type: "channel", id: this.roomId },
      { type: "user", id: userId },
    ];
  }

  private defaultSaveName() {
    const [first, ...rest] = this.savableQueue();
    if (!first) return "Saved session";
    const name = rest.length
      ? `${first.title} and ${rest.length} more`
      : first.title;
    return truncate(name, sessionSaveNameLength);
  }

  // Says whether the session was saved. A failure is logged rather than
  // thrown, so that it cannot keep the session from ending.
  private saveSession(userId: string, owner: SessionSaveOwner, name: string) {
    const tracks = this.savableQueue();
    try {
      this.store.addSessionSave(
        owner,
        name,
        userId,
        tracks,
        this.savableSettings(),
      );
    } catch (error) {
      this.log.error(
        {
          event: "session_save_failed",
          userId,
          ownerType: owner.type,
          err: error,
        },
        "Could not save the session",
      );
      return false;
    }
    this.audit.record("session.saved", userId, {
      sessionId: this.id,
      ownerType: owner.type,
      tracks: tracks.length,
    });
    this.log.info(
      {
        event: "session_saved",
        userId,
        ownerType: owner.type,
        tracks: tracks.length,
      },
      "Session saved for later",
    );
    return true;
  }

  // Who may delete a save: its owner's, and for a channel's, whoever saved
  // it or can end sessions here.
  // A channel's saves are deleted by whoever saved them, anyone who can end
  // the session, and the channel's managers.
  private canDeleteSave(userId: string, save: SessionSave) {
    if (this.isExcluded(userId)) return false;
    return save.owner.type === "user"
      ? save.owner.id === userId
      : save.savedBy === userId ||
          this.can(userId, "end-session") ||
          (save.owner.id === this.roomId && this.isChannelManager(userId));
  }

  private isChannelManager(userId: string) {
    return (
      !this.isExcluded(userId) &&
      (userId === this.config.managerUserId ||
        this.channelManagers?.isManager(this.roomId, userId) === true)
    );
  }

  // Ending asks in a dialog over Settings, where the user can save the queue
  // and settings for a later session: to this channel or to their account.
  private async endModal(interaction: Interaction) {
    if (!interaction.triggerId) return;
    if (!this.can(interaction.userId, "end-session")) {
      await this.enqueue(() => this.end(interaction.userId, "ended by host"));
      return;
    }
    const tracks = this.savableQueue().length;
    const option = (value: string, text: string) => ({
      text: plain(text),
      value,
    });
    const dontSave = option("none", "Don't save");
    await this.slack.pushModal(interaction.triggerId, {
      type: "modal",
      callback_id: "end_session_confirm",
      private_metadata: JSON.stringify({ sessionId: this.id }),
      title: plain("End session?"),
      submit: plain("End"),
      close: plain("Cancel"),
      blocks: [
        section("This stops playback and ends the session."),
        input(
          "save_to",
          "Save for next time",
          {
            type: "radio_buttons",
            action_id: "choice",
            options: [
              dontSave,
              option("channel", "Save to this channel"),
              option("user", "Save to my account"),
            ],
            initial_option: dontSave,
          },
          {
            hint: `Saves the queue (${songCount(tracks)}) and settings, not permissions. Anyone here can load a channel save; only you can load one in your account.`,
          },
        ),
        input(
          "save_name",
          "Name",
          {
            type: "plain_text_input",
            action_id: "value",
            max_length: sessionSaveNameLength,
            placeholder: plain(this.defaultSaveName()),
          },
          {
            optional: true,
            hint: "Saving under a name you have used before replaces that save.",
          },
        ),
      ],
    });
  }

  // Replacing a channel save someone else made takes what deleting it does.
  // Ending already requires the end permission, which covers that.
  private async endSubmission(interaction: Interaction) {
    if (parseMetadata(interaction.metadata).sessionId !== this.id) return;
    const choice =
      interaction.state.save_to?.choice?.selected_option?.value ?? "none";
    const name =
      truncate(
        interaction.state.save_name?.value?.value?.trim() ?? "",
        sessionSaveNameLength,
      ) || this.defaultSaveName();
    const owner: SessionSaveOwner | undefined =
      choice === "channel"
        ? { type: "channel", id: this.roomId }
        : choice === "user"
          ? { type: "user", id: interaction.userId }
          : undefined;
    const alreadyEnded = this.state === "ended";
    const saved = await this.end(
      interaction.userId,
      "ended by host",
      owner ? { save: { owner, name } } : {},
    );
    if (this.state !== "ended") return;
    const text = !owner
      ? "The session has ended."
      : saved
        ? `The session has ended and was saved as “${escape(name)}”.`
        : alreadyEnded
          ? "The session had already ended, so it was not saved."
          : "The session has ended, but it could not be saved.";
    // Settings stays open under the dialog; say why its controls are gone.
    if (interaction.previousViewId)
      await this.slack
        .updateModal(
          interaction.previousViewId,
          undefined,
          settingsMessageView(text),
        )
        .catch((error) =>
          this.log.warn(
            { event: "ended_settings_update_failed", err: error },
            "Could not update Settings after ending the session",
          ),
        );
    else if (owner) await this.notice(interaction.userId, text);
  }

  // The idle player's other button: pick a saved session, from this channel
  // or the user's own account, to load.
  private async loadModal(interaction: Interaction) {
    if (!interaction.triggerId) return;
    const saves = this.store.sessionSaves(this.saveOwners(interaction.userId));
    if (!saves.length)
      return this.notice(
        interaction.userId,
        "There are no saved sessions to load.",
      );
    const option = (save: (typeof saves)[number]) => ({
      text: plain(
        truncate(`${save.name} · ${songCount(save.tracks.length)}`, 75),
      ),
      value: save.id,
    });
    const groups = (
      [
        ["This channel", saves.filter((save) => save.owner.type === "channel")],
        ["Your account", saves.filter((save) => save.owner.type === "user")],
      ] as const
    ).filter(([, group]) => group.length);
    await this.slack.modal(interaction.triggerId, {
      type: "modal",
      callback_id: "load_session_save",
      private_metadata: JSON.stringify({ sessionId: this.id }),
      title: plain("Load saved session"),
      submit: plain("Load"),
      close: plain("Cancel"),
      blocks: [
        input(
          "save",
          "Saved session",
          {
            type: "static_select",
            action_id: "selection",
            option_groups: groups.map(([label, group]) => ({
              label: plain(label),
              options: group.slice(0, 100).map(option),
            })),
            initial_option: option(saves[0]!),
          },
          { hint: "Adds its queue and applies its settings." },
        ),
        input(
          "forget",
          "After loading",
          toggle("enabled", "Delete this save", false),
          {
            optional: true,
            hint: "A save whose songs do not all fit in the queue is kept.",
          },
        ),
      ],
    });
  }

  // Queues a saved session's songs, credited to whoever loads it, and
  // applies the settings they may change. Like other additions, the songs
  // are staged in the action queue and prepared outside it, since preparing
  // waits on that queue.
  private async loadSubmission(interaction: Interaction) {
    if (parseMetadata(interaction.metadata).sessionId !== this.id) return;
    const { userId } = interaction;
    const id = interaction.state.save?.selection?.selected_option?.value;
    const loaded = await this.enqueue(async () => {
      if (this.inactive()) return;
      if (!this.isParticipantOrManager(userId)) {
        await this.rejectNonParticipant(interaction);
        return;
      }
      const save = this.store
        .sessionSaves(this.saveOwners(userId))
        .find((save) => save.id === id);
      if (!save) {
        await this.notice(userId, "That saved session is no longer available.");
        return;
      }
      const { tracks, settings } = save;
      // A save without songs still changes the session for everyone, so it
      // takes the add permission too.
      if (
        !(await this.require(
          interaction,
          tracks.length > 1 ? "add-bulk" : "add",
        ))
      )
        return;
      if (tracks.length) await this.removeQueuedAutoplay();
      const fit = tracks.length
        ? this.fitBatchToQueue(tracks)
        : { items: [], omitted: 0 };
      if ("error" in fit) {
        await this.notice(userId, fit.error);
        return;
      }
      const previous = this.settingsSnapshot();
      const canVolume = this.can(userId, "volume");
      const canConfigure = this.can(userId, "configure-settings");
      if (canVolume && settings.volume !== undefined) {
        this.volume = settings.volume;
        this.sendMedia({ type: "volume", value: this.volume });
        this.store.setSession(this.id, { volume: this.volume });
      }
      if (canConfigure)
        await this.applySettings({
          displayMode: settings.displayMode,
          autoplayMode: settings.autoplayMode,
          loopMode: settings.loopMode,
          transitionMode: settings.transitionMode,
          duckingMode: settings.duckingMode,
          anchorEnabled: settings.anchorEnabled,
        });
      const pending = this.stageEntries(userId, fit.items);
      if (pending.length) void this.recommendations?.refreshUser(userId);
      const forget = checked(interaction.state.forget?.enabled);
      const mayDelete = this.canDeleteSave(userId, save);
      const deleted = forget && mayDelete && !fit.omitted;
      if (deleted) this.store.deleteSessionSave(save.id);
      const current = this.settingsSnapshot();
      const changes = settingsChanges(previous, current);
      this.audit.record("session.save_loaded", userId, {
        sessionId: this.id,
        ownerType: save.owner.type,
        savedBy: save.savedBy,
        savedAt: save.savedAt,
        tracks: pending.length,
        deleted,
        changed: changedSettings(changes),
      });
      if (!previous.anchorEnabled && this.anchorEnabled) await this.reanchor();
      else await this.render();
      if (pending.length) this.queueChanged();
      this.scheduleAutoplay();
      const skipped = [
        fit.omitted ? `${songCount(fit.omitted)} did not fit in the queue` : "",
        !canVolume || !canConfigure
          ? "you don't have permission to change some of its settings"
          : "",
      ].filter(Boolean);
      const kept =
        !forget || deleted
          ? ""
          : mayDelete
            ? " It was kept, since not all of its songs fit."
            : " It was kept: only whoever saved it, a channel manager, or someone who can end the session can delete it.";
      const note =
        skipped.length || kept
          ? `Loaded “${escape(save.name)}”${skipped.length ? `, but ${skipped.join(", and ")}` : ""}.${kept}`
          : undefined;
      return { pending, note };
    });
    if (!loaded) return;
    const prepared = Promise.all(
      loaded.pending.map(({ entry, controller }) =>
        this.prepareManual(entry, controller).catch((error) =>
          this.log.warn(
            {
              event: "loaded_track_failure_unhandled",
              entryId: entry.id,
              err: error,
            },
            "Could not finish handling a loaded track",
          ),
        ),
      ),
    );
    if (loaded.note)
      await this.notice(userId, loaded.note).catch((error) =>
        this.log.warn(
          { event: "session_load_notice_failed", userId, err: error },
          "Could not tell the user how loading a saved session went",
        ),
      );
    await prepared;
  }

  private async claimHost(interaction: Interaction) {
    if (
      interaction.value !== this.id ||
      (interaction.messageTs && interaction.messageTs !== this.uiTs)
    )
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
    await this.takeHost(interaction.userId);
  }

  // Draws the player from the session as it is now. Slack is sent it beside
  // the session's queue of actions, so a click does not wait on the one
  // before it reaching Slack: one update is in flight at a time, and renders
  // made meanwhile collapse into the newest.
  private render() {
    this.plugins.changed();
    if (!this.uiTs || this.inactive()) return;
    this.revision++;
    this.store.setUi(this.id, this.uiTs, this.revision);
    this.playerBlocks = this.blocks();
    this.playerSending ??= this.sendPlayer();
  }

  private async sendPlayer() {
    try {
      let attempt = 0;
      while (this.playerBlocks && !this.inactive()) {
        const blocks = this.playerBlocks;
        this.playerBlocks = undefined;
        const ts = this.uiTs;
        try {
          await this.slack.update(
            this.room.uiChannelId,
            ts,
            "HuddleFM player",
            blocks,
            { interactive: true },
          );
          attempt = 0;
        } catch (error) {
          // A newer render goes out in its place; otherwise this one is tried
          // again, after as long as Slack asks when it is rate limited, so
          // the player never stays behind the session.
          const delay = this.playerSettling
            ? undefined
            : slackRetryDelay(error, ++attempt);
          this.log.warn(
            { event: "player_update_failed", messageTs: ts, delay, err: error },
            "Could not update the player message",
          );
          if (delay === undefined || ts !== this.uiTs) continue;
          this.playerBlocks ??= blocks;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            this.playerWake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          this.playerWake = undefined;
        }
      }
    } finally {
      this.playerSending = undefined;
    }
  }

  // Waits for the player's updates to reach Slack, trying a pending one now
  // rather than after a rate limit, and once only.
  private async settlePlayer() {
    this.playerSettling = true;
    this.playerWake?.();
    try {
      await this.playerSending;
    } finally {
      this.playerSettling = false;
    }
  }

  private queueRender() {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      void this.enqueue(() => this.render());
    }, 100);
  }

  private async reanchor(previousChannelId = this.room.uiChannelId) {
    if (this.inactive()) return;
    const revision = ++this.revision;
    const old = this.uiTs;
    const current = await this.post(
      this.room.uiChannelId,
      this.room.uiThreadTs,
      "HuddleFM player",
      this.blocks(),
    );
    // The new message is drawn from the session as it was posted, which any
    // update still waiting to be sent to the old one is behind. Until then
    // that update stays, so a failed post leaves the old message current.
    this.playerBlocks = undefined;
    this.uiTs = current;
    this.store.setUi(this.id, current, revision);
    // A render while it was posted went to the old message.
    if (this.revision !== revision) this.render();
    await this.slack
      .delete(previousChannelId, old)
      .catch((error) =>
        this.log.error(
          { event: "old_player_delete_failed", messageTs: old, err: error },
          "Could not delete old player message",
        ),
      );
    this.log.info(
      { event: "player_reanchored", revision },
      "Player message reanchored",
    );
  }

  private blocks() {
    const id = `${this.id}_${this.revision}`;
    const current = this.current;
    const next = this.queue[0];
    const findingAutoplay = !next && this.autoplayPending;
    // Nothing playing, queued, or being chosen: offer to start something
    // instead of controls that have nothing to act on.
    const idle = !current && !next && !this.autoplayPending;
    const value = this.id;
    return [
      {
        type: "container",
        block_id: `player_${id}`,
        title: plain(current ? displayTitle(current) : "Nothing playing"),
        subtitle: plain(
          current
            ? `${current.automatic ? "Autoplay · " : ""}${current.album ? `${current.album} · ` : ""}${current.artist}`
            : this.videoMode
              ? "Ready to watch"
              : "Ready for music",
        ),
        ...artworkIcon(current),
        child_blocks: [
          ...(current
            ? [
                context(
                  `current_status_${id}`,
                  `${liveStatus(current)}${
                    // A video's title can be cut short, so it is a click
                    // away.
                    trackKind(current) === "video" &&
                    /^https?:\/\//.test(current.canonicalUrl)
                      ? `${addedBy(current)} · <${escape(current.canonicalUrl).replaceAll("|", "%7C")}|Open video>`
                      : addedBy(current)
                  }`,
                ),
                actions(`playback_${id}`, [
                  button("previous_track", icon(":ms-skip-back:"), { value }),
                  button(
                    "toggle_playback",
                    icon(this.state === "paused" ? ":ms-play:" : ":ms-pause:"),
                    { style: "primary", value },
                  ),
                  button("next_track", icon(":ms-skip-forward:"), { value }),
                ]),
                actions(`volume_${id}`, [
                  button("volume_down", icon(":ms-speaker-low-volume:"), {
                    value,
                  }),
                  button("volume_up", icon(":ms-speaker-loud-volume:"), {
                    value,
                  }),
                  // Likes feed music recommendations, so video mode puts
                  // Jump to in their place; a live stream has nowhere to
                  // jump to.
                  ...(this.videoMode
                    ? when(
                        !current.live,
                        button("open_jump_to", plain(":ms-3-00:"), { value }),
                      )
                    : // Carries the entry rather than the session: a click
                      // can land after the song has rolled over, and it
                      // should like the song they were listening to rather
                      // than whatever is playing by the time it arrives.
                      [
                        button("like_track", icon(":ms-sparkling-heart:"), {
                          value: current.id,
                        }),
                      ]),
                ]),
                actions(`seek_${id}`, [
                  ...when(
                    !current.live,
                    button("seek_back", icon(":ms-rewind:"), { value }),
                  ),
                  ...when(
                    !current.live,
                    button("seek_forward", icon(":ms-fast-forward:"), {
                      value,
                    }),
                  ),
                  // Carries the entry for the same reason the like button does.
                  button("save_track", icon(":ms-floppy-disk:"), {
                    value: current.id,
                  }),
                  ...when(
                    this.videoMode,
                    button("toggle_captions", plain("CC"), {
                      value,
                      ...(this.captions ? { style: "primary" } : {}),
                    }),
                  ),
                ]),
              ]
            : when(
                idle,
                actions(`play_something_${id}`, [
                  // Play something picks songs, which is music mode's, or in
                  // video mode suggests from Jellyfin, for whoever linked it.
                  ...when(
                    !this.videoMode || this.anyoneHasJellyfin(),
                    button("play_something", plain("Play something"), {
                      style: "primary",
                      value,
                    }),
                  ),
                  // Shown whether or not there are saves, since the player
                  // is the same for everyone and each sees only some saves.
                  button("open_load_session", plain("Load saved session"), {
                    value,
                  }),
                ]),
              )),
          context(
            `volume_status_${id}`,
            `${this.videoMode ? "Video mode · " : ""}Volume: ${Math.round(this.volume * 10_000) / 100}%${this.hostId ? ` · Host: <@${this.hostId}>` : " · No host"}${
              this.integrations.size
                ? ` · Controlling: ${[...this.integrations.keys()].map((id) => `<@${id}>`).join(", ")}`
                : ""
            }`,
          ),
        ],
      },
      {
        type: "container",
        block_id: `next_${id}`,
        title: plain(
          next
            ? `Next: ${displayTitle(next)}`
            : findingAutoplay
              ? "Finding next song"
              : "Nothing queued",
        ),
        subtitle: plain(
          next && current?.live
            ? "Up next: waiting on the live stream"
            : next
              ? `${next.live ? "🔴 LIVE · " : ""}${next.status === "preparing" ? "Preparing · " : ""}${next.automatic ? "Autoplay · " : ""}${next.album ? `${next.album} · ` : ""}${next.artist}`
              : findingAutoplay
                ? "Autoplay is picking a recommendation"
                : this.videoMode
                  ? "Add a video to keep watching"
                  : "Add a song to keep the music going",
        ),
        ...artworkIcon(next),
        child_blocks: [
          context(
            `queue_status_${id}`,
            `${next ? `${addedBy(next)} · ` : ""}${songCount(this.queue.length)} in queue`,
          ),
          actions(`add_${id}`, [
            button("open_add_to_queue", plain("Add to queue"), { value }),
          ]),
          actions(`actions_${id}`, [
            button("view_full_queue", plain("Queue"), { value }),
            ...when(
              !this.hostId,
              button("claim_host", plain("Take over"), { value }),
            ),
            button("open_settings", plain("Settings"), { value }),
          ]),
          ...footerContext(this.config.footer, `footer_${id}`),
        ],
      },
    ];
  }

  private anyoneHasJellyfin() {
    const jellyfin = this.jellyfinUi;
    return (
      jellyfin !== undefined &&
      [...this.participants].some((userId) => jellyfin.hasServers(userId))
    );
  }

  // Time played counts as watching while a video shows, and as listening
  // otherwise.
  private countTime(seconds: number) {
    if (!(seconds > 0)) return;
    if (this.current?.isVideo) this.watchedSeconds += seconds;
    else this.listenedSeconds += seconds;
  }

  // Scrobbling follows the music, so video mode leaves it be.
  private startScrobbling(
    entry: Entry,
    position = this.playbackSeconds,
    ask = true,
  ) {
    // Nor is a live stream a listen to scrobble.
    if (this.videoMode || entry.live) {
      this.playbackScrobbling?.finish();
      return;
    }
    this.playbackScrobbling?.start(
      entry,
      this.participants,
      this.state === "playing",
      position,
      ask,
    );
  }

  // A track watched as a video counts as one, not as a song.
  private async markWatched(entry: Entry) {
    const isVideo = this.videoMode && entry.form === "video";
    if (Boolean(entry.isVideo) === isVideo) return;
    entry.isVideo = isVideo;
    this.store.setTrack(entry.id, { isVideo });
  }

  private cancelReprepares() {
    for (const controller of this.reprepares.values()) controller.abort();
    this.reprepares.clear();
  }

  // A private word to whoever added a track, or to the host for a track
  // nobody added.
  private async videoNotice(entry: Entry | undefined, text: string) {
    const userId =
      entry && !entry.automatic && entry.requesterId !== this.botUserId
        ? entry.requesterId
        : this.hostId;
    if (userId) await this.notice(userId, text);
  }

  // The screen share or a video's picture failed, and media is showing the
  // card and playing the sound instead.
  private async videoFailed(type: string, entryId?: string) {
    if (!this.videoMode || this.inactive()) return;
    const entry =
      [this.current, ...this.queue].find((item) => item?.id === entryId) ??
      this.current;
    this.log.warn(
      { event: type, entryId: entry?.id },
      type === "share_failed"
        ? "Screen share failed; playing as audio"
        : "Video could not be shown; playing as audio",
    );
    await this.videoNotice(
      entry,
      type === "share_failed"
        ? "Couldn’t share the screen in the huddle, so videos will play as audio for now."
        : `Couldn’t show the video for ${entry?.title ?? "this track"}, so it’s playing as audio.`,
    );
  }

  // Why video mode cannot start now, if it cannot.
  private videoModeBlocked() {
    const limit = this.config.video?.sessionLimit ?? 2;
    if (limit <= 0) return "Video mode is turned off on this server.";
    const others = this.videoSessions() - (this.videoMode ? 1 : 0);
    if (others >= limit)
      return `Video mode is in use in ${others} other huddle${others === 1 ? "" : "s"}, the limit on this server.`;
    if (this.contentShares >= screenShareSlots)
      return "Two people are already sharing their screens, and Slack allows only two at once. Try again when one of them stops.";
  }

  /**
   * Switches between music and video mode, for the host. The queue carries
   * across, each track prepared again for the new mode where it needs to be,
   * and the music settings stay as they were for when music comes back.
   * Returns why it could not, if it could not.
   */
  private async switchMediaMode(
    userId: string,
    mode: MediaMode,
    source: string,
  ): Promise<string | undefined> {
    if (mode === this.mediaMode) return;
    if (!this.settingsAdmin(userId))
      return "Only the host can switch between music and video mode.";
    if (mode === "video") {
      const blocked = this.videoModeBlocked();
      if (blocked) return blocked;
    }
    const previous = this.mediaMode;
    this.mediaMode = mode;
    this.store.setSession(this.id, { mediaMode: mode });
    this.audit.record("session.mode_changed", userId, {
      sessionId: this.id,
      source,
      previous,
      mode,
    });
    this.log.info(
      { event: "media_mode_changed", mode, source, userId },
      "Media mode changed",
    );
    this.cancelReprepares();
    // Each mode's autoplay picks for itself, so the other's queued pick goes.
    await this.removeQueuedAutoplay();
    if (mode === "video") await this.closeVideoRequest("Video mode is on.");
    this.sendMediaSettings();
    const current = this.current;
    if (current) {
      if (this.formFits(current)) {
        // Same file, now with or without its picture: it carries on.
        this.sendMedia(await this.playMessage(current));
        this.sendLyrics(current);
        this.syncPreloads();
        await this.markWatched(current);
      }
      this.startScrobbling(current);
    }
    this.syncForms();
    this.scheduleAutoplay();
    await this.render();
    this.sessionChanged();
  }

  private async toggleCaptions(interaction: Interaction) {
    if (!(await this.require(interaction, "pause"))) return;
    if (!this.videoMode)
      return this.notice(interaction.userId, "Captions are for video mode.");
    // A Jellyfin item has its own audio languages and captions to pick.
    const playback = this.current?.stream?.jellyfin;
    if (
      playback &&
      this.jellyfinUi &&
      interaction.triggerId &&
      (playback.audioTracks.length > 1 || playback.subtitleTracks.length)
    ) {
      await this.slack.modal(
        interaction.triggerId,
        this.jellyfinUi.tracksView(playback, this.captions),
      );
      return;
    }
    this.captions = !this.captions;
    this.store.setSession(this.id, { captions: this.captions });
    this.sendMedia({ type: "captions", on: this.captions });
    this.audit.record("playback.captions", interaction.userId, {
      sessionId: this.id,
      captions: this.captions,
    });
    const current = this.current;
    if (
      this.captions &&
      current &&
      !(
        (current.form === "video" || current.form === "music_video") &&
        (current.stream
          ? Boolean(current.stream.subtitles)
          : current.filePath &&
            (await Bun.file(captionsPath(current.filePath)).exists()))
      )
    )
      await this.notice(interaction.userId, "This video has no captions.");
    await this.render();
  }

  // The audio and captions picked for the playing Jellyfin item. The server
  // streams it again with them, from where it is.
  private async jellyfinTracksSubmission(interaction: Interaction) {
    if (!(await this.require(interaction, "pause"))) return;
    const current = this.current;
    const playback = current?.stream?.jellyfin;
    if (
      !current ||
      !playback ||
      parseMetadata(interaction.metadata).itemId !== playback.itemId
    )
      return this.notice(
        interaction.userId,
        "That is no longer playing; press CC again.",
      );
    const audioValue = interaction.state.audio?.track?.selected_option?.value;
    const subtitleValue =
      interaction.state.subtitles?.track?.selected_option?.value;
    const audioStreamIndex =
      audioValue === undefined ? playback.audioStreamIndex : Number(audioValue);
    const captions = subtitleValue !== undefined && subtitleValue !== "off";
    const subtitleStreamIndex = captions
      ? Number(subtitleValue)
      : playback.subtitleStreamIndex;
    if (captions !== this.captions) {
      this.captions = captions;
      this.store.setSession(this.id, { captions });
      this.sendMedia({ type: "captions", on: captions });
      this.audit.record("playback.captions", interaction.userId, {
        sessionId: this.id,
        captions,
      });
    }
    const changed =
      audioStreamIndex !== playback.audioStreamIndex ||
      subtitleStreamIndex !== playback.subtitleStreamIndex;
    current.jellyfinTracks = { audioStreamIndex, subtitleStreamIndex };
    await this.render();
    if (!changed) return;
    const controller = new AbortController();
    void this.download(current, controller).then(
      (media) =>
        this.enqueue(async () => {
          if (this.current !== current || this.inactive()) return;
          this.prepared(current, media);
          await this.sendCurrent(current);
        }),
      (error) =>
        this.notice(
          interaction.userId,
          `Couldn’t switch the audio or captions: ${message(error)}`,
        ),
    );
  }

  private async jumpToModal(interaction: Interaction) {
    if (!(await this.require(interaction, "skip"))) return;
    const current = this.current;
    if (!current || !interaction.triggerId)
      return this.notice(interaction.userId, "Nothing is playing.");
    if (current.live)
      return this.notice(
        interaction.userId,
        "A live stream plays where it is now, so there is nowhere to jump to.",
      );
    const chapters = (
      current.filePath
        ? await readChapters(current.filePath)
        : (current.chapters ?? [])
    ).slice(0, selectOptionLimit);
    await this.slack.modal(interaction.triggerId, {
      type: "modal",
      callback_id: "jump_to_time",
      private_metadata: JSON.stringify({
        sessionId: this.id,
        entryId: current.id,
      }),
      title: plain("Jump to"),
      submit: plain("Jump"),
      close: plain("Cancel"),
      blocks: [
        ...when(
          chapters.length,
          input(
            "chapter",
            "Chapter",
            {
              type: "static_select",
              action_id: "start",
              placeholder: plain("Choose a chapter"),
              options: chapters.map((chapter) => ({
                text: plain(
                  shorten(
                    `${formatClock(chapter.start)} · ${chapter.title}`,
                    75,
                  ),
                ),
                value: String(chapter.start),
              })),
            },
            { optional: true },
          ),
        ),
        input(
          "time",
          "Time",
          {
            type: "plain_text_input",
            action_id: "value",
            placeholder: plain("For example, 42:10 or 1:23:45"),
          },
          {
            optional: chapters.length > 0,
            hint: current.duration
              ? `The video runs ${formatClock(current.duration)}.`
              : undefined,
          },
        ),
      ],
    });
  }

  private async jumpToSubmission(interaction: Interaction) {
    const metadata = parseMetadata(interaction.metadata);
    if (!(await this.require(interaction, "skip"))) return;
    const current = this.current;
    if (!current || metadata.entryId !== current.id)
      return this.notice(
        interaction.userId,
        "That is no longer playing; open Jump to again.",
      );
    const raw = interaction.state.time?.value?.value?.trim() ?? "";
    const chapter = Number(
      interaction.state.chapter?.start?.selected_option?.value,
    );
    const seconds = raw
      ? parseClock(raw)
      : Number.isFinite(chapter)
        ? chapter
        : undefined;
    if (seconds === undefined)
      return this.notice(
        interaction.userId,
        raw
          ? "Times look like 42:10 or 1:23:45."
          : "Choose a chapter or enter a time.",
      );
    if (current.duration && seconds >= current.duration)
      return this.notice(
        interaction.userId,
        `That is past the end; it runs ${formatClock(current.duration)}.`,
      );
    const previous = this.playbackSeconds;
    this.playbackSeconds = seconds;
    this.sendMedia({ type: "seek", seconds });
    this.plugins.changed();
    this.audit.record("playback.seeked", interaction.userId, {
      sessionId: this.id,
      trackId: current.id,
      previous,
      seconds,
    });
    this.store.incrementUsage(seconds >= previous ? "forward" : "back");
  }

  // Video mode for a video link added in music mode: the host switches, and
  // anyone else asks the host.
  private async addWithVideoMode(interaction: Interaction) {
    if (!interaction.viewId) return;
    const bulk = interaction.state.links?.text?.value !== undefined;
    if (!(await this.require(interaction, bulk ? "add-bulk" : "add"))) return;
    const switching = this.settingsAdmin(interaction.userId);
    let outcome = "Added.";
    if (this.videoMode) outcome = "Added. Video mode is already on.";
    else if (switching) {
      const blocked = await this.switchMediaMode(
        interaction.userId,
        "video",
        "add",
      );
      if (blocked) {
        await this.slack.updateModal(
          interaction.viewId,
          interaction.viewHash,
          this.addResultView(blocked),
        );
        return;
      }
      outcome = "Added, and switched to video mode.";
    } else if (!this.hostId)
      outcome = "Added. There is no host to ask for video mode.";
    else if (Date.now() < this.videoRequestsPausedUntil)
      outcome = "Added. The host said not now, so it will play as audio.";
    else {
      const selection =
        interaction.state.track?.selection?.selected_option?.value;
      await this.requestVideoMode(
        interaction.userId,
        bulk ? undefined : this.tracks.referencedTitle(selection ?? ""),
      );
      outcome = "Added, and asked the host to switch to video mode.";
    }
    await this.slack.updateModal(
      interaction.viewId,
      interaction.viewHash,
      this.addResultView(outcome),
    );
    const added = { ...interaction, value: "" };
    if (bulk) void this.bulkAddLinks(added);
    else void this.add(added);
  }

  private addResultView(text: string) {
    return {
      type: "modal",
      callback_id: "add_track_done",
      private_metadata: JSON.stringify({ sessionId: this.id }),
      title: plain("Add to queue"),
      close: plain("Done"),
      blocks: [section(text)],
    };
  }

  /**
   * Asks the host, in a direct message, to switch to video mode. More asks
   * while one is open join it rather than sending another.
   */
  private async requestVideoMode(userId: string, title?: string) {
    const hostId = this.hostId;
    if (!hostId || this.videoMode) return;
    const request = this.videoRequest;
    if (request && request.hostId === hostId) {
      if (!request.userIds.includes(userId)) request.userIds.push(userId);
      const message = await request.message;
      if (message)
        await this.slack
          .update(
            message.channelId,
            message.ts,
            this.videoRequestText(request),
            this.videoRequestBlocks(request),
          )
          .catch((error) =>
            this.log.warn(
              { event: "video_request_update_failed", err: error },
              "Could not update the video mode request",
            ),
          );
      return;
    }
    const next: VideoRequest = { userIds: [userId], title, hostId };
    this.videoRequest = next;
    next.message = this.slack
      .dm(hostId, this.videoRequestText(next), {
        blocks: this.videoRequestBlocks(next),
      })
      .catch((error) => {
        this.log.warn(
          { event: "video_request_failed", hostId, err: error },
          "Could not ask the host for video mode",
        );
        if (this.videoRequest === next) this.videoRequest = undefined;
        return undefined;
      });
    this.audit.record("session.video_requested", userId, {
      sessionId: this.id,
      hostId,
    });
    await next.message;
  }

  private videoRequestText(request: VideoRequest) {
    const [first, ...others] = request.userIds;
    const who = others.length
      ? `<@${first}> and ${others.length} other${others.length === 1 ? "" : "s"} want`
      : `<@${first}> wants`;
    return `${who} to switch to video mode to watch ${request.title ? `“${escape(shorten(request.title, 100))}”` : "a video"}.`;
  }

  private videoRequestBlocks(request: VideoRequest) {
    return [
      section(this.videoRequestText(request)),
      actions(`video_request_${this.id}`, [
        button("approve_video_request", plain("Switch to video mode"), {
          style: "primary",
          value: this.id,
        }),
        button("decline_video_request", plain("Not now"), { value: this.id }),
      ]),
    ];
  }

  // Ends the open request, saying how in the host's message.
  private async closeVideoRequest(text: string) {
    const request = this.videoRequest;
    this.videoRequest = undefined;
    const message = await request?.message;
    if (!message) return;
    await this.slack
      .update(message.channelId, message.ts, text, [section(text)])
      .catch((error) =>
        this.log.warn(
          { event: "video_request_close_failed", err: error },
          "Could not update the video mode request",
        ),
      );
  }

  private async answerVideoRequest(interaction: Interaction, approve: boolean) {
    if (!this.settingsAdmin(interaction.userId))
      return this.notice(
        interaction.userId,
        "Only the host can answer that request.",
      );
    if (!approve) {
      this.videoRequestsPausedUntil = Date.now() + videoRequestPauseMs;
      this.audit.record("session.video_declined", interaction.userId, {
        sessionId: this.id,
      });
      return this.closeVideoRequest(
        "Not now. Nobody can ask again for 15 minutes.",
      );
    }
    if (this.videoMode) return this.closeVideoRequest("Video mode is on.");
    // Switching closes the request itself.
    const blocked = await this.switchMediaMode(
      interaction.userId,
      "video",
      "request",
    );
    if (blocked && interaction.responseUrl)
      await this.slack
        .replaceOriginal(interaction.responseUrl, blocked, [
          section(blocked),
          ...(this.videoRequest
            ? this.videoRequestBlocks(this.videoRequest).slice(1)
            : []),
        ])
        .catch(() => undefined);
  }

  /**
   * In music mode, a video link added as audio gets a hint under it, with a
   * way to switch, or to ask the host to.
   */
  private async videoLinkHint(interaction: Interaction) {
    if (!interaction.viewId || this.videoMode) return;
    const bulk = interaction.actionId === "text";
    const links = bulk
      ? (interaction.state.links?.text?.value ?? "").split(/\s+/)
      : [
          this.tracks.referencedUrl(
            interaction.state.track?.selection?.selected_option?.value ?? "",
          ) ?? "",
        ];
    const video = links.some((link) => isVideoLink(link));
    if ((this.hintedViews.get(interaction.viewId) ?? false) === video) return;
    this.hintedViews.delete(interaction.viewId);
    this.hintedViews.set(interaction.viewId, video);
    // Dialogs are let go of in time; they do not say when they close.
    for (const viewId of this.hintedViews.keys()) {
      if (this.hintedViews.size <= 100) break;
      this.hintedViews.delete(viewId);
    }
    const view = bulk
      ? this.bulkAddView(video ? interaction.userId : undefined)
      : await this.addView(interaction.userId, video);
    await this.slack.updateModal(
      interaction.viewId,
      interaction.viewHash,
      view,
    );
  }

  // The hint under a video link in music mode.
  private videoHintBlocks(userId: string) {
    const host = this.settingsAdmin(userId);
    const ask =
      !host &&
      Boolean(this.hostId) &&
      Date.now() >= this.videoRequestsPausedUntil;
    return [
      context(
        "video_hint",
        "This looks like a video, so it will play as audio. The host can switch to video mode in Settings to watch it.",
      ),
      ...when(
        (host || ask) && !this.videoModeBlocked(),
        actions("video_hint_actions", [
          button(
            "add_with_video_mode",
            plain(
              host
                ? "Add and switch to video mode"
                : "Add and ask for video mode",
            ),
            { value: this.id },
          ),
        ]),
      ),
    ];
  }

  // A notice is told in passing, often partway through a change to the
  // session, so one Slack refuses (ephemerals fail fast) never stops it.
  private async notice(user: string, text: string, kind = "failure") {
    // A client mod hears it as the answer to what it asked.
    const run = this.dataChannelRuns.getStore();
    if (run && !run.done && !run.post) {
      (kind === "info" ? run.info : run.notices).push(text);
      return;
    }
    await this.slack
      .ephemeral(this.room.uiChannelId, user, text, this.room.uiThreadTs)
      .catch((error) =>
        this.log.warn(
          { event: "notice_failed", userId: user, err: error },
          "Could not send notice",
        ),
      );
  }

  private async promptScrobbling(userId: string) {
    if (
      userId === this.botUserId ||
      !this.scrobbling?.shouldPrompt(this.id, userId)
    )
      return;
    await this.slack
      .ephemeral(
        this.room.uiChannelId,
        userId,
        "Do you want to scrobble your listening in this Huddle?",
        this.room.uiThreadTs,
        [
          section("Do you want to scrobble your listening in this Huddle?"),
          actions("session_scrobbling_prompt", [
            button(
              "enable_session_scrobbling",
              plain("Enable scrobbling for this session"),
              { style: "primary", value: this.id },
            ),
          ]),
        ],
      )
      .catch((error) =>
        this.log.warn(
          { event: "scrobbling_prompt_failed", userId, err: error },
          "Could not send scrobbling prompt",
        ),
      );
  }

  // The track a "Scrobble this track" button from this session names.
  private promptedTrackId(value: string | undefined) {
    const prefix = `${this.id}:`;
    return value?.startsWith(prefix) ? value.slice(prefix.length) : undefined;
  }

  private async promptTrackScrobbling(userId: string, track: ScrobbleTrack) {
    const text = `Scrobble *${escape(track.title)}* — ${escape(track.artist)}?`;
    await this.slack
      .ephemeral(this.room.uiChannelId, userId, text, this.room.uiThreadTs, [
        section(text),
        actions("track_scrobbling_prompt", [
          button("scrobble_track", plain("Scrobble this track"), {
            style: "primary",
            value: `${this.id}:${track.id}`,
          }),
          button(
            "enable_session_scrobbling",
            plain("Scrobble everything in this Huddle"),
            { value: `${this.id}:${track.id}` },
          ),
        ]),
      ])
      .catch((error) =>
        this.log.warn(
          {
            event: "track_scrobbling_prompt_failed",
            userId,
            trackId: track.id,
            err: error,
          },
          "Could not send track scrobbling prompt",
        ),
      );
  }

  private refreshIdle() {
    if (this.inactive()) return;
    const alone = () =>
      ![...this.participants].some((id) => id !== this.botUserId);
    if (alone() && !this.aloneTimer) {
      this.warnLeaving(
        "alone",
        "I’m alone in the Huddle, so I’ll leave in 2 minutes.",
      );
      this.log.debug(
        { event: "alone_timeout_scheduled", timeoutMs: this.config.aloneMs },
        "Alone timeout scheduled",
      );
      this.aloneTimer = setTimeout(
        () =>
          void this.enqueue(async () => {
            this.aloneTimer = undefined;
            if (alone()) await this.end(undefined, "alone timeout");
          }),
        this.config.aloneMs,
      );
    } else if (!alone()) {
      clearTimeout(this.aloneTimer);
      this.aloneTimer = undefined;
    }
    this.holdLeaveTimer(
      "idle",
      () => !this.current,
      this.config.idleMs,
      "Nothing is playing, so I’ll leave in 2 minutes.",
    );
    this.holdLeaveTimer(
      "paused",
      () => this.state === "paused",
      this.config.pausedMs,
      "Playback is paused, so I’ll leave in 2 minutes.",
    );
  }

  // Keeps a leave timer running, with a warning partway through, for as long
  // as `still()` holds, and drops both the moment it stops holding.
  private holdLeaveTimer(
    kind: "idle" | "paused",
    still: () => boolean,
    timeoutMs: number,
    warning: string,
  ) {
    const timer = `${kind}Timer` as const;
    const warningTimer = `${kind}WarningTimer` as const;
    if (!still()) {
      clearTimeout(this[timer]);
      this[timer] = undefined;
      clearTimeout(this[warningTimer]);
      this[warningTimer] = undefined;
      return;
    }
    if (this[timer]) return;
    this[warningTimer] = setTimeout(
      () => {
        this[warningTimer] = undefined;
        if (still()) this.warnLeaving(kind, warning);
      },
      Math.max(0, timeoutMs - this.config.warningMs),
    );
    this[timer] = setTimeout(
      () =>
        void this.enqueue(async () => {
          this[timer] = undefined;
          if (still()) await this.end(undefined, `${kind} timeout`);
        }),
      timeoutMs,
    );
    this.log.debug(
      { event: `${kind}_timeout_scheduled`, timeoutMs },
      `${capitalize(kind)} timeout scheduled`,
    );
  }

  private warnLeaving(kind: "alone" | "idle" | "paused", text: string) {
    void this.post(this.room.uiChannelId, this.room.uiThreadTs, text).catch(
      (error) =>
        this.log.warn(
          { event: `${kind}_notice_failed`, err: error },
          `Could not post ${kind} timeout notice`,
        ),
    );
  }

  // Stops everything in flight: autoplay, downloads and timers.
  private stopWork() {
    // Clients see the session end or pause for a restart, then hear no more.
    this.plugins.finish();
    if (this.current)
      this.jellyfinUi?.stopped(this.current.id, this.playbackSeconds);
    this.jellyfinUi?.close();
    this.cancelAutoplay();
    for (const controller of this.preparations.values()) controller.abort();
    this.preparations.clear();
    this.cancelReprepares();
    for (const timer of [
      this.idleTimer,
      this.idleWarningTimer,
      this.aloneTimer,
      this.pausedTimer,
      this.pausedWarningTimer,
      this.anchorTimer,
      this.renderTimer,
    ])
      clearTimeout(timer);
  }

  private async end(
    userId: string | undefined,
    reason: string,
    options: { save?: { owner: SessionSaveOwner; name: string } } = {},
  ): Promise<boolean> {
    if (this.state === "ended") return false;
    if (userId && !this.can(userId, "end-session")) {
      this.audit.record("action.denied", userId, {
        sessionId: this.id,
        capability: "end-session",
      });
      await this.notice(
        userId,
        "You do not have permission to end this session.",
      );
      return false;
    }
    const saved = Boolean(
      userId &&
      options.save &&
      this.saveSession(userId, options.save.owner, options.save.name),
    );
    const state = this.state;
    const startedAt = Date.now();
    this.log.info(
      { event: "end_started", userId, reason, previousState: state },
      "Ending session",
    );
    this.state = "ended";
    this.playbackScrobbling?.finish();
    this.stopWork();
    void this.closeVideoRequest("The session ended.");
    clearTimeout(this.queueModalTimer);
    this.queueViews.clear();
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
    this.audit.record("session.ended", userId, {
      sessionId: this.id,
      reason,
      previousState: state,
      tracksPlayed: this.history.length,
      listenedSeconds: this.listenedSeconds,
    });
    this.dropIntegrations("session.ended");
    this.sessionChanged();
    this.sendMedia({ type: "leave" });
    // An update to the player still on its way would land after the recap.
    await Promise.all([this.leaveMedia(), this.settlePlayer()]);
    try {
      if (this.uiTs) {
        await this.slack
          .delete(this.room.uiChannelId, this.uiTs)
          .catch((error) =>
            this.log.error(
              {
                event: "ended_player_delete_failed",
                messageTs: this.uiTs,
                err: error,
              },
              "Could not delete ended player message",
            ),
          );
        const text = `Session ended: ${reason}`;
        const blocks = this.recapBlocks(text);
        const timestamp = await this.post(
          this.room.uiChannelId,
          this.room.uiThreadTs,
          text,
          blocks,
        );
        this.uiTs = timestamp;
        this.store.setEndMessage(this.id, timestamp, text, blocks);
      }
    } finally {
      this.sessionEnded(this.id, [...this.participants]);
      this.log.info(
        {
          event: "ended",
          reason,
          tracksPlayed: this.history.length,
          listenedSeconds: this.listenedSeconds,
          durationMs: Date.now() - startedAt,
        },
        "Session ended",
      );
    }
    return saved;
  }

  private async post(
    channelId: string,
    threadTs: string | undefined,
    text: string,
    blocks?: unknown[],
  ) {
    const messageTs = await this.slack.post(channelId, threadTs, text, blocks);
    this.messagePosted(this.id, channelId, messageTs);
    return messageTs;
  }

  private recapBlocks(text: string) {
    const songs = [...this.history, ...(this.current ? [this.current] : [])];
    const blocks: unknown[] = [section(text)];
    if (!songs.length) return [...blocks, this.restoreBlock()];
    const autoplay = songs.filter((song) => song.automatic).length;
    const artists = Map.groupBy(songs, (song) => firstArtist(song.artist));
    const [topArtist, topSongs] = [...artists].sort(
      (a, b) => b[1].length - a[1].length,
    )[0]!;
    // Songs whose adder took their name off them count for nobody.
    const requesters = Map.groupBy(
      songs.filter((song) => !song.automatic && song.requesterId),
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
        section(
          [
            `*Listening time:* ${elapsed(this.listenedSeconds)}`,
            ...(this.watchedSeconds
              ? [`*Watching time:* ${elapsed(this.watchedSeconds)}`]
              : []),
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
        ),
        ...sectionBlocks(
          "*Songs*",
          songs.map(
            (song, index) =>
              `${index + 1}. *${escape(song.title)}* — ${escape(song.artist)}${song.automatic ? " · Autoplay" : song.requesterId ? ` · <@${song.requesterId}>` : ""}`,
          ),
        ),
      ],
    });
    blocks.push(this.restoreBlock());
    return blocks;
  }

  private restoreBlock() {
    return actions(`restore_${this.id}`, [
      button("restore_session", plain("Restore session"), {
        style: "primary",
        value: this.id,
      }),
    ]);
  }
}
