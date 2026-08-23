import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { redactSecrets } from "./error-message.ts";
import { logger } from "./logger.ts";
import type { ChimeBootstrap } from "./slack-huddle.ts";

const log = logger.child({ component: "media-browser" });

export class MediaBrowserPool {
  private browser?: Browser;
  private launching?: Promise<Browser>;

  constructor(private chromePath: string) {}

  session(baseUrl: string) {
    return new MediaBrowser(this, baseUrl);
  }

  async context() {
    const browser = await this.getBrowser();
    return browser.newContext({ viewport: { width: 720, height: 720 } });
  }

  async close() {
    const browser =
      this.browser ?? (await this.launching?.catch(() => undefined));
    this.browser = undefined;
    await browser?.close();
    if (browser) log.info({ event: "browser_closed" }, "Chromium closed");
  }

  private async getBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    const startedAt = Date.now();
    log.info({ event: "browser_launch_started" }, "Launching Chromium");
    this.launching ??= chromium.launch({
      executablePath: this.chromePath,
      headless: true,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
        "--allow-http-screen-capture",
        "--enable-usermedia-screen-capturing",
        "--this-tab-capture-auto-accept",
      ],
    });
    try {
      const browser = await this.launching;
      this.browser = browser;
      browser.on("disconnected", () => {
        if (this.browser === browser) this.browser = undefined;
        log.warn({ event: "browser_disconnected" }, "Chromium disconnected");
      });
      log.info(
        { event: "browser_launched", durationMs: Date.now() - startedAt },
        "Chromium launched",
      );
      return browser;
    } finally {
      this.launching = undefined;
    }
  }
}

export class MediaBrowser {
  private context?: BrowserContext;
  private page?: Page;

  constructor(
    private pool: MediaBrowserPool,
    private baseUrl: string,
  ) {}

  async start(bootstrap: ChimeBootstrap) {
    const pageLog = log.child({ mediaSessionId: bootstrap.sessionId });
    const startedAt = Date.now();
    pageLog.info({ event: "page_start_started" }, "Starting media page");
    await this.close();
    this.context = await this.pool.context();
    this.page = await this.context.newPage();
    this.page.on("console", (message) => {
      const fields = { event: "page_console", browserLevel: message.type() };
      const text = redactSecrets(message.text());
      if (message.type() === "error") pageLog.error(fields, text);
      else if (message.type() === "warning") pageLog.warn(fields, text);
      else pageLog.debug(fields, text);
    });
    this.page.on("pageerror", (error) =>
      pageLog.error({ event: "page_error", err: error }, "Media page failed"),
    );
    await this.page.goto(
      `${this.baseUrl}/media?token=${encodeURIComponent(bootstrap.bridgeToken)}`,
    );
    await this.page.click("#capture");
    pageLog.info(
      { event: "page_started", durationMs: Date.now() - startedAt },
      "Media page started",
    );
  }

  async close() {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    await context?.close();
    if (context) log.debug({ event: "page_closed" }, "Media page closed");
  }
}
