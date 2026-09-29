import { expect, test } from "bun:test";
import { parseIds, parseMediaBackend, parseWholeNumber } from "./config.ts";

test("parses comma and whitespace separated IDs", () => {
  expect([...parseIds("C123,C456 C789\nC123")]).toEqual([
    "C123",
    "C456",
    "C789",
  ]);
});

test("uses the browser media backend unless native is chosen", () => {
  expect(parseMediaBackend(undefined)).toBe("browser");
  expect(parseMediaBackend("")).toBe("browser");
  expect(parseMediaBackend("chromium")).toBe("browser");
  expect(parseMediaBackend(" Native ")).toBe("native");
});

test("falls back when a count is unset, fractional, or too small", () => {
  expect(parseWholeNumber(undefined, 2, 1)).toBe(2);
  expect(parseWholeNumber(" ", 2, 1)).toBe(2);
  expect(parseWholeNumber("4", 2, 1)).toBe(4);
  expect(parseWholeNumber("0", 2, 1)).toBe(2);
  expect(parseWholeNumber("0", 30)).toBe(0);
  expect(parseWholeNumber("1.5", 2, 1)).toBe(2);
  expect(parseWholeNumber("lots", 2, 1)).toBe(2);
});

test("an offset may be negative, within its bounds", () => {
  expect(parseWholeNumber("-250", 0, -10_000)).toBe(-250);
  expect(parseWholeNumber("300", 0, -10_000)).toBe(300);
  expect(parseWholeNumber("-20000", 0, -10_000)).toBe(0);
  expect(parseWholeNumber("150000", 0, -10_000, 10_000)).toBe(0);
});
