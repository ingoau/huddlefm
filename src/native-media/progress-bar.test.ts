import { expect, test } from "bun:test";
import {
  barLayout,
  drawProgressBar,
  ProgressBarOverlay,
} from "./progress-bar.ts";

const size = { width: 64, height: 36 };
const frameOf = (luma: number, chroma: number) => {
  const frame = Buffer.alloc((size.width * size.height * 3) / 2, chroma);
  frame.fill(luma, 0, size.width * size.height);
  return frame;
};
const luma = (frame: Buffer, x: number, y: number) =>
  frame[y * size.width + x]!;
const u = (frame: Buffer, x: number, y: number) =>
  frame[size.width * size.height + (y >> 1) * (size.width / 2) + (x >> 1)]!;

test("the bar sits on even rows at the bottom, under a shade", () => {
  expect(barLayout({ width: 1280, height: 720 })).toEqual({
    top: 714,
    bar: 6,
    shadeTop: 690,
    shade: 24,
  });
});

test("the played part is white and the rest lets the picture through", () => {
  const frame = frameOf(100, 200);
  drawProgressBar(frame, size, 0.25);
  const { top, shadeTop } = barLayout(size);
  const bottom = size.height - 1;
  expect(luma(frame, 0, bottom)).toBe(235);
  expect(luma(frame, 15, bottom)).toBe(235);
  expect(u(frame, 15, bottom)).toBe(128);
  // Dimmed and lightened, and paler, but not white.
  expect(luma(frame, 16, top)).toBe(Math.round(100 * 0.5 + 235 * 0.22));
  expect(u(frame, 40, bottom)).toBe(164);
  // The shade darkens towards the bar and leaves the colour.
  expect(luma(frame, 40, top - 1)).toBeLessThan(luma(frame, 40, shadeTop));
  expect(u(frame, 40, top - 2)).toBe(200);
  // Above the shade, nothing changes.
  expect(luma(frame, 40, shadeTop - 1)).toBe(100);
});

test("the overlay draws on a copy, and hands back the same one until the bar moves", () => {
  const overlay = new ProgressBarOverlay(size);
  const frame = frameOf(100, 128);
  const first = overlay.over(frame, 0.5);
  expect(first).not.toBe(frame);
  expect(luma(frame, 0, size.height - 1)).toBe(100);
  expect(overlay.over(frame, 0.501)).toBe(first);
  const moved = overlay.over(frame, 0.75);
  expect(moved).not.toBe(first);
  expect(luma(moved, 40, size.height - 1)).toBe(235);
  expect(overlay.over(frameOf(100, 128), 0.75)).not.toBe(moved);
});

test("the overlay's copies take turns in two buffers, each a new one", () => {
  const overlay = new ProgressBarOverlay(size);
  const drawn = [0.2, 0.4, 0.6].map((amount) =>
    overlay.over(frameOf(100, 128), amount),
  );
  expect(new Set(drawn).size).toBe(3);
  expect(drawn[2]!.buffer).toBe(drawn[0]!.buffer);
  expect(drawn[1]!.buffer).not.toBe(drawn[0]!.buffer);
  // The reused memory holds the latest picture.
  expect(luma(drawn[2]!, 37, size.height - 1)).toBe(235);
  expect(luma(drawn[2]!, 39, size.height - 1)).not.toBe(235);
});
