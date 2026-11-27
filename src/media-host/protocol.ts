// What the Slack app and a media host (src/media-host/host.ts) say to each
// other over the host's Unix socket. Both ends speak JSON lines. A connection
// opens with one hello line, `host` naming what it is for:
//
// - `start`: run a new media process with the bootstrap, then pass lines
//   both ways, as the process's stdin and stdout were before.
// - `attach`: pick up a running media process after the app restarted. The
//   host answers `attached` and replays what the process said meanwhile, or
//   answers `missing`.
// - `list`: the host answers `sessions` with the media processes it runs.
// - `close`: the host ends one media process, which leaves its huddle.
//
// On a session's connection, the app may also send `tag` (who the session
// belongs to, which `list` reports), `detach` (the app is going away and will
// attach again) and `close`; the host sends `exited` when the process ends.
// Every other line is the media process's own.

import type { ChimeBootstrap } from "../slack-huddle.ts";

/** Bumped when either end changes the hello or the host's own lines. */
export const mediaHostProtocol = 1;

export const hostSocketName = "media.sock";
/** Where the app serves the media routes for the host's loopback proxy. */
export const appSocketName = "app.sock";
/** Where the app passes connections on to its public network proxy. */
export const proxySocketName = "proxy.sock";

/**
 * The app's loopback ports the media processes use: its HTTP port, and its
 * public network proxy's, which streams go through.
 */
type AppPorts = { httpPort: number; proxyPort?: number };

export type HostHello =
  | ({
      host: "start";
      protocol: number;
      bootstrap: ChimeBootstrap;
    } & AppPorts)
  | ({ host: "attach"; protocol: number; sessionId: string } & AppPorts)
  | { host: "list"; protocol: number }
  | { host: "close"; protocol: number; sessionId: string };

/** What the app keeps with a session on the host, to attach to it again. */
export type HostedTag = {
  /** The coordinator's session id, whose saved session has the rest. */
  owner: string;
};

export type HostedSession = {
  sessionId: string;
  bootstrap: ChimeBootstrap;
  tag?: HostedTag;
  attached: boolean;
};

export type HostReply =
  | { host: "started" }
  | { host: "attached" }
  | { host: "missing" }
  | {
      host: "sessions";
      protocol: number;
      code: string;
      sessions: HostedSession[];
    }
  | { host: "closed" }
  | { host: "exited"; code: number | null }
  | { host: "error"; message: string };

const mediaDirectory = new URL("../native-media/", import.meta.url);
const root = new URL("../../", import.meta.url);

let codeHash: Promise<string> | undefined;

/** The media host's code: every file it and the media processes import. */
async function hostedFiles() {
  const roots = [
    ...new Bun.Glob("*.{ts,proto}").scanSync({ cwd: mediaDirectory.pathname }),
  ]
    .filter((name) => !name.endsWith(".test.ts"))
    .map((name) => new URL(name, mediaDirectory).pathname);
  roots.push(
    new URL("./main.ts", import.meta.url).pathname,
    new URL("./host.ts", import.meta.url).pathname,
  );
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const files = new Set<string>();
  const visit = async (path: string) => {
    if (files.has(path)) return;
    files.add(path);
    if (!path.endsWith(".ts")) return;
    const source = await Bun.file(path).text();
    for (const { path: specifier } of transpiler.scanImports(source))
      if (specifier.startsWith("."))
        await visit(new URL(specifier, `file://${path}`).pathname);
  };
  for (const path of roots) await visit(path);
  return [...files].sort();
}

/**
 * A hash of the media host's code, its packages and its Bun, so the app can
 * tell when the host runs other media code than its own image has.
 */
export function mediaCodeHash() {
  codeHash ??= (async () => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`bun ${Bun.version}\0`);
    const lockfile = Bun.file(new URL("bun.lock", root));
    if (await lockfile.exists()) hasher.update(await lockfile.bytes());
    for (const path of await hostedFiles()) {
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      hasher.update(`${path.slice(root.pathname.length)}\0`);
      hasher.update(await file.bytes());
    }
    return hasher.digest("hex").slice(0, 16);
  })();
  return codeHash;
}
