// Throwaway spike: native Chime attendee that sends audio (+ optional video),
// logs speech signals and reconnects after a drop.
// Usage: bun media.ts [--video] [--no-audio] [--seconds N] [--channel C]
//                     [--ducking off|gentle|strong]
import nodeDataChannel from "node-datachannel";
import { createEncoder, Application, Signal } from "libopus-wasm";
import { loadEnv, redact, roomsJoin, Signaling } from "./chime";
import { writeFileSync } from "node:fs";
// The bot's own ducking policy, used read-only so the spike ducks exactly like
// the browser backend does.
import {
  DuckingController,
  parseDuckingMode,
  type DuckDecision,
} from "../../src/ducking";

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
const duckingMode = parseDuckingMode(arg("ducking"));
const t0 = performance.now();
const stamp = () =>
  `[${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
const say = (...a: unknown[]) => console.log(stamp(), ...a);

// ---- stats -------------------------------------------------------------------
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
  sendErrors: 0,
  reconnects: 0,
};
const speech = {
  presenceEvents: 0,
  volumeFrames: 0,
  nonZeroVolumes: 0,
  muteEvents: 0,
  ducks: 0,
};

// ---- join ----------------------------------------------------------------------
let { meeting, attendee } = await roomsJoin(channel);
let selfId: string = attendee.AttendeeId;
const audioSessionId = Math.floor(Math.random() * 2 ** 32);
say(
  "rooms.join ok, attendee",
  selfId.slice(0, 8),
  "capabilities",
  JSON.stringify(attendee.Capabilities),
);

// ---- ducking ---------------------------------------------------------------
// Mirrors applyDuck() in src/media-page.ts, with the Web Audio gain ramp
// replaced by a linear ramp applied to the PCM before encoding.
const ducking = new DuckingController(duckingMode);
const duckRamp = { from: 1, to: 1, start: 0, ms: 0 };
let duckTimer: Timer | undefined;
function duckGainAt(t: number) {
  const { from, to, start, ms } = duckRamp;
  if (ms <= 0 || t >= start + ms) return to;
  return from + ((to - from) * (t - start)) / ms;
}
function applyDuck(decision: DuckDecision | undefined) {
  if (!decision) return;
  clearTimeout(duckTimer);
  duckTimer = undefined;
  const now = performance.now();
  if (decision.gain !== duckRamp.to) {
    if (decision.gain < duckRamp.to) speech.ducks++;
    say(
      `duck: ${decision.gain < duckRamp.to ? "down" : "up"} to ${decision.gain} over ${decision.rampSeconds}s (speaking ${ducking.speaking})`,
    );
  }
  // Hold at the value the ramp actually reached, like cancelAndHoldAtTime().
  Object.assign(duckRamp, {
    from: duckGainAt(now),
    to: decision.gain,
    start: now,
    ms: decision.rampSeconds * 1000,
  });
  if (decision.recheckMs !== undefined)
    duckTimer = setTimeout(
      () => applyDuck(ducking.tick(Date.now())),
      decision.recheckMs,
    );
}

// ---- speech signals (what ducking needs) -----------------------------------
const streamToAttendee = new Map<number, string>();
const lastPrinted = new Map<string, number>();
function onSpeechFrame(type: string, f: any) {
  if (type === "AUDIO_STREAM_ID_INFO") {
    for (const s of f.audio_stream_id_info.streams ?? []) {
      if (s.attendee_id) {
        streamToAttendee.set(s.audio_stream_id, s.attendee_id);
        if (s.attendee_id !== selfId && s.muted !== undefined)
          applyDuck(ducking.volume(s.attendee_id, null, s.muted, Date.now()));
        speech.presenceEvents++;
        say(
          `presence: ${s.attendee_id === selfId ? "self" : s.attendee_id.slice(0, 8)} joined (stream ${s.audio_stream_id})${s.muted ? " muted" : ""}`,
        );
      } else if (s.muted !== undefined) {
        const id = streamToAttendee.get(s.audio_stream_id);
        if (id && id !== selfId)
          applyDuck(ducking.volume(id, null, s.muted, Date.now()));
        speech.muteEvents++;
        say(
          `mute: ${streamToAttendee.get(s.audio_stream_id)?.slice(0, 8)} muted=${s.muted}`,
        );
      } else {
        const id = streamToAttendee.get(s.audio_stream_id);
        if (id && id !== selfId) applyDuck(ducking.leave(id, Date.now()));
        speech.presenceEvents++;
        say(
          `presence: stream ${s.audio_stream_id} left${s.dropped ? " (dropped)" : ""}`,
        );
      }
    }
  } else if (type === "AUDIO_METADATA") {
    speech.volumeFrames++;
    // Same normalisation as the JS SDK's DefaultVolumeIndicatorAdapter
    // (-42 dB..-14 dB -> 0..1). Attendees missing from a frame that carries
    // volumes are implicitly silent, which is what lets the duck release.
    const levels = new Map<string, number>();
    let hasVolumes = false;
    for (const a of f.audio_metadata.attendee_states ?? []) {
      const id = streamToAttendee.get(a.audio_stream_id);
      if (!id || a.volume === undefined) continue;
      hasVolumes = true;
      levels.set(id, Math.min(1, Math.max(0, (-a.volume + 42) / 28)));
    }
    if (!hasVolumes) return;
    const now = Date.now();
    for (const id of new Set(streamToAttendee.values())) {
      if (id === selfId) continue;
      const level = levels.get(id) ?? 0;
      applyDuck(ducking.volume(id, level, null, now));
      if (level > 0) speech.nonZeroVolumes++;
      if (level > 0.05 && now - (lastPrinted.get(id) ?? 0) > 1000) {
        lastPrinted.set(id, now);
        say(
          `volume: ${id.slice(0, 8)} ${"#".repeat(Math.round(level * 20)).padEnd(20)} ${level.toFixed(2)}`,
        );
      }
    }
  } else if (type === "AUDIO_STATUS" || f?.error) {
    say(type, JSON.stringify(redact(f.audio_status ?? f.error)));
  }
}

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

// ---- session: signaling + peer connection, re-created on reconnect ----------
type Session = {
  sig: Signaling;
  pc: any;
  audioTrack: any;
  videoTrack: any;
  pings: Timer;
  opusPt: number;
  h264Pt: number;
  open: boolean;
  dead: boolean;
  lastInbound: number;
};
let session: Session | undefined;
const frameLog: Signaling["log"] = [];
let undecodable = 0; // from torn-down sessions
const audioSsrc = (Math.random() * 2 ** 31) >>> 0;
const videoSsrc = (Math.random() * 2 ** 31) >>> 0;

function iceServersFrom(turn: any) {
  return turn.uris.map((uri: string) => {
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
}

// Tears down whatever a failed attempt managed to build before rethrowing.
async function connect(): Promise<Session> {
  const sig = new Signaling(meeting, attendee, audioSessionId);
  const built: { s?: Session } = {};
  try {
    return await connectWith(sig, built);
  } catch (e) {
    if (built.s) teardown(built.s);
    else
      try {
        sig.ws?.close();
      } catch {}
    throw e;
  }
}

async function connectWith(
  sig: Signaling,
  built: { s?: Session },
): Promise<Session> {
  await sig.connect();
  sig.join();
  const ack = await sig.wait("JOIN_ACK");
  const index = await sig.wait("INDEX").catch(() => undefined);
  say(
    "INDEX",
    JSON.stringify({
      at_capacity: index?.index?.at_capacity,
      sources: index?.index?.sources?.length ?? 0,
      num_participants: index?.index?.num_participants,
    }),
  );
  const turn = ack.joinack.turn_credentials;

  const pc = new PeerConnection("chime", {
    iceServers: iceServersFrom(turn),
    iceTransportPolicy: "relay",
  });
  const audio = new Audio("0", "SendRecv");
  audio.addOpusCodec(
    111,
    "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000",
  );
  audio.addSSRC(audioSsrc, "huddlefm", "huddlefm", "audio");
  const audioTrack = pc.addTrack(audio);
  // Like amazon-chime-sdk-js, always offer a video m-line: inactive when not
  // sending, so the server can set up the video session either way.
  const video = new Video("1", withVideo ? "SendRecv" : "Inactive");
  video.addH264Codec(
    102,
    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  );
  if (withVideo) video.addSSRC(videoSsrc, "huddlefm", "huddlefm", "video");
  const videoTrack = pc.addTrack(video);

  const s: Session = {
    sig,
    pc,
    audioTrack,
    videoTrack,
    pings: sig.startPings(),
    opusPt: 111,
    h264Pt: 102,
    open: false,
    dead: false,
    lastInbound: Date.now(),
  };
  built.s = s;
  sig.on((type, f) => {
    s.lastInbound = Date.now();
    if (type === "CLOSED") lost(s, `signaling closed ${JSON.stringify(f)}`);
    else onSpeechFrame(type, f);
  });
  pc.onStateChange((st: string) => say("pc state", st));
  pc.onIceStateChange((st: string) => {
    say("ice state", st);
    if (st === "failed" || st === "closed") lost(s, `ice ${st}`);
  });
  audioTrack.onMessage((m: Buffer) => {
    if (m[1] >= 192 && m[1] <= 223) {
      stats.inAudioRtcp++;
      rtcpKinds(m);
    } else stats.inAudioRtp++;
  });
  videoTrack.onMessage((m: Buffer) => {
    if (m[1] >= 192 && m[1] <= 223) {
      stats.inVideoRtcp++;
      rtcpKinds(m);
    }
  });
  const opened = new Promise<void>((resolve) => {
    audioTrack.onOpen(resolve);
    pc.onStateChange((st: string) => st === "connected" && resolve());
  });

  const gathered = new Promise<void>((resolve) =>
    pc.onGatheringStateChange((st: string) => st === "complete" && resolve()),
  );
  pc.setLocalDescription();
  await Promise.race([gathered, Bun.sleep(10000)]);
  // SDP.withUnifiedPlanFormat() in the JS SDK marks the offer as unified plan.
  const offer: string = pc
    .localDescription()
    .sdp.replace(/^o=\S+/m, "o=mozilla-chrome");
  const relayCount = (offer.match(/typ relay/g) ?? []).length;
  say("offer ready, relay candidates:", relayCount);
  if (!relayCount)
    say(
      "WARNING: no relay candidates; TURN is unreachable from this network (UDP 3478 / TLS 443 to *.chime.aws)",
    );

  sig.send("SUBSCRIBE", {
    sub: {
      duplex: withVideo ? 3 : 1, // DUPLEX when sending video, else RX
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
      receive_stream_ids: [0], // one 0 per non-recvonly video m-line
      sdp_offer: offer,
      audio_host: meeting.MediaPlacement.AudioHostUrl,
      audio_checkin: false,
      audio_muted: false,
    },
  });
  const subAck = await sig.wait("SUBSCRIBE_ACK");
  say(
    "SUBSCRIBE_ACK",
    JSON.stringify({
      error: subAck.error,
      duplex: subAck.suback?.duplex,
      allocations: subAck.suback?.allocations,
      hasAnswer: !!subAck.suback?.sdp_answer,
    }),
  );
  // 206 is VideoCallSwitchToViewOnly in the JS SDK: no video send slot, but the
  // session carries on. Only give up when there is no answer at all.
  const answer: string | undefined = subAck.suback?.sdp_answer;
  if (!answer) throw new Error(`SUBSCRIBE rejected ${JSON.stringify(subAck)}`);
  writeFileSync(
    new URL("./last-sdp.txt", import.meta.url).pathname,
    `--- offer\n${offer.replace(/ice-pwd:\S+/g, "ice-pwd:<r>")}\n--- answer\n${answer.replace(/ice-pwd:\S+/g, "ice-pwd:<r>")}`,
  );
  pc.setRemoteDescription(
    answer
      .split("\r\n")
      .filter((l) => !/typ srflx/.test(l))
      .join("\r\n"),
    "answer",
  );
  s.opusPt = Number(answer.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1] ?? 111);
  s.h264Pt = Number(answer.match(/a=rtpmap:(\d+) H264\/90000/i)?.[1] ?? 102);
  await Promise.race([
    opened,
    Bun.sleep(15000).then(() => {
      throw new Error("media did not connect within 15 s");
    }),
  ]);
  s.open = true;
  return s;
}

function teardown(s: Session) {
  s.dead = true;
  s.open = false;
  clearInterval(s.pings);
  undecodable += s.sig.undecodable;
  frameLog.push(...s.sig.log);
  try {
    s.sig.ws.close();
  } catch {}
  try {
    s.pc.close();
  } catch {}
}

// ---- reconnect -------------------------------------------------------------
let lostAt = 0;
let reconnecting = false;
let stopping = false;
function lost(s: Session, reason: string) {
  if (s.dead || stopping) return;
  lostAt = performance.now();
  say(`connection lost: ${reason}`);
  teardown(s);
  if (session === s) session = undefined;
  void reconnect();
}
async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  for (let attempt = 1; !stopping; attempt++) {
    // Reuse the JoinToken first, like the JS SDK. If that keeps failing, ask
    // Slack for a fresh attendee.
    if (attempt === 4) {
      say("reconnect: falling back to a fresh rooms.join");
      try {
        ({ meeting, attendee } = await roomsJoin(channel));
        selfId = attendee.AttendeeId;
      } catch (e) {
        say("rooms.join failed:", String(e));
      }
    }
    try {
      say(`reconnect attempt ${attempt}`);
      session = await connect();
      stats.reconnects++;
      say(
        `reconnected in ${((performance.now() - lostAt) / 1000).toFixed(1)} s (attempt ${attempt}, attendee ${selfId.slice(0, 8)})`,
      );
      break;
    } catch (e) {
      say(`reconnect attempt ${attempt} failed:`, String(e));
      await Bun.sleep(Math.min(8000, 1000 * 2 ** (attempt - 1)));
    }
  }
  reconnecting = false;
}
// No inbound frame for 15 s means signaling is dead even if the socket has not
// noticed yet (the server sends BITRATES every 4 s and PING every 10 s).
const watchdog = setInterval(() => {
  const s = session;
  if (s?.open && Date.now() - s.lastInbound > 15000)
    lost(s, `no signaling frames for ${Date.now() - s.lastInbound} ms`);
}, 1000);

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
  // Duck gain at the start and end of this 20 ms frame, interpolated per sample.
  const now = performance.now();
  const g0 = duckGainAt(now),
    g1 = duckGainAt(now + 20);
  for (let i = 0; i < 960; i++, sample++) {
    const t = sample / 48000;
    const note = notes[Math.floor(t / 0.5) % notes.length];
    const env = Math.min(1, (t % 0.5) * 40) * Math.exp(-3 * (t % 0.5));
    const v =
      Math.sin(2 * Math.PI * note * t) *
      env *
      9000 *
      (g0 + ((g1 - g0) * i) / 960);
    const pan = Math.floor(t / 4) % 2 === 0 ? 0 : 1; // alternate L/R-biased every 4 s
    pcm[2 * i] = v * (pan ? 0.35 : 1);
    pcm[2 * i + 1] = v * (pan ? 1 : 0.35);
  }
  return opus.encode(pcm);
}
// A track throws once ICE/DTLS is gone; count that instead of crashing.
function send(track: any, packet: Buffer) {
  try {
    return track.sendMessageBinary(packet) as boolean;
  } catch (e) {
    if (stats.sendErrors++ === 0) say("send failed:", String(e));
    return false;
  }
}
let audioTimer: Timer | undefined;
const audioStart = performance.now();
function startAudio() {
  audioTimer = setInterval(() => {
    const due = Math.floor((performance.now() - audioStart) / 20);
    // After a stall (reconnect, frozen process) skip ahead instead of bursting.
    if (due - aSeq > 25) {
      sample += (due - aSeq) * 960;
      aSeq = due;
    }
    while (aSeq <= due) {
      const s = session;
      if (s?.open) {
        const payload = audioFrame();
        if (
          send(
            s.audioTrack,
            rtp(s.opusPt, aSeq, aSeq * 960, audioSsrc, payload),
          )
        ) {
          stats.audioSent++;
          stats.audioBytes += payload.length;
        }
      } else sample += 960;
      aSeq++;
    }
  }, 10);
}

// ---- video: ffmpeg test pattern -> H.264 baseline -> RTP -------------------
let ffmpeg: ReturnType<typeof Bun.spawn> | undefined;
let lastVideoTs = 0;
// Some ffmpeg builds (e.g. Homebrew's default) lack drawtext; fall back to
// testsrc, whose built-in frame counter still shows the video is live.
const hasDrawtext = Bun.spawnSync(["ffmpeg", "-hide_banner", "-filters"])
  .stdout.toString()
  .includes(" drawtext ");
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
      hasDrawtext
        ? "testsrc2=size=720x720:rate=15"
        : "testsrc=size=720x720:rate=15",
      ...(hasDrawtext
        ? [
            "-vf",
            "drawtext=text='HuddleFM native spike %{localtime\\:%T}':fontcolor=white:fontsize=36:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=h-80",
          ]
        : []),
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
    const s = session;
    if (!au.length || !s?.open) return;
    const ts = frame++ * 6000;
    for (let n = 0; n < au.length; n++) {
      const nal = au[n],
        last = n === au.length - 1;
      if (nal.length <= 1150) {
        send(s.videoTrack, rtp(s.h264Pt, vSeq++, ts, videoSsrc, nal, last));
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
          send(
            s.videoTrack,
            rtp(s.h264Pt, vSeq++, ts, videoSsrc, fu, last && end),
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
      const nal = buf.subarray(begin, starts[s + 1]);
      if ((nal[0] & 0x1f) === 9) flushAu();
      nals.push(Buffer.from(nal));
    }
    if (starts.length) buf = buf.subarray(starts[starts.length - 1]);
  }
}

// ---- run ---------------------------------------------------------------------
try {
  session = await connect();
} catch (e) {
  say("connect failed:", String(e));
  process.exit(1);
}
say(
  "media connected: sending",
  [withAudio && "audio", withVideo && "video"].filter(Boolean).join(" + "),
  `(ducking ${duckingMode})`,
);
if (withAudio) startAudio();
if (withVideo) startVideo().catch((e) => say("video error", String(e)));

const srTimer = setInterval(() => {
  const s = session;
  if (!s?.open) return;
  if (withAudio)
    send(
      s.audioTrack,
      senderReport(audioSsrc, aSeq * 960, stats.audioSent, stats.audioBytes),
    );
  if (withVideo)
    send(
      s.videoTrack,
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
      duckGain: Number(duckGainAt(performance.now()).toFixed(2)),
      undecodableFrames: undecodable + (session?.sig.undecodable ?? 0),
      connected: !!session?.open,
    }),
  );
}, 10000);

async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  say("shutting down:", reason);
  clearInterval(audioTimer);
  clearInterval(srTimer);
  clearInterval(statTimer);
  clearInterval(watchdog);
  clearTimeout(duckTimer);
  ffmpeg?.kill();
  say("final", JSON.stringify({ ...stats, ...speech }));
  const s = session;
  if (s) {
    try {
      s.sig.send("LEAVE", { leave: {} });
      await s.sig.wait("LEAVE_ACK", 5000);
      say("LEAVE_ACK");
    } catch (e) {
      say(String(e));
    }
    teardown(s);
  }
  writeFileSync(
    new URL("./last-frames.json", import.meta.url).pathname,
    JSON.stringify(
      redact(frameLog.filter((l) => l.type !== "AUDIO_METADATA")),
      null,
      1,
    ),
  );
  (nodeDataChannel as any).cleanup();
  process.exit(0);
}
setTimeout(() => shutdown("time limit"), seconds * 1000);
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
