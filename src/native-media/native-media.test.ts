import { describe, expect, test } from "bun:test";
import { DuckingController, type DuckDecision } from "../ducking.ts";
import { Compressor } from "./compressor.ts";
import { SampleQueue } from "./decoder.ts";
import {
  AnnexBSplitter,
  countPictureLoss,
  h264Payloads,
  rtpPacket,
} from "./rtp.ts";
import { decodeFrame, encodeFrame, rawFrameType } from "./signaling.ts";
import { normalizedVolume, SpeechSignals } from "./speech.ts";
import { iceServers } from "./chime-link.ts";
import {
  NativeMediaSession,
  nativeMediaFailed,
  withLocalAudio,
} from "./session.ts";
import { statusCodes } from "./status-codes.ts";

describe("signaling frames", () => {
  test("round-trip through the Chime protobuf with a type byte", () => {
    const bytes = encodeFrame("PING_PONG", {
      ping_pong: { type: 1, ping_id: 7 },
    });
    expect(bytes[0]).toBe(0x05);
    const frame = decodeFrame(bytes);
    expect(frame.type).toBe("PING_PONG");
    expect(frame.ping_pong).toEqual({ type: "PING", ping_id: 7 });
  });

  test("decode JOIN_ACK TURN credentials", () => {
    const frame = decodeFrame(
      encodeFrame("JOIN_ACK", {
        joinack: {
          turn_credentials: {
            username: "u",
            password: "p",
            ttl: 300,
            uris: ["turns:ice.example:443?transport=tcp"],
          },
        },
      }),
    );
    expect(frame.joinack?.turn_credentials?.uris).toEqual([
      "turns:ice.example:443?transport=tcp",
    ]);
  });

  test("an unknown frame type can still be read off the wire", () => {
    // Field 1 (timestamp) = 1, field 2 (type) = 99, an enum value the proto
    // does not have.
    const bytes = new Uint8Array([0x05, 0x08, 0x01, 0x10, 99]);
    expect(() => decodeFrame(bytes)).toThrow();
    expect(rawFrameType(bytes)).toBe(99);
  });

  test("TURN URIs become relay servers for every transport", () => {
    expect(
      iceServers({
        username: "u",
        password: "p",
        uris: [
          "turn:ice.example:3478?transport=udp",
          "turn:ice.example:3478?transport=tcp",
          "turns:ice.example:443?transport=tcp",
          "stun:ignored",
        ],
      }).map((server) => [server.relayType, server.port]),
    ).toEqual([
      ["TurnUdp", 3478],
      ["TurnTcp", 3478],
      ["TurnTls", 443],
    ]);
  });
});

describe("speech signals", () => {
  const streams = (...entries: Record<string, unknown>[]) => ({
    type: "AUDIO_STREAM_ID_INFO",
    audio_stream_id_info: { streams: entries as never },
  });
  const volumes = (...entries: Record<string, unknown>[]) => ({
    type: "AUDIO_METADATA",
    audio_metadata: { attendee_states: entries as never },
  });

  function setup() {
    const decisions: DuckDecision[] = [];
    const ducking = new DuckingController("strong");
    const speech = new SpeechSignals("bot", ducking, (decision) => {
      if (decision) decisions.push(decision);
    });
    return { decisions, ducking, speech };
  }

  test("normalises Chime attenuation like the JS SDK", () => {
    expect(normalizedVolume(42)).toBe(0);
    expect(normalizedVolume(14)).toBe(1);
    expect(normalizedVolume(28)).toBe(0.5);
  });

  test("someone speaking ducks, the bot's own stream never does", () => {
    const { speech, ducking } = setup();
    speech.handle(
      streams(
        { audio_stream_id: 1, attendee_id: "bot" },
        { audio_stream_id: 2, attendee_id: "person" },
      ),
      0,
    );
    speech.handle(volumes({ audio_stream_id: 1, volume: 14 }), 10);
    expect(ducking.speaking).toBe(0);
    speech.handle(volumes({ audio_stream_id: 2, volume: 14 }), 20);
    expect(ducking.speaking).toBe(1);
  });

  test("a frame without someone counts them as quiet", () => {
    const { speech, ducking } = setup();
    speech.handle(streams({ audio_stream_id: 2, attendee_id: "person" }), 0);
    speech.handle(volumes({ audio_stream_id: 2, volume: 14 }), 10);
    speech.handle(volumes({ audio_stream_id: 9, volume: 14 }), 20);
    expect(ducking.speaking).toBe(0);
  });

  test("muting and leaving stop the duck", () => {
    const { speech, ducking } = setup();
    speech.handle(streams({ audio_stream_id: 2, attendee_id: "person" }), 0);
    speech.handle(volumes({ audio_stream_id: 2, volume: 14 }), 10);
    speech.handle(streams({ audio_stream_id: 2, muted: true }), 20);
    expect(ducking.speaking).toBe(0);
    speech.handle(streams({ audio_stream_id: 2, muted: false }), 30);
    speech.handle(volumes({ audio_stream_id: 2, volume: 14 }), 40);
    expect(ducking.speaking).toBe(1);
    speech.handle(streams({ audio_stream_id: 2 }), 50);
    expect(ducking.speaking).toBe(0);
  });
});

describe("RTP", () => {
  test("builds a header with marker, sequence, timestamp and SSRC", () => {
    const packet = rtpPacket(111, 65_537, 2 ** 32 + 5, 42, new Uint8Array([9]));
    expect([...packet.subarray(0, 12)]).toEqual([
      0x80, 111, 0, 1, 0, 0, 0, 5, 0, 0, 0, 42,
    ]);
    expect(rtpPacket(102, 0, 0, 1, new Uint8Array(), true)[1]).toBe(0x80 | 102);
  });

  test("splits Annex-B into access units at delimiters", () => {
    const splitter = new AnnexBSplitter();
    const aud = [0, 0, 0, 1, 0x09, 0xf0];
    const sps = [0, 0, 0, 1, 0x67, 1, 2];
    const idr = [0, 0, 1, 0x65, 3, 4, 5];
    expect(splitter.push(new Uint8Array([...aud, ...sps, ...idr]))).toEqual([]);
    // The next delimiter closes the unit even before its own NAL completes.
    const units = splitter.push(new Uint8Array([...aud]));
    expect(units.map((unit) => unit.map((nal) => [...nal]))).toEqual([
      [
        [0x67, 1, 2],
        [0x65, 3, 4, 5],
      ],
    ]);
    expect(splitter.push(new Uint8Array([0x41, ...aud]))).toEqual([]);
    expect(
      splitter
        .push(new Uint8Array([...idr, ...aud]))
        .map((unit) => unit.length),
    ).toEqual([1]);
  });

  test("fragments large NAL units as FU-A with the marker on the end", () => {
    const small = Buffer.from([0x67, 1, 2]);
    const large = Buffer.alloc(25, 7);
    large[0] = 0x65;
    const payloads = h264Payloads([small, large], 10);
    expect(payloads[0]).toEqual({ payload: small, marker: false });
    const fragments = payloads.slice(1);
    expect(fragments.map((fragment) => fragment.payload[1]! & 0xc0)).toEqual([
      0x80, 0, 0x40,
    ]);
    expect(fragments.every((fragment) => fragment.payload[0] === 0x7c)).toBe(
      true,
    );
    expect(fragments.map((fragment) => fragment.marker)).toEqual([
      false,
      false,
      true,
    ]);
    expect(
      fragments.reduce(
        (total, fragment) => total + fragment.payload.length - 2,
        0,
      ),
    ).toBe(24);
  });

  test("counts picture loss indications in compound RTCP", () => {
    const receiverReport = [0x80, 201, 0, 1, 0, 0, 0, 1];
    const pli = [0x81, 206, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2];
    expect(countPictureLoss(Buffer.from([...receiverReport, ...pli]))).toBe(1);
  });

  test("counts full intra requests as picture loss", () => {
    const fir = [
      0x84, 206, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0,
    ];
    const nack = [0x81, 205, 0, 3, 0, 0, 0, 1, 0, 0, 0, 2, 0, 5, 0, 0];
    expect(countPictureLoss(Buffer.from([...fir, ...nack]))).toBe(1);
  });
});

describe("audio helpers", () => {
  test("the sample queue reads across chunks", () => {
    const queue = new SampleQueue();
    queue.push(Float32Array.from([1, 1, 2, 2]));
    queue.push(Float32Array.from([3, 3]));
    const out = new Float32Array(6);
    expect(queue.read(out, 3)).toBe(3);
    expect([...out]).toEqual([1, 1, 2, 2, 3, 3]);
    expect(queue.frames).toBe(0);
  });

  test("the compressor follows Chromium's default curve", () => {
    const compressor = new Compressor();
    expect(compressor.curve(-60)).toBe(-60);
    // The knee runs from the threshold up to +6 dB, so full scale is still
    // inside it.
    expect(compressor.curve(0)).toBeCloseTo(-6.06, 1);
    const silence = new Float32Array(960);
    expect(Math.max(...compressor.process(silence))).toBe(0);
  });

  // Peaks of a steady 200 Hz tone after one second, measured from Chromium's
  // own DynamicsCompressorNode with its defaults in an OfflineAudioContext.
  test.each([
    [-40, -36.34],
    [-30, -26.34],
    [-24, -20.34],
    [-18, -14.57],
    [-12, -9.4],
    [-6, -5.15],
    [-3, -3.51],
    [0, -2.26],
  ])("a %d dBFS tone comes out at %d dBFS, as in Chromium", (input, output) => {
    const compressor = new Compressor();
    const gain = 10 ** (input / 20);
    const samples = new Float32Array(48_000 * 4);
    for (let frame = 0; frame < 48_000 * 2; frame++)
      samples[frame * 2] = samples[frame * 2 + 1] =
        gain * Math.sin((2 * Math.PI * 200 * frame) / 48_000);
    for (let offset = 0; offset < samples.length; offset += 1920)
      compressor.process(samples.subarray(offset, offset + 1920));
    const peak = Math.max(...samples.subarray(48_000 * 2).map(Math.abs));
    expect(20 * Math.log10(peak)).toBeCloseTo(output, 1);
  });

  test("the compressor looks ahead, so a sudden loud hit does not clip", () => {
    const compressor = new Compressor();
    const samples = new Float32Array(48_000 * 4);
    for (let frame = 0; frame < 48_000 * 2; frame++)
      samples[frame * 2] = samples[frame * 2 + 1] =
        (frame < 48_000 ? 0.03 : 0.9) *
        Math.sin((2 * Math.PI * 100 * frame) / 48_000);
    compressor.process(samples);
    expect(Math.max(...samples.map(Math.abs))).toBeLessThan(1);
    // Six milliseconds of delay, as in Chromium.
    const impulse = new Float32Array(960 * 2);
    impulse[0] = impulse[1] = 0.001;
    new Compressor().process(impulse);
    expect(impulse.findIndex((sample) => sample !== 0)).toBe(288 * 2);
  });
});

describe("native session messages", () => {
  const paths: Record<string, string> = { a: "/data/media/a.opus" };
  const audioPath = (entryId: string) => paths[entryId];

  test("play and preload decode local files when the entry has one", () => {
    expect(
      withLocalAudio(
        { type: "play", entryId: "a", url: "http://x/a" },
        audioPath,
      ),
    ).toEqual({ type: "play", entryId: "a", url: "/data/media/a.opus" });
    expect(
      withLocalAudio(
        {
          type: "preload",
          entries: [
            { entryId: "a", url: "http://x/a" },
            { entryId: "b", url: "http://x/b" },
          ],
        },
        audioPath,
      ),
    ).toEqual({
      type: "preload",
      entries: [
        { entryId: "a", url: "/data/media/a.opus" },
        { entryId: "b", url: "http://x/b" },
      ],
    });
  });

  test("other messages pass through untouched", () => {
    const message = { type: "seek", seconds: 3 };
    expect(withLocalAudio(message, audioPath)).toBe(message);
  });
});

describe("native media diagnostics", () => {
  test("keep recent lines at every level and media events", () => {
    const messages: unknown[] = [];
    const session = new NativeMediaSession((message) => messages.push(message));
    const receive = (line: unknown) =>
      Reflect.get(session, "receive").call(session, JSON.stringify(line), {
        debug() {},
        info() {},
        warn() {},
        error() {},
        trace() {},
      });
    receive({
      log: { level: "debug", event: "chime_ice", message: "Candidate" },
    });
    receive({
      log: { level: "warn", event: "chime_reconnect", message: "Reconnecting" },
    });
    receive({ type: "playback_position", details: { seconds: 3 } });
    receive({ type: "fatal", details: { message: "relay lost" } });
    expect(messages).toEqual([
      { type: "playback_position", details: { seconds: 3 } },
      { type: "fatal", details: { message: "relay lost" } },
    ]);
    expect(session.diagnostics().map(({ at: _at, ...entry }) => entry)).toEqual(
      [
        { level: "debug", event: "chime_ice", message: "Candidate" },
        { level: "warn", event: "chime_reconnect", message: "Reconnecting" },
        {
          level: "error",
          event: "media_fatal",
          message: "fatal",
          details: { message: "relay lost" },
        },
      ],
    );
  });

  test("keep only the most recent entries", () => {
    const session = new NativeMediaSession(() => {});
    const receive = Reflect.get(session, "receive").bind(session);
    const quiet = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
    for (let index = 0; index < 250; index++)
      receive(
        JSON.stringify({
          log: { level: "debug", event: "tick", message: String(index) },
        }),
        quiet,
      );
    const kept = session.diagnostics();
    expect(kept).toHaveLength(200);
    expect(kept[0]).toMatchObject({ message: "50" });
    expect(kept.at(-1)).toMatchObject({ message: "249" });
  });
});

describe("native media failures", () => {
  test("count crashes and lost connections, not a Huddle that is over", () => {
    const ended = (code?: number) => ({ type: "ended", details: { code } });
    expect(nativeMediaFailed({ type: "fatal" })).toBeTrue();
    expect(nativeMediaFailed(ended(statusCodes.taskFailed))).toBeTrue();
    expect(
      nativeMediaFailed(ended(statusCodes.signalingClosedUnexpectedly)),
    ).toBeTrue();
    expect(nativeMediaFailed(ended())).toBeTrue();
    expect(nativeMediaFailed(ended(statusCodes.left))).toBeFalse();
    expect(nativeMediaFailed(ended(statusCodes.meetingEnded))).toBeFalse();
    expect(nativeMediaFailed(ended(statusCodes.attendeeRemoved))).toBeFalse();
    expect(
      nativeMediaFailed(ended(statusCodes.joinedFromAnotherDevice)),
    ).toBeFalse();
    expect(nativeMediaFailed({ type: "stalled" })).toBeFalse();
    expect(nativeMediaFailed({ type: "joined" })).toBeFalse();
  });
});
