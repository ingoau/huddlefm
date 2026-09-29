/**
 * A queue of H.264 access units in shared memory, written by the video worker
 * and read by the audio thread on its pacer tick. Bun spends about 6% of a
 * core on messages between threads once they come at frame rate, however
 * small they are; this costs nothing while idle.
 *
 * One writer and one reader. Each record is its byte length, the timestamp,
 * the NAL count, then each NAL's length and bytes; a length of 0xffffffff
 * means the rest of the ring is unused and the next record is at its start.
 * A unit that does not fit is dropped rather than overwriting unread ones.
 */
export class UnitRing {
  private positions: Int32Array;
  private view: DataView;
  private bytes: Uint8Array;
  readonly capacity: number;

  constructor(readonly buffer = new SharedArrayBuffer(8 + 4 * 1024 * 1024)) {
    // [write, read] byte offsets into the data after them.
    this.positions = new Int32Array(buffer, 0, 2);
    this.capacity = buffer.byteLength - 8;
    this.view = new DataView(buffer, 8);
    this.bytes = new Uint8Array(buffer, 8);
  }

  /** Queues one access unit; false if the reader is too far behind. */
  write(nals: Uint8Array[], timestamp: number) {
    const size = 12 + nals.reduce((sum, nal) => sum + 4 + nal.byteLength, 0);
    let write = Atomics.load(this.positions, 0);
    const read = Atomics.load(this.positions, 1);
    const free = (read - write - 1 + this.capacity) % this.capacity;
    if (write + size > this.capacity) {
      // Wrap: the record must not split across the end.
      const tail = this.capacity - write;
      if (size + tail > free) return false;
      if (tail >= 4) this.view.setUint32(write, 0xffffffff);
      write = 0;
      // The reader must not overtake an unwritten wrap.
      if (size >= read) return false;
    } else if (size > free) return false;
    this.view.setUint32(write, size);
    this.view.setUint32(write + 4, timestamp >>> 0);
    this.view.setUint32(write + 8, nals.length);
    let offset = write + 12;
    for (const nal of nals) {
      this.view.setUint32(offset, nal.byteLength);
      this.bytes.set(nal, offset + 4);
      offset += 4 + nal.byteLength;
    }
    Atomics.store(this.positions, 0, offset % this.capacity);
    return true;
  }

  /** Hands over every queued unit, oldest first, as copies. */
  drain(each: (nals: Buffer[], timestamp: number) => void) {
    const write = Atomics.load(this.positions, 0);
    let read = Atomics.load(this.positions, 1);
    while (read !== write) {
      if (
        this.capacity - read < 4 ||
        this.view.getUint32(read) === 0xffffffff
      ) {
        read = 0;
        continue;
      }
      const size = this.view.getUint32(read);
      const timestamp = this.view.getUint32(read + 4);
      const count = this.view.getUint32(read + 8);
      const nals: Buffer[] = [];
      let offset = read + 12;
      for (let index = 0; index < count; index++) {
        const length = this.view.getUint32(offset);
        nals.push(
          Buffer.from(this.bytes.slice(offset + 4, offset + 4 + length)),
        );
        offset += 4 + length;
      }
      read = (read + size) % this.capacity;
      each(nals, timestamp);
    }
    Atomics.store(this.positions, 1, read);
  }
}
