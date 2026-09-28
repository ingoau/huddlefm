import { logger } from "../logger.ts";
import { redactSecrets } from "../error-message.ts";
import type { ChimeBootstrap } from "../slack-huddle.ts";
import { statusCodes } from "./status-codes.ts";

const log = logger.child({ component: "native-media" });

export type MediaMessage = {
  type: string;
  details?: unknown;
  sessionId?: string;
};

type LogLine = {
  level?: string;
  event?: string;
  message?: string;
  [field: string]: unknown;
};

const levels = new Set(["trace", "debug", "info", "warn", "error"]);
// The child needs no Slack credentials, so it only gets what running Bun and
// ffmpeg takes.
const inheritedEnv = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"];

/**
 * Runs one Huddle's native media in its own Bun process (src/native-media/
 * main.ts), so a crash in native WebRTC or media code ends that one session
 * instead of the whole bot. It speaks the media page's protocol: coordinator
 * messages go in on stdin, and the page's events come back on stdout.
 */
export class NativeMediaSession {
  private child?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private closing = false;
  // The child exits by itself after reporting `ended`; that exit is expected.
  private ended = false;
  private sessionId?: string;

  constructor(
    private onMessage: (message: MediaMessage) => void,
    // Maps an entry to its downloaded file. The child decodes files directly:
    // the loopback /audio route ignores Range requests, so ffmpeg could not
    // seek through it.
    private audioPath: (entryId: string) => string | undefined = () =>
      undefined,
  ) {}

  async start(bootstrap: ChimeBootstrap) {
    await this.close();
    this.closing = false;
    this.ended = false;
    this.sessionId = bootstrap.sessionId;
    const childLog = log.child({ mediaSessionId: bootstrap.sessionId });
    const env = Object.fromEntries(
      inheritedEnv.flatMap((name) =>
        process.env[name] ? [[name, process.env[name]!]] : [],
      ),
    );
    const child = Bun.spawn(
      [process.execPath, new URL("./main.ts", import.meta.url).pathname],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
    );
    this.child = child;
    childLog.info(
      { event: "native_media_started", pid: child.pid },
      "Native media process started",
    );
    void this.readLines(child.stdout, (line) => this.receive(line, childLog));
    void this.readLines(child.stderr, (line) =>
      childLog.warn(
        { event: "native_media_stderr" },
        redactSecrets(line).slice(0, 2_000),
      ),
    );
    void child.exited.then((exitCode) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.closing || this.ended) return;
      childLog.error(
        { event: "native_media_exited", exitCode },
        "Native media process exited unexpectedly",
      );
      // Ends the session like a lost browser page should have, which also
      // offers the Restore session button.
      this.onMessage({
        type: "ended",
        details: {
          code: statusCodes.taskFailed,
          message: `Native media process exited with ${exitCode}`,
        },
        sessionId: this.sessionId,
      });
    });
    this.write({ type: "bootstrap", payload: bootstrap });
  }

  /** Sends a coordinator message; false when no media process is running. */
  send(message: unknown) {
    return this.write(this.withLocalAudio(message));
  }

  private withLocalAudio(message: unknown) {
    if (!message || typeof message !== "object") return message;
    const media = message as {
      type?: string;
      entryId?: string;
      url?: string;
      entries?: { entryId: string; url: string }[];
    };
    const local = (entryId: string | undefined, url: string | undefined) =>
      (entryId && this.audioPath(entryId)) || url;
    if (media.type === "play")
      return { ...media, url: local(media.entryId, media.url) };
    if (media.type === "preload" && Array.isArray(media.entries))
      return {
        ...media,
        entries: media.entries.map((entry) => ({
          ...entry,
          url: local(entry.entryId, entry.url),
        })),
      };
    return message;
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    try {
      void child.stdin.end();
    } catch {}
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ]);
    if (!exited) child.kill("SIGKILL");
    if (this.child === child) this.child = undefined;
    log.debug(
      { event: "native_media_closed", mediaSessionId: this.sessionId },
      "Native media process closed",
    );
  }

  private write(message: unknown) {
    const child = this.child;
    if (!child) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      void child.stdin.flush();
      return true;
    } catch {
      return false;
    }
  }

  private receive(line: string, childLog: typeof log) {
    let parsed: MediaMessage & { log?: LogLine };
    try {
      parsed = JSON.parse(line);
    } catch {
      childLog.debug(
        { event: "native_media_output" },
        redactSecrets(line).slice(0, 2_000),
      );
      return;
    }
    if (parsed.log) {
      const { level, event, message, ...fields } = parsed.log;
      const method = levels.has(String(level))
        ? (level as "trace" | "debug" | "info" | "warn" | "error")
        : "info";
      childLog[method](
        { event: event ?? "native_media_log", ...fields },
        redactSecrets(String(message ?? "")),
      );
      return;
    }
    if (typeof parsed.type !== "string") return;
    if (parsed.type === "ended") this.ended = true;
    this.onMessage(parsed);
  }

  private async readLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ) {
    const decoder = new TextDecoder();
    let buffered = "";
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) onLine(line);
          newline = buffered.indexOf("\n");
        }
      }
    } catch {}
    if (buffered.trim()) onLine(buffered.trim());
  }
}
