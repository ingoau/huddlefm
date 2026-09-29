import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileResponse, parseRange } from "./file-response.ts";

const directory = await mkdtemp(join(tmpdir(), "huddlefm-range-"));
const path = join(directory, "track.m4a");
const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
await Bun.write(path, bytes);
afterAll(() => rm(directory, { recursive: true, force: true }));

const request = (range?: string) =>
  new Request("http://127.0.0.1/audio/a", {
    headers: range ? { range } : {},
  });

describe("parseRange", () => {
  test("reads the three single-range forms", () => {
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-5", 100)).toEqual({ start: 95, end: 99 });
    // Past the end is cut to the file.
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  test("serves the whole file for anything it cannot serve as one range", () => {
    for (const header of [
      null,
      "",
      "bytes=-",
      "bytes=20-10",
      "bytes=0-1,5-6",
      "items=0-1",
      "bytes=a-b",
    ])
      expect(parseRange(header, 100)).toBeUndefined();
  });

  test("a range past the end cannot be satisfied", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});

describe("fileResponse", () => {
  test("serves the whole file and says ranges work", async () => {
    const response = fileResponse(Bun.file(path), request(), {
      "cache-control": "no-store",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test("serves a range", async () => {
    const response = fileResponse(Bun.file(path), request("bytes=10-19"));
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(response.headers.get("content-type")).toBe(Bun.file(path).type);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      bytes.slice(10, 20),
    );
  });

  test("refuses a range past the end", () => {
    const response = fileResponse(Bun.file(path), request("bytes=200-"));
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */100");
  });
});
