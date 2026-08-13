import { loadConfig } from "./config.ts";
import { MediaBrowser } from "./media-browser.ts";
import { SlackAppAdapter } from "./slack-app.ts";
import { SlackHuddleAdapter, verifySlackIdentity, type ChimeBootstrap } from "./slack-huddle.ts";
import type { ServerWebSocket } from "bun";

const config = loadConfig();
const build = await Bun.build({
  entrypoints: [new URL("./media-page.ts", import.meta.url).pathname],
  outdir: "dist",
  target: "browser",
  minify: true,
  define: { global: "globalThis" },
});
if (!build.success) throw new AggregateError(build.logs, "Media page build failed");

let bootstrap: ChimeBootstrap | undefined;
let mediaSocket: ServerWebSocket<unknown> | undefined;
let mediaBrowser: MediaBrowser;
let mediaState: { type: string; details?: unknown } | undefined;
const slackApp = new SlackAppAdapter(config);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  routes: {
    "/health": () =>
      Response.json({
        ok: true,
        sessionId: bootstrap?.sessionId ?? null,
        media: mediaState ?? null,
      }),
    "/favicon.ico": () => new Response(null, { status: 204 }),
    "/media": () =>
      new Response(
        "<!doctype html><meta charset=utf-8><title>HuddleFM media</title><p id=status>connecting</p><script type=module src=/media-page.js></script>",
        { headers: { "content-type": "text/html" } },
      ),
    "/media-page.js": () =>
      new Response(Bun.file("dist/media-page.js"), {
        headers: { "content-type": "text/javascript" },
      }),
    "/join": {
      POST: async request => {
        const { channelId } = (await request.json()) as { channelId?: string };
        if (!channelId?.match(/^[A-Z0-9]+$/))
          return Response.json({ error: "Invalid channelId" }, { status: 400 });
        try {
          const joined = await new SlackHuddleAdapter(config).join(channelId);
          bootstrap = {
            sessionId: crypto.randomUUID(),
            meeting: joined.chimeMeeting,
            attendee: joined.chimeAttendee,
            initialVolume: 0.25,
            bridgeToken: crypto.randomUUID(),
          };
          await mediaBrowser.start(bootstrap);
          return Response.json({ ok: true, sessionId: bootstrap.sessionId, huddleId: joined.huddleId });
        } catch (error) {
          console.error(error instanceof Error ? error.message : error);
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
        }
      },
    },
    "/tone": {
      POST: async request => {
        const { frequency = 440 } = (await request.json()) as { frequency?: number };
        mediaSocket?.send(JSON.stringify({ type: "tone", frequency }));
        return Response.json({ ok: Boolean(mediaSocket) });
      },
    },
    "/leave": {
      POST: () => {
        mediaSocket?.send(JSON.stringify({ type: "leave" }));
        bootstrap = undefined;
        return Response.json({ ok: true });
      },
    },
    "/gate2/events": () => Response.json(slackApp.events),
    "/gate2/message": {
      POST: async request => {
        const { channelId } = (await request.json()) as { channelId?: string };
        if (!channelId?.match(/^[A-Z0-9]+$/))
          return Response.json({ error: "Invalid channelId" }, { status: 400 });
        return Response.json({ ts: await slackApp.postGate2Test(channelId) });
      },
    },
    "/gate2/delete": {
      POST: async request => {
        const { channelId, ts } = (await request.json()) as {
          channelId?: string;
          ts?: string;
        };
        if (!channelId || !ts)
          return Response.json({ error: "Missing channelId or ts" }, { status: 400 });
        await slackApp.deleteMessage(channelId, ts);
        return Response.json({ ok: true });
      },
    },
  },
  fetch(request, server) {
    const url = new URL(request.url);
    if (
      url.pathname !== "/bridge" ||
      !bootstrap ||
      url.searchParams.get("token") !== bootstrap.bridgeToken
    ) {
      return new Response("Not found", { status: 404 });
    }
    return server.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
  },
  websocket: {
    open(socket) {
      mediaSocket = socket;
    },
    message(socket, raw) {
      const message = JSON.parse(String(raw));
      mediaState = { type: message.type, details: message.details };
      if (message.type === "ready" && bootstrap)
        socket.send(JSON.stringify({ type: "bootstrap", payload: bootstrap }));
      const details =
        message.type === "fatal"
          ? `: ${String(message.details).replace(/(token|cookie|authorization)[^\s,]*/gi, "$1=[redacted]")}`
          : "";
      console.log(`[media] ${message.type}${details}`);
    },
    close(socket) {
      if (mediaSocket === socket) mediaSocket = undefined;
    },
  },
});

mediaBrowser = new MediaBrowser(config.chromePath, server.url.origin);
const userId = await verifySlackIdentity(config);
await slackApp.start();
console.log(`HuddleFM ready as ${userId} on ${server.url}`);

const shutdown = async () => {
  server.stop();
  await slackApp.stop();
  await mediaBrowser.close();
  process.exit();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
