import { expect, test } from "bun:test";
import { FfmpegLog, inputArgs } from "./decoder.ts";

test("opens a prepared file at where it is to start", () => {
  expect(inputArgs("file.opus", 12.5)).toEqual([
    "-ss",
    "12.500",
    "-i",
    "file.opus",
  ]);
  expect(inputArgs("file.opus", 0)).toEqual(["-i", "file.opus"]);
});

test("reads a stream through the proxy, riding out drops, with its headers", () => {
  expect(
    inputArgs("https://example.com/a.m3u8", 30, {
      proxy: "http://127.0.0.1:4000",
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://example.com/",
        "Bad Header": "x",
        Smuggled: "a\r\nX-Other: b",
      },
    }),
  ).toEqual([
    "-ss",
    "30.000",
    "-http_proxy",
    "http://127.0.0.1:4000",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_delay_max",
    "10",
    "-rw_timeout",
    "30000000",
    "-user_agent",
    "Mozilla/5.0",
    "-headers",
    "Referer: https://example.com/\r\n",
    "-i",
    "https://example.com/a.m3u8",
  ]);
});

test("a live stream joins where it is, never at a position", () => {
  const args = inputArgs("https://example.com/live.m3u8", 300, { live: true });
  expect(args).not.toContain("-ss");
  expect(args.slice(-2)).toEqual(["-i", "https://example.com/live.m3u8"]);
});

test("reads where the input starts and the last error from ffmpeg's log", async () => {
  const log = new FfmpegLog(
    new Response(
      [
        "[info] Input #0, hls, from 'https://example.com/live.m3u8?token=secret':",
        "[info]   Duration: N/A, start: 1001.376778, bitrate: N/A",
        "[hls @ 0x1] [info] Opening 'https://example.com/seg1.ts' for reading",
        "[warning] Something odd",
        "[in#0 @ 0x2] [error] Error opening input: Server returned 403 Forbidden",
        "[info]   Duration: 00:00:10.00, start: 5.000000, bitrate: 1 kb/s",
        "",
      ].join("\n"),
    ).body!,
  );
  await log.done;
  expect(log.start).toBe(1001.376778);
  expect(log.lastError).toBe(
    "Error opening input: Server returned 403 Forbidden",
  );
});
