import { logger } from "../logger.ts";
import { redactSecrets } from "../error-message.ts";
import type { ChimeBootstrap } from "../slack-huddle.ts";
import { statusCodes } from "./status-codes.ts";
import {
  hostReply,
  LineSocket,
  MediaHostClient,
} from "../media-host/client.ts";
import { mediaHostProtocol, type HostedTag } from "../media-host/protocol.ts";

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
// The child needs no Slack credentials, so it only gets what running Bun and
// ffmpeg takes.
const inheritedEnv = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"];

/** Starts one huddle's media process (main.ts), here or on a media host. */
export function spawnMediaProcess() {
  const env = Object.fromEntries(
    inheritedEnv.flatMap((name) =>
      process.env[name] ? [[name, process.env[name]!]] : [],
    ),
  );
  return Bun.spawn(
    [process.execPath, new URL("./main.ts", import.meta.url).pathname],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
  );
}

export type MediaProcess = ReturnType<typeof spawnMediaProcess>;

/** Calls onLine with each line of a stream, until it ends. */
export async function readLines(
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

/** Writes one line to a media process's stdin; false once it is gone. */
export function writeLine(child: MediaProcess, line: string) {
  try {
    child.stdin.write(`${line}\n`);
    void child.stdin.flush();
    return true;
  } catch {
    return false;
  }
}

/** Ends a media process's stdin, which makes it leave, and waits for it. */
export async function endMediaProcess(child: MediaProcess, waitMs = 5_000) {
  try {
    void child.stdin.end();
  } catch {}
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(waitMs).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

/** What a session's media runs on: a child process, or a media host. */
type MediaLink = {
  write(line: string): boolean;
  /** Ends the media process, which leaves the huddle. */
  close(): Promise<void>;
  /** Lets the media process run on without the app; only on a host. */
  detach(): Promise<boolean>;
};

/**
 * Points `play` and `preload` at the downloaded files instead of the loopback
 * /audio URLs, so ffmpeg reads them straight from disk. An entry without a
 * file keeps its URL, which still seeks: /audio serves byte ranges.
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

/**
 * Runs one huddle's native media in its own Bun process (src/native-media/
 * main.ts), so a crash in native WebRTC or media code ends that one session
 * instead of the whole bot. Coordinator messages go in on stdin, and media
 * events come back on stdout.
 *
 * With a media host, the process runs there instead, in its own container,
 * and the same lines go over the host's socket. The process then keeps
 * playing while the app restarts, and the app attaches to it again.
 */
export class NativeMediaSession {
  private link?: MediaLink;
  private closing = false;
  // The child exits by itself after reporting `ended`; that exit is expected.
  private ended = false;
  private sessionId?: string;
  // The app asked the media to leave, so its leaving is not the host's doing.
  private leaveAsked = false;
  // The media host is going away, or went, with this session's media.
  private hostGone = false;

  constructor(
    private onMessage: (message: MediaMessage) => void,
    // Maps an entry to its downloaded file; see withLocalAudio.
    private audioPath: (entryId: string) => string | undefined = () =>
      undefined,
    private host?: MediaHostClient,
  ) {}

  /** Whether the media outlives the app, on a media host. */
  get hosted() {
    return Boolean(this.host);
  }

  /** Whether media is running and reachable. */
  get connected() {
    return Boolean(this.link) && !this.hostGone;
  }

  private reset(sessionId: string) {
    this.closing = false;
    this.ended = false;
    this.leaveAsked = false;
    this.hostGone = false;
    this.sessionId = sessionId;
  }

  async start(bootstrap: ChimeBootstrap) {
    await this.close();
    this.reset(bootstrap.sessionId);
    const childLog = log.child({ mediaSessionId: bootstrap.sessionId });
    if (this.host) {
      const lines = await this.host.connect({
        host: "start",
        protocol: mediaHostProtocol,
        ...this.host.ports(),
        bootstrap,
      });
      this.link = this.hostLink(lines, childLog);
      childLog.info(
        { event: "native_media_started", host: true },
        "Native media process started on the media host",
      );
      return;
    }
    const child = spawnMediaProcess();
    this.link = this.childLink(child, childLog);
    childLog.info(
      { event: "native_media_started", pid: child.pid },
      "Native media process started",
    );
    this.write({ type: "bootstrap", payload: bootstrap });
  }

  /**
   * Picks up a media process still running on the media host, which replays
   * what it said while no one was attached. False when it is gone.
   */
  async attach(sessionId: string) {
    if (!this.host) return false;
    await this.close();
    this.reset(sessionId);
    const childLog = log.child({ mediaSessionId: sessionId });
    const lines = await this.host.connect({
      host: "attach",
      protocol: mediaHostProtocol,
      ...this.host.ports(),
      sessionId,
    });
    // What the host replays can come in the same read as its answer.
    const early: string[] = [];
    let answered = false;
    const answer = await new Promise<"attached" | "missing">((resolve) => {
      // A host that never answers counts as one without the session.
      const timer = setTimeout(() => {
        answered = true;
        resolve("missing");
      }, 5_000);
      lines.onLine = (line) => {
        if (answered) {
          early.push(line);
          return;
        }
        const reply = hostReply(line);
        if (reply?.host === "attached" || reply?.host === "missing") {
          answered = true;
          clearTimeout(timer);
          resolve(reply.host);
        } else if (reply?.host === "error") {
          childLog.warn(
            { event: "native_media_attach_refused", error: reply.message },
            "The media host refused to attach",
          );
          resolve("missing");
        }
      };
      lines.onClose = () => resolve("missing");
    });
    if (answer === "missing") {
      lines.destroy();
      return false;
    }
    this.link = this.hostLink(lines, childLog);
    for (const line of early) lines.onLine(line);
    childLog.info(
      { event: "native_media_attached", replayed: early.length },
      "Attached to the native media process on the media host",
    );
    return true;
  }

  /**
   * Has the media host keep what the media says from here on for the next
   * app, before the session is saved for a restart, so nothing it says in
   * between is lost. Messages still go to the media.
   */
  hold() {
    if (!this.host) return false;
    return this.link?.write(JSON.stringify({ host: "detach" })) ?? false;
  }

  /** Tells the media host whose session this is, for attaching to it again. */
  tag(tag: HostedTag) {
    if (!this.host) return false;
    return this.link?.write(JSON.stringify({ host: "tag", ...tag })) ?? false;
  }

  /** Sends a coordinator message; false when no media process is running. */
  send(message: unknown) {
    if ((message as { type?: unknown } | null)?.type === "leave")
      this.leaveAsked = true;
    return this.write(withLocalAudio(message, this.audioPath));
  }

  /**
   * Lets the media process play on while the app restarts. False when it
   * runs here, and so ends with the app.
   */
  async detach() {
    const link = this.link;
    if (!link) return false;
    this.closing = true;
    const detached = await link.detach();
    if (this.link === link) this.link = undefined;
    return detached;
  }

  async close() {
    const link = this.link;
    if (!link) return;
    this.closing = true;
    this.leaveAsked = true;
    await link.close();
    if (this.link === link) this.link = undefined;
    log.debug(
      { event: "native_media_closed", mediaSessionId: this.sessionId },
      "Native media process closed",
    );
  }

  private childLink(child: MediaProcess, childLog: typeof log): MediaLink {
    void readLines(child.stdout, (line) => this.receive(line, childLog));
    void readLines(child.stderr, (line) => {
      const message = redactSecrets(line).slice(0, 2_000);
      childLog.warn({ event: "native_media_stderr" }, message);
    });
    const link: MediaLink = {
      write: (line) => writeLine(child, line),
      close: () => endMediaProcess(child),
      detach: async () => {
        await endMediaProcess(child);
        return false;
      },
    };
    void child.exited.then((exitCode) => this.exited(link, exitCode, childLog));
    return link;
  }

  private hostLink(lines: LineSocket, childLog: typeof log): MediaLink {
    let exited: ReturnType<typeof Promise.withResolvers<void>> | undefined =
      Promise.withResolvers<void>();
    let exitCode: number | null = null;
    const gone = () => {
      exited?.resolve();
      exited = undefined;
    };
    const link: MediaLink = {
      write: (line) => lines.write(line),
      close: async () => {
        if (!exited) return;
        // A host that is stopping ends the process itself.
        if (this.hostGone) {
          lines.destroy();
          return;
        }
        lines.write({ host: "close" });
        const done = exited.promise;
        const ended = await Promise.race([
          done.then(() => true),
          Bun.sleep(6_000).then(() => false),
        ]);
        if (!ended) lines.destroy();
      },
      detach: async () => {
        if (!exited) return false;
        lines.write({ host: "detach" });
        lines.end();
        await Promise.race([exited.promise, Bun.sleep(2_000)]);
        lines.destroy();
        return true;
      },
    };
    lines.onLine = (line) => {
      const reply = hostReply(line);
      // What the media says as the host stops it is not the session ending.
      if (!reply)
        return this.hostGone ? undefined : this.receive(line, childLog);
      if (reply.host === "stopping") this.lostHost(childLog);
      if (reply.host === "exited") exitCode = reply.code;
      if (reply.host === "error")
        childLog.error(
          { event: "media_host_refused", error: reply.message },
          "The media host refused the session",
        );
    };
    lines.onClose = () => {
      gone();
      // The host went without the process exiting first: it crashed, or
      // its container was stopped.
      if (exitCode === null && !this.closing && !this.ended)
        this.lostHost(childLog);
      if (this.hostGone) {
        if (this.link === link) this.link = undefined;
        return;
      }
      this.exited(link, exitCode, childLog);
    };
    return link;
  }

  /**
   * The media host is stopping, or went, taking this session's media with
   * it. That is reported once, as `media_host_lost`, so the session is
   * restored once a host is back instead of ending.
   */
  private lostHost(childLog: typeof log) {
    if (this.hostGone) return;
    this.hostGone = true;
    childLog.warn(
      { event: "media_host_lost" },
      "The media host stopped with this session's media",
    );
    this.onMessage({ type: "media_host_lost", sessionId: this.sessionId });
  }

  private exited(
    link: MediaLink,
    exitCode: number | null,
    childLog: typeof log,
  ) {
    if (this.link !== link) return;
    this.link = undefined;
    if (this.closing || this.ended) return;
    childLog.error(
      { event: "native_media_exited", exitCode, host: this.hosted },
      this.hosted
        ? "Lost the native media process on the media host"
        : "Native media process exited unexpectedly",
    );
    // Ends the session, which also offers the Restore session button.
    this.onMessage({
      type: "ended",
      details: {
        code: statusCodes.taskFailed,
        message: this.hosted
          ? `Lost the media host's process (exit code ${exitCode})`
          : `Native media process exited with ${exitCode}`,
      },
      sessionId: this.sessionId,
    });
  }

  private write(message: unknown) {
    return this.link?.write(JSON.stringify(message)) ?? false;
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
      childLog[method](
        { event: event ?? "native_media_log", ...safeFields },
        text,
      );
      return;
    }
    if (typeof parsed.type !== "string") return;
    // Media that leaves without being asked, on a host, was stopped by it:
    // a host from before it said it was stopping does that.
    if (
      this.hosted &&
      parsed.type === "ended" &&
      !this.leaveAsked &&
      (parsed.details as { code?: unknown } | undefined)?.code ===
        statusCodes.left
    )
      return this.lostHost(childLog);
    if (parsed.type === "ended") this.ended = true;
    this.onMessage(parsed);
  }
}
