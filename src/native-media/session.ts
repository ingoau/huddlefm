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

/** Redacts string fields too: errors and reasons can quote server text. */
function redactFields(fields: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === "string" ? redactSecrets(value) : value,
    ]),
  );
}

const levels = new Set(["trace", "debug", "info", "warn", "error"]);
/** How many recent warnings, errors and stats a session keeps for diagnostics. */
const diagnosticsLimit = 30;
// The child needs no Slack credentials, so it only gets what running Bun and
// ffmpeg takes.
const inheritedEnv = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"];

/**
 * Points `play` and `preload` at the downloaded files instead of the loopback
 * /audio URLs, which ignore Range requests and so cannot be seeked by ffmpeg.
 */
export function withLocalAudio(
  message: unknown,
  audioPath: (entryId: string) => string | undefined,
) {
  if (!message || typeof message !== "object") return message;
  const media = message as {
    type?: string;
    entryId?: string;
    url?: string;
    entries?: { entryId: string; url: string }[];
  };
  const local = (entryId: string | undefined, url: string | undefined) =>
    (entryId && audioPath(entryId)) || url;
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

// Ends that mean the Huddle is over or the bot was sent away, which the
// browser would meet just the same.
const deliberateEnds = new Set<number>([
  statusCodes.left,
  statusCodes.joinedFromAnotherDevice,
  statusCodes.meetingEnded,
  statusCodes.attendeeRemoved,
]);

/** Whether a media event means native media broke, rather than was left. */
export function nativeMediaFailed(message: MediaMessage) {
  if (message.type === "fatal") return true;
  if (message.type !== "ended") return false;
  const code =
    message.details && typeof message.details === "object"
      ? (message.details as { code?: unknown }).code
      : undefined;
  return typeof code !== "number" || !deliberateEnds.has(code);
}

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
  private recent: Record<string, unknown>[] = [];

  constructor(
    private onMessage: (message: MediaMessage) => void,
    // Maps an entry to its downloaded file; see withLocalAudio.
    private audioPath: (entryId: string) => string | undefined = () =>
      undefined,
  ) {}

  async start(bootstrap: ChimeBootstrap) {
    await this.close();
    this.closing = false;
    this.ended = false;
    this.sessionId = bootstrap.sessionId;
    this.recent = [];
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
    void this.readLines(child.stderr, (line) => {
      const message = redactSecrets(line).slice(0, 2_000);
      this.remember("warn", "native_media_stderr", message);
      childLog.warn({ event: "native_media_stderr" }, message);
    });
    void child.exited.then((exitCode) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.closing || this.ended) return;
      this.remember("error", "native_media_exited", "Exited unexpectedly", {
        exitCode,
      });
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

  /**
   * The process's recent warnings, errors and stats, oldest first, for a
   * report on why this session was given up.
   */
  diagnostics() {
    return [...this.recent];
  }

  /** Sends a coordinator message; false when no media process is running. */
  send(message: unknown) {
    return this.write(withLocalAudio(message, this.audioPath));
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

  private remember(
    level: string,
    event: string,
    message: string,
    fields: Record<string, unknown> = {},
  ) {
    this.recent.push({
      at: new Date().toISOString(),
      level,
      event,
      message,
      ...fields,
    });
    if (this.recent.length > diagnosticsLimit) this.recent.shift();
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
      const safeFields = redactFields(fields);
      const text = redactSecrets(String(message ?? ""));
      if (
        method === "warn" ||
        method === "error" ||
        event === "native_media_stats"
      )
        this.remember(method, event ?? "native_media_log", text, safeFields);
      childLog[method](
        { event: event ?? "native_media_log", ...safeFields },
        text,
      );
      return;
    }
    if (typeof parsed.type !== "string") return;
    if (parsed.type === "fatal" || parsed.type === "ended")
      this.remember(
        parsed.type === "fatal" ? "error" : "info",
        `media_${parsed.type}`,
        parsed.type,
        parsed.details && typeof parsed.details === "object"
          ? { details: redactFields(parsed.details as Record<string, unknown>) }
          : {},
      );
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
