import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { ChimeBootstrap } from "./slack-huddle.ts";

export class MediaBrowser {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(
    private chromePath: string,
    private baseUrl: string,
  ) {}

  async start(bootstrap: ChimeBootstrap) {
    this.browser ??= await chromium.launch({
      executablePath: this.chromePath,
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
    });
    await this.context?.close();
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.on("console", message => console.log(`[media:${message.type()}] ${message.text()}`));
    this.page.on("pageerror", error => console.error(`[media:error] ${error.message}`));
    await this.page.goto(`${this.baseUrl}/media?token=${encodeURIComponent(bootstrap.bridgeToken)}`);
  }

  async close() {
    await this.context?.close();
    await this.browser?.close();
  }

  async stop() {
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
  }
}
