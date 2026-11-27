import { createServer, type Server } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger.ts";
import { redactSecrets } from "../error-message.ts";
import type { ChimeBootstrap } from "../slack-huddle.ts";
import {
  endMediaProcess,
  readLines,
  spawnMediaProcess,
  writeLine,
} from "../native-media/session.ts";
import { hostReply, LineSocket } from "./client.ts";
import {
  appSocketName,
  hostSocketName,
  mediaCodeHash,
  mediaHostProtocol,
  type HostedSession,
  type HostedTag,
  type HostHello,
} from "./protocol.ts";

const log = logger.child({ component: "media-host" });

/** One media process, as the host runs it. */
export type HostedChild = {
  write(line: string): boolean;
  /** Ends stdin, which makes the process leave its huddle, and waits. */
  end(): Promise<void>;
  exited: Promise<number | null>;
  read(onLine: (line: string) => void, onStderr: (line: string) => void): void;
};

function spawnChild(): HostedChild {
  const child = spawnMediaProcess();
  return {
    write: (line) => writeLine(child, line),
    end: () => endMediaProcess(child),
    exited: child.exited,
    read: (onLine, onStderr) => {
      void readLines(child.stdout, onLine);
      void readLines(child.stderr, onStderr);
    },
  };
}

type Hosted = {
  sessionId: string;
  bootstrap: ChimeBootstrap;
  tag?: HostedTag;
  child: HostedChild;
  /** The app's connection, while one is attached. */
  connection?: LineSocket;
  /** What the process said while no one was attached. */
  held: string[];
  orphanTimer?: ReturnType<typeof setTimeout>;
};

// Reports that only matter as of now: while no one is attached, each keeps
// only its newest.
const latestOnly = new Set([
  "playback_position",
  "audio_outbound",
  "content_shares",
]);
const maxHeld = 2_000;
const levels = new Set(["trace", "debug", "info", "warn", "error"]);

function lineType(line: string) {
  const match = /^\{"type":"([a-z_]+)"/.exec(line);
  return match?.[1];
}

/**
 * Runs huddles' media processes for a Slack app in another container, so
 * they keep playing while the app restarts: it talks to them over a Unix
 * socket instead of their stdin and stdout, and attaches to them again once
 * it is back. See protocol.ts.
 *
 * The media processes fetch audio, artwork and streams from the app on
 * loopback, so the host serves the app's port on its own loopback and passes
 * those requests to the app's socket.
 */
export class MediaHost {
  private sessions = new Map<string, Hosted>();
  private server?: Server;
  private proxy?: ReturnType<typeof Bun.serve>;
  private proxyPort?: number;
  private stopping = false;
  readonly socketPath: string;
  readonly appSocketPath: string;

  constructor(
    readonly directory: string,
    private options: {
      /** How long a process plays on with no one attached before it leaves. */
      orphanMs?: number;
      spawn?: () => HostedChild;
      /** False leaves out the loopback proxy, for tests. */
      proxy?: boolean;
    } = {},
  ) {
    this.socketPath = join(directory, hostSocketName);
    this.appSocketPath = join(directory, appSocketName);
  }

  private get orphanMs() {
    return this.options.orphanMs ?? 10 * 60_000;
  }

  async listen() {
    await mkdir(this.directory, { recursive: true });
    await rm(this.socketPath, { force: true });
    const server = createServer((socket) =>
      this.accept(new LineSocket(socket)),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    log.info(
      { event: "media_host_listening", socketPath: this.socketPath },
      "Media host listening",
    );
  }

  /** Ends every media process, as the host itself is going away. */
  async stop() {
    this.stopping = true;
    this.server?.close();
    void this.proxy?.stop(true);
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => session.child.end()),
    );
    await rm(this.socketPath, { force: true });
  }

  get size() {
    return this.sessions.size;
  }

  private accept(lines: LineSocket) {
    let first = true;
    lines.onLine = (line) => {
      if (!first) return;
      first = false;
      let hello: HostHello;
      try {
        hello = JSON.parse(line);
      } catch {
        lines.write({ host: "error", message: "Malformed hello" });
        lines.end();
        return;
      }
      void this.hello(lines, hello).catch((error) => {
        log.error(
          { event: "media_host_hello_failed", err: error },
          "Hello failed",
        );
        lines.write({
          host: "error",
          message: String(error?.message ?? error),
        });
        lines.end();
      });
    };
  }

  private async hello(lines: LineSocket, hello: HostHello) {
    if (hello.protocol !== mediaHostProtocol) {
      lines.write({
        host: "error",
        message: `The media host speaks protocol ${mediaHostProtocol}, not ${hello.protocol}`,
      });
      lines.end();
      return;
    }
    if (hello.host === "list") {
      const sessions: HostedSession[] = [...this.sessions.values()].map(
        (session) => ({
          sessionId: session.sessionId,
          bootstrap: session.bootstrap,
          ...(session.tag ? { tag: session.tag } : {}),
          attached: Boolean(session.connection),
        }),
      );
      lines.write({
        host: "sessions",
        protocol: mediaHostProtocol,
        code: await mediaCodeHash(),
        sessions,
      });
      lines.end();
      return;
    }
    if (hello.host === "close") {
      const session = this.sessions.get(hello.sessionId);
      if (session) await session.child.end();
      lines.write({ host: "closed" });
      lines.end();
      return;
    }
    if (hello.host === "start") {
      this.serveApp(hello.httpPort);
      return this.start(lines, hello.bootstrap);
    }
    if (hello.host === "attach") {
      this.serveApp(hello.httpPort);
      return this.attach(lines, hello.sessionId);
    }
    lines.write({ host: "error", message: "Unknown hello" });
    lines.end();
  }

  private start(lines: LineSocket, bootstrap: ChimeBootstrap) {
    if (this.stopping) throw new Error("The media host is stopping");
    if (this.sessions.has(bootstrap.sessionId))
      throw new Error("That media session is already running");
    const spawn = this.options.spawn ?? spawnChild;
    const session: Hosted = {
      sessionId: bootstrap.sessionId,
      bootstrap,
      child: spawn(),
      held: [],
    };
    this.sessions.set(session.sessionId, session);
    const childLog = log.child({ mediaSessionId: session.sessionId });
    session.child.read(
      (line) => this.fromChild(session, line),
      (line) => this.fromChildStderr(session, line),
    );
    void session.child.exited.then((code) => {
      if (this.sessions.get(session.sessionId) !== session) return;
      this.sessions.delete(session.sessionId);
      clearTimeout(session.orphanTimer);
      childLog.info(
        { event: "media_host_process_exited", exitCode: code },
        "Media process exited",
      );
      const connection = session.connection;
      session.connection = undefined;
      if (!connection) return;
      connection.write({ host: "exited", code });
      connection.end();
    });
    session.child.write(
      JSON.stringify({ type: "bootstrap", payload: bootstrap }),
    );
    childLog.info(
      { event: "media_host_process_started" },
      "Media process started",
    );
    lines.write({ host: "started" });
    this.bind(session, lines);
  }

  private attach(lines: LineSocket, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      lines.write({ host: "missing" });
      lines.end();
      return;
    }
    const previous = session.connection;
    if (previous) {
      session.connection = undefined;
      previous.destroy();
    }
    lines.write({ host: "attached" });
    const held = session.held;
    session.held = [];
    for (const line of held) lines.write(line);
    this.bind(session, lines);
    log.info(
      {
        event: "media_host_attached",
        mediaSessionId: sessionId,
        replayed: held.length,
      },
      "App attached to a media process",
    );
  }

  private bind(session: Hosted, lines: LineSocket) {
    clearTimeout(session.orphanTimer);
    session.orphanTimer = undefined;
    session.connection = lines;
    lines.onLine = (line) => {
      const control = hostReply(line) as
        { host: string; owner?: unknown } | undefined;
      if (!control) {
        session.child.write(line);
        return;
      }
      if (control.host === "tag" && typeof control.owner === "string")
        session.tag = { owner: control.owner };
      else if (control.host === "detach") this.unbind(session, lines);
      else if (control.host === "close") void session.child.end();
    };
    lines.onClose = () => this.unbind(session, lines);
  }

  /** The app went away; the process plays on until it comes back. */
  private unbind(session: Hosted, lines: LineSocket) {
    if (session.connection !== lines) return;
    session.connection = undefined;
    if (this.sessions.get(session.sessionId) !== session) return;
    clearTimeout(session.orphanTimer);
    session.orphanTimer = setTimeout(() => {
      log.warn(
        { event: "media_host_orphan_left", mediaSessionId: session.sessionId },
        "No app attached to a media process in time; leaving its huddle",
      );
      void session.child.end();
    }, this.orphanMs);
    log.info(
      { event: "media_host_detached", mediaSessionId: session.sessionId },
      "App detached from a media process",
    );
  }

  private fromChild(session: Hosted, line: string) {
    if (session.connection?.write(line)) return;
    if (line.startsWith('{"log"')) return this.logLocally(session, line);
    const type = lineType(line);
    if (type && latestOnly.has(type)) {
      const index = session.held.findLastIndex(
        (held) => lineType(held) === type,
      );
      if (index >= 0) session.held.splice(index, 1);
    }
    session.held.push(line);
    if (session.held.length > maxHeld) session.held.shift();
  }

  private fromChildStderr(session: Hosted, line: string) {
    const message = redactSecrets(line).slice(0, 2_000);
    if (
      session.connection?.write({
        log: { level: "warn", event: "native_media_stderr", message },
      })
    )
      return;
    log.warn(
      { event: "native_media_stderr", mediaSessionId: session.sessionId },
      message,
    );
  }

  /** A log line no app is attached to hear, logged here instead. */
  private logLocally(session: Hosted, line: string) {
    try {
      const { level, event, message, ...fields } = JSON.parse(line).log ?? {};
      const method = levels.has(String(level))
        ? (level as "trace" | "debug" | "info" | "warn" | "error")
        : "info";
      log[method](
        {
          event: event ?? "native_media_log",
          mediaSessionId: session.sessionId,
          ...Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [
              key,
              typeof value === "string" ? redactSecrets(value) : value,
            ]),
          ),
        },
        redactSecrets(String(message ?? "")),
      );
    } catch {}
  }

  /**
   * Serves the app's loopback port here, passing each request to the app's
   * socket, so the media processes' /audio, /artwork and /stream URLs work.
   */
  private serveApp(port: number) {
    if (this.options.proxy === false) return;
    if (this.proxyPort === port && this.proxy) return;
    void this.proxy?.stop(true);
    const appSocket = this.appSocketPath;
    this.proxy = Bun.serve({
      hostname: "127.0.0.1",
      port,
      // A stream's reader stops for a while once it is far enough ahead.
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        try {
          return await fetch(`http://localhost${url.pathname}${url.search}`, {
            unix: appSocket,
            method: request.method,
            headers: request.headers,
            signal: request.signal,
            redirect: "manual",
            decompress: false,
          });
        } catch {
          return new Response("HuddleFM is restarting", { status: 503 });
        }
      },
    });
    this.proxyPort = port;
    log.info(
      { event: "media_host_proxy_listening", port },
      "Serving the app's media routes on loopback",
    );
  }
}
