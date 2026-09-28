import nodeDataChannel from "node-datachannel";
import {
  ChimeSignaling,
  type SignalFrame,
  type SignalingLog,
  type TurnCredentials,
} from "./signaling.ts";
import {
  countPictureLoss,
  h264Payloads,
  isRtcp,
  rtpPacket,
  senderReport,
} from "./rtp.ts";
import { statusCodes } from "./status-codes.ts";

export { statusCodes };

const { PeerConnection, Audio, Video } = nodeDataChannel;
type Peer = InstanceType<typeof PeerConnection>;
type Track = ReturnType<Peer["addTrack"]>;

// AUDIO_STATUS values that end the session instead of reconnecting.
const terminalAudioStatus: Record<number, number> = {
  301: statusCodes.joinedFromAnotherDevice,
  302: statusCodes.disconnectAudio,
  403: statusCodes.authenticationRejected,
  409: statusCodes.atCapacity,
  410: statusCodes.meetingEnded,
  411: statusCodes.attendeeRemoved,
};

const opusProfile =
  "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000";
const h264Profile =
  "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";
/** How long signaling may stay silent; the server sends BITRATES every 4 s. */
const silenceLimitMs = 15_000;
/** How long to keep retrying a lost connection before giving up. */
const reconnectWindowMs = 120_000;

export type ChimeMeeting = {
  MediaPlacement: { SignalingUrl: string; AudioHostUrl: string };
};
export type ChimeAttendee = { AttendeeId: string; JoinToken: string };

/** Chime said the session is over; reconnecting cannot help. */
class TerminalError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Connection = {
  signaling: ChimeSignaling;
  peer: Peer;
  audio: Track;
  video?: Track;
  /** Whether this connection's offer asked to send video. */
  requestedVideo: boolean;
  opusPayloadType: number;
  h264PayloadType: number;
  open: boolean;
  dead: boolean;
  reportTimer?: ReturnType<typeof setInterval>;
};

export type ChimeLinkEvents = {
  log: SignalingLog;
  /** Every decoded signaling frame, for volume and presence. */
  onFrame(frame: SignalFrame): void;
  /** A connection (first or reconnected) is carrying media. */
  onConnected(reconnect: boolean): void;
  onPictureLoss(): void;
  /** The session cannot continue; `code` is a MeetingSessionStatusCode. */
  onTerminal(code: number, reason: string): void;
};

export function iceServers(turn: TurnCredentials) {
  return turn.uris.flatMap((uri) => {
    const match = uri.match(/^(turns?):([^:?]+):(\d+)(?:\?transport=(\w+))?/);
    if (!match) return [];
    const [, scheme, hostname, port, transport] = match;
    return [
      {
        hostname: hostname!,
        port: Number(port),
        username: turn.username,
        password: turn.password,
        relayType:
          scheme === "turns"
            ? ("TurnTls" as const)
            : transport === "tcp"
              ? ("TurnTcp" as const)
              : ("TurnUdp" as const),
      },
    ];
  });
}

/**
 * Keeps one attendee connected to a Chime meeting: signaling, a relay-only
 * WebRTC peer, and RTP for the music and the video card. Rebuilds the whole
 * connection with the same JoinToken when it drops, which brings the same
 * attendee back, and gives up after two minutes.
 */
export class ChimeLink {
  readonly attendeeId: string;
  private connection?: Connection;
  private wantVideo: boolean;
  private stopping = false;
  private reconnecting?: Promise<void>;
  private watchdog?: ReturnType<typeof setInterval>;
  // One audio session and one set of SSRCs for the attendee's lifetime, so a
  // reconnect continues the same streams.
  private audioSessionId = Math.floor(Math.random() * 2 ** 32);
  private audioSsrc = (Math.random() * 2 ** 31) >>> 0;
  private videoSsrc = (Math.random() * 2 ** 31) >>> 0;
  private audioSequence = 0;
  private audioTimestamp = 0;
  private videoSequence = 0;
  private lastVideoTimestamp = 0;
  readonly stats = {
    audioPackets: 0,
    audioBytes: 0,
    videoPackets: 0,
    videoBytes: 0,
    reconnects: 0,
  };

  constructor(
    private meeting: ChimeMeeting,
    private attendee: ChimeAttendee,
    video: boolean,
    private events: ChimeLinkEvents,
  ) {
    this.attendeeId = attendee.AttendeeId;
    this.wantVideo = video;
  }

  get connected() {
    return Boolean(this.connection?.open);
  }

  get sendingVideo() {
    return Boolean(this.connection?.open && this.connection.video);
  }

  async start() {
    this.connection = await this.connect();
    this.watchdog = setInterval(() => this.checkSilence(), 1_000);
    this.events.onConnected(false);
    this.reconcileVideo(this.connection);
  }

  // A display change that lands while a connection is being built only takes
  // effect on the next one, so rebuild once more if they disagree.
  private reconcileVideo(connection: Connection) {
    if (connection.requestedVideo !== this.wantVideo)
      this.lost(connection, "video changed while connecting", true);
  }

  /** Sends one Opus frame covering `samples` samples at 48 kHz. */
  sendAudio(payload: Uint8Array, samples = 960) {
    const connection = this.connection;
    const timestamp = this.audioTimestamp;
    this.audioTimestamp = (this.audioTimestamp + samples) >>> 0;
    const sequence = this.audioSequence++;
    if (!connection?.open) return false;
    const sent = this.write(
      connection.audio,
      rtpPacket(
        connection.opusPayloadType,
        sequence,
        timestamp,
        this.audioSsrc,
        payload,
      ),
    );
    if (sent) {
      this.stats.audioPackets++;
      this.stats.audioBytes += payload.length;
    }
    return sent;
  }

  /** Sends one H.264 access unit with a 90 kHz timestamp. */
  sendVideo(nals: Buffer[], timestamp: number) {
    const connection = this.connection;
    if (!connection?.open || !connection.video) return;
    this.lastVideoTimestamp = timestamp;
    for (const { payload, marker } of h264Payloads(nals)) {
      const sent = this.write(
        connection.video,
        rtpPacket(
          connection.h264PayloadType,
          this.videoSequence++,
          timestamp,
          this.videoSsrc,
          payload,
          marker,
        ),
      );
      if (!sent) return;
      this.stats.videoPackets++;
      this.stats.videoBytes += payload.length;
    }
  }

  /**
   * Starts or stops the video tile. Chime negotiates video per SUBSCRIBE, so
   * this rebuilds the connection with the new offer; audio pauses for about a
   * second while it does.
   */
  setVideo(enabled: boolean) {
    if (enabled === this.wantVideo) return;
    this.wantVideo = enabled;
    const connection = this.connection;
    if (connection && !this.stopping)
      this.lost(connection, enabled ? "video enabled" : "video disabled", true);
  }

  async leave(timeoutMs = 3_000) {
    this.stopping = true;
    clearInterval(this.watchdog);
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    if (connection.signaling.send("LEAVE", { leave: {} }))
      await connection.signaling.wait("LEAVE_ACK", timeoutMs).catch(() => {});
    this.teardown(connection);
  }

  close() {
    this.stopping = true;
    clearInterval(this.watchdog);
    if (this.connection) this.teardown(this.connection);
    this.connection = undefined;
  }

  private write(track: Track, packet: Buffer) {
    try {
      return track.sendMessageBinary(packet);
    } catch {
      // A track throws once ICE or DTLS is gone; the watchdog reconnects.
      return false;
    }
  }

  private async connect(): Promise<Connection> {
    const signaling = new ChimeSignaling(
      this.meeting.MediaPlacement.SignalingUrl,
      this.attendee.JoinToken,
      this.events.log,
    );
    let connection: Connection | undefined;
    let terminal: TerminalError | undefined;
    signaling.onFrame((frame) => {
      const status = frame.audio_status?.audio_status;
      if (status !== undefined && terminalAudioStatus[status])
        terminal ??= new TerminalError(
          terminalAudioStatus[status],
          `Chime audio status ${status}`,
        );
    });
    try {
      await signaling.connect();
      signaling.join(this.audioSessionId);
      const ack = await signaling.wait("JOIN_ACK");
      const turn = ack.joinack?.turn_credentials;
      if (!turn?.uris?.length)
        throw new Error("Chime JOIN_ACK carried no TURN servers");
      await signaling.wait("INDEX", 5_000).catch(() => undefined);
      connection = this.createPeer(signaling, turn);
      await this.subscribe(connection);
      connection.open = true;
      this.watch(connection);
      return connection;
    } catch (error) {
      if (connection) this.teardown(connection);
      else signaling.close();
      if (signaling.closeCode === 4410)
        throw new TerminalError(
          statusCodes.meetingEnded,
          "Chime meeting ended",
        );
      throw terminal ?? error;
    }
  }

  private createPeer(signaling: ChimeSignaling, turn: TurnCredentials) {
    const peer = new PeerConnection("chime", {
      iceServers: iceServers(turn),
      iceTransportPolicy: "relay",
    });
    const audio = new Audio("0", "SendRecv");
    audio.addOpusCodec(111, opusProfile);
    audio.addSSRC(this.audioSsrc, "huddlefm", "huddlefm", "audio");
    const audioTrack = peer.addTrack(audio);
    // Like amazon-chime-sdk-js, always offer a video m-line, inactive when not
    // sending; the server will not set up the session without one.
    const video = new Video("1", this.wantVideo ? "SendRecv" : "Inactive");
    video.addH264Codec(102, h264Profile);
    if (this.wantVideo)
      video.addSSRC(this.videoSsrc, "huddlefm", "huddlefm", "video");
    const videoTrack = peer.addTrack(video);
    return {
      signaling,
      peer,
      audio: audioTrack,
      video: this.wantVideo ? videoTrack : undefined,
      requestedVideo: this.wantVideo,
      opusPayloadType: 111,
      h264PayloadType: 102,
      open: false,
      dead: false,
    } satisfies Connection;
  }

  private async subscribe(connection: Connection) {
    const { peer, signaling } = connection;
    const gathered = new Promise<void>((resolve) =>
      peer.onGatheringStateChange(
        (state: string) => state === "complete" && resolve(),
      ),
    );
    const opened = new Promise<void>((resolve) => {
      connection.audio.onOpen(resolve);
      peer.onStateChange((state: string) => state === "connected" && resolve());
    });
    peer.setLocalDescription();
    // Chime takes the whole offer at once; there is no trickle ICE.
    await Promise.race([gathered, Bun.sleep(10_000)]);
    // SDP.withUnifiedPlanFormat() in the JS SDK marks the offer this way.
    const offer = peer
      .localDescription()!
      .sdp.replace(/^o=\S+/m, "o=mozilla-chrome");
    if (!/typ relay/.test(offer))
      throw new Error("No TURN relay candidate; Chime media is unreachable");
    const video = Boolean(connection.video);
    signaling.send("SUBSCRIBE", {
      sub: {
        duplex: video ? 3 : 1, // DUPLEX while sending video, otherwise RX
        send_streams: [
          {
            media_type: 1,
            track_label: "AmazonChimeExpressAudio",
            stream_id: 1,
            group_id: 1,
            framerate: 15,
            max_bitrate_kbps: 600,
            avg_bitrate_bps: 400_000,
            attendee_id: this.attendeeId,
          },
          ...(video
            ? [
                {
                  media_type: 2,
                  track_label: "AmazonChimeExpressVideo",
                  stream_id: 2,
                  group_id: 2,
                  framerate: 5,
                  max_bitrate_kbps: 600,
                  attendee_id: this.attendeeId,
                  width: 720,
                  height: 720,
                },
              ]
            : []),
        ],
        receive_stream_ids: [0], // one 0 per video m-line that is not recvonly
        sdp_offer: offer,
        audio_host: this.meeting.MediaPlacement.AudioHostUrl,
        audio_checkin: false,
        audio_muted: false,
      },
    });
    const ack = await signaling.wait("SUBSCRIBE_ACK");
    const answer = ack.suback?.sdp_answer;
    if (!answer)
      throw new Error(
        `Chime refused SUBSCRIBE: ${ack.error?.status ?? "no answer"} ${ack.error?.description ?? ""}`,
      );
    if (video && ack.suback?.duplex === "RX") {
      // 206, VideoCallSwitchToViewOnly: no video slot, but audio carries on.
      this.events.log(
        "warn",
        "chime_video_refused",
        "Chime refused the video tile",
        { status: ack.error?.status },
      );
      connection.video = undefined;
    }
    peer.setRemoteDescription(
      answer
        .split("\r\n")
        .filter((line) => !/typ srflx/.test(line))
        .join("\r\n"),
      "answer",
    );
    connection.opusPayloadType = Number(
      answer.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1] ?? 111,
    );
    connection.h264PayloadType = Number(
      answer.match(/a=rtpmap:(\d+) H264\/90000/i)?.[1] ?? 102,
    );
    await Promise.race([
      opened,
      Bun.sleep(15_000).then(() => {
        throw new Error("Chime media did not connect within 15 s");
      }),
    ]);
  }

  private watch(connection: Connection) {
    const { signaling, peer } = connection;
    signaling.onFrame((frame) => {
      const audioStatus = frame.audio_status?.audio_status;
      if (audioStatus !== undefined && terminalAudioStatus[audioStatus]) {
        this.terminal(
          terminalAudioStatus[audioStatus],
          `Chime audio status ${audioStatus}`,
        );
        return;
      }
      if (audioStatus !== undefined && audioStatus !== 200) {
        this.lost(connection, `Chime audio status ${audioStatus}`);
        return;
      }
      this.events.onFrame(frame);
    });
    signaling.onClose((code, reason) => {
      if (code === 4410)
        this.terminal(statusCodes.meetingEnded, "Chime meeting ended");
      else this.lost(connection, `signaling closed ${code} ${reason}`);
    });
    peer.onIceStateChange((state: string) => {
      if (state === "failed" || state === "closed")
        this.lost(connection, `ICE ${state}`);
    });
    peer.onStateChange((state: string) => {
      if (state === "failed" || state === "closed")
        this.lost(connection, `peer ${state}`);
    });
    connection.video?.onMessage((packet: Buffer) => {
      if (isRtcp(packet) && countPictureLoss(packet))
        this.events.onPictureLoss();
    });
    signaling.startPings();
    connection.reportTimer = setInterval(() => {
      if (!connection.open) return;
      this.write(
        connection.audio,
        senderReport(
          this.audioSsrc,
          this.audioTimestamp,
          this.stats.audioPackets,
          this.stats.audioBytes,
        ),
      );
      if (connection.video)
        this.write(
          connection.video,
          senderReport(
            this.videoSsrc,
            this.lastVideoTimestamp,
            this.stats.videoPackets,
            this.stats.videoBytes,
          ),
        );
    }, 1_000);
  }

  private checkSilence() {
    const connection = this.connection;
    if (!connection?.open) return;
    const silentMs = Date.now() - connection.signaling.lastInboundAt;
    if (silentMs > silenceLimitMs)
      this.lost(connection, `no signaling for ${silentMs} ms`);
  }

  private teardown(connection: Connection) {
    connection.dead = true;
    connection.open = false;
    clearInterval(connection.reportTimer);
    connection.signaling.close();
    try {
      connection.peer.close();
    } catch {}
  }

  private terminal(code: number, reason: string) {
    if (this.stopping) return;
    this.close();
    this.events.onTerminal(code, reason);
  }

  private lost(connection: Connection, reason: string, planned = false) {
    if (connection.dead || this.stopping) return;
    this.events.log(
      planned ? "info" : "warn",
      planned ? "chime_renegotiating" : "chime_connection_lost",
      planned ? "Rebuilding the Chime connection" : "Chime connection lost",
      { reason },
    );
    this.teardown(connection);
    if (this.connection === connection) this.connection = undefined;
    this.reconnecting ??= this.reconnect().finally(() => {
      this.reconnecting = undefined;
    });
  }

  private async reconnect() {
    const startedAt = Date.now();
    for (let attempt = 1; !this.stopping; attempt++) {
      try {
        const connection = await this.connect();
        if (this.stopping) {
          this.teardown(connection);
          return;
        }
        this.connection = connection;
        this.stats.reconnects++;
        this.events.log("info", "chime_reconnected", "Chime reconnected", {
          attempt,
          durationMs: Date.now() - startedAt,
          video: Boolean(connection.video),
        });
        this.events.onConnected(true);
        this.reconcileVideo(connection);
        return;
      } catch (error) {
        if (error instanceof TerminalError) {
          this.terminal(error.code, error.message);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.events.log(
          "warn",
          "chime_reconnect_failed",
          "Chime reconnect attempt failed",
          { attempt, error: message },
        );
        if (Date.now() - startedAt > reconnectWindowMs) {
          this.terminal(
            statusCodes.signalingClosedUnexpectedly,
            `Could not reconnect to Chime: ${message}`,
          );
          return;
        }
        await Bun.sleep(Math.min(8_000, 1_000 * 2 ** (attempt - 1)));
      }
    }
  }
}
