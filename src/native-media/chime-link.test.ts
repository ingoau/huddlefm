import { afterEach, expect, test } from "bun:test";
import nodeDataChannel from "node-datachannel";
import { ChimeLink } from "./chime-link.ts";
import { decodeFrame, encodeFrame } from "./signaling.ts";

const { PeerConnection } = nodeDataChannel;

type Subscribe = { duplex: string; videoDirection: string | undefined };

/**
 * A stand-in for Chime: a signaling WebSocket that answers JOIN and SUBSCRIBE,
 * with a real WebRTC peer behind it on loopback that counts the RTP it gets.
 */
function fakeChime(afterJoin: Uint8Array[] = []) {
  const received = { audio: 0, video: 0 };
  const joins: number[] = [];
  const subscribes: Subscribe[] = [];
  let peer: InstanceType<typeof PeerConnection> | undefined;

  const answer = (offer: string) =>
    new Promise<string>((resolve) => {
      if (!peer) {
        peer = new PeerConnection("fake-chime", { iceServers: [] });
        peer.onTrack((track) =>
          track.onMessage((packet) => {
            if ((packet[1] ?? 0) >= 192 && (packet[1] ?? 0) <= 223) return;
            if (track.mid() === "0") received.audio++;
            else received.video++;
          }),
        );
      }
      const current = peer;
      let answered = false;
      const finish = () => {
        if (answered) return;
        answered = true;
        resolve(current.localDescription()!.sdp);
      };
      current.onLocalDescription((_sdp, type) => {
        if (type !== "answer") return;
        if (current.gatheringState() === "complete") finish();
      });
      current.onGatheringStateChange((state) => {
        if (state === "complete") finish();
      });
      // Chime is ICE-lite: it never starts connectivity checks, the client
      // does once it has the answer. Without the client's candidates this
      // peer cannot start them either, so it cannot begin DTLS before the
      // client knows its fingerprint.
      current.setRemoteDescription(
        offer.replace(/^a=candidate:.*\r\n/gm, ""),
        "offer",
      );
    });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      return server.upgrade(request, {
        headers: { "Sec-WebSocket-Protocol": "_aws_wt_session" },
      })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      async message(socket, data) {
        const frame = decodeFrame(new Uint8Array(data as Buffer)) as any;
        if (frame.type === "JOIN") {
          joins.push(Date.now());
          socket.send(
            encodeFrame("JOIN_ACK", {
              joinack: {
                turn_credentials: { username: "u", password: "p", uris: [] },
              },
            }),
          );
          socket.send(encodeFrame("INDEX", { index: { num_participants: 2 } }));
          for (const frame of afterJoin) socket.send(frame);
        }
        if (frame.type === "SUBSCRIBE") {
          const offer: string = frame.sub.sdp_offer;
          const videoSection = offer.split(/^m=/m)[2] ?? "";
          subscribes.push({
            duplex: frame.sub.duplex,
            videoDirection: videoSection.match(
              /a=(sendrecv|sendonly|recvonly|inactive)/,
            )?.[1],
          });
          socket.send(
            encodeFrame("SUBSCRIBE_ACK", {
              suback: {
                duplex: frame.sub.duplex,
                sdp_answer: await answer(offer),
              },
            }),
          );
        }
        if (frame.type === "LEAVE") socket.send(encodeFrame("LEAVE_ACK"));
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}/control`,
    received,
    joins,
    subscribes,
    stop() {
      peer?.close();
      server.stop(true);
    },
  };
}

let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

async function until(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await Bun.sleep(20);
  }
}

test("a display toggle renegotiates video on the live connection", async () => {
  const chime = fakeChime();
  cleanup.push(() => chime.stop());
  let videoChanges = 0;
  let reconnects = 0;
  const link = new ChimeLink(
    { MediaPlacement: { SignalingUrl: chime.url, AudioHostUrl: "audio" } },
    { AttendeeId: "bot", JoinToken: "token" },
    true,
    {
      log: () => {},
      onSignaling: () => {},
      onFrame: () => {},
      onConnected: (reconnect) => {
        if (reconnect) reconnects++;
      },
      onVideoChanged: () => videoChanges++,
      onPictureLoss: () => {},
      onTerminal: (code, reason) => {
        throw new Error(`terminal ${code}: ${reason}`);
      },
    },
    false,
  );
  cleanup.push(() => link.leave());
  await link.start();
  expect(link.sendingVideo).toBe(true);

  // Stream audio and a video access unit the way main.ts does.
  const payload = new Uint8Array(40).fill(1);
  const nal = Buffer.from([0x65, 1, 2, 3]);
  const pump = setInterval(() => {
    link.sendAudio(payload);
    link.sendVideo([nal], Date.now() * 90);
  }, 20);
  cleanup.push(() => clearInterval(pump));
  await until(() => chime.received.audio > 10 && chime.received.video > 10);

  link.setVideo(false);
  await until(() => videoChanges === 1);
  // Dropped node-datachannel track wrappers close their track when they are
  // collected, so collect now instead of whenever the GC gets to it.
  Bun.gc(true);
  expect(link.sendingVideo).toBe(false);
  const audioAtOff = chime.received.audio;
  const videoAtOff = chime.received.video;
  await Bun.sleep(300);
  expect(chime.received.audio).toBeGreaterThan(audioAtOff + 5);
  expect(chime.received.video).toBe(videoAtOff);

  link.setVideo(true);
  await until(() => videoChanges === 2);
  Bun.gc(true);
  expect(link.sendingVideo).toBe(true);
  await until(() => chime.received.video > videoAtOff + 5);

  // One JOIN for the whole session: the toggles never rebuilt the connection.
  expect(chime.joins).toHaveLength(1);
  expect(reconnects).toBe(0);
  expect(chime.subscribes).toEqual([
    { duplex: "DUPLEX", videoDirection: "sendrecv" },
    { duplex: "RX", videoDirection: "inactive" },
    { duplex: "DUPLEX", videoDirection: "sendrecv" },
  ]);
}, 30_000);

test("frames sent before media connects still reach the listener", async () => {
  // Chime lists the attendees already in the meeting once, right after JOIN;
  // missing it leaves their volumes unattributed, so nobody ever ducks.
  const chime = fakeChime([
    encodeFrame("AUDIO_STREAM_ID_INFO", {
      audio_stream_id_info: {
        streams: [{ audio_stream_id: 2, attendee_id: "person" }],
      },
    }),
  ]);
  cleanup.push(() => chime.stop());
  const events: string[] = [];
  const link = new ChimeLink(
    { MediaPlacement: { SignalingUrl: chime.url, AudioHostUrl: "audio" } },
    { AttendeeId: "bot", JoinToken: "token" },
    false,
    {
      log: () => {},
      onSignaling: () => events.push("signaling"),
      onFrame: (frame) => {
        const attendees = frame.audio_stream_id_info?.streams?.map(
          (stream) => stream.attendee_id,
        );
        if (attendees) events.push(`streams ${attendees.join(",")}`);
      },
      onConnected: () => events.push("connected"),
      onVideoChanged: () => {},
      onPictureLoss: () => {},
      onTerminal: (code, reason) => {
        throw new Error(`terminal ${code}: ${reason}`);
      },
    },
    false,
  );
  cleanup.push(() => link.leave());
  await link.start();
  expect(events).toEqual(["signaling", "streams person", "connected"]);
}, 30_000);
