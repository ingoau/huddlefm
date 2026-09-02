import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const css = await Bun.file(new URL("./media-page.css", import.meta.url)).text();
const chromePath = process.env.CHROME_PATH ?? "/usr/bin/chromium";
const canLaunchChrome = await Bun.file(chromePath).exists();

test("does not keep a played line highlighted while it finishes animating", () => {
  expect(css).toContain(
    "> .blyrics--line:has(~ .blyrics--active):not(.blyrics--active)",
  );
  expect(css).not.toContain(
    "> .blyrics--line:has(~ .blyrics--active):not(.blyrics--animating)",
  );
  expect(css).toContain(
    ".blyrics-container > .blyrics--line.blyrics--active {",
  );
  expect(css).not.toMatch(
    /\.blyrics-container > \.blyrics--line\.blyrics--active,\s*\.blyrics-container > \.blyrics--line\.blyrics--animating/,
  );
  expect(css).toContain(
    "> .blyrics--line:not(.blyrics--active)\n  .blyrics--word",
  );
  expect(css).not.toContain(
    "> .blyrics--line:not(.blyrics--active):not(.blyrics--animating)",
  );
  expect(css).not.toContain(
    "> .blyrics--line.blyrics--active.blyrics--animating",
  );
  expect(css).toContain("--blyrics-lyric-highlight-fade-out-duration: 0.25s");
  expect(css).not.toContain(
    "transition: color calc(var(--blyrics-lyric-scroll-duration) * 3)",
  );
});

test.skipIf(!canLaunchChrome)(
  "dims a still-animating previous line once the next line is active",
  async () => {
    const bundled = await Bun.build({
      entrypoints: [new URL("./media-page.css", import.meta.url).pathname],
    });
    const bundledCss = await bundled.outputs[0]!.text();
    const dir = await mkdtemp(join(tmpdir(), "lyrics-highlight-"));
    const pagePath = join(dir, "lyrics.html");
    await writeFile(
      pagePath,
      `<!doctype html>
<html>
  <head>
    <style>${bundledCss}
      * { transition: none !important; animation: none !important; }
      body { background: #08080a; margin: 0; }
    </style>
  </head>
  <body>
    <div class="blyrics-container" data-sync="synced">
      <div id="played" class="blyrics--line blyrics--animating">
        <span class="blyrics--word">Obsessed with living in the present</span>
      </div>
      <div id="current" class="blyrics--line blyrics--active blyrics--animating">
        <span class="blyrics--word">And with no one around me, I come alive</span>
      </div>
      <div id="upcoming" class="blyrics--line">
        <span class="blyrics--word">At this age. I wouldn't wanna</span>
      </div>
    </div>
  </body>
</html>`,
    );

    const browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 720, height: 720 },
      });
      await page.goto(`file://${pagePath}`);
      const styles = await page.evaluate(() => {
        const colorOf = (id: string) =>
          getComputedStyle(document.querySelector(`#${id} .blyrics--word`)!)
            .color;
        const filterOf = (id: string) =>
          getComputedStyle(document.getElementById(id)!).filter;
        return {
          playedColor: colorOf("played"),
          currentColor: colorOf("current"),
          upcomingColor: colorOf("upcoming"),
          playedFilter: filterOf("played"),
          currentFilter: filterOf("current"),
        };
      });

      expect(styles.currentColor).toBe("rgb(255, 255, 255)");
      expect(styles.playedColor).not.toBe(styles.currentColor);
      expect(styles.upcomingColor).not.toBe(styles.currentColor);
      expect(styles.playedColor).toBe(styles.upcomingColor);
      expect(styles.currentFilter).toContain("blur(0px)");
      expect(styles.playedFilter).not.toContain("blur(0px)");
    } finally {
      await browser.close();
    }
  },
);
