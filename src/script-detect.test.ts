import { expect, test } from "bun:test";
import { containsNonLatin, detectNonLatinLanguage } from "./script-detect.ts";

test("treats Latin text and shared punctuation as already romanized", () => {
  expect(containsNonLatin("Hello, world — ¿qué tal? ♪")).toBe(false);
  expect(containsNonLatin("Beyoncé feat. Sigur Rós")).toBe(false);
});

test("spots text that still needs romanizing", () => {
  for (const text of ["共振で", "안녕하세요", "Привет", "مرحبا"])
    expect(containsNonLatin(text)).toBe(true);
});

test("picks kana over Han for mixed Japanese lines", () => {
  expect(detectNonLatinLanguage("共振で苦しんで")).toBe("ja");
  expect(detectNonLatinLanguage("共振")).toBe("zh");
});

test("names the script's language, or nothing for Latin text", () => {
  expect(detectNonLatinLanguage("안녕하세요")).toBe("ko");
  expect(detectNonLatinLanguage("Привет")).toBe("ru");
  expect(detectNonLatinLanguage("สวัสดี")).toBe("th");
  expect(detectNonLatinLanguage("Hello")).toBe(null);
});
