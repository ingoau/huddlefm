// Throwaway spike: minimal Chime signaling client. Not production code.
import protobuf from "protobufjs";
import { readFileSync } from "node:fs";

const root = protobuf.parse(
  readFileSync(new URL("./SignalingProtocol.proto", import.meta.url), "utf8"),
  { keepCase: true },
).root;
export const Frame = root.lookupType("SdkSignalFrame");
const T = (Frame.lookupEnum("Type") as protobuf.Enum).values;
export const FrameType = T;
const typeName = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

export function loadEnv(path: string) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}

export function redact(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) =>
      /token|password|username|credential/i.test(key) && typeof v === "string"
        ? `<redacted ${v.length}>`
        : v,
    ),
  );
}

export async function roomsJoin(channelId: string) {
  const body = new FormData();
  body.set("channel_id", channelId);
  body.set("regions", process.env.CHIME_MEDIA_REGION ?? "ap-southeast-2");
  body.set(
    "token",
    process.env.SLACK_ENTERPRISE_XOXC ?? process.env.SLACK_TEAM_XOXC!,
  );
  body.set("multidevice", "true");
  const res = await fetch("https://hackclub.slack.com/api/rooms.join", {
    method: "POST",
    headers: { cookie: `d=${process.env.SLACK_XOXD}` },
    body,
  });
  const json: any = await res.json();
  if (!json.ok) throw new Error(`rooms.join: ${json.error ?? res.status}`);
  const meeting = { ...json.call.free_willy.meeting };
  if (meeting.MeetingFeatures === null) delete meeting.MeetingFeatures;
  return { meeting, attendee: json.call.free_willy.attendee, raw: json };
}

// Reads field 2 (the frame type) straight off the wire, for frames the proto
// cannot decode.
function rawType(bytes: Uint8Array) {
  try {
    const reader = protobuf.Reader.create(bytes);
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      if (tag >>> 3 === 2 && (tag & 7) === 0) return reader.uint32();
      reader.skipType(tag & 7);
    }
  } catch {}
  return "?";
}

export type Handler = (type: string, frame: any) => void;

export class Signaling {
  ws!: WebSocket;
  pingId = 0;
  undecodable = 0;
  handlers: Handler[] = [];
  log: { dir: "in" | "out"; at: number; type: string; frame: any }[] = [];
  constructor(
    private meeting: any,
    private attendee: any,
    // The JS SDK keeps one audio session id across reconnects.
    private audioSessionId = Math.floor(Math.random() * 2 ** 32),
  ) {}

  on(handler: Handler) {
    this.handlers.push(handler);
  }

  connect() {
    const url =
      this.meeting.MediaPlacement.SignalingUrl +
      "?X-Chime-Control-Protocol-Version=3&X-Amzn-Chime-Send-Close-On-Error=1";
    this.ws = new WebSocket(url, ["_aws_wt_session", this.attendee.JoinToken]);
    this.ws.binaryType = "arraybuffer";
    return new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) =>
        reject(
          new Error(`signaling ws error ${String((e as any).message ?? e)}`),
        );
      this.ws.onclose = (e) => {
        console.log(
          `[sig] closed code=${e.code} reason=${e.reason} at ${new Date().toISOString()}`,
        );
        for (const h of this.handlers)
          h("CLOSED", { code: e.code, reason: e.reason });
      };
      this.ws.onmessage = (e) => {
        const bytes = new Uint8Array(e.data as ArrayBuffer);
        let frame: any;
        try {
          frame = Frame.toObject(Frame.decode(bytes.subarray(1)), {
            enums: String,
            longs: String,
            bytes: String,
          });
        } catch (err) {
          // Like the JS SDK, skip frames we cannot decode. The server sends
          // frame types newer than our v3.31.0 proto; in proto2 an unknown
          // enum value is dropped, so the required `type` looks missing.
          this.undecodable++;
          console.log(
            `[sig] undecodable frame (${bytes.length} bytes, type ${rawType(bytes.subarray(1))}): ${String(err)}`,
          );
          this.log.push({
            dir: "in",
            at: Date.now(),
            type: `UNDECODABLE_${rawType(bytes.subarray(1))}`,
            frame: { length: bytes.length },
          });
          return;
        }
        this.log.push({ dir: "in", at: Date.now(), type: frame.type, frame });
        if (frame.type === "PING_PONG" && frame.ping_pong?.type === "PING") {
          this.send("PING_PONG", {
            ping_pong: { type: 2, ping_id: frame.ping_pong.ping_id },
          });
        }
        for (const h of this.handlers) h(frame.type, frame);
      };
    });
  }

  send(type: keyof typeof T, body: Record<string, unknown> = {}) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      console.log(`[sig] drop ${type}: socket state ${this.ws.readyState}`);
      return;
    }
    const msg = Frame.fromObject({
      timestamp_ms: Date.now(),
      type: T[type],
      ...body,
    });
    const encoded = Frame.encode(msg).finish();
    const out = new Uint8Array(encoded.length + 1);
    out[0] = 0x05;
    out.set(encoded, 1);
    this.log.push({ dir: "out", at: Date.now(), type, frame: body });
    this.ws.send(out);
  }

  wait(type: string, timeoutMs = 15000) {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${type}`)),
        timeoutMs,
      );
      const h: Handler = (t, f) => {
        if (t === type || (f?.error && t !== "PING_PONG")) {
          clearTimeout(timer);
          this.handlers = this.handlers.filter((x) => x !== h);
          f?.error && t !== type
            ? reject(new Error(`signaling error ${JSON.stringify(f.error)}`))
            : resolve(f);
        }
      };
      this.on(h);
    });
  }

  join() {
    this.send("JOIN", {
      join: {
        protocol_version: 2,
        // Leave max_num_of_videos unset like the JS SDK: sending 0 made the
        // server report at_capacity and answer SUBSCRIBE with 206 (view-only).
        flags: 2, // HAS_STREAM_UPDATE
        client_details: {
          app_name: "huddlefm-spike",
          app_version: "0.0.1",
          device_model: "Linux",
          device_make: "Linux",
          platform_name: "Bun",
          platform_version: Bun.version,
          client_source: "amazon-chime-sdk-js",
          chime_sdk_version: "3.31.0",
        },
        audio_session_id: this.audioSessionId,
        wants_compressed_sdp: false,
      },
    });
  }

  startPings() {
    return setInterval(() => {
      this.send("PING_PONG", {
        ping_pong: { type: 1, ping_id: ++this.pingId },
      });
    }, 10000);
  }
}

export { typeName };
