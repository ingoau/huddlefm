import { expect, test } from "bun:test";
import { volumeGain } from "./volume.ts";

test("maps volume percentages to a logarithmic gain curve", () => {
  expect(volumeGain(0)).toBe(0);
  expect(volumeGain(0.5)).toBeCloseTo(0.1);
  expect(volumeGain(1)).toBe(1);
});
