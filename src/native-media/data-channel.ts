import { contentSuffix } from "./content-shares.ts";
import type { SignalFrame } from "./signaling.ts";

/** The Chime data message topic HuddleFM's clients and the bot share. */
export const dataTopic = "huddlefm";
/** Bumped when a message changes shape; others are ignored. */
export const protocolVersion = 1;
/** Chime refuses data messages larger than this. */
export const maxDataBytes = 2048;
/** The least time between two pongs to one attendee. */
const pongIntervalMs = 1_000;

/** A message on the topic, as JSON. */
export type DataPayload = { v: number; type: string; [key: string]: unknown };

/** A message someone else sent on the topic, with who Chime says sent it. */
export type ReceivedData = {
  payload: DataPayload;
  attendeeId: string;
  userId: string;
};

/**
 * The Slack user behind a Chime external user id. Slack's are
 * `<prefix>-<callId>-<userId>`, sometimes with one more part, and its client
 * reads the user the same way.
 */
export function slackUserId(externalUserId: string | undefined) {
  const parts = (externalUserId ?? "").split("-");
  const userId = parts.length === 3 || parts.length === 4 ? parts[2] : "";
  return userId && /^[UW][A-Z0-9]+$/.test(userId) ? userId : undefined;
}

export function encodePayload(payload: Record<string, unknown>) {
  const data = new TextEncoder().encode(
    JSON.stringify({ ...payload, v: protocolVersion }),
  );
  if (data.length > maxDataBytes)
    throw new Error(`Data message is ${data.length} bytes`);
  return data;
}

function decodePayload(base64: string | undefined) {
  if (!base64) return;
  try {
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    if (
      payload &&
      typeof payload === "object" &&
      payload.v === protocolVersion &&
      typeof payload.type === "string"
    )
      return payload as DataPayload;
  } catch {}
}

/**
 * HuddleFM's messages over the Chime data channel. Chime stamps each with its
 * sender, so a message names the Slack user who sent it without any token.
 * For now the bot announces itself and answers pings, so a client can tell
 * the channel works both ways.
 */
export class DataChannel {
  private lastPong = new Map<string, number>();

  constructor(
    private selfId: string,
    private send: (data: Uint8Array) => boolean,
    private onMessage: (message: ReceivedData) => void,
    private onThrottled: () => void,
    private now = Date.now,
  ) {}

  handle(frame: SignalFrame) {
    for (const message of frame.data_message?.messages ?? []) {
      if (message.topic !== dataTopic) continue;
      const attendeeId = message.sender_attendee_id;
      if (
        attendeeId === this.selfId ||
        attendeeId === `${this.selfId}${contentSuffix}`
      ) {
        // Chime only returns the bot's own messages when it throttled them.
        if (message.ingest_time_ns === 0) this.onThrottled();
        continue;
      }
      const userId = slackUserId(message.sender_external_user_id);
      const payload = decodePayload(message.data);
      if (!attendeeId || !userId || !payload) continue;
      this.onMessage({ payload, attendeeId, userId });
      if (payload.type === "ping") this.pong(payload, attendeeId, userId);
    }
  }

  /** Tells clients already in the Huddle that the bot is here. */
  announce() {
    return this.broadcast({ type: "hello" });
  }

  broadcast(payload: Record<string, unknown>) {
    return this.send(encodePayload(payload));
  }

  private pong(ping: DataPayload, attendeeId: string, userId: string) {
    const now = this.now();
    if (now - (this.lastPong.get(attendeeId) ?? -Infinity) < pongIntervalMs)
      return;
    this.lastPong.set(attendeeId, now);
    this.broadcast({
      type: "pong",
      // Echoed only when it is a short id, so a pong always fits.
      ...(typeof ping.id === "string" && ping.id.length <= 64
        ? { id: ping.id }
        : {}),
      to: userId,
    });
  }
}
