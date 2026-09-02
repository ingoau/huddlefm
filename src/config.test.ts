import { expect, test } from "bun:test";
import { optionalText, parseIds } from "./config.ts";

test("parses comma and whitespace separated IDs", () => {
  expect([...parseIds("C123,C456 C789\nC123")]).toEqual([
    "C123",
    "C456",
    "C789",
  ]);
});

test("treats blank optional text as unset", () => {
  expect(optionalText()).toBeUndefined();
  expect(optionalText("")).toBeUndefined();
  expect(optionalText("   ")).toBeUndefined();
  expect(optionalText("  *Need help?*  ")).toBe("*Need help?*");
});
