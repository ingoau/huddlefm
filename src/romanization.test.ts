import { expect, test } from "bun:test";
import type { Lyric } from "@braccato/core";
import {
  enrichLyricsWithRomanization,
  lyricsHaveRomanization,
  type RomanizeFetch,
} from "./romanization.ts";

function line(words: string, extra: Partial<Lyric> = {}): Lyric {
  return { startTimeMs: 0, durationMs: 1000, words, ...extra };
}

test("leaves Latin lyrics untouched", async () => {
  const lines = [line("Hello world"), line("Another line")];
  await enrichLyricsWithRomanization(lines, {
    fetch: (() => {
      throw new Error("should not fetch");
    }) as RomanizeFetch,
  });
  expect(lines.every((item) => !item.romanization)).toBe(true);
  expect(lyricsHaveRomanization(lines)).toBe(false);
});

test("keeps provider-supplied romanization", async () => {
  const lines = [
    line("안녕하세요", { romanization: "annyeonghaseyo" }),
    line("세계"),
  ];
  await enrichLyricsWithRomanization(lines, {
    fetch: (async () =>
      new Response(
        JSON.stringify({
          lines: [
            {
              translation: "world",
              romanization: "segye",
              needsTranslation: true,
            },
          ],
          detectedLang: "ko",
        }),
        { status: 200 },
      )) as RomanizeFetch,
  });
  expect(lines[0]!.romanization).toBe("annyeonghaseyo");
  expect(lines[1]!.romanization).toBe("segye");
  expect(lyricsHaveRomanization(lines)).toBe(true);
});

test("enriches whitespace-only romanization values", async () => {
  const lines = [
    line("안녕하세요", { romanization: "   " }),
    line("세계", { romanization: "segye" }),
    line("한글", { isInstrumental: true, romanization: "   " }),
  ];
  await enrichLyricsWithRomanization(lines, {
    fetch: (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.lines).toEqual(["안녕하세요"]);
      return new Response(
        JSON.stringify({ lines: [{ romanization: "annyeonghaseyo" }] }),
        { status: 200 },
      );
    }) as RomanizeFetch,
  });
  expect(lines[0]!.romanization).toBe("annyeonghaseyo");
  expect(lines[1]!.romanization).toBe("segye");
  expect(lines[2]!.romanization).toBe("   ");
});

test("uses Unison romanization when available", async () => {
  const lines = [line("你好世界"), line("再见")];
  const urls: string[] = [];
  await enrichLyricsWithRomanization(lines, {
    videoId: "abc",
    fetch: (async (input, init) => {
      urls.push(String(input));
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.lines).toEqual(["你好世界", "再见"]);
      expect(body.from).toBe("zh");
      expect(body.videoId).toBe("abc");
      return new Response(
        JSON.stringify({
          lines: [
            {
              translation: "Hello World",
              romanization: "Nǐ hǎo shìjiè",
              needsTranslation: true,
            },
            {
              translation: "Goodbye",
              romanization: "Zàijiàn",
              needsTranslation: true,
            },
          ],
          detectedLang: "zh",
        }),
        { status: 200 },
      );
    }) as RomanizeFetch,
  });
  expect(urls).toEqual(["https://unison.boidu.dev/translate"]);
  expect(lines[0]!.romanization).toBe("Nǐ hǎo shìjiè");
  expect(lines[1]!.romanization).toBe("Zàijiàn");
});

test("romanizes mixed scripts in language-specific batches", async () => {
  const lines = [line("안녕하세요"), line("你好")];
  const batches: { from?: string; lines: string[] }[] = [];
  await enrichLyricsWithRomanization(lines, {
    fetch: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        from?: string;
        lines: string[];
      };
      batches.push({ from: body.from, lines: body.lines });
      if (body.from === "ko")
        return new Response(
          JSON.stringify({
            lines: [
              {
                translation: "hello",
                romanization: "annyeonghaseyo",
                needsTranslation: true,
              },
            ],
            detectedLang: "ko",
          }),
          { status: 200 },
        );
      return new Response(
        JSON.stringify({
          lines: [
            {
              translation: "hello",
              romanization: "nǐ hǎo",
              needsTranslation: true,
            },
          ],
          detectedLang: "zh",
        }),
        { status: 200 },
      );
    }) as RomanizeFetch,
  });
  expect(batches.map(({ from, lines }) => ({ from, lines }))).toEqual([
    { from: "ko", lines: ["안녕하세요"] },
    { from: "zh", lines: ["你好"] },
  ]);
  expect(lines[0]!.romanization).toBe("annyeonghaseyo");
  expect(lines[1]!.romanization).toBe("nǐ hǎo");
});

test("falls back to Google romaji when Unison omits romanization", async () => {
  const lines = [line("こんにちは")];
  const urls: string[] = [];
  await enrichLyricsWithRomanization(lines, {
    fetch: (async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("unison.boidu.dev"))
        return new Response(
          JSON.stringify({
            lines: [
              {
                translation: "Hello",
                romanization: null,
                needsTranslation: true,
              },
            ],
            detectedLang: "ja",
          }),
          { status: 200 },
        );
      return new Response(
        JSON.stringify([[["こんにちは", "こんにちは", null, "Konnichiwa"]]]),
        { status: 200 },
      );
    }) as RomanizeFetch,
  });
  expect(urls[0]).toContain("unison.boidu.dev/translate");
  expect(urls[1]).toContain("translate.googleapis.com");
  expect(lines[0]!.romanization).toBe("Konnichiwa");
});

test("shares one timeout signal across sequential providers", async () => {
  const lines = [line("こんにちは")];
  const signals: (AbortSignal | null | undefined)[] = [];
  await enrichLyricsWithRomanization(lines, {
    fetch: (async (input, init) => {
      signals.push(init?.signal);
      if (String(input).includes("unison.boidu.dev"))
        return new Response(
          JSON.stringify({ lines: [{ romanization: null }] }),
          {
            status: 200,
          },
        );
      return new Response(
        JSON.stringify([[["こんにちは", "こんにちは", null, "Konnichiwa"]]]),
        { status: 200 },
      );
    }) as RomanizeFetch,
  });
  expect(signals).toHaveLength(2);
  expect(signals[0]).toBe(signals[1]);
  expect(lines[0]!.romanization).toBe("Konnichiwa");
});

test("uses local transliteration without trying Google after abort", async () => {
  const lines = [line("Привет")];
  const controller = new AbortController();
  let calls = 0;
  await enrichLyricsWithRomanization(lines, {
    signal: controller.signal,
    fetch: (async () => {
      calls += 1;
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as RomanizeFetch,
  });
  expect(calls).toBe(1);
  expect(lines[0]!.romanization?.toLowerCase()).toContain("privet");
});

test("uses local transliteration when remote providers fail", async () => {
  const lines = [line("안녕하세요"), line("Привет")];
  await enrichLyricsWithRomanization(lines, {
    fetch: (async () => {
      throw new Error("offline");
    }) as RomanizeFetch,
  });
  expect(lines[0]!.romanization?.toLowerCase()).toContain("annyeong");
  expect(lines[1]!.romanization?.toLowerCase()).toContain("privet");
});

test("skips instrumental lines and music-note placeholders", async () => {
  const lines = [line("♪", { isInstrumental: true }), line("♪"), line("한글")];
  await enrichLyricsWithRomanization(lines, {
    fetch: (async () =>
      new Response(
        JSON.stringify({
          lines: [
            {
              translation: "Hangul",
              romanization: "hangeul",
              needsTranslation: true,
            },
          ],
          detectedLang: "ko",
        }),
        { status: 200 },
      )) as RomanizeFetch,
  });
  expect(lines[0]!.romanization).toBeUndefined();
  expect(lines[1]!.romanization).toBeUndefined();
  expect(lines[2]!.romanization).toBe("hangeul");
});
