import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import {
  hostSocketName,
  mediaHostProtocol,
  type HostedSession,
  type HostHello,
  type HostReply,
} from "./protocol.ts";

/** JSON lines over a stream socket, both ways. */
export class LineSocket {
  onLine: (line: string) => void = () => {};
  onClose: () => void = () => {};
  private buffered = "";
  private closed = false;

  constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffered += chunk;
      let newline = this.buffered.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffered.slice(0, newline).trim();
        this.buffered = this.buffered.slice(newline + 1);
        if (line) this.onLine(line);
        newline = this.buffered.indexOf("\n");
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      const rest = this.buffered.trim();
      this.buffered = "";
      if (rest) this.onLine(rest);
      this.onClose();
    });
  }

  get open() {
    return !this.closed && !this.socket.destroyed;
  }

  /** Sends a line, a string as it is or anything else as JSON. */
  write(line: unknown) {
    if (!this.open) return false;
    try {
      this.socket.write(
        `${typeof line === "string" ? line : JSON.stringify(line)}\n`,
      );
      return true;
    } catch {
      return false;
    }
  }

  end() {
    try {
      this.socket.end();
    } catch {}
  }

  destroy() {
    this.socket.destroy();
  }
}

/** Parses a host line, or undefined for a media process's own. */
export function hostReply(line: string): HostReply | undefined {
  if (!line.startsWith('{"host"')) return;
  try {
    const parsed = JSON.parse(line);
    return typeof parsed?.host === "string" ? parsed : undefined;
  } catch {
    return;
  }
}

/**
 * The Slack app's side of a media host, which runs the huddles' media
 * processes in their own container so they keep playing while the app
 * restarts.
 */
export class MediaHostClient {
  readonly socketPath: string;

  constructor(
    readonly directory: string,
    readonly httpPort: number,
  ) {
    this.socketPath = join(directory, hostSocketName);
  }

  /** Opens a connection and sends its hello; rejects when nothing answers. */
  connect(hello: HostHello, timeoutMs = 5_000) {
    return new Promise<LineSocket>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timed out connecting to the media host"));
      }, timeoutMs);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(
          new Error(`Could not reach the media host: ${error.message}`, {
            cause: error,
          }),
        );
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        const lines = new LineSocket(socket);
        lines.write(hello);
        resolve(lines);
      });
    });
  }

  /** Sends a hello and waits for the host's first answer to it. */
  async request(hello: HostHello, timeoutMs = 5_000) {
    const lines = await this.connect(hello, timeoutMs);
    const reply = await new Promise<HostReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        lines.destroy();
        reject(new Error("The media host did not answer"));
      }, timeoutMs);
      lines.onLine = (line) => {
        const parsed = hostReply(line);
        if (!parsed) return;
        clearTimeout(timer);
        resolve(parsed);
      };
      lines.onClose = () => {
        clearTimeout(timer);
        reject(new Error("The media host closed the connection"));
      };
    });
    lines.end();
    if (reply.host === "error") throw new Error(reply.message);
    return reply;
  }

  /** The media processes the host runs, and the hash of its media code. */
  async list(): Promise<{ code: string; sessions: HostedSession[] }> {
    const reply = await this.request({
      host: "list",
      protocol: mediaHostProtocol,
    });
    if (reply.host !== "sessions")
      throw new Error(`Unexpected media host answer: ${reply.host}`);
    if (reply.protocol !== mediaHostProtocol)
      throw new Error(
        `The media host speaks protocol ${reply.protocol}, not ${mediaHostProtocol}`,
      );
    return { code: reply.code, sessions: reply.sessions };
  }

  /** Waits for the host to come up, as it may be starting beside the app. */
  async waitForList(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await this.list();
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await Bun.sleep(500);
      }
    }
  }

  /** Ends one media process, which leaves its huddle. */
  async closeSession(sessionId: string) {
    await this.request(
      { host: "close", protocol: mediaHostProtocol, sessionId },
      10_000,
    );
  }
}
