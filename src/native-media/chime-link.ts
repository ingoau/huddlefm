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
import { cardSize, videoFps, videoMaxKbps } from "./video-format.ts";

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
  // node-datachannel closes the native track when a wrapper is garbage
  // collected, and every addTrack for a mid returns a new wrapper around the
  // same track, so each one stays referenced until the connection goes.
  tracks: Track[];
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
  /** The live connection started or stopped sending video. */
  onVideoChanged(): void;
  onPictureLoss(): void;
  /** The session cannot continue; `code` is a MeetingSessionStatusCode. */
  onTerminal(code: number, reason: string): void;
};

export function iceServers(turn: TurnCredentials) {
  return (turn.uris ?? []).flatMap((uri) => {
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
  // Video changes run one at a time on the live connection.
  private renegotiating: Promise<void> = Promise.resolve();
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
    // Chime is only reachable through TURN; tests connect on loopback.
    private relayOnly = true,
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
    // A display change that landed while connecting is applied now.
    this.renegotiateVideo();
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
   * like the JS SDK this flips the video m-line between sendrecv and inactive
   * and subscribes again on the live connection; audio keeps flowing. A
   * connection still being built picks the change up when it is published.
   */
  setVideo(enabled: boolean) {
    if (enabled === this.wantVideo) return;
    this.wantVideo = enabled;
    this.renegotiateVideo();
  }

  private renegotiateVideo() {
    // Errors are handled inside; the catch only keeps later changes chained.
    this.renegotiating = this.renegotiating
      .then(() => this.renegotiate(this.connection))
      .catch(() => {});
  }

  private async renegotiate(connection: Connection | undefined) {
    while (
      connection &&
      connection === this.connection &&
      connection.open &&
      !this.stopping &&
      connection.requestedVideo !== this.wantVideo
    ) {
      const video = this.wantVideo;
      try {
        const track = connection.peer.addTrack(this.videoDescription(video));
        connection.tracks.push(track);
        const offer = await this.renegotiatedOffer(connection.peer);
        if (connection !== this.connection || connection.dead) return;
        const ack = await this.sendSubscribe(connection, offer, video);
        if (connection !== this.connection || connection.dead) return;
        this.applyAnswer(connection, ack, video ? track : undefined);
        this.watchVideo(connection);
        this.events.log(
          "info",
          "chime_video_renegotiated",
          video ? "Started the video tile" : "Stopped the video tile",
          { video: Boolean(connection.video) },
        );
        this.events.onVideoChanged();
      } catch (error) {
        // If Chime will not renegotiate in place, rebuilding the connection
        // with the new offer still works.
        this.events.log(
          "warn",
          "chime_renegotiation_failed",
          "Could not change video in place; rebuilding the connection",
          { error: error instanceof Error ? error.message : String(error) },
        );
        this.lost(connection, "video renegotiation failed", true);
        return;
      }
    }
  }

  /** The offer libdatachannel makes after a track changed direction. */
  private renegotiatedOffer(peer: Peer) {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out creating a renegotiation offer")),
        5_000,
      );
      peer.onLocalDescription((sdp: string, type: string) => {
        if (type !== "offer") return;
        clearTimeout(timer);
        resolve(peer.localDescription()?.sdp ?? sdp);
      });
      peer.setLocalDescription();
    });
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
      if (!turn || (this.relayOnly && !turn.uris?.length))
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
      iceTransportPolicy: this.relayOnly ? "relay" : "all",
    });
    const audio = new Audio("0", "SendRecv");
    audio.addOpusCodec(111, opusProfile);
    audio.addSSRC(this.audioSsrc, "huddlefm", "huddlefm", "audio");
    const audioTrack = peer.addTrack(audio);
    const videoTrack = peer.addTrack(this.videoDescription(this.wantVideo));
    return {
      signaling,
      peer,
      audio: audioTrack,
      video: this.wantVideo ? videoTrack : undefined,
      tracks: [audioTrack, videoTrack],
      requestedVideo: this.wantVideo,
      opusPayloadType: 111,
      h264PayloadType: 102,
      open: false,
      dead: false,
    } satisfies Connection;
  }

  // Like amazon-chime-sdk-js, always offer a video m-line, inactive when not
  // sending; the server will not set up the session without one. Adding it
  // again under the same mid replaces the track's description.
  private videoDescription(send: boolean) {
    const video = new Video("1", send ? "SendRecv" : "Inactive");
    video.addH264Codec(102, h264Profile);
    if (send) video.addSSRC(this.videoSsrc, "huddlefm", "huddlefm", "video");
    return video;
  }

  private async subscribe(connection: Connection) {
    const { peer } = connection;
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
    const offer = peer.localDescription()!.sdp;
    if (this.relayOnly && !/typ relay/.test(offer))
      throw new Error("No TURN relay candidate; Chime media is unreachable");
    const ack = await this.sendSubscribe(
      connection,
      offer,
      connection.requestedVideo,
    );
    this.applyAnswer(connection, ack, connection.video);
    await Promise.race([
      opened,
      Bun.sleep(15_000).then(() => {
        throw new Error("Chime media did not connect within 15 s");
      }),
    ]);
  }

  private async sendSubscribe(
    connection: Connection,
    offer: string,
    video: boolean,
  ) {
    const signaling = connection.signaling;
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
                  framerate: videoFps,
                  max_bitrate_kbps: videoMaxKbps,
                  attendee_id: this.attendeeId,
                  width: cardSize,
                  height: cardSize,
                },
              ]
            : []),
        ],
        receive_stream_ids: [0], // one 0 per video m-line that is not recvonly
        // SDP.withUnifiedPlanFormat() in the JS SDK marks the offer this way.
        sdp_offer: offer.replace(/^o=\S+/m, "o=mozilla-chrome"),
        audio_host: this.meeting.MediaPlacement.AudioHostUrl,
        audio_checkin: false,
        audio_muted: false,
      },
    });
    const ack = await signaling.wait("SUBSCRIBE_ACK");
    if (!ack.suback?.sdp_answer)
      throw new Error(
        `Chime refused SUBSCRIBE: ${ack.error?.status ?? "no answer"} ${ack.error?.description ?? ""}`,
      );
    return ack;
  }

  /** Applies a SUBSCRIBE_ACK's answer and records what Chime agreed to. */
  private applyAnswer(
    connection: Connection,
    ack: SignalFrame,
    videoTrack: Track | undefined,
  ) {
    const answer = ack.suback!.sdp_answer!;
    connection.requestedVideo = Boolean(videoTrack);
    connection.video = videoTrack;
    if (videoTrack && ack.suback?.duplex === "RX") {
      // 206, VideoCallSwitchToViewOnly: no video slot, but audio carries on.
      this.events.log(
        "warn",
        "chime_video_refused",
        "Chime refused the video tile",
        { status: ack.error?.status },
      );
      connection.video = undefined;
    }
    connection.peer.setRemoteDescription(
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
  }

  private watchVideo(connection: Connection) {
    connection.video?.onMessage((packet: Buffer) => {
      if (isRtcp(packet) && countPictureLoss(packet))
        this.events.onPictureLoss();
    });
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
    this.watchVideo(connection);
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
        // The display changed while this connection was being built. Rebuild
        // here: lost() cannot start another reconnect while this one runs.
        if (connection.requestedVideo !== this.wantVideo) {
          this.events.log(
            "info",
            "chime_renegotiating",
            "Rebuilding the Chime connection",
            { reason: "video changed while connecting" },
          );
          this.teardown(connection);
          continue;
        }
        this.connection = connection;
        this.stats.reconnects++;
        this.events.log("info", "chime_reconnected", "Chime reconnected", {
          attempt,
          durationMs: Date.now() - startedAt,
          video: Boolean(connection.video),
        });
        this.events.onConnected(true);
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
