// Throwaway spike: run the current Chromium backend (src/media-page.ts in a
// headless browser, launched like MediaBrowserPool) against the same huddle as
// media.ts, playing the same test arpeggio, for comparison. Run through bench.ts.
// Usage: bun chromium.ts [--seconds N] [--channel C] [--rejoin]
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { loadEnv, roomsJoin } from "./chime";
import { mkdirSync, existsSync } from "node:fs";

loadEnv(process.env.SPIKE_ENV ?? new URL("./.env", import.meta.url).pathname);
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : (process.argv[i + 1] ?? "true");
};
const seconds = Number(arg("seconds") ?? 60);
const channel = arg("channel") ?? "C0BPVPVLQ4D";
const rejoin = process.argv.includes("--rejoin");
const chromePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const t0 = performance.now();
const say = (...a: unknown[]) =>
  console.log(
    `[${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s]`,
    ...a,
  );
const mark = (name: string) => say(`MARK ${name}`);

const root = new URL("../../", import.meta.url).pathname;
const work = new URL("./bench-results/", import.meta.url).pathname;
mkdirSync(work, { recursive: true });

// ---- assets: page bundle, test arpeggio, artwork ----------------------------
const build = await Bun.build({
  entrypoints: [`${root}src/media-page.ts`],
  outdir: `${work}dist`,
  target: "browser",
  minify: true,
  define: { global: "globalThis" },
});
if (!build.success) throw new AggregateError(build.logs, "page build failed");

// The same C-E-G-C arpeggio media.ts synthesises, rendered to Opus like a
// downloaded track.
const audioPath = `${work}arpeggio.opus`;
if (!existsSync(audioPath)) {
  const total = 48000 * 300;
  const pcm = new Int16Array(total * 2);
  const notes = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63];
  for (let s = 0; s < total; s++) {
    const t = s / 48000;
    const note = notes[Math.floor(t / 0.5) % notes.length];
    const env = Math.min(1, (t % 0.5) * 40) * Math.exp(-3 * (t % 0.5));
    const v = Math.sin(2 * Math.PI * note * t) * env * 9000;
    const pan = Math.floor(t / 4) % 2;
    pcm[2 * s] = v * (pan ? 0.35 : 1);
    pcm[2 * s + 1] = v * (pan ? 1 : 0.35);
  }
  const ff = Bun.spawn(
    [
      "ffmpeg",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-b:a",
      "160k",
      "-y",
      audioPath,
    ],
    { stdin: "pipe" },
  );
  ff.stdin.write(new Uint8Array(pcm.buffer));
  ff.stdin.end();
  await ff.exited;
}
const artworkPath = `${work}artwork.png`;
if (!existsSync(artworkPath))
  Bun.spawnSync([
    "ffmpeg",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "mandelbrot=s=600x600",
    "-frames:v",
    "1",
    "-y",
    artworkPath,
  ]);

// ---- server: same routes the bot serves to the media page ------------------
type Bridge = { send(message: unknown): void };
let bridge: Bridge | undefined;
const pageEvents = new EventTarget();
const html =
  "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>HuddleFM media</title><link rel=stylesheet href=/media-page.css><main id=stage data-display-mode=default><div id=artwork></div><div id=cover></div><header><h1 id=title>Ready for music</h1><p id=artist>Waiting for the next track</p></header><section id=lyrics-frame><braccato-lyrics id=lyrics></braccato-lyrics></section><div id=timeline><time id=elapsed>0:00</time><div id=progress><div id=progress-fill></div></div><time id=duration>0:00</time></div></main><button id=capture>Start camera</button><p id=status>connecting</p><script type=module src=/media-page.js></script>";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const path = new URL(req.url).pathname;
    if (path === "/bridge") {
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    }
    if (path === "/media")
      return new Response(html, { headers: { "content-type": "text/html" } });
    if (path === "/media-page.js")
      return new Response(Bun.file(`${work}dist/media-page.js`), {
        headers: { "content-type": "text/javascript" },
      });
    if (path === "/media-page.css")
      return new Response(Bun.file(`${work}dist/media-page.css`), {
        headers: { "content-type": "text/css" },
      });
    if (path === "/audio.opus") return new Response(Bun.file(audioPath));
    if (path === "/artwork.png") return new Response(Bun.file(artworkPath));
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      bridge = { send: (m) => ws.send(JSON.stringify(m)) };
    },
    message(_ws, data) {
      const message = JSON.parse(String(data));
      pageEvents.dispatchEvent(
        new CustomEvent(message.type, { detail: message.details }),
      );
      if (!["playback_position", "playing"].includes(message.type))
        say(
          "page:",
          message.type,
          message.details ? JSON.stringify(message.details) : "",
        );
    },
  },
});
const nextEvent = (type: string, timeoutMs = 30000) =>
  new Promise<any>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for page ${type}`)),
      timeoutMs,
    );
    pageEvents.addEventListener(
      type,
      (e) => {
        clearTimeout(timer);
        resolve((e as CustomEvent).detail);
      },
      { once: true },
    );
  });

// ---- stats: keep every RTCPeerConnection the SDK creates -------------------
const initScript = () => {
  const Native = window.RTCPeerConnection;
  (window as any).__pcs = [];
  (window as any).RTCPeerConnection = function (...args: any[]) {
    const pc = new (Native as any)(...args);
    (window as any).__pcs.push(pc);
    return pc;
  };
  (window as any).RTCPeerConnection.prototype = Native.prototype;
};
async function rtcStats(page: Page) {
  return page.evaluate(async () => {
    const out: any = {};
    for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
      if (pc.connectionState === "closed") continue;
      const report = await pc.getStats();
      const codecs = new Map<string, string>();
      report.forEach((s: any) => {
        if (s.type === "codec") codecs.set(s.id, s.mimeType);
      });
      report.forEach((s: any) => {
        if (s.type === "outbound-rtp")
          out[`out_${s.kind}`] = {
            packetsSent: s.packetsSent,
            bytesSent: s.bytesSent,
            codec: codecs.get(s.codecId),
            ...(s.kind === "video"
              ? {
                  framesEncoded: s.framesEncoded,
                  fps: s.framesPerSecond,
                  size: `${s.frameWidth}x${s.frameHeight}`,
                  encoder: s.encoderImplementation,
                  limitation: s.qualityLimitationReason,
                  pli: s.pliCount,
                  nack: s.nackCount,
                }
              : { targetBitrate: s.targetBitrate }),
          };
        if (s.type === "remote-inbound-rtp")
          out[`remote_${s.kind}`] = {
            packetsLost: s.packetsLost,
            fractionLost: s.fractionLost,
            jitterMs: Math.round((s.jitter ?? 0) * 1000),
            rttMs: Math.round((s.roundTripTime ?? 0) * 1000),
          };
        if (s.type === "inbound-rtp" && s.kind === "audio")
          out.in_audio = { packetsReceived: s.packetsReceived };
      });
    }
    return out;
  });
}

// ---- one session: context + page + join + play -----------------------------
let context: BrowserContext | undefined;
let page: Page | undefined;
async function session(prefix: string) {
  mark(`${prefix}start`);
  const { meeting, attendee } = await roomsJoin(channel);
  mark(`${prefix}rooms_join`);
  context = await browser.newContext({ viewport: { width: 720, height: 720 } });
  await context.addInitScript(initScript);
  page = await context.newPage();
  page.on("pageerror", (e) => say("pageerror", String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      say(`console.${m.type()}`, m.text().slice(0, 200));
  });
  const ready = nextEvent("ready");
  await page.goto(`${server.url}media?token=bench`);
  await page.click("#capture");
  mark(`${prefix}page_loaded`);
  await ready;
  const joined = nextEvent("joined");
  bridge!.send({
    type: "bootstrap",
    payload: {
      sessionId: `bench-${prefix || "cold"}`,
      meeting,
      attendee,
      initialVolume: 1,
      duckingMode: "gentle",
    },
  });
  await joined;
  mark(`${prefix}joined`);
  bridge!.send({
    type: "play",
    entryId: "arpeggio",
    url: "/audio.opus",
    title: "HuddleFM benchmark",
    artist: "Chromium backend",
    artwork: "/artwork.png",
    fadeOutSeconds: 0,
  });
  // Poll until audio and video bytes leave the peer connection.
  let audio = false,
    video = false;
  for (let i = 0; i < 300 && !(audio && video); i++) {
    const s = await rtcStats(page);
    if (!audio && s.out_audio?.bytesSent > 0) {
      audio = true;
      mark(`${prefix}audio_flowing`);
    }
    if (!video && s.out_video?.framesEncoded > 0) {
      video = true;
      mark(`${prefix}video_flowing`);
    }
    await Bun.sleep(100);
  }
}
async function leave() {
  if (!bridge || !page) return;
  const ended = nextEvent("ended", 5000).catch(() => undefined);
  bridge.send({ type: "leave" });
  await ended;
  await context?.close();
  context = undefined;
  page = undefined;
}

// Cold join time is measured from here: building the page bundle and the test
// audio above is not part of joining.
mark("assets_ready");
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--allow-http-screen-capture",
    "--enable-usermedia-screen-capturing",
    "--this-tab-capture-auto-accept",
  ],
});
mark("browser_launched");
say("chrome", browser.version());

await session("");
await Bun.sleep(5000);
await page!.screenshot({ path: `${work}card.png` });
const statTimer = setInterval(async () => {
  if (page)
    say("stats", JSON.stringify(await rtcStats(page).catch(() => ({}))));
}, 10000);
await Bun.sleep(Math.max(0, seconds * 1000 - (performance.now() - t0)));
clearInterval(statTimer);
if (page) say("final", JSON.stringify(await rtcStats(page)));
await leave();
mark("left");
if (rejoin) {
  // Warm join: the bot keeps Chromium running, so later sessions only pay
  // for a new context, page and meeting join.
  await session("warm_");
  await Bun.sleep(5000);
  await leave();
  mark("warm_left");
}
await browser.close();
server.stop(true);
process.exit(0);
