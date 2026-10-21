import { logger } from "./logger.ts";

const log = logger.child({ component: "stream-relay" });

/** The first piece after a start or a seek: small, so playback starts soon. */
const firstChunkBytes = 1024 * 1024;
const chunkBytes = 4 * 1024 * 1024;
/** Tries for each piece before the stream gives up and the player retries. */
const attempts = 3;
const retryDelayMs = 500;
const chunkTimeoutMs = 20_000;
/** YouTube's addresses last about six hours; nothing is kept past this. */
const keepMs = 8 * 60 * 60_000;
/** Two for each video: plenty for every queue, and small kept. */
const maxStreams = 1024;

type Upstream = {
  url: string;
  headers: Record<string, string>;
  size: number;
  contentType: string;
  expiresAt: number;
};

export type RelayFetch = (
  url: string,
  init: BunFetchRequestInit,
) => Promise<Response>;

/**
 * Serves a YouTube video's sound or picture to the media process over
 * loopback, fetched from YouTube in pieces as yt-dlp does. ffmpeg reading
 * YouTube's address in one request gets it at about twice the playback rate,
 * so its buffer barely fills and a hiccup freezes the picture or the sound,
 * and an occasional refusal ends the track. Pieces come at the full rate,
 * one is fetched ahead while the last is read, and each is retried.
 */
export class StreamRelay {
  private streams = new Map<string, Upstream>();

  constructor(
    private options: {
      /** The bot's own server, which serves `/stream/<token>`. */
      origin: () => string;
      /** The public network proxy every request to YouTube goes through. */
      proxy: () => string | undefined;
      fetch?: RelayFetch;
      chunkBytes?: number;
      firstChunkBytes?: number;
      retryDelayMs?: number;
    },
  ) {}

  /**
   * The loopback address a YouTube stream plays from, or nothing when its
   * length is not in the address, which the relay needs to answer seeks, or
   * when the relay is full. Either way it is then read directly.
   */
  register(url: string, headers: Record<string, string> = {}) {
    const parsed = new URL(url);
    const size = Number(parsed.searchParams.get("clen"));
    if (!Number.isSafeInteger(size) || size <= 0) return undefined;
    this.prune();
    // A stream still queued or playing is never dropped for a new one.
    if (this.streams.size >= maxStreams) {
      log.warn(
        { event: "relay_full", streams: this.streams.size },
        "Reading the stream directly; the relay is full",
      );
      return undefined;
    }
    const token = crypto.randomUUID().replaceAll("-", "");
    this.streams.set(token, {
      url,
      headers,
      size,
      contentType:
        parsed.searchParams.get("mime") ?? "application/octet-stream",
      expiresAt: Date.now() + keepMs,
    });
    return `${this.options.origin()}/stream/${token}`;
  }

  /** Whether `token` is a stream the relay holds. */
  has(token: string) {
    const upstream = this.streams.get(token);
    return Boolean(upstream && upstream.expiresAt > Date.now());
  }

  /**
   * Answers ffmpeg's request for `/stream/<token>`, ranges included. It
   * waits for the first piece, so a stream YouTube refuses gets an error
   * ffmpeg gives up on, rather than a dropped connection it keeps retrying.
   */
  async handle(request: Request, token: string) {
    const upstream = this.streams.get(token);
    if (!upstream || !this.has(token))
      return new Response("Not found", { status: 404 });
    const range = parseRange(request.headers.get("range"), upstream.size);
    if (!range)
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${upstream.size}` },
      });
    const partial = request.headers.has("range");
    const status = partial ? 206 : 200;
    const headers = {
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-type": upstream.contentType,
      "content-length": String(range.end - range.start + 1),
      ...(partial
        ? {
            "content-range": `bytes ${range.start}-${range.end}/${upstream.size}`,
          }
        : {}),
    };
    if (request.method === "HEAD")
      return new Response(null, { status, headers });
    let body: ReadableStream<Uint8Array>;
    try {
      body = await this.body(upstream, range.start, range.end);
    } catch (error) {
      log.warn(
        { event: "stream_refused", from: range.start, err: error },
        "YouTube would not send the stream",
      );
      return new Response("YouTube would not send the stream", {
        status: 502,
      });
    }
    return new Response(body, { status, headers });
  }

  /**
   * Bytes `start` to `end` of the stream, a piece ahead of the reader, once
   * the first piece is in.
   */
  private async body(upstream: Upstream, start: number, end: number) {
    const abort = new AbortController();
    const first = this.options.firstChunkBytes ?? firstChunkBytes;
    const size = this.options.chunkBytes ?? chunkBytes;
    let next = start;
    const piece = () => {
      if (next > end) return undefined;
      const from = next;
      const to = Math.min(end, from + (from === start ? first : size) - 1);
      next = to + 1;
      return this.piece(upstream, from, to, abort.signal);
    };
    const opening = piece()!;
    let ahead = piece();
    // Nobody may be waiting on it when the reader goes.
    ahead?.catch(() => {});
    let pending: Uint8Array | undefined;
    try {
      pending = await opening;
    } catch (error) {
      abort.abort();
      throw error;
    }
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (pending) {
          controller.enqueue(pending);
          pending = undefined;
          return;
        }
        const current = ahead;
        if (!current) return controller.close();
        ahead = piece();
        ahead?.catch(() => {});
        try {
          controller.enqueue(await current);
        } catch (error) {
          abort.abort();
          // ffmpeg sees the connection fail, and the player picks it up.
          controller.error(error);
        }
      },
      cancel: () => abort.abort(),
    });
  }

  /** One piece of the stream, tried again when YouTube falters. */
  private async piece(
    upstream: Upstream,
    from: number,
    to: number,
    signal: AbortSignal,
  ) {
    const fetcher = this.options.fetch ?? fetch;
    // Nothing goes to YouTube but through the public network proxy.
    const proxy = this.options.proxy();
    if (!proxy) throw new Error("No proxy to fetch the stream through");
    let failure: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (signal.aborted) throw new Error("Stream closed");
      try {
        const response = await fetcher(`${upstream.url}&range=${from}-${to}`, {
          headers: upstream.headers,
          proxy,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(chunkTimeoutMs),
          ]),
        });
        if (!response.ok) throw new Error(`YouTube HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== to - from + 1)
          throw new Error(
            `YouTube sent ${bytes.length} bytes of ${to - from + 1}`,
          );
        return bytes;
      } catch (error) {
        failure = error;
        if (signal.aborted) break;
        log.warn(
          { event: "piece_failed", from, to, attempt, err: error },
          "Fetching a piece of the stream again",
        );
        if (attempt < attempts)
          await Bun.sleep(
            (this.options.retryDelayMs ?? retryDelayMs) * attempt,
          );
      }
    }
    throw failure;
  }

  private prune() {
    const now = Date.now();
    for (const [token, upstream] of this.streams)
      if (upstream.expiresAt <= now) this.streams.delete(token);
  }
}

/** The bytes a Range header asks for, or all of them; nothing if outside. */
export function parseRange(header: string | null, size: number) {
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  // "bytes=-500" is the last 500 bytes.
  if (!match[1]) {
    const length = Math.min(size, Number(match[2]));
    return length > 0 ? { start: size - length, end: size - 1 } : undefined;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return start < size && start <= end ? { start, end } : undefined;
}
