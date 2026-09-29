import type { BunFile } from "bun";

/**
 * Serves a file, honouring a single-range `Range` header. Bun only does that
 * for static routes, not for a response built in `fetch`, and without it a
 * seek has to read the file from the top: ffmpeg in the native media backend
 * and the media page's <audio> both seek with ranges.
 */
export function fileResponse(
  file: BunFile,
  request: Request,
  headers: Record<string, string> = {},
) {
  const size = file.size;
  const base = { ...headers, "accept-ranges": "bytes" };
  const range = parseRange(request.headers.get("range"), size);
  if (range === undefined) return new Response(file, { headers: base });
  if (range === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { ...base, "content-range": `bytes */${size}` },
    });
  const { start, end } = range;
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...base,
      "content-type": file.type,
      "content-range": `bytes ${start}-${end}/${size}`,
    },
  });
}

/**
 * The byte range a `Range` header asks for, per RFC 9110. Anything it cannot
 * serve as one range (no header, another unit, several ranges, a malformed
 * one) is undefined, which serves the whole file as the RFC allows.
 */
export function parseRange(header: string | null, size: number) {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return;
  const [, first, last] = match as unknown as [string, string, string];
  if (!first) {
    if (!last) return;
    // A suffix: the last `last` bytes.
    const length = Number(last);
    if (length === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  if (last && Number(last) < start) return;
  if (start >= size) return "unsatisfiable";
  const end = last ? Math.min(Number(last), size - 1) : size - 1;
  return { start, end };
}
