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
/** The version of the messages in docs/data-channel.md that `hello` names. */
export const dataProtocol = 1;
/** What the bot offers clients, as `hello` lists it. */
export const dataFeatures = ["state", "commands", "search", "settings"];
// Room left in a chunk for its envelope, so each one stays under the limit.
const chunkEnvelopeBytes = 128;

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

/**
 * A payload as the data messages that carry it: itself when it fits, or else
 * `chunk`s, each a slice of its JSON text that fits once wrapped.
 */
export function encodeMessages(payload: Record<string, unknown>, id: string) {
  const text = JSON.stringify({ ...payload, v: protocolVersion });
  const whole = new TextEncoder().encode(text);
  if (whole.length <= maxDataBytes) return [whole];
  const slices: string[] = [];
  const budget = maxDataBytes - chunkEnvelopeBytes - id.length;
  let start = 0;
  while (start < text.length) {
    // Slices are cut by UTF-16 code unit and measured as JSON-escaped UTF-8,
    // backing off until one fits, without splitting a surrogate pair.
    let end = Math.min(text.length, start + budget);
    while (end > start) {
      const code = text.charCodeAt(end - 1);
      const splitsPair = code >= 0xd800 && code <= 0xdbff && end < text.length;
      if (
        !splitsPair &&
        new TextEncoder().encode(JSON.stringify(text.slice(start, end)))
          .length <= budget
      )
        break;
      end -= splitsPair ? 1 : Math.max(1, Math.ceil((end - start) / 8));
    }
    if (end <= start) throw new Error("Data message cannot be chunked");
    slices.push(text.slice(start, end));
    start = end;
  }
  return slices.map((data, i) =>
    encodePayload({ type: "chunk", id, i, n: slices.length, data }),
  );
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
 * The bot answers pings here and hands every other message to `onMessage`;
 * docs/data-channel.md describes the messages.
 */
export class DataChannel {
  private lastPong = new Map<string, number>();
  private chunkIds = 0;

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
      if (payload.type === "ping") this.pong(payload, attendeeId, userId);
      else this.onMessage({ payload, attendeeId, userId });
    }
  }

  /** Tells clients already in the Huddle that the bot is here. */
  announce() {
    return this.broadcast({
      type: "hello",
      protocol: dataProtocol,
      features: dataFeatures,
    });
  }

  /** Sends a payload to everyone, in chunks when it is too large for one. */
  broadcast(payload: Record<string, unknown>) {
    const id = (this.chunkIds++).toString(36);
    return encodeMessages(payload, id).every((data) => this.send(data));
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
