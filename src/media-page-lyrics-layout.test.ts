import { expect, test } from "bun:test";
import { createServer } from "http";
import { readFileSync } from "fs";
import { chromium, type Browser } from "playwright-core";
import { parseLRC } from "@braccato/parsers";

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
].filter((value): value is string => Boolean(value));

function resolveChromium() {
  for (const candidate of CHROMIUM_CANDIDATES) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
}

async function withLyricsPage(
  lyrics: ReturnType<typeof parseLRC>,
  currentTime: number,
  run: (page: Awaited<ReturnType<Browser["newPage"]>>) => Promise<void>,
) {
  const executablePath = resolveChromium();
  if (!executablePath) {
    console.warn("Skipping lyrics layout test: no Chromium binary found");
    return;
  }

  const libCss = readFileSync(
    "node_modules/@braccato/core/dist/styles/lyrics.css",
    "utf8",
  );
  const varsCss = readFileSync(
    "node_modules/@braccato/core/dist/styles/variables.css",
    "utf8",
  );
  const mediaCss = readFileSync("src/media-page.css", "utf8").replace(
    /@import[^;]+;/g,
    "",
  );
  const html = `<!doctype html>
<html><head><style>
${varsCss}${libCss}${mediaCss}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#08080a;color:#fff}
#lyrics-frame{position:absolute;inset:18% 7% 12%;overflow:hidden;opacity:1!important;transform:none!important;mask-image:none}
braccato-lyrics{display:block;height:100%;overflow:hidden}
</style></head>
<body>
<section id="lyrics-frame"><braccato-lyrics id="lyrics"></braccato-lyrics></section>
<audio id="player"></audio>
<script type="module">
import "/pkg/element.js";
const el = document.querySelector("#lyrics");
el.host = { getScrollElement: () => el };
el.theme = "/* blyrics-target-scroll-pos-ratio = 0.45; */";
el.source = document.querySelector("#player");
el.lyrics = ${JSON.stringify(lyrics)};
const player = document.querySelector("#player");
let t = ${currentTime};
Object.defineProperty(player, "paused", { get: () => false });
Object.defineProperty(player, "currentTime", {
  get: () => t,
  set(value) { t = value; },
});
Object.defineProperty(player, "playbackRate", { get: () => 1, set() {} });
Object.defineProperty(player, "error", { get: () => null });
el.playing = true;
el.currentTime = ${currentTime};
player.dispatchEvent(new Event("play"));
setTimeout(() => { window.__ready = true; }, 250);
</script>
</body></html>`;

  const root = "node_modules/@braccato/core/dist";
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }
    if (req.url?.startsWith("/pkg/")) {
      try {
        const body = readFileSync(`${root}/${req.url.slice(5)}`);
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind lyrics layout test server");
  }

  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 720, height: 720 },
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(() =>
      Boolean(
        (window as unknown as { __ready?: boolean }).__ready &&
        document.querySelector(".blyrics--active .blyrics--word"),
      ),
    );
    await page.waitForTimeout(500);
    await run(page);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("long hyphenated scat lines do not collapse into a narrow highlight column", async () => {
  const lyrics = parseLRC(
    `[00:12.09]Babedi-babobeh-popbopbedop-babobeh
[00:15.34]Bopbopbedop-babobeh-popbopbedop-bababababehdi
[00:18.41]I'm calling out from Scatland`,
    225_000,
  );

  await withLyricsPage(lyrics, 16, async (page) => {
    const metrics = await page.evaluate(() => {
      const active = document.querySelector(".blyrics--active");
      const next = active?.nextElementSibling;
      const word = active?.querySelector(".blyrics--word");
      const highlight = word?.querySelector(".blyrics-word-highlight");
      if (!active || !word || !next || !highlight) {
        return { ok: false as const, reason: "missing-dom" };
      }

      const wordRect = word.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      const highlightRect = highlight.getBoundingClientRect();
      // The bug rendered the highlight clone ~100px wide and hundreds of px tall.
      const highlightCollapsed =
        getComputedStyle(highlight).display !== "none" &&
        highlightRect.width > 0 &&
        highlightRect.width < 160 &&
        highlightRect.height > wordRect.height * 1.5;

      return {
        ok: true as const,
        sync: document
          .querySelector(".blyrics-container")
          ?.getAttribute("data-sync"),
        wordWidth: Math.round(wordRect.width),
        wordDisplay: getComputedStyle(word).display,
        highlightDisplay: getComputedStyle(highlight).display,
        highlightCollapsed,
        overlapPx: Math.round(activeRect.bottom - nextRect.top),
      };
    });

    expect(metrics.ok).toBe(true);
    if (!metrics.ok) return;
    expect(metrics.sync).toBe("synced");
    expect(metrics.wordDisplay).toBe("inline-block");
    expect(metrics.highlightDisplay).toBe("none");
    expect(metrics.highlightCollapsed).toBe(false);
    expect(metrics.wordWidth).toBeGreaterThan(400);
    expect(metrics.overlapPx).toBeLessThanOrEqual(0);
  });
});
