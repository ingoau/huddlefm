import { describe, expect, test } from "bun:test";
import { UnitRing } from "./unit-ring.ts";

const unit = (seed: number, sizes: number[]) =>
  sizes.map((size, index) =>
    new Uint8Array(size).fill((seed * 7 + index) & 0xff),
  );

function drained(ring: UnitRing) {
  const out: { nals: Buffer[]; timestamp: number }[] = [];
  ring.drain((nals, timestamp) => out.push({ nals, timestamp }));
  return out;
}

describe("unit ring", () => {
  test("hands units over in order, NAL by NAL", () => {
    const ring = new UnitRing(new SharedArrayBuffer(8 + 1024));
    expect(ring.write(unit(1, [2, 30]), 90)).toBe(true);
    expect(ring.write(unit(2, [5]), 180)).toBe(true);
    const out = drained(ring);
    expect(out.map((value) => value.timestamp)).toEqual([90, 180]);
    expect(out[0]!.nals.map((nal) => nal.length)).toEqual([2, 30]);
    expect([...out[0]!.nals[1]!]).toEqual([...unit(1, [2, 30])[1]!]);
    expect(drained(ring)).toEqual([]);
  });

  test("wraps around the end without splitting a unit", () => {
    const ring = new UnitRing(new SharedArrayBuffer(8 + 256));
    let written = 0;
    let read = 0;
    for (let round = 0; round < 50; round++) {
      const sizes = [1 + ((round * 37) % 90), 3];
      expect(ring.write(unit(round, sizes), round)).toBe(true);
      written++;
      for (const { nals, timestamp } of drained(ring)) {
        expect(timestamp).toBe(read);
        expect(nals.map((nal) => nal.length)).toEqual([
          1 + ((read * 37) % 90),
          3,
        ]);
        expect(nals[0]![0]).toBe((read * 7) & 0xff);
        read++;
      }
    }
    expect(read).toBe(written);
  });

  test("drops a unit that does not fit instead of overwriting", () => {
    // Each 40-byte NAL takes a 56-byte record.
    const ring = new UnitRing(new SharedArrayBuffer(8 + 128));
    expect(ring.write(unit(1, [40]), 1)).toBe(true);
    expect(ring.write(unit(2, [40]), 2)).toBe(true);
    expect(ring.write(unit(3, [40]), 3)).toBe(false);
    expect(drained(ring).map((value) => value.timestamp)).toEqual([1, 2]);
    // Read, the space is free again, past the end and round to the start.
    expect(ring.write(unit(4, [40]), 4)).toBe(true);
    expect(drained(ring).map((value) => value.timestamp)).toEqual([4]);
  });

  test("carries units intact between threads", async () => {
    const ring = new UnitRing(new SharedArrayBuffer(8 + 64 * 1024));
    const worker = new Worker(
      URL.createObjectURL(
        new Blob(
          [
            `import { UnitRing } from ${JSON.stringify(new URL("./unit-ring.ts", import.meta.url).href)};
             self.onmessage = async ({ data }) => {
               const ring = new UnitRing(data);
               for (let n = 0; n < 2000; ) {
                 const nal = new Uint8Array(1 + (n * 131) % 3000).fill(n & 0xff);
                 if (ring.write([nal], n)) n++;
                 else await new Promise((r) => setTimeout(r, 1));
               }
               postMessage("done");
             };`,
          ],
          { type: "application/typescript" },
        ),
      ),
    );
    const done = new Promise((resolve) => (worker.onmessage = resolve));
    worker.postMessage(ring.buffer);
    let next = 0;
    let finished = false;
    void done.then(() => (finished = true));
    while (next < 2000) {
      ring.drain((nals, timestamp) => {
        expect(timestamp).toBe(next);
        expect(nals[0]!.length).toBe(1 + ((next * 131) % 3000));
        expect(nals[0]!.every((byte) => byte === (next & 0xff))).toBe(true);
        next++;
      });
      if (next < 2000) await Bun.sleep(finished ? 0 : 1);
    }
    worker.terminate();
    expect(next).toBe(2000);
  }, 20_000);
});
