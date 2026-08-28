import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PostHog } from "posthog-node";
import { redactSecrets, safeError } from "./error-message.ts";

type Properties = Record<string, unknown>;
type Client = Pick<PostHog, "capture" | "captureException" | "shutdown">;
type Context = {
  distinctId?: string;
  sessionId?: string;
  properties?: Properties;
};

const secret =
  /authorization|cookie|password|secret|token|api[_-]?key|session[_-]?key|xox[acpbrs]/i;
const userName = /^(?:name|user_?name|display_?name|real_?name|actor_?name)$/i;

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      userName.test(key)
        ? []
        : [[key, secret.test(key) ? "[redacted]" : sanitize(item, seen)]],
    ),
  );
}

async function installationId(path: string) {
  const existing = await readFile(path, "utf8").catch(() => "");
  if (existing.trim()) return existing.trim();
  const id = crypto.randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, id);
  return id;
}

export class Analytics {
  private captured = new WeakSet<object>();

  constructor(
    private client?: Client,
    readonly systemId = "",
    private onError: (error: unknown) => void = () => {},
  ) {}

  static async create(
    apiKey?: string,
    host?: string,
    onError?: (error: unknown) => void,
    idPath = "data/posthog-installation-id",
  ) {
    if (!apiKey) return new Analytics(undefined, "", onError);
    const client = new PostHog(apiKey, {
      host,
      disableGeoip: true,
      personProfiles: "always",
      before_send: (event) =>
        event
          ? {
              ...event,
              properties: sanitize(event.properties) as Properties,
            }
          : null,
    });
    if (onError) client.on("error", onError);
    return new Analytics(client, await installationId(idPath), onError);
  }

  capture(event: string, context: Context = {}) {
    if (!this.client) return;
    try {
      this.client.capture({
        distinctId: context.distinctId ?? this.systemId,
        event,
        properties: sanitize({
          ...context.properties,
          ...(context.sessionId ? { $session_id: context.sessionId } : {}),
        }) as Properties,
      });
    } catch (error) {
      this.onError(error);
    }
  }

  audit(event: string, actorId: string | undefined, details: Properties) {
    const properties = { ...details };
    const sessionId =
      typeof properties.sessionId === "string"
        ? String(properties.sessionId)
        : undefined;
    const requesterId =
      properties.origin !== "autoplay" &&
      typeof properties.requesterId === "string"
        ? properties.requesterId
        : undefined;
    delete properties.sessionId;
    if (!actorId || actorId === properties.requesterId || !requesterId)
      delete properties.requesterId;
    this.capture(event, {
      distinctId: actorId ?? requesterId,
      sessionId,
      properties,
    });
  }

  exception(error: unknown, context: Context = {}) {
    if (!this.client) return;
    if (error && typeof error === "object") {
      if (this.captured.has(error)) return;
      this.captured.add(error);
    }
    const sanitized = new Error(safeError(error));
    if (error instanceof Error) {
      sanitized.name = error.name;
      sanitized.stack = error.stack
        ? redactSecrets(error.stack)
        : sanitized.stack;
    }
    try {
      this.client.captureException(
        sanitized,
        context.distinctId ?? this.systemId,
        sanitize({
          ...context.properties,
          ...(context.sessionId ? { $session_id: context.sessionId } : {}),
        }) as Properties,
      );
    } catch (captureError) {
      this.onError(captureError);
    }
  }

  async shutdown() {
    try {
      await this.client?.shutdown(5_000);
    } catch (error) {
      this.onError(error);
    }
  }
}

let current = new Analytics();

export async function startAnalytics(
  apiKey?: string,
  host?: string,
  onError?: (error: unknown) => void,
) {
  try {
    current = await Analytics.create(apiKey, host, onError);
  } catch (error) {
    current = new Analytics();
    onError?.(error);
  }
}

export function capture(...args: Parameters<Analytics["capture"]>) {
  current.capture(...args);
}

export function captureAudit(...args: Parameters<Analytics["audit"]>) {
  current.audit(...args);
}

export function captureException(...args: Parameters<Analytics["exception"]>) {
  current.exception(...args);
}

export function shutdownAnalytics() {
  return current.shutdown();
}
