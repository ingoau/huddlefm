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

export type HostHello =
  | {
      host: "start";
      protocol: number;
      httpPort: number;
      bootstrap: ChimeBootstrap;
    }
  | { host: "attach"; protocol: number; httpPort: number; sessionId: string }
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

/** The source directories whose changes need a media host restart. */
const hostedSources = [
  new URL("../native-media/", import.meta.url),
  new URL("./", import.meta.url),
];

let codeHash: Promise<string> | undefined;

/**
 * A hash of the media host's own code, so the app can tell when the host runs
 * older media code than its own image has.
 */
export function mediaCodeHash() {
  codeHash ??= (async () => {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const directory of hostedSources) {
      const glob = new Bun.Glob("*.{ts,proto}");
      const names = [...glob.scanSync({ cwd: directory.pathname })]
        .filter((name) => !name.endsWith(".test.ts"))
        .sort();
      for (const name of names) {
        hasher.update(`${name}\0`);
        hasher.update(await Bun.file(new URL(name, directory)).bytes());
      }
    }
    return hasher.digest("hex").slice(0, 16);
  })();
  return codeHash;
}
