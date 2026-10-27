import { describe, expect, test } from "bun:test";
import {
  DataChannel,
  dataTopic,
  encodeMessages,
  maxChunks,
  encodePayload,
  maxDataBytes,
  slackUserId,
  type ReceivedData,
} from "./data-channel.ts";
import { decodeFrame, encodeFrame } from "./signaling.ts";

const self = "bot-attendee";
const external = "slack-R0123ABC-U0456DEF";

/** A DATA_MESSAGE frame as Chime would deliver it, through the real proto. */
function frame(
  messages: {
    topic?: string;
    data: Uint8Array;
    sender_attendee_id?: string;
    sender_external_user_id?: string;
    ingest_time_ns?: number;
  }[],
) {
  return decodeFrame(
    encodeFrame("DATA_MESSAGE", {
      data_message: {
        messages: messages.map((message) => ({
          topic: dataTopic,
          sender_attendee_id: "user-attendee",
          sender_external_user_id: external,
          ingest_time_ns: 1_000_000,
          ...message,
        })),
      },
    }),
  );
}

function json(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function channel(now = () => 0) {
  const sent: unknown[] = [];
  const received: ReceivedData[] = [];
  let throttled = 0;
  const data = new DataChannel(
    self,
    (bytes) => {
      sent.push(JSON.parse(new TextDecoder().decode(bytes)));
      return true;
    },
    (message) => received.push(message),
    () => throttled++,
    now,
  );
  return { data, sent, received, throttled: () => throttled };
}

describe("data channel", () => {
  test("reads the Slack user from Chime's external user id", () => {
    expect(slackUserId(external)).toBe("U0456DEF");
    expect(slackUserId("slack-R0123ABC-W0456DEF-extra")).toBe("W0456DEF");
    expect(slackUserId("U0456DEF")).toBeUndefined();
    expect(slackUserId("a-b-not-a-user")).toBeUndefined();
    expect(slackUserId(undefined)).toBeUndefined();
  });

  test("encodes a data message frame the way Chime reads it", () => {
    const decoded = decodeFrame(
      encodeFrame("DATA_MESSAGE", {
        data_message: {
          messages: [{ topic: dataTopic, data: encodePayload({ type: "x" }) }],
        },
      }),
    );
    const message = decoded.data_message?.messages?.[0];
    expect(decoded.type).toBe("DATA_MESSAGE");
    expect(message?.topic).toBe(dataTopic);
    expect(
      JSON.parse(Buffer.from(message!.data!, "base64").toString()),
    ).toEqual({ type: "x", v: 1 });
  });

  test("answers a ping with a pong naming its sender", () => {
    const { data, sent, received } = channel();
    data.handle(frame([{ data: json({ v: 1, type: "ping", id: "abc" }) }]));
    expect(received).toEqual([]);
    expect(sent).toEqual([{ type: "pong", id: "abc", to: "U0456DEF", v: 1 }]);
  });

  test("hands other messages on with their sender", () => {
    const { data, sent, received } = channel();
    data.handle(frame([{ data: json({ v: 1, type: "sync" }) }]));
    expect(received).toEqual([
      {
        payload: { v: 1, type: "sync" },
        attendeeId: "user-attendee",
        userId: "U0456DEF",
      },
    ]);
    expect(sent).toEqual([]);
  });

  test("pongs each attendee at most once a second", () => {
    let now = 0;
    const { data, sent } = channel(() => now);
    const ping = frame([{ data: json({ v: 1, type: "ping" }) }]);
    data.handle(ping);
    now = 500;
    data.handle(ping);
    now = 1_000;
    data.handle(ping);
    expect(sent).toHaveLength(2);
  });

  test("ignores other topics, versions, bad JSON and unknown senders", () => {
    const { data, received } = channel();
    data.handle(
      frame([
        { topic: "data-channel", data: json({ v: 1, type: "sync" }) },
        { data: json({ v: 2, type: "sync" }) },
        { data: json({ v: 1 }) },
        { data: new TextEncoder().encode("{") },
        {
          sender_external_user_id: "nobody",
          data: json({ v: 1, type: "sync" }),
        },
      ]),
    );
    expect(received).toEqual([]);
  });

  test("skips its own messages and notices throttled ones", () => {
    const { data, sent, received, throttled } = channel();
    const ping = json({ v: 1, type: "ping" });
    data.handle(
      frame([
        { sender_attendee_id: self, data: ping },
        { sender_attendee_id: `${self}#content`, data: ping },
        { sender_attendee_id: self, data: ping, ingest_time_ns: 0 },
      ]),
    );
    expect(received).toEqual([]);
    expect(sent).toEqual([]);
    expect(throttled()).toBe(1);
  });

  test("announces itself with its protocol and features", () => {
    const { data, sent } = channel();
    data.announce();
    expect(sent).toEqual([
      {
        type: "hello",
        protocol: 1,
        features: ["state", "commands", "search", "settings"],
        v: 1,
      },
    ]);
    expect(() =>
      encodePayload({ type: "big", text: "x".repeat(maxDataBytes) }),
    ).toThrow();
  });

  test("sends a message too large for one in chunks that fit", () => {
    const { data, sent } = channel();
    // Wide characters and escapes, so a slice's size isn't its length.
    const text = 'ü😀"\n'.repeat(900);
    expect(data.broadcast({ type: "state", text })).toBe(true);
    const chunks = sent as {
      type: string;
      id: string;
      i: number;
      n: number;
      data: string;
    }[];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.type === "chunk")).toBe(true);
    expect(chunks.map((chunk) => chunk.i)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(new Set(chunks.map((chunk) => `${chunk.id}/${chunk.n}`)).size).toBe(
      1,
    );
    expect(JSON.parse(chunks.map((chunk) => chunk.data).join(""))).toEqual({
      type: "state",
      text,
      v: 1,
    });
    for (const bytes of encodeMessages({ type: "state", text }, "zz"))
      expect(bytes.length).toBeLessThanOrEqual(maxDataBytes);
    // Each message gets its own id.
    data.broadcast({ type: "state", text });
    expect((sent.at(-1) as { id: string }).id).not.toBe(chunks[0]!.id);
  });

  test("won't chunk a message past what clients put back together", () => {
    const text = "x".repeat(maxDataBytes * (maxChunks + 1));
    expect(() => encodeMessages({ type: "state", text }, "zz")).toThrow();
  });
});
