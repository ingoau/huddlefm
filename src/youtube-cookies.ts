import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger.ts";

const log = logger.child({ component: "youtube-cookies" });

/** Domains whose cookies belong to a YouTube sign-in. */
const accountDomain =
  /^(?:#HttpOnly_)?\.?(?:[\w-]+\.)*(?:youtube|google)\.com$/i;

const header = "# Netscape HTTP Cookie File\n";

/**
 * Only a YouTube or Google sign-in's lines of a Netscape cookies file, or
 * nothing when it has none. Cookies other sites set while yt-dlp fetched from
 * them are dropped rather than kept and sent back.
 */
export function accountCookies(text: string) {
  return serialize(parse(text));
}

/** A cookies file's YouTube and Google lines, by domain, path and name. */
function parse(text: string) {
  const cookies = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split("\t");
    if (fields.length < 7 || !accountDomain.test(fields[0]!)) continue;
    const domain = fields[0]!.replace(/^#HttpOnly_/i, "").toLowerCase();
    cookies.set([domain, fields[2], fields[5]].join("\t"), line);
  }
  return cookies;
}

/**
 * Whether two lines hold the same cookie. yt-dlp drops the `#HttpOnly_`
 * prefix when it saves, which changes nothing it sends.
 */
function same(a: string | undefined, b: string | undefined) {
  const plain = (line?: string) => line?.replace(/^#HttpOnly_/i, "");
  return plain(a) === plain(b);
}

function serialize(cookies: Map<string, string>) {
  return cookies.size
    ? `${header}${[...cookies.values()].join("\n")}\n`
    : undefined;
}

/**
 * A YouTube account's cookies, which yt-dlp signs in with. YouTube rotates
 * them as they are used, and yt-dlp writes the new ones back to the file it
 * was given, so each run gets its own copy, and what it leaves is kept, in
 * memory and in the original file, for the next. Runs never share a file,
 * which yt-dlp rewrites as it finishes.
 */
export class YouTubeCookies {
  private text?: string;
  private saving: Promise<void> = Promise.resolve();
  private saveFailed = false;
  private warnedInvalid = false;

  constructor(private path: string) {}

  /** Reads the cookies; without any, yt-dlp runs signed out. */
  async initialize() {
    try {
      this.text = accountCookies(await Bun.file(this.path).text());
      if (this.text)
        log.info(
          { event: "loaded", path: this.path },
          "YouTube cookies loaded",
        );
      else
        log.error(
          { event: "empty", path: this.path },
          "YouTube cookies file has no YouTube or Google cookies; continuing signed out",
        );
    } catch (error) {
      log.error(
        { event: "unreadable", path: this.path, err: error },
        "Could not read YouTube cookies file; continuing signed out",
      );
    }
  }

  /**
   * Runs yt-dlp with `arguments` that sign it in, if there are cookies, and
   * keeps whatever cookies it leaves behind.
   */
  async use<T extends { stderr: string }>(
    run: (args: string[]) => Promise<T>,
  ): Promise<T> {
    const text = this.text;
    if (!text) return run([]);
    const directory = await mkdtemp(join(tmpdir(), "huddlefm-cookies-"));
    const file = join(directory, "cookies.txt");
    try {
      await writeFile(file, text, { mode: 0o600 });
      try {
        const result = await run(["--cookies", file]);
        this.checkValid(result.stderr);
        return result;
      } finally {
        await this.keep(file, text);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Applies what one run changed to the latest cookies, rather than replacing
   * them with its copy: a long download finishing after shorter runs must not
   * bring back cookies YouTube has since rotated.
   */
  private async keep(file: string, before: string) {
    let after: Map<string, string>;
    try {
      after = parse(await Bun.file(file).text());
    } catch {
      return;
    }
    const started = parse(before);
    const latest = parse(this.text ?? "");
    // Only where no other run has changed the cookie since this one started.
    const untouched = (key: string) => same(latest.get(key), started.get(key));
    for (const [key, line] of after)
      if (!same(line, started.get(key)) && untouched(key))
        latest.set(key, line);
    for (const key of started.keys())
      if (!after.has(key) && untouched(key)) latest.delete(key);
    const text = serialize(latest);
    // A run that lost every cookie, as when yt-dlp failed to write them,
    // leaves the account as it was.
    if (!text || text === this.text) return;
    this.text = text;
    this.saving = this.saving.then(() => this.save()).catch(() => {});
    await this.saving;
  }

  /** Writes the latest cookies over the original file. */
  private async save() {
    if (this.saveFailed || !this.text) return;
    const text = this.text;
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, this.path);
      return;
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
    }
    // A file mounted on its own cannot be replaced, only written.
    try {
      await writeFile(this.path, text);
    } catch (error) {
      this.saveFailed = true;
      log.warn(
        { event: "save_failed", path: this.path, err: error },
        "Could not save refreshed YouTube cookies; they will be lost on restart",
      );
    }
  }

  private checkValid(stderr: string) {
    if (this.warnedInvalid || !/cookies are no longer valid/i.test(stderr))
      return;
    this.warnedInvalid = true;
    log.error(
      { event: "invalid", path: this.path },
      "YouTube says its cookies are no longer valid; export them again",
    );
  }
}
