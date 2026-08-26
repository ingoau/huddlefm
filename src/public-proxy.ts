import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect, isIP } from "node:net";
import { logger } from "./logger.ts";

const log = logger.child({ component: "public-proxy" });

export class PublicNetworkProxy {
  private constructor(private server: ReturnType<typeof createServer>) {}

  static async start() {
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url!);
        if (url.protocol !== "http:")
          throw new Error("Unsupported proxy protocol");
        const target = await publicAddress(url.hostname);
        const upstream = httpRequest(
          {
            host: target.address,
            family: target.family,
            port: url.port || 80,
            method: request.method,
            path: `${url.pathname}${url.search}`,
            headers: { ...request.headers, host: url.host },
          },
          (result) => {
            response.writeHead(result.statusCode ?? 502, result.headers);
            result.pipe(response);
          },
        );
        upstream.on("error", () => response.destroy());
        request.on("error", () => upstream.destroy());
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
      } catch {
        response.writeHead(403).end();
      }
    });
    server.on("connect", async (request, client, head) => {
      try {
        const url = new URL(`http://${request.url}`);
        const target = await publicAddress(url.hostname);
        const upstream = connect(
          {
            host: target.address,
            family: target.family,
            port: Number(url.port || 443),
          },
          () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
          },
        );
        upstream.on("error", () => client.destroy());
        upstream.on("close", () => client.destroy());
        client.on("error", () => upstream.destroy());
        client.on("close", () => upstream.destroy());
      } catch {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    log.info(
      {
        event: "started",
        port: address && typeof address !== "string" ? address.port : undefined,
      },
      "Public network proxy started",
    );
    return new PublicNetworkProxy(server);
  }

  get url() {
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Network proxy is not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  close() {
    return new Promise<void>((resolve, reject) =>
      this.server.close((error) => {
        if (error) return reject(error);
        log.info({ event: "stopped" }, "Public network proxy stopped");
        resolve();
      }),
    );
  }
}

export async function assertPublicUrl(url: URL) {
  if (url.username || url.password)
    throw new Error("Credentials in URLs are not allowed");
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  await publicAddress(url.hostname);
}

async function publicAddress(hostname: string) {
  hostname = hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost"))
    throw new Error("Local URLs are not allowed");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !publicIp(address)))
    throw new Error("Private or reserved network destinations are not allowed");
  return addresses[0]!;
}

export function publicIp(address: string) {
  if (!address.includes(":")) {
    const parts = address.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some(
        (value) => !Number.isInteger(value) || value < 0 || value > 255,
      )
    )
      return false;
    const [a, b, c] = parts;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a! >= 224
    );
  }
  const value = ipv6(address);
  if (value === undefined) return false;
  return ![
    ["::", 128],
    ["::1", 128],
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["5f00::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ].some(([base, bits]) =>
    samePrefix(value, ipv6(String(base))!, Number(bits)),
  );
}

function samePrefix(value: bigint, base: bigint, bits: number) {
  const shift = BigInt(128 - bits);
  return value >> shift === base >> shift;
}

function ipv6(address: string) {
  if (!address.includes(":")) return;
  const [left, right = ""] = address.toLowerCase().split("::");
  if (address.split("::").length > 2) return;
  const parse = (part: string) =>
    part
      ? part.split(":").flatMap((value) => {
          if (!value.includes(".")) return [Number.parseInt(value, 16)];
          const bytes = value.split(".").map(Number);
          return [(bytes[0]! << 8) + bytes[1]!, (bytes[2]! << 8) + bytes[3]!];
        })
      : [];
  const before = parse(left!);
  const after = parse(right);
  const fill = address.includes("::") ? 8 - before.length - after.length : 0;
  const parts = [...before, ...Array(fill).fill(0), ...after];
  if (
    parts.length !== 8 ||
    parts.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 0xffff,
    )
  )
    return;
  return parts.reduce((result, part) => (result << 16n) | BigInt(part), 0n);
}
