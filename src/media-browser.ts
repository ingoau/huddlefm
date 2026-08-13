import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { ChimeBootstrap } from "./slack-huddle.ts";

export class MediaBrowser {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>;

  constructor(
    private chromePath: string,
    private baseUrl: string,
  ) {}

  async start(bootstrap: ChimeBootstrap) {
    this.browser ??= await chromium.launch({
      executablePath: this.chromePath,
      headless: true,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
        "--allow-http-screen-capture",
        "--enable-usermedia-screen-capturing",
        "--auto-select-tab-capture-source-by-title=HuddleFM media",
      ],
    });
    if (this.context) {
      this.storageState = await this.context.storageState();
      await this.context.close();
    }
    this.context = await this.browser.newContext({
      viewport: { width: 720, height: 720 },
      storageState: this.storageState,
    });
    this.page = await this.context.newPage();
    this.page.on("console", message => console.log(`[media:${message.type()}] ${message.text()}`));
    this.page.on("pageerror", error => console.error(`[media:error] ${error.message}`));
    await this.page.goto(`${this.baseUrl}/media?token=${encodeURIComponent(bootstrap.bridgeToken)}`);
    await this.page.click("#capture");
  }

  async close() {
    await this.context?.close();
    await this.browser?.close();
  }

  async stop() {
    this.storageState = await this.context?.storageState();
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
  }
}
