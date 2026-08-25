import type { ServerWebSocket } from "bun";
import { rm } from "node:fs/promises";
import { AuditLog } from "./audit-log.ts";
import { canvasMarkdown } from "./canvas.ts";
import { CompanionChannels } from "./companion-channels.ts";
import { loadConfig } from "./config.ts";
import { Coordinator } from "./coordinator.ts";
import { safeError } from "./error-message.ts";
import { controlDenied } from "./local-control.ts";
import { flushLogs, logger } from "./logger.ts";
import { LyricsCatalog } from "./lyrics.ts";
import { MediaBrowserPool, type MediaBrowser } from "./media-browser.ts";
import { ScrobbleDispatcher } from "./scrobbling.ts";
import { SlackAppAdapter, type Interaction } from "./slack-app.ts";
import {
  SlackHuddleAdapter,
  verifySlackIdentity,
  type ChimeBootstrap,
} from "./slack-huddle.ts";
import { Store, type SavedSession } from "./store.ts";
import { TrackCatalog } from "./tracks.ts";

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
await Promise.all(
  saved.expiredIds.map((id) =>
    rm(`data/media/${id}`, { recursive: true, force: true }),
  ),
);
const catalog = new TrackCatalog(config);
const lyrics = new LyricsCatalog();
const slackApp = new SlackAppAdapter(config);
const audit = new AuditLog("data/audit.jsonl", (id) => slackApp.userName(id));
if (store.needsUsageBackfill())
  store.importUsage(await audit.historicalUsage());
const slackHuddle = new SlackHuddleAdapter(config);
const mediaBrowsers = new MediaBrowserPool(config.chromePath);
const runtimes = new Map<string, Runtime>();
const joiningChannels = new Set<string>();
const joiningCalls = new Set<string>();
const pendingRestores = new Map<string, SavedSession>();
const restoring = new Set<string>();
const restoreWork = new Set<Promise<void>>();
const endCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const migratingControls = new Set<string>();
let botUserId = "";
let companions: CompanionChannels;
let restoreTimer: ReturnType<typeof setInterval> | undefined;
let canvasTimer: ReturnType<typeof setInterval> | undefined;
let canvasUpdate: Promise<void> | undefined;
let canvasPending = false;
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
  canvasUpdate = Promise.resolve()
    .then(() =>
      slackApp.updateCanvas(
        canvasId,
        canvasMarkdown(store.canvasStats(), store.usageStats()),
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

type SocketData = { sessionId: string };
type Gate = ReturnType<typeof Promise.withResolvers<void>>;
type Runtime = {
  sourceChannelId: string;
  callId: string;
  bootstrap: ChimeBootstrap;
  browser: MediaBrowser;
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

function runtimeForCall(callId: string) {
  return [...runtimes.values()].find(
    (runtime) =>
      runtime.callId === callId ||
      runtime.coordinator?.room.huddleId === callId,
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
          );
    if (!channelId) throw new Error("No replacement channel was created");
    await companions.activate(channelId, coordinator.participantIds());
    await coordinator.moveControls(channelId);
    log.info(
      { event: "controls_channel_migrated", oldChannelId, channelId },
      "Migrated Huddle controls channel",
    );
  } catch (error) {
    await slackApp
      .dm(
        coordinator.hostUserId(),
        `I lost access to the HuddleFM controls channel and couldn’t replace it: ${safeError(error)}`,
      )
      .catch(() => {});
    log.error(
      { event: "controls_channel_migration_failed", oldChannelId, err: error },
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
  await rm(`data/media/${sessionId}`, { recursive: true, force: true });
  pendingRestores.delete(sessionId);
}

async function joinHuddle(
  channelId: string,
  inviterUserId: string,
  callId?: string,
  restored?: SavedSession,
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
  joiningChannels.add(channelId);
  if (callId) joiningCalls.add(callId);
  let runtime: Runtime | undefined;
  let companionChannelId: string | undefined;
  let preparedParticipantIds = [inviterUserId];
  try {
    try {
      companionChannelId = await companions.prepare(channelId, inviterUserId);
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
      return { declined: true };
    }
    const joined = await slackHuddle.join(channelId);
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
      bridgeToken: crypto.randomUUID(),
    };
    runtime = {
      sourceChannelId: channelId,
      callId: joined.huddleCallId,
      bootstrap,
      browser: mediaBrowsers.session(server.url.origin),
    };
    runtimes.set(bootstrap.sessionId, runtime);
    log.debug(
      {
        event: "runtime_created",
        mediaSessionId: bootstrap.sessionId,
        channelId,
        callId: joined.huddleCallId,
      },
      "Media runtime created",
    );
    const gate = (runtime.joinGate = Promise.withResolvers<void>());
    const timer = setTimeout(
      () => gate.reject(new Error("Timed out joining Chime")),
      30_000,
    );
    try {
      await runtime.browser.start(bootstrap);
      await gate.promise;
      log.info(
        {
          event: "media_joined",
          mediaSessionId: bootstrap.sessionId,
          durationMs: Date.now() - startedAt,
        },
        "Media page joined Chime",
      );
    } catch (error) {
      await runtime.browser.close();
      runtimes.delete(bootstrap.sessionId);
      throw error;
    } finally {
      clearTimeout(timer);
      runtime.joinGate = undefined;
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
      (message) => runtime?.socket?.send(JSON.stringify(message)),
      async () => {
        const gate = (runtime!.leaveGate = Promise.withResolvers<void>());
        const timer = setTimeout(gate.resolve, 5_000);
        try {
          await gate.promise;
        } finally {
          clearTimeout(timer);
          runtime!.leaveGate = undefined;
        }
        await runtime!.browser.close();
        runtimes.delete(bootstrap.sessionId);
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
    ));
    try {
      if (restored) await coordinator.resume();
      else await coordinator.start();
      store.setSessionParticipants(
        coordinator.id,
        coordinator.participantIds(),
      );
    } catch (error) {
      await runtime.browser.close();
      runtimes.delete(bootstrap.sessionId);
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
        restoredSessionId: restored?.id,
        durationMs: Date.now() - startedAt,
        err,
      },
      restored ? "Huddle session restore failed" : "Huddle join failed",
    );
    throw err;
  } finally {
    joiningChannels.delete(channelId);
    if (callId) joiningCalls.delete(callId);
  }
}

async function restoreSession(saved: SavedSession) {
  if (Date.now() >= saved.resumeUntil) {
    await abandonSession(saved.id);
    log.info(
      { event: "restore_expired", sessionId: saved.id },
      "Expired interrupted session",
    );
    return;
  }
  const callId = await slackHuddle.activeHuddleCall(
    saved.sourceChannelId ?? saved.channelId,
    saved.huddleThreadTs ?? saved.threadTs,
  );
  if (!callId) {
    await abandonSession(saved.id);
    log.info(
      { event: "restore_huddle_ended", sessionId: saved.id },
      "Expired session because its Huddle ended",
    );
    return;
  }
  await joinHuddle(
    saved.sourceChannelId ?? saved.channelId,
    saved.hostId ?? saved.creatorId,
    callId,
    saved,
  );
  pendingRestores.delete(saved.id);
  log.info(
    { event: "restore_completed", sessionId: saved.id },
    "Interrupted session restored",
  );
}

async function retryRestores() {
  if (shuttingDown) return;
  const work = [...pendingRestores.values()]
    .filter((saved) => !restoring.has(saved.id))
    .map((saved) => {
      restoring.add(saved.id);
      const task = restoreSession(saved)
        .catch((error) =>
          log.warn(
            {
              event: "restore_attempt_failed",
              sessionId: saved.id,
              err: error,
            },
            "Interrupted session restore attempt failed",
          ),
        )
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
        session.endBlocks.filter(
          (block) =>
            !(
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
            ),
        ),
      );
  } catch (error) {
    log.error(
      { event: "restore_button_remove_failed", sessionId, err: error },
      "Could not remove session restore button",
    );
  } finally {
    store.expireSession(sessionId);
    await rm(`data/media/${sessionId}`, { recursive: true, force: true });
    log.info(
      { event: "ended_session_cleaned", sessionId },
      "Ended session cleaned up",
    );
  }
}

async function restoreEndedSession(interaction: Interaction) {
  const session = restorableSession(interaction.value);
  if (
    !session ||
    interaction.channelId !== session.channelId ||
    interaction.messageTs !== session.uiTs
  )
    return;
  if (Date.now() >= session.resumeUntil) {
    await cleanupEndedSession(session.id);
    await slackApp.ephemeral(
      session.channelId,
      interaction.userId,
      "That session can no longer be restored.",
      session.threadTs,
    );
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
  try {
    const callId = await slackHuddle.activeHuddleCall(
      session.sourceChannelId ?? session.channelId,
      session.huddleThreadTs ?? session.threadTs,
    );
    if (!callId) {
      await slackApp.ephemeral(
        session.channelId,
        interaction.userId,
        "That Huddle is no longer active.",
        session.threadTs,
      );
      return;
    }
    await joinHuddle(
      session.sourceChannelId ?? session.channelId,
      interaction.userId,
      callId,
      session,
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
  } catch (error) {
    log.error(
      {
        event: "manual_restore_failed",
        sessionId: session.id,
        durationMs: Date.now() - startedAt,
        err: error,
      },
      "Manual session restore failed",
    );
    await slackApp.ephemeral(
      session.channelId,
      interaction.userId,
      `I couldn’t restore that session: ${safeError(error)}`,
      session.threadTs,
    );
  } finally {
    restoring.delete(session.id);
  }
}

async function joinMentionedHuddle(
  event: Extract<
    import("./slack-huddle.ts").HuddleEvent,
    { type: "ThreadActivity" }
  >,
) {
  const callId = await slackHuddle.activeHuddleCall(
    event.channelId,
    event.threadTs,
  );
  if (!callId) {
    await slackApp.ephemeral(
      event.channelId,
      event.userId,
      "This isn’t an active Huddle thread.",
      event.threadTs,
    );
    return;
  }
  if (
    joiningChannels.has(event.channelId) ||
    joiningCalls.has(callId) ||
    runtimeForCall(callId)
  )
    return;
  await joinHuddle(event.channelId, event.userId, callId);
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
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>HuddleFM media</title><link rel=stylesheet href=/media-page.css><main id=stage data-display-mode=default><div id=artwork></div><div id=cover></div><header><h1 id=title>Ready for music</h1><p id=artist>Waiting for the next track</p></header><section id=lyrics-frame><braccato-lyrics id=lyrics></braccato-lyrics></section><div id=progress><div id=progress-fill></div></div></main><button id=capture>Start camera</button><p id=status>connecting</p><script type=module src=/media-page.js></script>",
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
        runtime?.socket?.send(JSON.stringify({ type: "tone", frequency: 440 }));
        log.debug(
          { event: "local_tone_requested", active: Boolean(runtime?.socket) },
          "Local control requested test tone",
        );
        return Response.json({ ok: Boolean(runtime?.socket) });
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
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/audio/")) {
      const entryId = url.pathname.slice(7);
      const token = url.searchParams.get("token") ?? "";
      const path = [...runtimes.values()]
        .find((runtime) => runtime.bootstrap.bridgeToken === token)
        ?.coordinator?.audioPath(entryId, token);
      return path
        ? new Response(Bun.file(path), {
            headers: { "cache-control": "no-store" },
          })
        : new Response("Not found", { status: 404 });
    }
    if (url.pathname !== "/bridge")
      return new Response("Not found", { status: 404 });
    const token = url.searchParams.get("token");
    const runtime = [...runtimes.values()].find(
      (runtime) => runtime.bootstrap.bridgeToken === token,
    );
    if (!runtime) return new Response("Not found", { status: 404 });
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
      } else socket.close();
    },
    message(socket, raw) {
      const runtime = runtimes.get(socket.data.sessionId);
      if (!runtime) return socket.close();
      const message = JSON.parse(String(raw));
      runtime.mediaState = { type: message.type, details: message.details };
      if (
        message.sessionId === runtime.bootstrap.sessionId &&
        message.type === "joined"
      )
        runtime.joinGate?.resolve();
      if (
        message.sessionId === runtime.bootstrap.sessionId &&
        (message.type === "fatal" || message.type === "ended")
      )
        runtime.joinGate?.reject(
          new Error(`Chime join failed: ${detailMessage(message.details)}`),
        );
      if (
        message.sessionId === runtime.bootstrap.sessionId &&
        message.type === "ended"
      )
        runtime.leaveGate?.resolve();
      if (message.type === "ready")
        socket.send(
          JSON.stringify({ type: "bootstrap", payload: runtime.bootstrap }),
        );
      if (message.sessionId === runtime.bootstrap.sessionId)
        runtime.coordinator?.mediaEvent(message.type, message.details);
      const fields = {
        event: "media_message",
        mediaSessionId: runtime.bootstrap.sessionId,
        mediaEvent: String(message.type),
        ...(message.type === "fatal"
          ? { error: detailMessage(message.details) }
          : {}),
      };
      if (message.type === "fatal")
        log.error(fields, "Media page reported fatal error");
      else if (message.type === "playback_position")
        log.trace(fields, "Media playback position received");
      else log.info(fields, "Media message received");
    },
    close(socket) {
      const runtime = runtimes.get(socket.data.sessionId);
      if (runtime?.socket === socket) runtime.socket = undefined;
      log.warn(
        { event: "media_socket_closed", mediaSessionId: socket.data.sessionId },
        "Media WebSocket closed",
      );
    },
  },
});

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
    : coordinatorFor(interaction)?.action(interaction);
await slackApp.start();
await slackHuddle.start((event) => {
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
    void joinHuddle(event.channelId, event.inviterUserId, event.callId).catch(
      () => {},
    );
    return;
  }
  if (event.type === "ThreadActivity") {
    const runtime = [...runtimes.values()].find(
      (runtime) =>
        event.channelId === runtime.coordinator?.room.uiChannelId &&
        event.threadTs === runtime.coordinator.room.uiThreadTs,
    );
    const mentioned =
      event.userId !== botUserId && event.text.includes(`<@${botUserId}>`);
    if (mentioned) {
      void slackHuddle.react(event.channelId, event.messageTs).catch((error) =>
        log.warn(
          {
            event: "mention_reaction_failed",
            channelId: event.channelId,
            err: error,
          },
          "Could not react to Huddle mention",
        ),
      );
      void (runtime?.coordinator?.repost() ?? joinMentionedHuddle(event)).catch(
        (error) =>
          log.error(
            {
              event: "mention_action_failed",
              channelId: event.channelId,
              userId: event.userId,
              err: error,
            },
            "Could not handle Huddle mention",
          ),
      );
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
  if (event.type === "MemberJoined")
    void (
      runtime.coordinator.room.companionChannelId
        ? companions
            .add(runtime.coordinator.room.companionChannelId, event.userId)
            .catch((error) =>
              slackApp
                .dm(
                  event.userId,
                  `I couldn’t add you to the HuddleFM controls channel: ${safeError(error)}`,
                )
                .catch(() => {}),
            )
        : Promise.resolve()
    ).then(() => {
      runtime.coordinator?.memberJoined(event.userId);
      if (runtime.coordinator)
        store.addSessionParticipant(runtime.coordinator.id, event.userId);
    });
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

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const startedAt = Date.now();
  log.info(
    { event: "shutdown_started", activeSessions: runtimes.size },
    "Shutdown started",
  );
  canvasPending = false;
  clearInterval(restoreTimer);
  clearInterval(canvasTimer);
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
        runtime.browser.close(),
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
  log.info(
    { event: "shutdown_completed", durationMs: Date.now() - startedAt },
    "Shutdown complete",
  );
  flushLogs();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function detailMessage(details: unknown) {
  return safeError(
    details && typeof details === "object" && "message" in details
      ? (details as { message?: unknown }).message
      : details,
  );
}
