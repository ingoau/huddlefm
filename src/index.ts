import type { ServerWebSocket } from "bun";
import { AuditLog } from "./audit-log.ts";
import { loadConfig } from "./config.ts";
import { Coordinator } from "./coordinator.ts";
import { controlDenied } from "./local-control.ts";
import { LyricsCatalog } from "./lyrics.ts";
import { MediaBrowser } from "./media-browser.ts";
import { SlackAppAdapter } from "./slack-app.ts";
import { SlackHuddleAdapter, verifySlackIdentity, type ChimeBootstrap } from "./slack-huddle.ts";
import { Store } from "./store.ts";
import { TrackCatalog } from "./tracks.ts";

const config = loadConfig();
const build = await Bun.build({
  entrypoints: [new URL("./media-page.ts", import.meta.url).pathname],
  outdir: "dist",
  target: "browser",
  minify: true,
  define: { global: "globalThis" },
});
if (!build.success) throw new AggregateError(build.logs, "Media page build failed");

const store = new Store();
const catalog = new TrackCatalog(config);
const lyrics = new LyricsCatalog();
const slackApp = new SlackAppAdapter(config);
const audit = new AuditLog("data/audit.jsonl", id => slackApp.userName(id));
const slackHuddle = new SlackHuddleAdapter(config);
let bootstrap: ChimeBootstrap | undefined;
let mediaSocket: ServerWebSocket<unknown> | undefined;
let mediaState: { type: string; details?: unknown } | undefined;
let active: Coordinator | undefined;
let mediaBrowser: MediaBrowser;
let botUserId = "";
let joining = false;
let mediaJoin: { sessionId: string; gate: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
let activeMediaSessionId: string | undefined;

async function joinHuddle(channelId: string, inviterUserId: string, callId?: string) {
  if (active || bootstrap || joining) throw new Error("A Huddle session is already active");
  joining = true;
  try {
    if (!(await slackHuddle.ensureChannelAccess(channelId))) {
      if (callId) await slackHuddle.decline(channelId, callId);
      await slackApp.privateChannelNotice(inviterUserId);
      return { declined: true };
    }
    const joined = await slackHuddle.join(channelId);
    const token = crypto.randomUUID();
    const attempt = bootstrap = {
      sessionId: crypto.randomUUID(),
      meeting: joined.chimeMeeting,
      attendee: joined.chimeAttendee,
      initialVolume: config.initialVolume,
      bridgeToken: token,
    };
    const gate = Promise.withResolvers<void>();
    const mediaAttempt = mediaJoin = { sessionId: attempt.sessionId, gate };
    const timer = setTimeout(() => gate.reject(new Error("Timed out joining Chime")), 30_000);
    try {
      await mediaBrowser.start(attempt);
      await gate.promise;
    } catch (error) {
      await mediaBrowser.stop();
      if (bootstrap === attempt) bootstrap = undefined;
      throw error;
    } finally {
      clearTimeout(timer);
      if (mediaJoin === mediaAttempt) mediaJoin = undefined;
    }
    let coordinator: Coordinator;
    coordinator = new Coordinator(
      joined,
      inviterUserId,
      botUserId,
      slackApp,
      store,
      catalog,
      lyrics,
      audit,
      config,
      token,
      message => mediaSocket?.send(JSON.stringify(message)),
      async () => {
        await mediaBrowser.stop();
        if (active === coordinator) {
          active = undefined;
          activeMediaSessionId = undefined;
        }
        if (bootstrap === attempt) bootstrap = undefined;
      },
    );
    try {
      await coordinator.start();
      active = coordinator;
      activeMediaSessionId = attempt.sessionId;
    } catch (error) {
      await mediaBrowser.stop();
      if (bootstrap === attempt) bootstrap = undefined;
      throw error;
    }
    return { sessionId: coordinator.id, huddleId: joined.huddleId };
  } finally {
    joining = false;
  }
}

const server = Bun.serve({
  hostname: config.bindAddress,
  port: config.port,
  routes: {
    "/health": () => Response.json({ ok: true, sessionId: active?.id ?? null, media: mediaState ?? null }),
    "/favicon.ico": () => new Response(null, { status: 204 }),
    "/media": () => new Response(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>HuddleFM media</title><link rel=stylesheet href=/media-page.css><main id=stage><div id=artwork></div><header><h1 id=title>Ready for music</h1><p id=artist>Waiting for the next track</p></header><section id=lyrics-frame><braccato-lyrics id=lyrics></braccato-lyrics></section><div id=progress><div id=progress-fill></div></div></main><button id=capture>Start camera</button><p id=status>connecting</p><script type=module src=/media-page.js></script>",
      { headers: { "content-type": "text/html" } },
    ),
    "/media-page.js": () => new Response(Bun.file("dist/media-page.js"), { headers: { "content-type": "text/javascript" } }),
    "/media-page.css": () => new Response(Bun.file("dist/media-page.css"), { headers: { "content-type": "text/css" } }),
    "/join": {
      POST: async request => {
        const denied = controlDenied(request, config.localControlToken);
        if (denied) return denied;
        const { channelId, inviterUserId } = await request.json() as { channelId?: string; inviterUserId?: string };
        if (!channelId?.match(/^[A-Z0-9]+$/) || !inviterUserId?.match(/^[A-Z0-9]+$/))
          return Response.json({ error: "Invalid channelId or inviterUserId" }, { status: 400 });
        try {
          return Response.json({ ok: true, ...await joinHuddle(channelId, inviterUserId) });
        } catch (error) {
          console.error(safeError(error));
          return Response.json({ error: safeError(error) }, { status: 502 });
        }
      },
    },
    "/tone": { POST: request => {
      const denied = controlDenied(request, config.localControlToken);
      if (denied) return denied;
      mediaSocket?.send(JSON.stringify({ type: "tone", frequency: 440 }));
      return Response.json({ ok: Boolean(mediaSocket) });
    } },
    "/leave": { POST: async request => {
      const denied = controlDenied(request, config.localControlToken);
      if (denied) return denied;
      await active?.endFromSlack();
      return Response.json({ ok: true });
    } },
  },
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/audio/")) {
      const path = active?.audioPath(url.pathname.slice(7), url.searchParams.get("token") ?? "");
      return path ? new Response(Bun.file(path), { headers: { "cache-control": "no-store" } }) : new Response("Not found", { status: 404 });
    }
    if (url.pathname !== "/bridge" || !bootstrap || url.searchParams.get("token") !== bootstrap.bridgeToken)
      return new Response("Not found", { status: 404 });
    return server.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
  },
  websocket: {
    open(socket) { mediaSocket = socket; },
    message(socket, raw) {
      const message = JSON.parse(String(raw));
      mediaState = { type: message.type, details: message.details };
      const pendingJoin = mediaJoin;
      if (pendingJoin && message.sessionId === pendingJoin.sessionId && message.type === "joined")
        pendingJoin.gate.resolve();
      if (pendingJoin && message.sessionId === pendingJoin.sessionId && (message.type === "fatal" || message.type === "ended"))
        pendingJoin.gate.reject(new Error(`Chime join failed: ${detailMessage(message.details)}`));
      if (message.type === "ready" && bootstrap)
        socket.send(JSON.stringify({ type: "bootstrap", payload: bootstrap }));
      if (message.sessionId === activeMediaSessionId)
        active?.mediaEvent(message.type, message.details);
      console.log(`[media] ${message.type}${message.type === "fatal" ? `: ${detailMessage(message.details)}` : ""}`);
    },
    close(socket) { if (mediaSocket === socket) mediaSocket = undefined; },
  },
});

mediaBrowser = new MediaBrowser(config.chromePath, server.url.origin);
botUserId = await verifySlackIdentity(config);
await catalog.initialize();
slackApp.onSuggestion = interaction => active?.suggestions(interaction) ?? Promise.resolve([]);
slackApp.onAction = interaction => active?.action(interaction);
await slackApp.start();
await slackHuddle.start(event => {
  if (event.type === "HuddleInvited") {
    console.log(`[huddle] invited ${event.callId} by ${event.inviterUserId}`);
    void joinHuddle(event.channelId, event.inviterUserId, event.callId).catch(error => console.error(safeError(error)));
  } else if (active && event.type === "ThreadActivity" && event.channelId === active.room.uiChannelId && event.threadTs === active.room.uiThreadTs)
    active.threadActivity(event.userId);
  else if (active && "callId" in event && event.callId === active.room.huddleCallId) {
    if (event.type === "MemberJoined") active.memberJoined(event.userId);
    if (event.type === "MemberLeft") active.memberLeft(event.userId);
    if (event.type === "HuddleEnded") void active.endFromSlack();
  }
});
console.log(`HuddleFM ready as ${botUserId} on ${server.url}`);

const shutdown = async () => {
  await active?.endFromSlack();
  server.stop();
  await slackApp.stop();
  slackHuddle.stop();
  await mediaBrowser.close();
  await catalog.close();
  store.close();
  await audit.flush();
  process.exit();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(
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
