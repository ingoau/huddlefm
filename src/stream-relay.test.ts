import { expect, test } from "bun:test";
import { parseRange, StreamRelay, type RelayFetch } from "./stream-relay.ts";

const size = 50;
const content = Uint8Array.from({ length: size }, (_, index) => index);
const youtube = `https://rr1---sn.googlevideo.com/videoplayback?id=x&clen=${size}&mime=audio%2Fwebm`;

/** A relay over a fake YouTube that answers `&range=` with that slice. */
function relay(
  fail: (from: number, attempt: number) => number | undefined = () => undefined,
) {
  const requests: { from: number; to: number; init: BunFetchRequestInit }[] =
    [];
  const tries = new Map<number, number>();
  const fetch: RelayFetch = async (url, init) => {
    const [from, to] = new URL(url).searchParams
      .get("range")!
      .split("-")
      .map(Number) as [number, number];
    requests.push({ from, to, init });
    const attempt = (tries.get(from) ?? 0) + 1;
    tries.set(from, attempt);
    const status = fail(from, attempt);
    if (status) return new Response("no", { status });
    return new Response(content.slice(from, to + 1));
  };
  return {
    requests,
    relay: new StreamRelay({
      origin: () => "http://127.0.0.1:3210",
      proxy: () => "http://127.0.0.1:4000",
      fetch,
      firstChunkBytes: 4,
      chunkBytes: 10,
      retryDelayMs: 1,
    }),
  };
}

const token = (url: string) =>
  url.slice("http://127.0.0.1:3210/stream/".length);
const bytes = async (response: Response) =>
  new Uint8Array(await response.arrayBuffer());

test("relays a YouTube stream in pieces, through the proxy, with its headers", async () => {
  const { relay: value, requests } = relay();
  const url = value.register(youtube, { "User-Agent": "yt-dlp" })!;
  expect(url).toStartWith("http://127.0.0.1:3210/stream/");
  const response = await value.handle(new Request(url), token(url));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe(String(size));
  expect(response.headers.get("content-type")).toBe("audio/webm");
  expect(await bytes(response)).toEqual(content);
  // A small first piece to start soon, then bigger ones.
  expect(requests.map(({ from, to }) => [from, to])).toEqual([
    [0, 3],
    [4, 13],
    [14, 23],
    [24, 33],
    [34, 43],
    [44, 49],
  ]);
  expect(requests[0]!.init.proxy).toBe("http://127.0.0.1:4000");
  expect(requests[0]!.init.headers).toEqual({ "User-Agent": "yt-dlp" });
});

test("answers ffmpeg's seeks with the range it asked for", async () => {
  const { relay: value } = relay();
  const url = value.register(youtube)!;
  const seek = await value.handle(
    new Request(url, { headers: { range: "bytes=20-" } }),
    token(url),
  );
  expect(seek.status).toBe(206);
  expect(seek.headers.get("content-range")).toBe(`bytes 20-49/${size}`);
  expect(await bytes(seek)).toEqual(content.slice(20));
  const tail = await value.handle(
    new Request(url, { headers: { range: "bytes=-5" } }),
    token(url),
  );
  expect(await bytes(tail)).toEqual(content.slice(45));
  const past = await value.handle(
    new Request(url, { headers: { range: "bytes=60-" } }),
    token(url),
  );
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe(`bytes */${size}`);
});

test("a piece YouTube refuses is fetched again", async () => {
  const { relay: value, requests } = relay((from, attempt) =>
    from === 14 && attempt < 3 ? 403 : undefined,
  );
  const url = value.register(youtube)!;
  expect(await bytes(await value.handle(new Request(url), token(url)))).toEqual(
    content,
  );
  expect(requests.filter(({ from }) => from === 14)).toHaveLength(3);
});

test("a piece that keeps failing ends the stream, for the player to retry", async () => {
  const { relay: value } = relay((from) => (from === 14 ? 403 : undefined));
  const url = value.register(youtube)!;
  await expect(
    (await value.handle(new Request(url), token(url))).arrayBuffer(),
  ).rejects.toThrow("YouTube HTTP 403");
});

test("closing the connection stops fetching", async () => {
  const { relay: value, requests } = relay();
  const url = value.register(youtube)!;
  const reader = (
    await value.handle(new Request(url), token(url))
  ).body!.getReader();
  await reader.read();
  await reader.cancel();
  await Bun.sleep(5);
  // The first piece, and the one fetched ahead of it, but no more.
  expect(requests.length).toBeLessThanOrEqual(3);
  expect(requests.at(-1)!.init.signal!.aborted).toBeTrue();
});

test("only relays what it registered, and only with a known length", async () => {
  const { relay: value } = relay();
  expect(
    value.register("https://rr1---sn.googlevideo.com/videoplayback?id=x"),
  ).toBeUndefined();
  expect(
    (await value.handle(new Request("http://127.0.0.1/stream/x"), "x")).status,
  ).toBe(404);
});

test("parses the ranges ffmpeg sends", () => {
  expect(parseRange(null, 100)).toEqual({ start: 0, end: 99 });
  expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
  expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
  expect(parseRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
  expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  expect(parseRange("bytes=100-", 100)).toBeUndefined();
  expect(parseRange("bytes=20-10", 100)).toBeUndefined();
  expect(parseRange("items=0-1", 100)).toBeUndefined();
});

test("a full relay keeps what it has, and the new stream is read directly", async () => {
  const { relay: value } = relay();
  const first = value.register(youtube)!;
  for (let index = 1; index < 1024; index++)
    expect(value.register(youtube)).toBeDefined();
  expect(value.register(youtube)).toBeUndefined();
  // The oldest still plays.
  expect(
    await bytes(await value.handle(new Request(first), token(first))),
  ).toEqual(content);
});

test("a stream YouTube refuses from the start gets an error, not a dropped connection", async () => {
  const { relay: value } = relay((from) => (from === 20 ? 403 : undefined));
  const url = value.register(youtube)!;
  const refused = await value.handle(
    new Request(url, { headers: { range: "bytes=20-" } }),
    token(url),
  );
  expect(refused.status).toBe(502);
});

test("nothing goes to YouTube without the proxy", async () => {
  const requests: string[] = [];
  const value = new StreamRelay({
    origin: () => "http://127.0.0.1:3210",
    proxy: () => undefined,
    fetch: async (url) => (requests.push(url), new Response(content)),
  });
  const url = value.register(youtube)!;
  expect((await value.handle(new Request(url), token(url))).status).toBe(502);
  expect(requests).toEqual([]);
});

test("HEAD describes the range it was asked for", async () => {
  const { relay: value, requests } = relay();
  const url = value.register(youtube)!;
  const head = await value.handle(
    new Request(url, { method: "HEAD", headers: { range: "bytes=10-" } }),
    token(url),
  );
  expect(head.status).toBe(206);
  expect(head.headers.get("content-range")).toBe(`bytes 10-49/${size}`);
  expect(head.headers.get("content-length")).toBe("40");
  expect(requests).toEqual([]);
});

test("knows which streams it holds", () => {
  const { relay: value } = relay();
  const url = value.register(youtube)!;
  expect(value.has(token(url))).toBeTrue();
  expect(value.has("unknown")).toBeFalse();
});
