import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { ChimeBootstrap } from "./slack-huddle.ts";

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
    const browser = this.browser ?? await this.launching?.catch(() => undefined);
    this.browser = undefined;
    await browser?.close();
  }

  private async getBrowser() {
    if (this.browser?.isConnected()) return this.browser;
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
      });
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
    await this.close();
    this.context = await this.pool.context();
    this.page = await this.context.newPage();
    this.page.on("console", message => console.log(`[media:${bootstrap.sessionId}:${message.type()}] ${message.text()}`));
    this.page.on("pageerror", error => console.error(`[media:${bootstrap.sessionId}:error] ${error.message}`));
    await this.page.goto(`${this.baseUrl}/media?token=${encodeURIComponent(bootstrap.bridgeToken)}`);
    await this.page.click("#capture");
  }

  async close() {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    await context?.close();
  }
}
