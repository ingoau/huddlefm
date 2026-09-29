/** Largest RTP payload sent, leaving room for SRTP and TURN overhead. */
export const maxPayloadBytes = 1_150;

export function rtpPacket(
  payloadType: number,
  sequence: number,
  timestamp: number,
  ssrc: number,
  payload: Uint8Array,
  marker = false,
) {
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = (marker ? 0x80 : 0) | payloadType;
  packet.writeUInt16BE(sequence & 0xffff, 2);
  packet.writeUInt32BE(timestamp >>> 0, 4);
  packet.writeUInt32BE(ssrc >>> 0, 8);
  packet.set(payload, 12);
  return packet;
}

/** An RTCP sender report with no report blocks. */
export function senderReport(
  ssrc: number,
  rtpTimestamp: number,
  packets: number,
  octets: number,
  now = Date.now(),
) {
  const packet = Buffer.alloc(28);
  packet[0] = 0x80;
  packet[1] = 200;
  packet.writeUInt16BE(6, 2);
  packet.writeUInt32BE(ssrc >>> 0, 4);
  const ntp = now / 1000 + 2_208_988_800;
  packet.writeUInt32BE(Math.floor(ntp) >>> 0, 8);
  packet.writeUInt32BE(Math.floor((ntp % 1) * 2 ** 32) >>> 0, 12);
  packet.writeUInt32BE(rtpTimestamp >>> 0, 16);
  packet.writeUInt32BE(packets >>> 0, 20);
  packet.writeUInt32BE(octets >>> 0, 24);
  return packet;
}

export function isRtcp(packet: Uint8Array) {
  const type = packet[1] ?? 0;
  return type >= 192 && type <= 223;
}

/**
 * Counts requests for a keyframe in a compound RTCP packet: picture loss
 * indications and full intra requests.
 */
export function countPictureLoss(packet: Buffer) {
  let count = 0;
  let offset = 0;
  while (offset + 4 <= packet.length) {
    const type = packet[offset + 1];
    const format = (packet[offset] ?? 0) & 0x1f;
    if (type === 206 && (format === 1 || format === 4)) count++;
    offset += (packet.readUInt16BE(offset + 2) + 1) * 4;
  }
  return count;
}

/**
 * Splits an H.264 Annex-B byte stream into access units. Encoders are run with
 * access unit delimiters (`aud=1`), so each delimiter closes the previous
 * access unit. Feed it bytes as they arrive; complete units come back.
 */
export class AnnexBSplitter {
  private buffer = Buffer.alloc(0);
  private pending: Buffer[] = [];
  // Whether the start code at the front of the buffer was already looked at.
  private headChecked = false;

  push(chunk: Uint8Array) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const buffer = this.buffer;
    const starts: number[] = [];
    for (let index = 0; index + 3 < buffer.length; index++) {
      if (
        buffer[index] === 0 &&
        buffer[index + 1] === 0 &&
        (buffer[index + 2] === 1 ||
          (buffer[index + 2] === 0 && buffer[index + 3] === 1))
      ) {
        starts.push(index);
        index += 2;
      }
    }
    const units: Buffer[][] = [];
    let lastChecked = false;
    starts.forEach((start, index) => {
      const header = start + (buffer[start + 2] === 1 ? 3 : 4);
      const checked = header < buffer.length;
      // A delimiter closes the access unit as soon as it is seen.
      if (checked && !(start === 0 && this.headChecked)) {
        if ((buffer[header]! & 0x1f) === 9 && this.pending.length) {
          units.push(this.pending);
          this.pending = [];
        }
      }
      lastChecked = checked;
      const next = starts[index + 1];
      if (next === undefined) return;
      const nal = Buffer.from(buffer.subarray(header, next));
      if (nal.length && (nal[0]! & 0x1f) !== 9) this.pending.push(nal);
    });
    if (starts.length) {
      this.buffer = buffer.subarray(starts.at(-1)!);
      this.headChecked = lastChecked;
    }
    return units;
  }
}

/**
 * RTP payloads for one H.264 access unit (RFC 6184): single NAL unit packets
 * for small NALs and FU-A fragments for large ones. The marker bit goes on the
 * last packet of the unit.
 */
export function h264Payloads(nals: Buffer[], maxBytes = maxPayloadBytes) {
  const payloads: { payload: Buffer; marker: boolean }[] = [];
  nals.forEach((nal, index) => {
    const lastNal = index === nals.length - 1;
    if (nal.length <= maxBytes) {
      payloads.push({ payload: nal, marker: lastNal });
      return;
    }
    const header = nal[0]!;
    for (let offset = 1; offset < nal.length; offset += maxBytes - 2) {
      const chunk = nal.subarray(offset, offset + maxBytes - 2);
      const first = offset === 1;
      const last = offset + chunk.length >= nal.length;
      payloads.push({
        payload: Buffer.concat([
          Buffer.from([
            (header & 0xe0) | 28,
            (first ? 0x80 : 0) | (last ? 0x40 : 0) | (header & 0x1f),
          ]),
          chunk,
        ]),
        marker: lastNal && last,
      });
    }
  });
  return payloads;
}
