import type { DuckDecision, DuckingController } from "../ducking.ts";
import type { SignalFrame } from "./signaling.ts";

// DefaultVolumeIndicatorAdapter in amazon-chime-sdk-js maps a volume
// attenuation of -42 dB..-14 dB onto 0..1.
const minVolumeDecibels = -42;
const maxVolumeDecibels = -14;

export function normalizedVolume(attenuation: number) {
  const level =
    (-attenuation - minVolumeDecibels) /
    (maxVolumeDecibels - minVolumeDecibels);
  return Math.min(1, Math.max(0, level));
}

/**
 * Turns Chime's per-attendee audio metadata into ducking decisions, like the
 * JS SDK's volume indicator and attendee presence callbacks do in the media
 * page. The bot's own attendee is the music, so it never counts as speech.
 */
export class SpeechSignals {
  private streams = new Map<number, string>();

  constructor(
    private selfId: string,
    private ducking: DuckingController,
    private apply: (decision: DuckDecision | undefined) => void,
  ) {}

  handle(frame: SignalFrame, now = Date.now()) {
    for (const stream of frame.audio_stream_id_info?.streams ?? [])
      this.streamInfo(stream, now);
    const states = frame.audio_metadata?.attendee_states;
    if (states) this.metadata(states, now);
  }

  /** Forgets everyone, for a rebuilt connection that will resend presence. */
  reset(now = Date.now()) {
    for (const attendeeId of new Set(this.streams.values()))
      if (attendeeId !== this.selfId)
        this.apply(this.ducking.leave(attendeeId, now));
    this.streams.clear();
  }

  private streamInfo(
    stream: NonNullable<
      NonNullable<SignalFrame["audio_stream_id_info"]>["streams"]
    >[number],
    now: number,
  ) {
    if (stream.attendee_id) {
      this.streams.set(stream.audio_stream_id, stream.attendee_id);
      if (stream.attendee_id !== this.selfId && stream.muted !== undefined)
        this.apply(
          this.ducking.volume(stream.attendee_id, null, stream.muted, now),
        );
      return;
    }
    const attendeeId = this.streams.get(stream.audio_stream_id);
    if (!attendeeId || attendeeId === this.selfId) {
      if (stream.muted === undefined)
        this.streams.delete(stream.audio_stream_id);
      return;
    }
    if (stream.muted !== undefined) {
      this.apply(this.ducking.volume(attendeeId, null, stream.muted, now));
      return;
    }
    // An entry with neither an attendee nor a mute state means the stream
    // left. The attendee is only gone if no newer stream belongs to them.
    this.streams.delete(stream.audio_stream_id);
    if (![...this.streams.values()].includes(attendeeId))
      this.apply(this.ducking.leave(attendeeId, now));
  }

  private metadata(
    states: NonNullable<
      NonNullable<SignalFrame["audio_metadata"]>["attendee_states"]
    >,
    now: number,
  ) {
    const levels = new Map<string, number>();
    let carriesVolumes = false;
    for (const state of states) {
      if (state.volume === undefined) continue;
      carriesVolumes = true;
      const attendeeId = this.streams.get(state.audio_stream_id);
      if (attendeeId) levels.set(attendeeId, normalizedVolume(state.volume));
    }
    // A frame that carries volumes implies silence for everyone it leaves out,
    // which is what lets the duck release.
    if (!carriesVolumes) return;
    for (const attendeeId of new Set(this.streams.values())) {
      if (attendeeId === this.selfId) continue;
      this.apply(
        this.ducking.volume(attendeeId, levels.get(attendeeId) ?? 0, null, now),
      );
    }
  }
}
