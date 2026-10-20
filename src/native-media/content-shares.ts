import type { SignalFrame } from "./signaling.ts";

/** Chime's suffix on the attendee that carries someone's screen share. */
export const contentSuffix = "#content";

/**
 * Counts the screen shares in the meeting, other than the bot's own, from the
 * attendee presence Chime sends. A share joins as its own attendee, named
 * after its sharer with `#content` on the end, like the JS SDK's
 * ContentShareConstants.Modality.
 */
export class ContentShares {
  private streams = new Map<number, string>();
  private reported = 0;

  constructor(
    private selfId: string,
    private onChange: (count: number) => void,
  ) {}

  get count() {
    return new Set(
      [...this.streams.values()].filter(
        (attendeeId) =>
          attendeeId.endsWith(contentSuffix) &&
          attendeeId !== `${this.selfId}${contentSuffix}`,
      ),
    ).size;
  }

  handle(frame: SignalFrame) {
    const streams = frame.audio_stream_id_info?.streams;
    if (!streams?.length) return;
    for (const stream of streams) {
      if (stream.attendee_id)
        this.streams.set(stream.audio_stream_id, stream.attendee_id);
      // An entry with neither an attendee nor a mute state means the stream
      // left.
      else if (stream.muted === undefined)
        this.streams.delete(stream.audio_stream_id);
    }
    this.report();
  }

  /** Forgets everyone, for a rebuilt connection that will resend presence. */
  reset() {
    this.streams.clear();
    this.report();
  }

  private report() {
    const count = this.count;
    if (count === this.reported) return;
    this.reported = count;
    this.onChange(count);
  }
}
