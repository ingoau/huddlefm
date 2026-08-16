import type { ServerWebSocket } from "bun";
import { rm } from "node:fs/promises";
import { AuditLog } from "./audit-log.ts";
import { canvasMarkdown } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { Coordinator } from "./coordinator.ts";
import { errorMessage } from "./error-message.ts";
import { controlDenied } from "./local-control.ts";
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
const config = loadConfig();
const build = await Bun.build({
  entrypoints: [new URL("./media-page.ts", import.meta.url).pathname],
  outdir: "dist",
  target: "browser",
  minify: true,
  define: { global: "globalThis" },
});
if (!build.success)
  throw new AggregateError(build.logs, "Media page build failed");

const store = new Store();
const scrobbling = new ScrobbleDispatcher(store, config);
scrobbling.start();
const saved = store.resumableSessions(Date.now(), resumeTtlMs);
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
let botUserId = "";
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
  canvasUpdate = Promise.resolve()
    .then(() =>
      slackHuddle.updateCanvas(
        canvasId,
        canvasMarkdown(store.canvasStats(), store.usageStats()),
      ),
    )
    .catch((error) =>
      console.error(`[canvas] update failed: ${safeError(error)}`),
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
  joiningChannels.add(channelId);
  if (callId) joiningCalls.add(callId);
  let runtime: Runtime | undefined;
  try {
    if (!(await slackHuddle.ensureChannelAccess(channelId))) {
      if (callId) await slackHuddle.decline(channelId, callId);
      await slackApp.privateChannelNotice(inviterUserId);
      return { declined: true };
    }
    const joined = await slackHuddle.join(channelId);
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
    const gate = (runtime.joinGate = Promise.withResolvers<void>());
    const timer = setTimeout(
      () => gate.reject(new Error("Timed out joining Chime")),
      30_000,
    );
    try {
      await runtime.browser.start(bootstrap);
      await gate.promise;
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
        const timer = setTimeout(gate.resolve, shuttingDown ? 20_000 : 5_000);
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
      scheduleEndCleanup,
    ));
    try {
      if (restored) await coordinator.resume();
      else await coordinator.start();
    } catch (error) {
      await runtime.browser.close();
      runtimes.delete(bootstrap.sessionId);
      throw error;
    }
    return { sessionId: coordinator.id, huddleId: joined.huddleId };
  } finally {
    joiningChannels.delete(channelId);
    if (callId) joiningCalls.delete(callId);
  }
}

async function restoreSession(saved: SavedSession) {
  if (Date.now() >= saved.resumeUntil) {
    store.expireSession(saved.id);
    await rm(`data/media/${saved.id}`, { recursive: true, force: true });
    pendingRestores.delete(saved.id);
    return;
  }
  const callId = await slackHuddle.activeHuddleCall(
    saved.channelId,
    saved.threadTs,
  );
  if (!callId) {
    store.expireSession(saved.id);
    await rm(`data/media/${saved.id}`, { recursive: true, force: true });
    pendingRestores.delete(saved.id);
    return;
  }
  await joinHuddle(
    saved.channelId,
    saved.hostId ?? saved.creatorId,
    callId,
    saved,
  );
  pendingRestores.delete(saved.id);
  console.log(`[restart] resumed ${saved.id}`);
}

async function retryRestores() {
  if (shuttingDown) return;
  const work = [...pendingRestores.values()]
    .filter((saved) => !restoring.has(saved.id))
    .map((saved) => {
      restoring.add(saved.id);
      const task = restoreSession(saved)
        .catch((error) =>
          console.error(`[restart] ${saved.id}: ${safeError(error)}`),
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
    console.error(`[restore] could not remove button: ${safeError(error)}`);
  } finally {
    store.expireSession(sessionId);
    await rm(`data/media/${sessionId}`, { recursive: true, force: true });
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
  try {
    const callId = await slackHuddle.activeHuddleCall(
      session.channelId,
      session.threadTs,
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
    await joinHuddle(session.channelId, interaction.userId, callId, session);
    clearTimeout(endCleanupTimers.get(session.id));
    endCleanupTimers.delete(session.id);
  } catch (error) {
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
          return Response.json({
            ok: true,
            ...(await joinHuddle(channelId, inviterUserId)),
          });
        } catch (error) {
          console.error(safeError(error));
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
      if (runtime) runtime.socket = socket;
      else socket.close();
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
      console.log(
        `[media:${runtime.bootstrap.sessionId}] ${message.type}${message.type === "fatal" ? `: ${detailMessage(message.details)}` : ""}`,
      );
    },
    close(socket) {
      const runtime = runtimes.get(socket.data.sessionId);
      if (runtime?.socket === socket) runtime.socket = undefined;
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
    console.log(`[huddle] invited ${event.callId} by ${event.inviterUserId}`);
    void joinHuddle(event.channelId, event.inviterUserId, event.callId).catch(
      (error) => console.error(safeError(error)),
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
      void slackHuddle
        .react(event.channelId, event.messageTs)
        .catch((error) =>
          console.error(`[huddle] reaction failed: ${safeError(error)}`),
        );
      void (runtime?.coordinator?.repost() ?? joinMentionedHuddle(event)).catch(
        (error) => console.error(safeError(error)),
      );
    }
    if (!mentioned) runtime?.coordinator?.threadActivity(event.userId);
    return;
  }
  const runtime = runtimeForCall(event.callId);
  if (!runtime?.coordinator) return;
  if (event.type === "MemberJoined")
    runtime.coordinator.memberJoined(event.userId);
  if (event.type === "MemberLeft") runtime.coordinator.memberLeft(event.userId);
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
console.log(`HuddleFM ready as ${botUserId} on ${server.url}`);

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  canvasPending = false;
  clearInterval(restoreTimer);
  clearInterval(canvasTimer);
  for (const timer of endCleanupTimers.values()) clearTimeout(timer);
  await canvasUpdate;
  await Promise.allSettled([...restoreWork]);
  const resumeUntil = Date.now() + resumeTtlMs;
  await Promise.allSettled(
    [...runtimes.values()].map(
      (runtime) =>
        runtime.coordinator?.suspendForRestart(resumeUntil) ??
        runtime.browser.close(),
    ),
  );
  await mediaBrowsers.close();
  server.stop();
  await slackApp.stop();
  slackHuddle.stop();
  await catalog.close();
  await scrobbling.stop();
  store.close();
  await audit.flush();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function safeError(error: unknown) {
  return errorMessage(error).replace(
    /(xox[acpbrs]-|token|cookie|authorization|JoinToken)[^\s,]*/gi,
    "$1[redacted]",
  );
}

function detailMessage(details: unknown) {
  return safeError(
    details && typeof details === "object" && "message" in details
      ? (details as { message?: unknown }).message
      : details,
  );
}
