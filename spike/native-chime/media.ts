// Throwaway spike: native Chime attendee that sends audio (+ optional video)
// and logs speech signals. Usage: bun media.ts [--video] [--seconds N] [--channel C]
import nodeDataChannel from "node-datachannel";
import { createEncoder, Application, Signal } from "libopus-wasm";
import { loadEnv, redact, roomsJoin, Signaling } from "./chime";
import { writeFileSync } from "node:fs";

const { PeerConnection, Audio, Video } = nodeDataChannel as any;
loadEnv(process.env.SPIKE_ENV ?? new URL("./.env", import.meta.url).pathname);
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : (process.argv[i + 1] ?? "true");
};
const withVideo = process.argv.includes("--video");
const withAudio = !process.argv.includes("--no-audio");
const seconds = Number(arg("seconds") ?? 60);
const channel = arg("channel") ?? "C0BPVPVLQ4D";
const t0 = performance.now();
const stamp = () =>
  `[${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
const say = (...a: unknown[]) => console.log(stamp(), ...a);

// ---- join + signaling ------------------------------------------------------
const { meeting, attendee } = await roomsJoin(channel);
const selfId: string = attendee.AttendeeId;
say("rooms.join ok, attendee", selfId.slice(0, 8));
const sig = new Signaling(meeting, attendee);
await sig.connect();
sig.join();
const ack = await sig.wait("JOIN_ACK");
await sig.wait("INDEX").catch(() => {});
const pings = sig.startPings();
const turn = ack.joinack.turn_credentials;
say("JOIN_ACK ok, turn uris", turn.uris.join(" "));

// ---- speech signals (what ducking needs) -----------------------------------
const streamToAttendee = new Map<number, string>();
const lastPrinted = new Map<string, number>();
const speech = {
  presenceEvents: 0,
  volumeFrames: 0,
  nonZeroVolumes: 0,
  muteEvents: 0,
};
sig.on((type, f) => {
  if (type === "AUDIO_STREAM_ID_INFO") {
    for (const s of f.audio_stream_id_info.streams ?? []) {
      if (s.attendee_id) {
        streamToAttendee.set(s.audio_stream_id, s.attendee_id);
        speech.presenceEvents++;
        say(
          `presence: ${s.attendee_id === selfId ? "self" : s.attendee_id.slice(0, 8)} joined (stream ${s.audio_stream_id})${s.muted ? " muted" : ""}`,
        );
      } else if (s.muted !== undefined) {
        speech.muteEvents++;
        say(
          `mute: ${streamToAttendee.get(s.audio_stream_id)?.slice(0, 8)} muted=${s.muted}`,
        );
      } else {
        speech.presenceEvents++;
        say(
          `presence: stream ${s.audio_stream_id} left${s.dropped ? " (dropped)" : ""}`,
        );
      }
    }
  } else if (type === "AUDIO_METADATA") {
    speech.volumeFrames++;
    for (const a of f.audio_metadata.attendee_states ?? []) {
      const id = streamToAttendee.get(a.audio_stream_id);
      if (!id || id === selfId || a.volume === undefined) continue;
      const level = Math.min(1, Math.max(0, (-a.volume + 42) / 28));
      if (level > 0) speech.nonZeroVolumes++;
      const now = Date.now();
      if (level > 0.05 && now - (lastPrinted.get(id) ?? 0) > 1000) {
        lastPrinted.set(id, now);
        say(
          `volume: ${id.slice(0, 8)} ${"#".repeat(Math.round(level * 20)).padEnd(20)} ${level.toFixed(2)}`,
        );
      }
    }
  } else if (type === "AUDIO_STATUS" || f?.error) {
    say(type, JSON.stringify(redact(f.audio_status ?? f.error)));
  } else if (type === "CLOSED") {
    say("signaling closed", JSON.stringify(f));
  }
});

// ---- peer connection -------------------------------------------------------
const iceServers = turn.uris.map((uri: string) => {
  const [, scheme, host, port, transport] = uri.match(
    /^(turns?):([^:?]+):(\d+)\?transport=(\w+)/,
  )!;
  const relayType =
    scheme === "turns"
      ? "TurnTls"
      : transport === "tcp"
        ? "TurnTcp"
        : "TurnUdp";
  return {
    hostname: host,
    port: Number(port),
    username: turn.username,
    password: turn.password,
    relayType,
  };
});
const pc = new PeerConnection("chime", {
  iceServers,
  iceTransportPolicy: "relay",
});
pc.onStateChange((s: string) => say("pc state", s));
pc.onIceStateChange((s: string) => say("ice state", s));

const audioSsrc = (Math.random() * 2 ** 31) >>> 0;
const videoSsrc = (Math.random() * 2 ** 31) >>> 0;
const audio = new Audio("0", "SendRecv");
audio.addOpusCodec(
  111,
  "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000",
);
audio.addSSRC(audioSsrc, "huddlefm", "huddlefm", "audio");
const audioTrack = pc.addTrack(audio);
let videoTrack: any;
if (withVideo) {
  const video = new Video("1", "SendRecv");
  video.addH264Codec(
    102,
    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  );
  video.addSSRC(videoSsrc, "huddlefm", "huddlefm", "video");
  videoTrack = pc.addTrack(video);
}

const gathered = new Promise<void>((resolve) =>
  pc.onGatheringStateChange((s: string) => s === "complete" && resolve()),
);
pc.setLocalDescription();
await Promise.race([gathered, Bun.sleep(10000)]);
const offer: string = pc.localDescription().sdp;
const relayCount = (offer.match(/typ relay/g) ?? []).length;
say("offer ready, relay candidates:", relayCount);
if (!relayCount)
  say(
    "WARNING: no relay candidates; TURN is unreachable from this network (UDP 3478 / TLS 443 to *.chime.aws)",
  );

sig.send("SUBSCRIBE", {
  sub: {
    duplex: withVideo ? 3 : 3,
    send_streams: [
      {
        media_type: 1,
        track_label: "AmazonChimeExpressAudio",
        stream_id: 1,
        group_id: 1,
        framerate: 15,
        max_bitrate_kbps: 600,
        avg_bitrate_bps: 400000,
        attendee_id: selfId,
      },
      ...(withVideo
        ? [
            {
              media_type: 2,
              track_label: "AmazonChimeExpressVideo",
              stream_id: 2,
              group_id: 2,
              framerate: 15,
              max_bitrate_kbps: 1000,
              attendee_id: selfId,
              width: 720,
              height: 720,
            },
          ]
        : []),
    ],
    receive_stream_ids: withVideo ? [0] : [],
    sdp_offer: offer,
    audio_host: meeting.MediaPlacement.AudioHostUrl,
    audio_checkin: false,
    audio_muted: false,
  },
});
const subAck = await sig.wait("SUBSCRIBE_ACK");
if (!subAck.suback?.sdp_answer || subAck.error) {
  say("SUBSCRIBE rejected:", JSON.stringify(subAck.error ?? subAck));
  sig.send("LEAVE", { leave: {} });
  await sig.wait("LEAVE_ACK", 5000).catch(() => {});
  process.exit(1);
}
const answer: string = subAck.suback.sdp_answer;
writeFileSync(
  new URL("./last-sdp.txt", import.meta.url).pathname,
  `--- offer\n${offer.replace(/ice-pwd:\S+/g, "ice-pwd:<r>")}\n--- answer\n${answer.replace(/ice-pwd:\S+/g, "ice-pwd:<r>")}`,
);
say(
  "SUBSCRIBE_ACK ok, allocations",
  JSON.stringify(subAck.suback.allocations ?? []),
);
pc.setRemoteDescription(
  answer
    .split("\r\n")
    .filter((l) => !/typ srflx/.test(l))
    .join("\r\n"),
  "answer",
);
const opusPt = Number(answer.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1] ?? 111);
const h264Pt = Number(answer.match(/a=rtpmap:(\d+) H264\/90000/i)?.[1] ?? 102);

// ---- RTP helpers -----------------------------------------------------------
function rtp(
  pt: number,
  seq: number,
  ts: number,
  ssrc: number,
  payload: Uint8Array,
  marker = false,
) {
  const p = Buffer.alloc(12 + payload.length);
  p[0] = 0x80;
  p[1] = (marker ? 0x80 : 0) | pt;
  p.writeUInt16BE(seq & 0xffff, 2);
  p.writeUInt32BE(ts >>> 0, 4);
  p.writeUInt32BE(ssrc, 8);
  p.set(payload, 12);
  return p;
}
function senderReport(
  ssrc: number,
  rtpTs: number,
  packets: number,
  octets: number,
) {
  const p = Buffer.alloc(28);
  p[0] = 0x80;
  p[1] = 200;
  p.writeUInt16BE(6, 2);
  p.writeUInt32BE(ssrc, 4);
  const ntp = Date.now() / 1000 + 2208988800;
  p.writeUInt32BE(Math.floor(ntp) >>> 0, 8);
  p.writeUInt32BE(Math.floor((ntp % 1) * 2 ** 32) >>> 0, 12);
  p.writeUInt32BE(rtpTs >>> 0, 16);
  p.writeUInt32BE(packets >>> 0, 20);
  p.writeUInt32BE(octets >>> 0, 24);
  return p;
}

const stats = {
  audioSent: 0,
  audioBytes: 0,
  videoFrames: 0,
  videoPackets: 0,
  videoBytes: 0,
  inAudioRtp: 0,
  inAudioRtcp: 0,
  inVideoRtcp: 0,
  pli: 0,
  remb: 0,
  nack: 0,
};
const rtcpKinds = (buf: Buffer) => {
  let off = 0;
  while (off + 4 <= buf.length) {
    const pt = buf[off + 1],
      fmt = buf[off] & 0x1f;
    if (pt === 206 && fmt === 1) stats.pli++;
    if (pt === 206 && fmt === 15) stats.remb++;
    if (pt === 205 && fmt === 1) stats.nack++;
    off += (buf.readUInt16BE(off + 2) + 1) * 4;
  }
};
audioTrack.onMessage((m: Buffer) => {
  if (m[1] >= 192 && m[1] <= 223) {
    stats.inAudioRtcp++;
    rtcpKinds(m);
  } else stats.inAudioRtp++;
});
videoTrack?.onMessage((m: Buffer) => {
  if (m[1] >= 192 && m[1] <= 223) {
    stats.inVideoRtcp++;
    rtcpKinds(m);
  }
});

// ---- audio: stereo test melody, Opus 128k ----------------------------------
const opus = await createEncoder({
  application: Application.Audio,
  signal: Signal.Music,
  bitrate: 128000,
  complexity: 10,
  vbr: true,
} as any);
const notes = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63]; // C E G C' G E
let sample = 0,
  aSeq = 0;
function audioFrame() {
  const pcm = new Int16Array(960 * 2);
  for (let i = 0; i < 960; i++, sample++) {
    const t = sample / 48000;
    const note = notes[Math.floor(t / 0.5) % notes.length];
    const env = Math.min(1, (t % 0.5) * 40) * Math.exp(-3 * (t % 0.5));
    const v = Math.sin(2 * Math.PI * note * t) * env * 9000;
    const pan = Math.floor(t / 4) % 2 === 0 ? 0 : 1; // alternate L/R-biased every 4 s
    pcm[2 * i] = v * (pan ? 0.35 : 1);
    pcm[2 * i + 1] = v * (pan ? 1 : 0.35);
  }
  return opus.encode(pcm);
}
let audioTimer: Timer | undefined;
let audioStart = 0;
function startAudio() {
  audioStart = performance.now();
  audioTimer = setInterval(() => {
    const due = Math.floor((performance.now() - audioStart) / 20);
    while (aSeq <= due) {
      const payload = audioFrame();
      if (
        audioTrack.sendMessageBinary(
          rtp(opusPt, aSeq, aSeq * 960, audioSsrc, payload),
        )
      ) {
        stats.audioSent++;
        stats.audioBytes += payload.length;
      }
      aSeq++;
    }
  }, 10);
}

// ---- video: ffmpeg test pattern -> H.264 baseline -> RTP -------------------
let ffmpeg: ReturnType<typeof Bun.spawn> | undefined;
async function startVideo() {
  ffmpeg = Bun.spawn(
    [
      "ffmpeg",
      "-loglevel",
      "error",
      "-re",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=720x720:rate=15",
      "-vf",
      "drawtext=text='HuddleFM native spike %{localtime\\:%T}':fontcolor=white:fontsize=36:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=h-80",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "baseline",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      "800k",
      "-maxrate",
      "1000k",
      "-bufsize",
      "500k",
      "-g",
      "15",
      "-bf",
      "0",
      "-x264-params",
      "aud=1:repeat-headers=1",
      "-f",
      "h264",
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  let buf = Buffer.alloc(0),
    vSeq = 0,
    frame = 0;
  const nals: Buffer[] = [];
  const flushAu = () => {
    const au = nals.splice(0).filter((n) => (n[0] & 0x1f) !== 9);
    if (!au.length) return;
    const ts = frame++ * 6000;
    for (let n = 0; n < au.length; n++) {
      const nal = au[n],
        last = n === au.length - 1;
      if (nal.length <= 1150) {
        videoTrack.sendMessageBinary(
          rtp(h264Pt, vSeq++, ts, videoSsrc, nal, last),
        );
        stats.videoPackets++;
        stats.videoBytes += nal.length;
      } else {
        const hdr = nal[0];
        let off = 1;
        while (off < nal.length) {
          const chunk = nal.subarray(off, off + 1150);
          const start = off === 1,
            end = off + chunk.length >= nal.length;
          const fu = Buffer.concat([
            Buffer.from([
              (hdr & 0xe0) | 28,
              (start ? 0x80 : 0) | (end ? 0x40 : 0) | (hdr & 0x1f),
            ]),
            chunk,
          ]);
          videoTrack.sendMessageBinary(
            rtp(h264Pt, vSeq++, ts, videoSsrc, fu, last && end),
          );
          stats.videoPackets++;
          stats.videoBytes += fu.length;
          off += chunk.length;
        }
      }
    }
    stats.videoFrames++;
    lastVideoTs = ts;
  };
  for await (const chunk of ffmpeg.stdout as ReadableStream<Uint8Array>) {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
    // split on start codes, keep the trailing partial NAL in buf
    const starts: number[] = [];
    for (let i = 0; i + 3 < buf.length; i++) {
      if (
        buf[i] === 0 &&
        buf[i + 1] === 0 &&
        (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))
      ) {
        starts.push(i);
        i += 2;
      }
    }
    for (let s = 0; s + 1 < starts.length; s++) {
      const begin = starts[s] + (buf[starts[s] + 2] === 1 ? 3 : 4);
      let end = starts[s + 1];
      const nal = buf.subarray(begin, end);
      if ((nal[0] & 0x1f) === 9) flushAu();
      nals.push(Buffer.from(nal));
    }
    if (starts.length) buf = buf.subarray(starts[starts.length - 1]);
  }
}
let lastVideoTs = 0;

// ---- run ---------------------------------------------------------------------
let started = false;
const begin = () => {
  if (started) return;
  started = true;
  say(
    "media connected: sending",
    [withAudio && "audio", withVideo && "video"].filter(Boolean).join(" + "),
  );
  if (withAudio) startAudio();
  if (withVideo) startVideo().catch((e) => say("video error", String(e)));
};
audioTrack.onOpen(begin);
pc.onStateChange((s: string) => s === "connected" && begin());

const srTimer = setInterval(() => {
  if (!started) return;
  if (withAudio)
    audioTrack.sendMessageBinary(
      senderReport(audioSsrc, aSeq * 960, stats.audioSent, stats.audioBytes),
    );
  if (withVideo)
    videoTrack.sendMessageBinary(
      senderReport(
        videoSsrc,
        lastVideoTs,
        stats.videoPackets,
        stats.videoBytes,
      ),
    );
}, 1000);
const statTimer = setInterval(() => {
  say(
    "stats",
    JSON.stringify({
      ...stats,
      audioKbps: Math.round(
        (stats.audioBytes * 8) /
          Math.max(1, (performance.now() - audioStart) / 1000) /
          1000,
      ),
      ...speech,
    }),
  );
}, 10000);

async function shutdown(reason: string) {
  say("shutting down:", reason);
  clearInterval(audioTimer);
  clearInterval(srTimer);
  clearInterval(statTimer);
  clearInterval(pings);
  ffmpeg?.kill();
  say("final", JSON.stringify({ ...stats, ...speech }));
  try {
    sig.send("LEAVE", { leave: {} });
    await sig.wait("LEAVE_ACK", 5000);
    say("LEAVE_ACK");
  } catch (e) {
    say(String(e));
  }
  writeFileSync(
    new URL("./last-frames.json", import.meta.url).pathname,
    JSON.stringify(
      redact(sig.log.filter((l) => l.type !== "AUDIO_METADATA")),
      null,
      1,
    ),
  );
  pc.close();
  (nodeDataChannel as any).cleanup();
  process.exit(0);
}
setTimeout(() => shutdown("time limit"), seconds * 1000);
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
