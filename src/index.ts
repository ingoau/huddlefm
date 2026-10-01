import type { ServerWebSocket } from "bun";
import { rm } from "node:fs/promises";
import {
  capture as captureAnalytics,
  captureAudit,
  shutdownAnalytics,
  startAnalytics,
} from "./analytics.ts";
import { AuditLog } from "./audit-log.ts";
import { canvasMarkdown } from "./canvas.ts";
import { CompanionChannels } from "./companion-channels.ts";
import { FallbackReports } from "./fallback-reports.ts";
import { agentConfigured, isBareMention, runAgentCommand } from "./agent.ts";
import { loadConfig, type MediaBackend } from "./config.ts";
import { Coordinator } from "./coordinator.ts";
import { parseLikeValue } from "./coordinator-ui.ts";
import { redactSecrets, safeError } from "./error-message.ts";
import { fileResponse } from "./file-response.ts";
import { controlDenied } from "./local-control.ts";
import { flushLogs, logger } from "./logger.ts";
import { LyricsCatalog } from "./lyrics.ts";
import { MediaBrowserPool } from "./media-browser.ts";
import {
  NativeMediaSession,
  nativeMediaFailed,
  type MediaMessage,
} from "./native-media/session.ts";
import {
  parsePlaybackReport,
  playbackReportCallbackId,
} from "./playback-report.ts";
import { recentLogs } from "./recent-logs.ts";
import { ScrobbleDispatcher } from "./scrobbling.ts";
import { SlackAppAdapter, type Interaction } from "./slack-app.ts";
import {
  SlackHuddleAdapter,
  huddleHasParticipant,
  roomOwnsThread,
  verifySlackIdentity,
  type ChimeBootstrap,
} from "./slack-huddle.ts";
import {
  integrationReply,
  isAllowlisted,
  parseIntegrationMessage,
} from "./integration.ts";
import { playWindowMs, skipWindowMs } from "./fatigue.ts";
import { Store, type SavedSession } from "./store.ts";
import { TrackCatalog } from "./tracks.ts";
import { likeWindowMs, RecommendationCatalog } from "./recommendations.ts";
import { ChannelManagers } from "./channel-managers.ts";
import { WorkspaceAdmins } from "./workspace-admins.ts";

const resumeTtlMs = 3 * 60_000;
const log = logger.child({ component: "app" });
process.on("uncaughtExceptionMonitor", (err) => {
  log.fatal({ event: "uncaught_exception", err }, "Uncaught exception");
  flushLogs();
});
const startupAt = Date.now();
log.info(
  { event: "startup_started", bunVersion: Bun.version },
  "HuddleFM startup started",
);
const config = loadConfig();
await startAnalytics(config.posthogApiKey, config.posthogHost, (error) =>
  log.warn(
    { event: "posthog_delivery_failed", error: safeError(error) },
    "PostHog delivery failed",
  ),
);
captureAnalytics("app.started", {
  properties: {
    bunVersion: Bun.version,
    queueLimit: config.queueLimit,
    trackDurationLimitSeconds: config.durationSeconds,
    trackDownloadLimitBytes: config.downloadBytes,
    initialVolume: config.initialVolume,
    duckingMode: config.duckingMode,
    lyricsOffsetMs: config.lyricsOffsetMs,
    loudnessNormalization: config.loudnessNormalization,
    trackPreparationConcurrency: config.preparationConcurrency,
    mediaCacheLimitBytes: config.mediaCacheBytes,
    mediaCacheMaxAgeDays: config.mediaCacheMaxAgeDays,
    aloneTimeoutMs: config.aloneMs,
    idleTimeoutMs: config.idleMs,
    pausedTimeoutMs: config.pausedMs,
    mediaRegion: config.mediaRegion,
    canvasConfigured: Boolean(config.canvasId),
    localControlConfigured: Boolean(config.localControlToken),
    lastFmConfigured: Boolean(config.lastFmApiKey && config.lastFmSharedSecret),
  },
});
const buildAt = Date.now();
const build = await Bun.build({
  entrypoints: [new URL("./media-page.ts", import.meta.url).pathname],
  outdir: "dist",
  target: "browser",
  minify: true,
  define: { global: "globalThis" },
});
if (!build.success)
  throw new AggregateError(build.logs, "Media page build failed");
log.info(
  { event: "media_build_completed", durationMs: Date.now() - buildAt },
  "Media page built",
);

const store = new Store();
log.info({ event: "store_opened" }, "Store opened");
// Listening memory past the window the mix looks at has decayed to nothing.
store.pruneListeningMemory(
  Date.now() - playWindowMs,
  Date.now() - skipWindowMs,
  Date.now() - likeWindowMs,
);
const scrobbling = new ScrobbleDispatcher(store, config);
scrobbling.start();
const saved = store.resumableSessions(Date.now(), resumeTtlMs);
log.info(
  {
    event: "resumable_sessions_loaded",
    resumable: saved.sessions.length,
    expired: saved.expiredIds.length,
  },
  "Loaded resumable sessions",
);
await Promise.all(saved.expiredIds.map(removeMediaFiles));
const catalog = new TrackCatalog(config);
const lyrics = new LyricsCatalog();
const recommendations = new RecommendationCatalog(store, catalog, config);
const slackApp = new SlackAppAdapter(config);
const workspaceAdmins = new WorkspaceAdmins(
  (userId) => slackApp.workspaceAdmin(userId),
  { enabled: config.adminsAreManagers },
);
const audit = new AuditLog(
  "data/audit.jsonl",
  (id) => slackApp.userName(id),
  captureAudit,
);
if (store.needsUsageBackfill())
  store.importUsage(await audit.historicalUsage());
const fallbackReports = new FallbackReports();
fallbackReports.start();
const slackHuddle = new SlackHuddleAdapter(config);
const channelManagers = new ChannelManagers((channelId) =>
  slackHuddle.channelManagers(channelId),
);
const mediaBrowsers = new MediaBrowserPool(config.chromePath);
const runtimes = new Map<string, Runtime>();
const joiningChannels = new Set<string>();
const joiningCalls = new Set<string>();
const pendingRestores = new Map<string, SavedSession>();
const restoreFailures = new Map<string, number>();
const maxRestoreAttempts = 4;
const restoring = new Set<string>();
const restoreWork = new Set<Promise<void>>();
const endCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const migratingControls = new Set<string>();
let botUserId = "";
let companions: CompanionChannels;
let restoreTimer: ReturnType<typeof setInterval> | undefined;
let canvasTimer: ReturnType<typeof setInterval> | undefined;
let reconcileTimer: ReturnType<typeof setInterval> | undefined;
let canvasUpdate: Promise<void> | undefined;
let canvasPending = false;
const reconcilingSessions = new Set<string>();
const reconcilePendingSessions = new Set<string>();
let shuttingDown = false;

function updateCanvas() {
  const canvasId = config.canvasId;
  if (!canvasId || shuttingDown) return;
  if (canvasUpdate) {
    canvasPending = true;
    return canvasUpdate;
  }
  const startedAt = Date.now();
  log.debug({ event: "canvas_update_started" }, "Updating Slack Canvas");
  canvasUpdate = canvasIntegrations()
    .then((integrations) =>
      slackApp.updateCanvas(
        canvasId,
        canvasMarkdown(store.canvasStats(), store.usageStats(), {
          integrations,
          sections: config.canvasSections,
        }),
      ),
    )
    .then(() =>
      log.info(
        { event: "canvas_updated", durationMs: Date.now() - startedAt },
        "Slack Canvas updated",
      ),
    )
    .catch((error) =>
      log.error(
        { event: "canvas_update_failed", err: error },
        "Slack Canvas update failed",
      ),
    )
    .finally(() => {
      canvasUpdate = undefined;
      if (canvasPending && !shuttingDown) {
        canvasPending = false;
        void updateCanvas();
      }
    });
  return canvasUpdate;
}

function canvasIntegrations() {
  if (!config.canvasSections.includes("integrations"))
    return Promise.resolve([]);
  return Promise.all(
    [...config.integrationUserIds].map(async (id) => ({
      id,
      name: await slackApp.userName(id),
    })),
  );
}

type SocketData = { sessionId: string };
type Gate = ReturnType<typeof Promise.withResolvers<void>>;
/** One Huddle's media backend: the browser page or the native process. */
type MediaSession = {
  start(bootstrap: ChimeBootstrap): Promise<void>;
  /** Delivers a coordinator message; false when nothing is connected. */
  send(message: unknown): boolean;
  close(): Promise<void>;
  /** Recent problems the backend saw, for a report on why it was given up. */
  diagnostics?(): unknown[];
};
type Runtime = {
  sourceChannelId: string;
  callId: string;
  bootstrap: ChimeBootstrap;
  backend: MediaBackend;
  /** Whether this Huddle has moved from native media to the browser. */
  fellBack: boolean;
  media: MediaSession;
  socket?: ServerWebSocket<SocketData>;
  coordinator?: Coordinator;
  mediaState?: { type: string; details?: unknown };
  joinGate?: Gate;
  leaveGate?: Gate;
};

function coordinatorFor(interaction: Interaction) {
  return [...runtimes.values()].find((runtime) =>
    runtime.coordinator?.handles(interaction),
  )?.coordinator;
}

function activeCoordinators() {
  return [...runtimes.values()].flatMap((runtime) =>
    runtime.coordinator ? [runtime.coordinator] : [],
  );
}

async function handleIntegrationDm(event: {
  userId: string;
  botId?: string;
  channelId: string;
  messageTs: string;
  text: string;
}) {
  if (event.userId === botUserId) return;
  if (!isAllowlisted(config.integrationUserIds, event.userId, event.botId))
    return;
  const reply = (body: Record<string, unknown>) =>
    slackApp.dm(event.userId, integrationReply(event.messageTs, body), {
      channelId: event.channelId,
      threadTs: event.messageTs,
    });
  const parsed = parseIntegrationMessage(event.text);
  if (!parsed.ok) {
    if (parsed.error === "ignored") return;
    const { ok: _ok, error, ...rest } = parsed;
    await reply({ ok: false, error, ...rest });
    return;
  }
  const coordinators = activeCoordinators();
  const command = parsed.command;
  const granted = coordinators.filter((session) =>
    session.hasGrant(event.userId),
  );
  const coordinator =
    command.type === "request_control"
      ? coordinators.find((session) => session.ownsChannel(command.channel!))
      : command.channel
        ? coordinators.find(
            (session) =>
              session.ownsChannel(command.channel!) &&
              session.hasGrant(event.userId),
          )
        : granted.length === 1
          ? granted[0]
          : undefined;
  if (coordinator) {
    await coordinator.handleIntegrationCommand(
      event.userId,
      command,
      event.messageTs,
      event.channelId,
    );
    return;
  }
  if (command.type === "request_control") {
    await reply({ ok: false, error: "session_not_found" });
    return;
  }
  const error =
    command.channel &&
    coordinators.some((session) => session.ownsChannel(command.channel!))
      ? "not_granted"
      : command.channel
        ? "session_not_found"
        : granted.length > 1
          ? "channel_required"
          : "not_granted";
  await reply({ ok: false, type: command.type, error });
}

function runtimeForCall(callId: string) {
  return [...runtimes.values()].find(
    (runtime) =>
      runtime.callId === callId ||
      runtime.coordinator?.room.huddleId === callId,
  );
}

function runtimeForToken(token: string) {
  return [...runtimes.values()].find(
    (runtime) => runtime.bootstrap.bridgeToken === token,
  );
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

async function discardRuntime(runtime: Runtime) {
  await runtime.media.close();
  runtimes.delete(runtime.bootstrap.sessionId);
}

/** Starts a runtime's media backend and waits for it to join Chime. */
async function joinMedia(runtime: Runtime) {
  const gate = (runtime.joinGate = Promise.withResolvers<void>());
  // The gate can be rejected while start() is still loading the page, before
  // anything awaits it, and Bun exits on an unhandled rejection.
  gate.promise.catch(() => {});
  const timer = setTimeout(
    () => gate.reject(new Error("Timed out joining Chime")),
    30_000,
  );
  try {
    await runtime.media.start(runtime.bootstrap);
    await gate.promise;
  } finally {
    clearTimeout(timer);
    runtime.joinGate = undefined;
  }
}

/**
 * Whether a runtime can still move from native media to the browser: only
 * with MEDIA_BACKEND=native-with-fallback, only once, and never while the
 * session is leaving on purpose.
 */
function canFallBack(runtime: Runtime) {
  return (
    config.media.fallback &&
    runtime.backend === "native" &&
    !runtime.leaveGate &&
    !shuttingDown &&
    runtimes.get(runtime.bootstrap.sessionId) === runtime
  );
}

/**
 * Swaps a runtime's native media for the browser. The native process leaves
 * Chime first, and the browser joins with the same attendee, so the Huddle
 * sees the bot drop out for a moment rather than a second copy of it. Each
 * swap gets a report file in data/reports with what led up to it and how
 * it went.
 */
async function moveToBrowser(
  runtime: Runtime,
  cause: {
    reason: string;
    sessionId?: string;
    userId?: string;
    reportId?: string;
    playback?: Record<string, unknown>;
  },
) {
  const native = runtime.media;
  runtime.backend = "browser";
  runtime.fellBack = true;
  // Swapped in before the native process closes, so its parting `ended`
  // no longer counts as this runtime's.
  runtime.media = createMediaSession(() => runtime, "browser");
  const startedAt = Date.now();
  const reportId = cause.reportId ?? crypto.randomUUID();
  const trigger = cause.userId ? "report" : "automatic";
  const mediaSessionId = runtime.bootstrap.sessionId;
  const appLogs = () => recentLogs.take(cause.sessionId, mediaSessionId);
  audit.record("media.fallback", cause.userId, {
    sessionId: cause.sessionId,
    mediaSessionId,
    callId: runtime.callId,
    trigger,
    reason: cause.reason,
    reportId,
    ...cause.playback,
  });
  log.warn(
    {
      event: "media_fallback_started",
      sessionId: cause.sessionId,
      mediaSessionId,
      trigger,
      reason: cause.reason,
      reportId,
    },
    "Falling back from native media to the browser",
  );
  void fallbackReports.update(reportId, {
    trigger,
    reason: cause.reason,
    ...(cause.userId ? { reportedBy: cause.userId } : {}),
    sessionId: cause.sessionId,
    callId: runtime.callId,
    mediaSessionId,
    playback: cause.playback,
    lastMediaEvent: runtime.mediaState && {
      type: runtime.mediaState.type,
      details: redactSecrets(
        JSON.stringify(runtime.mediaState.details ?? null),
      ),
    },
    nativeLogs: native.diagnostics?.() ?? [],
    appLogs: appLogs(),
  });
  try {
    await native.close();
    await joinMedia(runtime);
    void fallbackReports.update(reportId, {
      outcome: { status: "joined", durationMs: Date.now() - startedAt },
      appLogs: appLogs(),
    });
  } catch (error) {
    void fallbackReports.update(reportId, {
      outcome: {
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: safeError(error),
      },
      appLogs: appLogs(),
    });
    throw error;
  }
}

/**
 * Moves a running session to the browser and replays what was playing, or
 * ends the session, with its Restore button, when the browser cannot join.
 */
async function fallBackToBrowser(
  runtime: Runtime,
  cause: { reason: string; userId?: string; reportId?: string },
) {
  const coordinator = runtime.coordinator;
  if (!coordinator || !canFallBack(runtime)) return;
  const startedAt = Date.now();
  const reportId = cause.reportId ?? crypto.randomUUID();
  store.setSession(coordinator.id, { mediaFallback: true });
  const moved = moveToBrowser(runtime, {
    ...cause,
    reportId,
    sessionId: coordinator.id,
    playback: coordinator.playbackSnapshot(),
  });
  coordinator.mediaFallbackStarted(!cause.userId);
  // The session can end while the browser is still joining; its page must
  // not outlive the runtime that was discarded without it.
  const discarded = () => runtimes.get(runtime.bootstrap.sessionId) !== runtime;
  try {
    await moved;
    if (discarded()) return await runtime.media.close();
    await coordinator.mediaReplaced();
    void fallbackReports.update(reportId, {
      replayed: true,
      appLogs: recentLogs.take(coordinator.id, runtime.bootstrap.sessionId),
    });
    log.info(
      {
        event: "media_fallback_completed",
        sessionId: coordinator.id,
        reportId,
        durationMs: Date.now() - startedAt,
      },
      "Fell back to browser media",
    );
  } catch (error) {
    if (discarded()) return await runtime.media.close();
    log.error(
      {
        event: "media_fallback_failed",
        sessionId: coordinator.id,
        reportId,
        durationMs: Date.now() - startedAt,
        err: error,
      },
      "Browser media could not take over from native media",
    );
    coordinator.mediaEvent("fatal");
  }
}

/**
 * Saves what someone said went wrong. Handled here rather than on the
 * Coordinator so a report sent after the session ended is still kept.
 */
function recordPlaybackReport(interaction: Interaction) {
  const report = parsePlaybackReport(interaction);
  if (!report) return;
  audit.record("media.problem_reported", interaction.userId, report);
  const { reportId, sessionId, switched, ...answers } = report;
  void fallbackReports.update(reportId, {
    answers: {
      userId: interaction.userId,
      submittedAt: new Date().toISOString(),
      ...answers,
    },
    // A report from a Huddle already on the browser switched nothing, so
    // its file starts here and gets the session's logs now.
    ...(switched
      ? {}
      : {
          trigger: "report",
          sessionId,
          switched,
          // The browser's own lines carry only its media session ID.
          appLogs: recentLogs.take(
            sessionId,
            [...runtimes.values()].find(
              (runtime) => runtime.coordinator?.id === sessionId,
            )?.bootstrap.sessionId,
          ),
        }),
  });
  log.info(
    {
      event: "media_problem_reported",
      sessionId: report.sessionId,
      reportId: report.reportId,
      problems: report.problems,
    },
    "Playback problem reported",
  );
}

function removeMediaFiles(sessionId: string) {
  return rm(`data/media/${sessionId}`, { recursive: true, force: true });
}

function savedHuddleRoom(saved: SavedSession) {
  return slackHuddle.activeHuddleRoom(
    saved.sourceChannelId ?? saved.channelId,
    saved.huddleThreadTs ?? saved.threadTs,
  );
}

function addCompanionMember(channelId: string, userId: string) {
  void companions
    .add(channelId, userId)
    .catch((error) =>
      slackApp
        .dm(
          userId,
          `I couldn’t add you to the HuddleFM controls channel: ${safeError(error)}`,
        )
        .catch(() => {}),
    );
}

async function migrateControls(runtime: Runtime) {
  const coordinator = runtime.coordinator;
  if (!coordinator || migratingControls.has(runtime.sourceChannelId)) return;
  migratingControls.add(runtime.sourceChannelId);
  const oldChannelId = coordinator.room.uiChannelId;
  try {
    const channelId =
      oldChannelId === runtime.sourceChannelId
        ? await companions.replace(
            runtime.sourceChannelId,
            coordinator.hostUserId(),
          )
        : await companions.prepare(
            runtime.sourceChannelId,
            coordinator.hostUserId(),
            config.forcedCompanionChannelIds.has(runtime.sourceChannelId),
          );
    if (!channelId) throw new Error("No replacement channel was created");
    await companions.activate(channelId, coordinator.participantIds());
    await coordinator.moveControls(channelId);
    log.info(
      { event: "controls_channel_migrated", oldChannelId, channelId },
      "Migrated Huddle controls channel",
    );
    captureAnalytics("controls_channel.migrated", {
      sessionId: coordinator.id,
      properties: { oldChannelId, channelId },
    });
  } catch (error) {
    await slackApp
      .dm(
        coordinator.hostUserId(),
        `I lost access to the HuddleFM controls channel and couldn’t replace it: ${safeError(error)}`,
      )
      .catch(() => {});
    log.error(
      {
        event: "controls_channel_migration_failed",
        oldChannelId,
        userId: coordinator.hostUserId(),
        err: error,
      },
      "Could not migrate Huddle controls channel",
    );
    await coordinator.endFromSlack();
  } finally {
    migratingControls.delete(runtime.sourceChannelId);
  }
}

async function abandonSession(sessionId: string) {
  companions.abandonSession(sessionId);
  store.expireSession(sessionId);
  await removeMediaFiles(sessionId);
  pendingRestores.delete(sessionId);
}

async function reconcileSessionParticipants(
  coordinator: Coordinator,
  callId: string,
) {
  // Read the revision before the round trip: a member event that lands while
  // Slack is answering makes this snapshot stale, and the coordinator drops
  // it rather than undoing the newer event.
  const version = coordinator.participantsVersion;
  const diff = await coordinator.reconcileParticipants(
    await slackHuddle.participants(callId),
    version,
  );
  if (!diff) return;
  const companionChannelId = coordinator.room.companionChannelId;
  for (const userId of diff.added) {
    store.addSessionParticipant(coordinator.id, userId);
    if (companionChannelId) addCompanionMember(companionChannelId, userId);
  }
  for (const userId of diff.removed) {
    if (companionChannelId) companions.removeLater(companionChannelId, userId);
    store.removeSessionParticipant(coordinator.id, userId);
  }
}

// Sessions reconcile independently: one Huddle whose Slack call is slow, or
// whose queue is busy, must never hold up or silence the others.
async function reconcileParticipants(runtime: Runtime) {
  const coordinator = runtime.coordinator;
  if (!coordinator || shuttingDown) return;
  if (reconcilingSessions.has(coordinator.id)) {
    // The pass already running picks this request up when it finishes.
    reconcilePendingSessions.add(coordinator.id);
    return;
  }
  reconcilingSessions.add(coordinator.id);
  try {
    do {
      reconcilePendingSessions.delete(coordinator.id);
      try {
        await reconcileSessionParticipants(coordinator, runtime.callId);
      } catch (error) {
        log.warn(
          {
            event: "participants_reconcile_failed",
            sessionId: coordinator.id,
            callId: runtime.callId,
            err: error,
          },
          "Could not reconcile Huddle participants",
        );
      }
    } while (reconcilePendingSessions.has(coordinator.id) && !shuttingDown);
  } finally {
    reconcilingSessions.delete(coordinator.id);
    reconcilePendingSessions.delete(coordinator.id);
  }
}

function reconcileAllParticipants() {
  if (shuttingDown) return;
  for (const runtime of [...runtimes.values()])
    void reconcileParticipants(runtime);
}

async function joinHuddle(
  channelId: string,
  inviterUserId: string,
  callId?: string,
  inviteFreeWilly?: Record<string, unknown>,
  restored?: SavedSession,
  resumeActorId?: string,
) {
  if (shuttingDown) throw new Error("HuddleFM is shutting down");
  if (
    joiningChannels.has(channelId) ||
    (callId && joiningCalls.has(callId)) ||
    [...runtimes.values()].some(
      (runtime) =>
        runtime.sourceChannelId === channelId || runtime.callId === callId,
    )
  )
    throw new Error("HuddleFM is already joining or active in this Huddle");
  if (!restored) scrobbling.syncAnalyticsUser(inviterUserId);
  else if (resumeActorId) scrobbling.syncAnalyticsUser(resumeActorId);
  const startedAt = Date.now();
  log.info(
    {
      event: "huddle_join_started",
      channelId,
      callId,
      inviterUserId,
      restoredSessionId: restored?.id,
    },
    restored ? "Restoring Huddle session" : "Joining Huddle",
  );
  captureAnalytics("huddle.join_started", {
    distinctId: inviterUserId,
    sessionId: restored?.id,
    properties: {
      channelId,
      callId,
      restored: Boolean(restored),
    },
  });
  joiningChannels.add(channelId);
  if (callId) joiningCalls.add(callId);
  let runtime: Runtime | undefined;
  let companionChannelId: string | undefined;
  let preparedParticipantIds = [inviterUserId];
  try {
    try {
      companionChannelId = await companions.prepare(
        channelId,
        inviterUserId,
        config.forcedCompanionChannelIds.has(channelId),
      );
    } catch (error) {
      if (callId) await slackHuddle.decline(channelId, callId).catch(() => {});
      await slackApp
        .dm(
          inviterUserId,
          `I couldn’t prepare a controls channel, so I didn’t join the Huddle: ${safeError(error)}`,
        )
        .catch(() => {});
      log.warn(
        {
          event: "controls_channel_prepare_failed",
          channelId,
          callId,
          err: error,
        },
        "Could not prepare Huddle controls channel",
      );
      captureAnalytics("controls_channel.prepare_failed", {
        distinctId: inviterUserId,
        sessionId: restored?.id,
        properties: { channelId, callId },
      });
      return { declined: true };
    }
    const joined =
      callId && inviteFreeWilly
        ? await slackHuddle.joinInvited(channelId, callId, inviteFreeWilly)
        : await slackHuddle.join(channelId);
    const huddleThreadTs = joined.uiThreadTs;
    preparedParticipantIds = [inviterUserId, ...joined.participantIds].filter(
      (userId) => !config.excludedUserIds.has(userId),
    );
    if (companionChannelId) {
      await companions.activate(companionChannelId, preparedParticipantIds);
      joined.uiChannelId = companionChannelId;
      joined.uiThreadTs = "";
      joined.companionChannelId = companionChannelId;
    }
    joined.sourceChannelId = channelId;
    joined.huddleThreadTs = huddleThreadTs;
    if (runtimeForCall(joined.huddleCallId))
      throw new Error("HuddleFM is already active in this Huddle");
    const bootstrap = {
      sessionId: crypto.randomUUID(),
      meeting: joined.chimeMeeting,
      attendee: joined.chimeAttendee,
      initialVolume: restored?.volume ?? config.initialVolume,
      duckingMode: restored?.duckingMode ?? config.duckingMode,
      lyricsOffsetMs: config.lyricsOffsetMs,
      bridgeToken: crypto.randomUUID(),
    };
    // A session that already fell back rejoins with the browser rather than
    // the backend that failed it.
    const fellBack = Boolean(restored?.mediaFallback && config.media.fallback);
    const backend = fellBack ? "browser" : config.media.backend;
    runtime = {
      sourceChannelId: channelId,
      callId: joined.huddleCallId,
      bootstrap,
      backend,
      fellBack,
      media: createMediaSession(() => runtime, backend),
    };
    runtimes.set(bootstrap.sessionId, runtime);
    log.debug(
      {
        event: "runtime_created",
        mediaSessionId: bootstrap.sessionId,
        channelId,
        callId: joined.huddleCallId,
        backend,
      },
      "Media runtime created",
    );
    try {
      try {
        await joinMedia(runtime);
      } catch (error) {
        // A Huddle that ended, or that sent the bot away, while native media
        // was joining would turn the browser away just the same.
        const ended = error instanceof Error ? error.cause : undefined;
        if (
          !canFallBack(runtime) ||
          (ended && !nativeMediaFailed(ended as MediaMessage))
        )
          throw error;
        await moveToBrowser(runtime, {
          reason: `Native media could not join: ${safeError(error)}`,
          sessionId: restored?.id,
        });
      }
      log.info(
        {
          event: "media_joined",
          mediaSessionId: bootstrap.sessionId,
          backend: runtime.backend,
          durationMs: Date.now() - startedAt,
        },
        "Media page joined Chime",
      );
    } catch (error) {
      await discardRuntime(runtime);
      throw error;
    }
    const coordinator = (runtime.coordinator = new Coordinator(
      joined,
      inviterUserId,
      botUserId,
      slackApp,
      store,
      catalog,
      lyrics,
      audit,
      config,
      bootstrap.bridgeToken,
      (message) => void runtime?.media.send(message),
      async () => {
        const gate = (runtime!.leaveGate = Promise.withResolvers<void>());
        const timer = setTimeout(gate.resolve, 5_000);
        try {
          await gate.promise;
        } finally {
          clearTimeout(timer);
          runtime!.leaveGate = undefined;
        }
        await discardRuntime(runtime!);
      },
      restored,
      scrobbling,
      () => void updateCanvas(),
      (sessionId, participantIds) => {
        scheduleEndCleanup(sessionId);
        if (joined.companionChannelId)
          companions.endSession(
            sessionId,
            joined.companionChannelId,
            participantIds,
          );
      },
      (sessionId, postedChannelId, messageTs) => {
        if (joined.companionChannelId === postedChannelId)
          companions.recordMessage(sessionId, postedChannelId, messageTs);
      },
      recommendations,
      workspaceAdmins,
      config.media.fallback
        ? {
            available: () => canFallBack(runtime!),
            start: (userId, reportId) =>
              void fallBackToBrowser(runtime!, {
                reason: "Reported by a user",
                userId,
                reportId,
              }),
          }
        : undefined,
      channelManagers,
    ));
    try {
      if (restored) await coordinator.resume(resumeActorId);
      else await coordinator.start();
      // Marked after start, which is what creates a new session's row.
      if (runtime.fellBack)
        store.setSession(coordinator.id, { mediaFallback: true });
      store.setSessionParticipants(
        coordinator.id,
        coordinator.participantIds(),
      );
      captureAnalytics("media.joined", {
        sessionId: coordinator.id,
        properties: {
          mediaSessionId: bootstrap.sessionId,
          backend: runtime.backend,
          fellBack: runtime.fellBack,
        },
      });
    } catch (error) {
      await discardRuntime(runtime);
      throw error;
    }
    log.info(
      {
        event: "huddle_join_completed",
        sessionId: coordinator.id,
        mediaSessionId: bootstrap.sessionId,
        huddleId: joined.huddleId,
        restored: Boolean(restored),
        durationMs: Date.now() - startedAt,
      },
      restored ? "Huddle session restored" : "Huddle joined",
    );
    captureAnalytics("huddle.join_completed", {
      distinctId: inviterUserId,
      sessionId: coordinator.id,
      properties: {
        huddleId: joined.huddleId,
        channelId,
        mediaSessionId: bootstrap.sessionId,
        restored: Boolean(restored),
        companionChannel: Boolean(joined.companionChannelId),
        durationMs: Date.now() - startedAt,
      },
    });
    return { sessionId: coordinator.id, huddleId: joined.huddleId };
  } catch (err) {
    if (companionChannelId) {
      companions.abortSetup(companionChannelId, preparedParticipantIds);
      if (runtime?.coordinator) {
        companions.endSession(
          runtime.coordinator.id,
          companionChannelId,
          runtime.coordinator.participantIds(),
        );
        store.expireSession(runtime.coordinator.id);
      }
    }
    log.error(
      {
        event: "huddle_join_failed",
        channelId,
        callId,
        inviterUserId,
        restoredSessionId: restored?.id,
        durationMs: Date.now() - startedAt,
        err,
      },
      restored ? "Huddle session restore failed" : "Huddle join failed",
    );
    captureAnalytics("huddle.join_failed", {
      distinctId: inviterUserId,
      sessionId: restored?.id,
      properties: {
        channelId,
        callId,
        restored: Boolean(restored),
        durationMs: Date.now() - startedAt,
      },
    });
    throw err;
  } finally {
    joiningChannels.delete(channelId);
    if (callId) joiningCalls.delete(callId);
  }
}

async function restoreSession(saved: SavedSession) {
  const abandon = async (event: string, analytics: string, message: string) => {
    await abandonSession(saved.id);
    log.info({ event, sessionId: saved.id }, message);
    captureAnalytics(analytics, { sessionId: saved.id });
  };
  if (Date.now() >= saved.resumeUntil)
    return abandon(
      "restore_expired",
      "session.restore_expired",
      "Expired interrupted session",
    );
  const room = await savedHuddleRoom(saved);
  if (!room)
    return abandon(
      "restore_huddle_ended",
      "session.restore_huddle_ended",
      "Expired session because its Huddle ended",
    );
  await joinHuddle(
    saved.sourceChannelId ?? saved.channelId,
    saved.hostId ?? saved.creatorId,
    room.callId,
    undefined,
    saved,
  );
  pendingRestores.delete(saved.id);
  log.info(
    { event: "restore_completed", sessionId: saved.id },
    "Interrupted session restored",
  );
  captureAnalytics("session.restore_completed", { sessionId: saved.id });
}

async function retryRestores() {
  if (shuttingDown) return;
  const work = [...pendingRestores.values()]
    .filter((saved) => !restoring.has(saved.id))
    .map((saved) => {
      restoring.add(saved.id);
      const task = restoreSession(saved)
        .catch(async (error) => {
          const failures = (restoreFailures.get(saved.id) ?? 0) + 1;
          restoreFailures.set(saved.id, failures);
          log.warn(
            {
              event: "restore_attempt_failed",
              sessionId: saved.id,
              attempt: failures,
              err: error,
            },
            "Interrupted session restore attempt failed",
          );
          if (failures < maxRestoreAttempts) return;
          pendingRestores.delete(saved.id);
          await abandonSession(saved.id);
          log.error(
            { event: "restore_abandoned", sessionId: saved.id, err: error },
            "Gave up restoring interrupted session",
          );
          captureAnalytics("session.restore_abandoned", {
            sessionId: saved.id,
            properties: { attempts: failures },
          });
        })
        .finally(() => {
          restoring.delete(saved.id);
          restoreWork.delete(task);
        });
      restoreWork.add(task);
      return task;
    });
  await Promise.all(work);
  if (!pendingRestores.size && restoreTimer) {
    clearInterval(restoreTimer);
    restoreTimer = undefined;
    log.info({ event: "restore_retries_stopped" }, "Restore retries stopped");
  }
}

function restorableSession(sessionId: string) {
  return store.restorableSessions().find((session) => session.id === sessionId);
}

function hasRestoreButton(block: unknown) {
  return (
    block &&
    typeof block === "object" &&
    "elements" in block &&
    Array.isArray(block.elements) &&
    block.elements.some(
      (element) =>
        element &&
        typeof element === "object" &&
        "action_id" in element &&
        element.action_id === "restore_session",
    )
  );
}

function scheduleEndCleanup(sessionId: string) {
  clearTimeout(endCleanupTimers.get(sessionId));
  const session = restorableSession(sessionId);
  if (!session) return;
  endCleanupTimers.set(
    sessionId,
    setTimeout(
      () => void cleanupEndedSession(sessionId),
      Math.max(0, session.resumeUntil - Date.now()),
    ),
  );
  log.debug(
    { event: "ended_session_cleanup_scheduled", sessionId },
    "Ended-session cleanup scheduled",
  );
}

async function cleanupEndedSession(sessionId: string) {
  endCleanupTimers.delete(sessionId);
  const session = restorableSession(sessionId);
  if (!session) return;
  if (restoring.has(sessionId)) {
    endCleanupTimers.set(
      sessionId,
      setTimeout(() => void cleanupEndedSession(sessionId), 1_000),
    );
    return;
  }
  if (Date.now() < session.resumeUntil) return scheduleEndCleanup(sessionId);
  log.info(
    { event: "ended_session_cleanup_started", sessionId },
    "Cleaning up ended session",
  );
  try {
    if (session.endText && session.endBlocks && session.uiTs)
      await slackApp.update(
        session.channelId,
        session.uiTs,
        session.endText,
        session.endBlocks.filter((block) => !hasRestoreButton(block)),
      );
  } catch (error) {
    log.error(
      { event: "restore_button_remove_failed", sessionId, err: error },
      "Could not remove session restore button",
    );
  } finally {
    store.expireSession(sessionId);
    await removeMediaFiles(sessionId);
    log.info(
      { event: "ended_session_cleaned", sessionId },
      "Ended session cleaned up",
    );
  }
}

// Taking back a like, from the ephemeral the like posted. Handled here rather
// than on the Coordinator because neither end of it belongs to a session: a
// like is stored against the listener and the song, and the Undo sits in a
// message Slack keeps showing long after the Huddle it was made in has ended.
// Only the person who pressed the button is ever shown it, and it only ever
// touches their own likes, so there is nobody else to check it against.
async function undoLike(interaction: Interaction) {
  const like = parseLikeValue(interaction.value);
  const removed =
    like && store.unlikeTrack(interaction.userId, like.title, like.artist);
  if (like && removed) {
    void recommendations.refreshUser(interaction.userId);
    audit.record("track.unliked", interaction.userId, {
      sessionId: like.sessionId,
      title: like.title,
      artist: like.artist,
      ...(like.discovery === undefined ? {} : { discovery: like.discovery }),
    });
  }
  if (!interaction.responseUrl) return;
  await slackApp
    .replaceOriginal(
      interaction.responseUrl,
      !like
        ? "That undo is no longer valid."
        : removed
          ? "Undone. That song is back to where it was in your recommendations."
          : "That like is already undone.",
    )
    .catch((error) =>
      log.warn(
        {
          event: "unlike_reply_failed",
          userId: interaction.userId,
          err: error,
        },
        "Could not answer a like undo",
      ),
    );
}

async function restoreEndedSession(interaction: Interaction) {
  const session = restorableSession(interaction.value);
  if (
    !session ||
    interaction.channelId !== session.channelId ||
    interaction.messageTs !== session.uiTs
  )
    return;
  const notify = (text: string) =>
    slackApp.ephemeral(
      session.channelId,
      interaction.userId,
      text,
      session.threadTs,
    );
  if (Date.now() >= session.resumeUntil) {
    await cleanupEndedSession(session.id);
    await notify("That session can no longer be restored.");
    return;
  }
  if (restoring.has(session.id)) return;
  restoring.add(session.id);
  const startedAt = Date.now();
  log.info(
    {
      event: "manual_restore_started",
      sessionId: session.id,
      userId: interaction.userId,
    },
    "Manual session restore started",
  );
  captureAnalytics("session.manual_restore_started", {
    distinctId: interaction.userId,
    sessionId: session.id,
  });
  try {
    const room = await savedHuddleRoom(session);
    if (!room) {
      await notify("That Huddle is no longer active.");
      return;
    }
    if (!huddleHasParticipant(room, interaction.userId)) {
      log.info(
        {
          event: "manual_restore_not_in_huddle",
          sessionId: session.id,
          userId: interaction.userId,
        },
        "Manual restore refused because the user is not in the Huddle",
      );
      await notify("Join the Huddle first, then I can restore that session.");
      return;
    }
    await joinHuddle(
      session.sourceChannelId ?? session.channelId,
      interaction.userId,
      room.callId,
      undefined,
      session,
      interaction.userId,
    );
    clearTimeout(endCleanupTimers.get(session.id));
    endCleanupTimers.delete(session.id);
    log.info(
      {
        event: "manual_restore_completed",
        sessionId: session.id,
        durationMs: Date.now() - startedAt,
      },
      "Manual session restore completed",
    );
    captureAnalytics("session.manual_restore_completed", {
      distinctId: interaction.userId,
      sessionId: session.id,
      properties: { durationMs: Date.now() - startedAt },
    });
  } catch (error) {
    log.error(
      {
        event: "manual_restore_failed",
        sessionId: session.id,
        userId: interaction.userId,
        durationMs: Date.now() - startedAt,
        err: error,
      },
      "Manual session restore failed",
    );
    await notify(`I couldn’t restore that session: ${safeError(error)}`);
  } finally {
    restoring.delete(session.id);
  }
}

async function mentionEphemeral(
  channelId: string,
  userId: string,
  text: string,
  threadTs?: string,
  fallbackChannelId?: string,
) {
  try {
    await slackApp.ephemeral(channelId, userId, text, threadTs);
  } catch (error) {
    if (!fallbackChannelId || fallbackChannelId === channelId) throw error;
    log.warn(
      {
        event: "mention_ephemeral_fallback",
        channelId,
        fallbackChannelId,
        err: error,
      },
      "Mention ephemeral failed in source channel; retrying in companion channel",
    );
    await slackApp.ephemeral(fallbackChannelId, userId, text);
  }
}

// Acknowledge a mention with 👀 right away, then swap that for ✅ or ❌ once the
// requested action settles. Only the first outcome reported is recorded.
function mentionReaction(channelId: string, messageTs: string) {
  const acknowledged = slackHuddle
    .react(channelId, messageTs, "eyes")
    .catch((error) =>
      log.warn(
        { event: "mention_reaction_failed", channelId, err: error },
        "Could not react to Huddle mention",
      ),
    );
  let settled = false;
  return (succeeded: boolean) => {
    if (settled) return;
    settled = true;
    void acknowledged
      .then(async () => {
        try {
          await slackHuddle.unreact(channelId, messageTs, "eyes");
        } catch (error) {
          log.warn(
            {
              event: "mention_acknowledgement_cleanup_failed",
              channelId,
              err: error,
            },
            "Could not remove the Huddle mention acknowledgement",
          );
        }
        await slackHuddle.react(
          channelId,
          messageTs,
          succeeded ? "white_check_mark" : "x",
        );
      })
      .catch((error) =>
        log.warn(
          {
            event: "mention_outcome_reaction_failed",
            channelId,
            succeeded,
            err: error,
          },
          "Could not mark the Huddle mention outcome",
        ),
      );
  };
}

async function joinMentionedHuddle(
  event: Extract<
    import("./slack-huddle.ts").HuddleEvent,
    { type: "ThreadActivity" }
  >,
) {
  const notify = (text: string) =>
    slackApp.ephemeral(event.channelId, event.userId, text, event.threadTs);
  const room = await slackHuddle.activeHuddleRoom(
    event.channelId,
    event.threadTs,
  );
  if (!room) {
    await notify("This isn’t an active Huddle thread.");
    return false;
  }
  if (
    joiningChannels.has(event.channelId) ||
    joiningCalls.has(room.callId) ||
    runtimeForCall(room.callId)
  )
    return true;
  if (!huddleHasParticipant(room, event.userId)) {
    log.info(
      {
        event: "mention_join_not_in_huddle",
        channelId: event.channelId,
        callId: room.callId,
        userId: event.userId,
      },
      "Huddle join refused because the user is not in the Huddle",
    );
    await notify(
      "Join the Huddle first, then mention me and I’ll bring the music.",
    );
    return false;
  }
  await joinHuddle(event.channelId, event.userId, room.callId);
  return true;
}

const server = Bun.serve<SocketData>({
  hostname: config.bindAddress,
  port: config.port,
  routes: {
    "/health": () => {
      const sessions = [...runtimes.values()].flatMap((runtime) =>
        runtime.coordinator
          ? [
              {
                sessionId: runtime.coordinator.id,
                huddleId: runtime.coordinator.room.huddleId,
                media: runtime.mediaState ?? null,
              },
            ]
          : [],
      );
      return Response.json({
        ok: true,
        sessionId: sessions.length === 1 ? sessions[0]?.sessionId : null,
        media: sessions.length === 1 ? sessions[0]?.media : null,
        sessions,
      });
    },
    "/favicon.ico": () => new Response(null, { status: 204 }),
    "/media": () =>
      new Response(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>HuddleFM media</title><link rel=stylesheet href=/media-page.css><main id=stage data-display-mode=default><div id=artwork></div><div id=cover></div><header><h1 id=title>Ready for music</h1><p id=artist>Waiting for the next track</p></header><section id=lyrics-frame><braccato-lyrics id=lyrics></braccato-lyrics></section><div id=timeline><time id=elapsed>0:00</time><div id=progress><div id=progress-fill></div></div><time id=duration>0:00</time></div></main><button id=capture>Start camera</button><p id=status>connecting</p><script type=module src=/media-page.js></script>",
        { headers: { "content-type": "text/html" } },
      ),
    "/media-page.js": () =>
      new Response(Bun.file("dist/media-page.js"), {
        headers: { "content-type": "text/javascript" },
      }),
    "/media-page.css": () =>
      new Response(Bun.file("dist/media-page.css"), {
        headers: { "content-type": "text/css" },
      }),
    "/join": {
      POST: async (request: Request) => {
        const denied = controlDenied(request, config.localControlToken);
        if (denied) return denied;
        const { channelId, inviterUserId } = (await request.json()) as {
          channelId?: string;
          inviterUserId?: string;
        };
        if (
          !channelId?.match(/^[A-Z0-9]+$/) ||
          !inviterUserId?.match(/^[A-Z0-9]+$/)
        )
          return Response.json(
            { error: "Invalid channelId or inviterUserId" },
            { status: 400 },
          );
        try {
          log.info(
            { event: "local_join_requested", channelId, inviterUserId },
            "Local control requested Huddle join",
          );
          return Response.json({
            ok: true,
            ...(await joinHuddle(channelId, inviterUserId)),
          });
        } catch (error) {
          log.error(
            { event: "local_join_failed", channelId, err: error },
            "Local control Huddle join failed",
          );
          return Response.json({ error: safeError(error) }, { status: 502 });
        }
      },
    },
    "/tone": {
      POST: (request: Request) => {
        const denied = controlDenied(request, config.localControlToken);
        if (denied) return denied;
        const runtime = selectedRuntime(request);
        if (runtime instanceof Response) return runtime;
        const sent =
          runtime?.media.send({ type: "tone", frequency: 440 }) ?? false;
        log.debug(
          { event: "local_tone_requested", active: sent },
          "Local control requested test tone",
        );
        return Response.json({ ok: sent });
      },
    },
    "/leave": {
      POST: async (request: Request) => {
        const denied = controlDenied(request, config.localControlToken);
        if (denied) return denied;
        const runtime = selectedRuntime(request);
        if (runtime instanceof Response) return runtime;
        await runtime?.coordinator?.endFromSlack();
        log.info(
          { event: "local_leave_requested", active: Boolean(runtime) },
          "Local control requested session end",
        );
        return Response.json({ ok: true });
      },
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const runtime = runtimeForToken(token);
    if (url.pathname.startsWith("/audio/")) {
      const path = runtime?.coordinator?.audioPath(
        url.pathname.slice(7),
        token,
      );
      return path && (await Bun.file(path).exists())
        ? fileResponse(Bun.file(path), request, { "cache-control": "no-store" })
        : notFound();
    }
    if (url.pathname.startsWith("/artwork/")) {
      const path = runtime?.coordinator?.artworkPath(
        url.pathname.slice(9),
        token,
      );
      return path && (await Bun.file(path).exists())
        ? new Response(Bun.file(path), {
            headers: {
              "cache-control": "no-store",
              "content-type": "image/jpeg",
            },
          })
        : notFound();
    }
    if (url.pathname !== "/bridge" || !runtime) return notFound();
    return server.upgrade(request, {
      data: { sessionId: runtime.bootstrap.sessionId },
    })
      ? undefined
      : new Response("Upgrade failed", { status: 400 });
  },
  websocket: {
    open(socket) {
      const runtime = runtimes.get(socket.data.sessionId);
      if (runtime) {
        runtime.socket = socket;
        log.info(
          {
            event: "media_socket_opened",
            mediaSessionId: socket.data.sessionId,
          },
          "Media WebSocket opened",
        );
        captureAnalytics("media.socket_opened", {
          sessionId: runtime.coordinator?.id,
          properties: { mediaSessionId: socket.data.sessionId },
        });
      } else socket.close();
    },
    message(socket, raw) {
      const runtime = runtimes.get(socket.data.sessionId);
      if (!runtime) return socket.close();
      const message = JSON.parse(String(raw));
      if (message.type === "ready")
        socket.send(
          JSON.stringify({ type: "bootstrap", payload: runtime.bootstrap }),
        );
      handleMediaMessage(runtime, message);
    },
    close(socket) {
      const runtime = runtimes.get(socket.data.sessionId);
      if (runtime?.socket === socket) runtime.socket = undefined;
      log.warn(
        { event: "media_socket_closed", mediaSessionId: socket.data.sessionId },
        "Media WebSocket closed",
      );
      captureAnalytics("media.socket_closed", {
        sessionId: runtime?.coordinator?.id,
        properties: { mediaSessionId: socket.data.sessionId },
      });
    },
  },
});

/**
 * The media backend for a new runtime. The browser backend drives the media
 * page through the /bridge WebSocket; the native one runs its own process and
 * reports through the same messages.
 */
function createMediaSession(
  current: () => Runtime | undefined,
  backend: MediaBackend,
): MediaSession {
  if (backend === "native") {
    const session: NativeMediaSession = new NativeMediaSession(
      (message) => {
        const runtime = current();
        // A process that was swapped out for the browser still reports its
        // own leaving, which must not end the session it handed over.
        if (runtime?.media === session) handleMediaMessage(runtime, message);
      },
      (entryId) => {
        const runtime = current();
        return runtime?.coordinator?.audioPath(
          entryId,
          runtime.bootstrap.bridgeToken,
        );
      },
    );
    return session;
  }
  const browser = mediaBrowsers.session(server.url.origin);
  return {
    start: (bootstrap) => browser.start(bootstrap),
    send: (message) => {
      const socket = current()?.socket;
      socket?.send(JSON.stringify(message));
      return Boolean(socket);
    },
    close: () => browser.close(),
  };
}

/** Handles an event from a runtime's media backend, whichever it is. */
function handleMediaMessage(runtime: Runtime, message: MediaMessage) {
  runtime.mediaState = { type: message.type, details: message.details };
  const ownSession = message.sessionId === runtime.bootstrap.sessionId;
  const detail = detailMessage(message.details);
  // Native media that fails mid-session hands over to the browser instead of
  // ending it. A failure while joining rejects the join gate as usual, and
  // joinHuddle falls back from there.
  if (
    ownSession &&
    runtime.coordinator &&
    nativeMediaFailed(message) &&
    canFallBack(runtime)
  )
    void fallBackToBrowser(runtime, {
      reason: `Native media ${message.type}: ${detail}`,
    });
  else {
    if (ownSession && message.type === "joined") runtime.joinGate?.resolve();
    if (ownSession && (message.type === "fatal" || message.type === "ended"))
      runtime.joinGate?.reject(
        new Error(`Chime join failed: ${detail}`, { cause: message }),
      );
    if (ownSession && message.type === "ended") runtime.leaveGate?.resolve();
    if (ownSession)
      runtime.coordinator?.mediaEvent(
        message.type,
        message.details as Parameters<Coordinator["mediaEvent"]>[1],
      );
  }
  const fields = {
    event: "media_message",
    mediaSessionId: runtime.bootstrap.sessionId,
    mediaEvent: String(message.type),
    ...(message.type === "fatal" ? { error: detail } : {}),
  };
  if (message.type === "fatal")
    log.error(
      { ...fields, err: new Error(detail) },
      "Media page reported fatal error",
    );
  else if (message.type === "playback_position")
    log.trace(fields, "Media playback position received");
  else log.info(fields, "Media message received");
}

function selectedRuntime(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  const active = [...runtimes.values()].filter(
    (runtime) => runtime.coordinator,
  );
  const runtime = sessionId
    ? active.find((runtime) => runtime.coordinator?.id === sessionId)
    : active.length <= 1
      ? active[0]
      : undefined;
  if (runtime) return runtime;
  if (!sessionId && !active.length) return;
  return Response.json(
    {
      error: sessionId
        ? "Session not found"
        : "sessionId is required when multiple huddles are active",
    },
    { status: 400 },
  );
}

botUserId = await verifySlackIdentity(config);
companions = new CompanionChannels(store, slackHuddle, slackApp, botUserId);
companions.start();
for (const sessionId of saved.expiredIds) {
  companions.abandonSession(sessionId);
}
await catalog.initialize();
slackApp.onSuggestion = (interaction) =>
  coordinatorFor(interaction)?.suggestions(interaction) ?? Promise.resolve([]);
slackApp.onAction = (interaction) =>
  interaction.actionId === "restore_session"
    ? restoreEndedSession(interaction)
    : interaction.actionId === "unlike_track"
      ? undoLike(interaction)
      : interaction.actionId === playbackReportCallbackId
        ? recordPlaybackReport(interaction)
        : coordinatorFor(interaction)?.action(interaction);
await slackApp.start();
// Huddle member events ride the private realtime gateway, which drops them
// whenever its socket cycles, so periodically and after every reconnect the
// tracked participants are reconciled with Slack's actual Huddle membership.
slackHuddle.onConnected = reconcileAllParticipants;
reconcileTimer = setInterval(reconcileAllParticipants, 60_000);
await slackHuddle.start((event) => {
  if (event.type === "DirectMessage") {
    void handleIntegrationDm(event).catch((error) =>
      log.warn(
        {
          event: "integration_dm_failed",
          userId: event.userId,
          err: error,
        },
        "Could not handle integration DM",
      ),
    );
    return;
  }
  if (event.type === "HuddleInvited") {
    log.info(
      {
        event: "huddle_invited",
        channelId: event.channelId,
        callId: event.callId,
        inviterUserId: event.inviterUserId,
      },
      "Huddle invitation received",
    );
    captureAnalytics("huddle.invited", {
      distinctId: event.inviterUserId,
      properties: { channelId: event.channelId, callId: event.callId },
    });
    void joinHuddle(
      event.channelId,
      event.inviterUserId,
      event.callId,
      event.freeWilly,
    ).catch(() => {});
    return;
  }
  if (event.type === "ThreadActivity") {
    const runtime = [...runtimes.values()].find((runtime) => {
      const room = runtime.coordinator?.room;
      return room
        ? roomOwnsThread(room, event.channelId, event.threadTs)
        : false;
    });
    const mentioned =
      event.userId !== botUserId && event.text.includes(`<@${botUserId}>`);
    if (mentioned) {
      const settleMention = mentionReaction(event.channelId, event.messageTs);
      const bare = isBareMention(event.text, botUserId);
      const coordinator = runtime?.coordinator;
      const failed = (name: string, message: string) => (error: unknown) => {
        settleMention(false);
        log.error(
          {
            event: name,
            channelId: event.channelId,
            userId: event.userId,
            err: error,
          },
          message,
        );
      };
      const hintFailed = (name: string, message: string) => (error: unknown) =>
        log.warn(
          { event: name, channelId: event.channelId, err: error },
          message,
        );
      const actionFailed = failed(
        "mention_action_failed",
        "Could not handle Huddle mention",
      );
      if (!coordinator) {
        void joinMentionedHuddle(event)
          .then((joined) => settleMention(joined))
          .catch(actionFailed);
      } else if (bare) {
        const companionId = coordinator.room.companionChannelId;
        const mentionedInHuddleThread =
          Boolean(companionId) &&
          event.channelId === coordinator.room.sourceChannelId &&
          event.threadTs === coordinator.room.huddleThreadTs;
        if (mentionedInHuddleThread && companionId) {
          void mentionEphemeral(
            event.channelId,
            event.userId,
            `Player controls are in <#${companionId}>. Mention me here with a request to control the session.`,
            event.threadTs,
            companionId,
          ).catch(
            hintFailed(
              "companion_mention_hint_failed",
              "Could not send companion channel mention hint",
            ),
          );
        }
        void coordinator
          .repost()
          .then(() => settleMention(true))
          .catch(actionFailed);
      } else if (!agentConfigured()) {
        settleMention(false);
        void mentionEphemeral(
          event.channelId,
          event.userId,
          "AI controls aren’t configured. Set OPENROUTER_API_KEY, or mention me with nothing else to bring the player to the bottom of the thread.",
          event.threadTs,
          coordinator.room.companionChannelId,
        ).catch(
          hintFailed(
            "agent_unconfigured_notice_failed",
            "Could not send agent configuration notice",
          ),
        );
      } else {
        void runAgentCommand({
          coordinator,
          userId: event.userId,
          text: event.text,
          botUserId,
        })
          .then((reply) => {
            settleMention(reply.ok);
            return mentionEphemeral(
              event.channelId,
              event.userId,
              reply.text,
              event.threadTs,
              coordinator.room.companionChannelId,
            );
          })
          .catch(
            failed("mention_agent_failed", "Could not handle agent mention"),
          );
      }
    }
    if (!mentioned) runtime?.coordinator?.threadActivity(event.userId);
    return;
  }
  if (
    event.type === "ChannelLeft" ||
    event.type === "ChannelMemberJoined" ||
    event.type === "ChannelMemberLeft"
  ) {
    const runtime = [...runtimes.values()].find(
      ({ coordinator }) => coordinator?.room.uiChannelId === event.channelId,
    );
    const coordinator = runtime?.coordinator;
    if (!runtime || !coordinator) return;
    if (
      event.type === "ChannelLeft" ||
      (event.type === "ChannelMemberLeft" && event.userId === botUserId)
    ) {
      void migrateControls(runtime);
      return;
    }
    if (!coordinator.room.companionChannelId) return;
    if (event.type === "ChannelMemberJoined") {
      if (!coordinator.hasParticipant(event.userId))
        void companions
          .removeNow(event.channelId, event.userId)
          .catch((error) =>
            log.warn(
              {
                event: "unexpected_member_remove_failed",
                ...event,
                err: error,
              },
              "Could not remove unexpected companion channel member",
            ),
          );
      return;
    }
    if (coordinator.hasParticipant(event.userId))
      void companions
        .add(event.channelId, event.userId)
        .catch((error) =>
          log.warn(
            { event: "active_member_reinvite_failed", ...event, err: error },
            "Could not restore active companion channel member",
          ),
        );
    return;
  }
  const runtime = runtimeForCall(event.callId);
  if (!runtime?.coordinator) return;
  if (
    event.type === "MemberJoined" &&
    config.excludedUserIds.has(event.userId)
  ) {
    if (runtime.coordinator.room.companionChannelId)
      void companions
        .removeNow(runtime.coordinator.room.companionChannelId, event.userId)
        .catch(() => {});
    return;
  }
  if (event.type === "MemberJoined") {
    runtime.coordinator.memberJoined(event.userId);
    store.addSessionParticipant(runtime.coordinator.id, event.userId);
    if (runtime.coordinator.room.companionChannelId)
      addCompanionMember(
        runtime.coordinator.room.companionChannelId,
        event.userId,
      );
  }
  if (event.type === "MemberLeft") {
    if (runtime.coordinator.room.companionChannelId)
      companions.removeLater(
        runtime.coordinator.room.companionChannelId,
        event.userId,
      );
    runtime.coordinator.memberLeft(event.userId);
    store.removeSessionParticipant(runtime.coordinator.id, event.userId);
  }
  if (event.type === "HuddleEnded") void runtime.coordinator.endFromSlack();
});
if (config.canvasId) {
  void updateCanvas();
  canvasTimer = setInterval(() => void updateCanvas(), 15 * 60_000);
}
for (const session of store.restorableSessions())
  scheduleEndCleanup(session.id);
for (const session of saved.sessions) pendingRestores.set(session.id, session);
await retryRestores();
if (pendingRestores.size)
  restoreTimer = setInterval(() => void retryRestores(), 5_000);
log.info(
  {
    event: "ready",
    botUserId,
    serverUrl: server.url.href,
    pendingRestores: pendingRestores.size,
    durationMs: Date.now() - startupAt,
  },
  "HuddleFM ready",
);
captureAnalytics("app.ready", {
  properties: {
    restoredSessions: saved.sessions.length - pendingRestores.size,
    pendingRestores: pendingRestores.size,
    durationMs: Date.now() - startupAt,
  },
});

const shutdownTimeoutMs = 30_000;
const shutdown = async () => {
  if (shuttingDown) {
    log.warn({ event: "shutdown_forced" }, "Forcing exit on repeated signal");
    flushLogs();
    process.exit(1);
  }
  shuttingDown = true;
  const startedAt = Date.now();
  log.info(
    { event: "shutdown_started", activeSessions: runtimes.size },
    "Shutdown started",
  );
  captureAnalytics("app.shutdown_started", {
    properties: { activeSessions: runtimes.size },
  });
  const failsafe = setTimeout(() => {
    log.error(
      { event: "shutdown_timeout", durationMs: Date.now() - startedAt },
      "Shutdown did not complete in time; exiting",
    );
    flushLogs();
    process.exit(1);
  }, shutdownTimeoutMs);
  failsafe.unref();
  try {
    await shutdownSteps();
    captureAnalytics("app.shutdown_completed", {
      properties: { durationMs: Date.now() - startedAt },
    });
    log.info(
      { event: "shutdown_completed", durationMs: Date.now() - startedAt },
      "Shutdown complete",
    );
  } catch (error) {
    log.error({ event: "shutdown_failed", err: error }, "Shutdown failed");
    captureAnalytics("app.shutdown_failed", {
      properties: { durationMs: Date.now() - startedAt },
    });
  }
  await shutdownAnalytics();
  flushLogs();
  process.exit(0);
};

async function shutdownSteps() {
  canvasPending = false;
  clearInterval(restoreTimer);
  clearInterval(canvasTimer);
  clearInterval(reconcileTimer);
  fallbackReports.stop();
  companions.stop();
  for (const timer of endCleanupTimers.values()) clearTimeout(timer);
  log.debug({ event: "shutdown_canvas_wait" }, "Waiting for Canvas update");
  await canvasUpdate;
  log.debug({ event: "shutdown_restore_wait" }, "Waiting for session restores");
  await Promise.allSettled([...restoreWork]);
  const resumeUntil = Date.now() + resumeTtlMs;
  log.info(
    { event: "shutdown_suspending_sessions", activeSessions: runtimes.size },
    "Suspending active sessions",
  );
  await Promise.allSettled(
    [...runtimes.values()].map(
      (runtime) =>
        runtime.coordinator?.suspendForRestart(resumeUntil) ??
        runtime.media.close(),
    ),
  );
  log.debug({ event: "shutdown_media_browsers" }, "Closing media browsers");
  await mediaBrowsers.close();
  log.debug({ event: "shutdown_server" }, "Stopping server");
  server.stop();
  log.debug({ event: "shutdown_slack_app" }, "Stopping Slack app");
  await slackApp.stop();
  log.debug(
    { event: "shutdown_huddle_connection" },
    "Stopping Huddle connection",
  );
  slackHuddle.stop();
  log.debug({ event: "shutdown_catalog" }, "Closing media catalog");
  await catalog.close();
  log.debug({ event: "shutdown_scrobbling" }, "Stopping scrobbling");
  await scrobbling.stop();
  log.debug({ event: "shutdown_store" }, "Closing store");
  store.close();
  log.debug({ event: "shutdown_audit" }, "Flushing audit log");
  await audit.flush();
  await fallbackReports.flush();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function detailMessage(details: unknown) {
  return safeError(
    details && typeof details === "object" && "message" in details
      ? (details as { message?: unknown }).message
      : details,
  );
}
