import { expect, test } from "bun:test";
import { effectiveDisplayMode } from "./display-mode.ts";

test("keeps preferred mode while lyrics availability is unknown", () => {
  expect(effectiveDisplayMode("lyrics", undefined)).toBe("lyrics");
  expect(effectiveDisplayMode("default", undefined)).toBe("default");
  expect(effectiveDisplayMode("off", undefined)).toBe("off");
});

test("falls back from lyrics to album art when lyrics are unavailable", () => {
  expect(effectiveDisplayMode("lyrics", false)).toBe("default");
});

test("shows lyrics when preferred and available", () => {
  expect(effectiveDisplayMode("lyrics", true)).toBe("lyrics");
});

test("does not override default or off based on lyrics", () => {
  expect(effectiveDisplayMode("default", false)).toBe("default");
  expect(effectiveDisplayMode("default", true)).toBe("default");
  expect(effectiveDisplayMode("off", false)).toBe("off");
  expect(effectiveDisplayMode("off", true)).toBe("off");
});
