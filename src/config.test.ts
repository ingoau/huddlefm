import { expect, test } from "bun:test";
import { parseIds, parseMediaBackend } from "./config.ts";

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
