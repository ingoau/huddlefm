import { createServer } from "node:net";
import { logger } from "./logger.ts";

const log = logger.child({ component: "pot-server" });

const readyTimeoutMs = 30_000;
const firstRestartDelayMs = 1_000;
const maxRestartDelayMs = 60_000;
/** Running this long counts as healthy, so the next crash restarts quickly. */
const healthyMs = 60_000;

/**
 * The BgUtils proof-of-origin token server, which yt-dlp's
 * bgutil-ytdlp-pot-provider plugin asks for the tokens YouTube wants before it
 * trusts a request. It is one long-lived process, so tokens are made once and
 * reused until they expire rather than for every extraction. It runs on Deno
 * with network access to loopback only: everything it fetches from YouTube
 * goes through the public network proxy yt-dlp hands it, like the rest of the
 * bot's traffic. The bot restarts it whenever it exits.
 */
export class PoTokenServer {
  private port?: number;
  private process?: ReturnType<typeof Bun.spawn>;
  private closing = false;
  private restartDelay = firstRestartDelayMs;
  private restartTimer?: ReturnType<typeof setTimeout>;

  /** `home` is the provider's `server` directory, with its node_modules. */
  constructor(private home: string) {}

  /**
   * The server's address, once a port is chosen. yt-dlp is pointed here even
   * while the server is starting or restarting; until it answers, the plugin
   * gives up on the token and yt-dlp carries on without one.
   */
  get url() {
    return this.port ? `http://127.0.0.1:${this.port}` : undefined;
  }

  /** Starts the server in the background and keeps it running. */
  start() {
    this.closing = false;
    void this.launch();
  }

  async close() {
    this.closing = true;
    clearTimeout(this.restartTimer);
    const child = this.process;
    if (!child) return;
    child.kill();
    await child.exited;
  }

  private async launch() {
    if (this.closing) return;
    // A fresh port each time, in case another process took the last one.
    this.port = await freePort();
    if (this.closing) return;
    const startedAt = Date.now();
    const child = Bun.spawn(
      [
        "deno",
        "run",
        "--no-prompt",
        "--allow-env",
        // Loopback only, for its own port and the proxy. Deno also checks the
        // unbound local address a connection starts from.
        "--allow-net=127.0.0.1,0.0.0.0:0",
        "--allow-ffi=.",
        "--allow-read=.",
        "../src/main.ts",
        "--port",
        String(this.port),
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: `${this.home}/node_modules`,
        // Not the bot's environment, which holds its Slack credentials.
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          NO_COLOR: "1",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    this.process = child;
    void this.logErrors(child.stderr);
    void this.waitForReady(child, startedAt);
    const code = await child.exited;
    if (this.process === child) this.process = undefined;
    if (this.closing) return;
    if (Date.now() - startedAt > healthyMs)
      this.restartDelay = firstRestartDelayMs;
    log.warn(
      { event: "exited", code, restartInMs: this.restartDelay },
      "Proof-of-origin token server exited; restarting",
    );
    this.restartTimer = setTimeout(() => void this.launch(), this.restartDelay);
    this.restartDelay = Math.min(this.restartDelay * 2, maxRestartDelayMs);
  }

  private async waitForReady(
    child: ReturnType<typeof Bun.spawn>,
    startedAt: number,
  ) {
    const url = this.url;
    while (Date.now() - startedAt < readyTimeoutMs) {
      if (this.process !== child) return;
      try {
        const response = await fetch(`${url}/ping`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          const { version } = (await response.json()) as { version?: unknown };
          log.info(
            { event: "ready", version, durationMs: Date.now() - startedAt },
            "Proof-of-origin token server ready",
          );
          return;
        }
      } catch {
        // Not listening yet.
      }
      await Bun.sleep(250);
    }
    if (this.process !== child) return;
    log.warn(
      { event: "start_timeout" },
      "Proof-of-origin token server did not start in time; restarting",
    );
    child.kill();
  }

  private async logErrors(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (pending + decoder.decode(value, { stream: true })).split(
        "\n",
      );
      pending = lines.pop() ?? "";
      for (const line of lines)
        if (line.trim())
          log.warn({ event: "server_error", line: line.trim() }, "POT server");
    }
  }
}

/** A loopback port nothing is listening on right now. */
function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
