import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountCookies, YouTubeCookies } from "./youtube-cookies.ts";

const line = (domain: string, name: string, value: string) =>
  [domain, "TRUE", "/", "TRUE", "1999999999", name, value].join("\t");

test("keeps only YouTube and Google cookies", () => {
  const text = [
    "# Netscape HTTP Cookie File",
    "# a comment",
    line(".youtube.com", "SID", "a"),
    line("#HttpOnly_.youtube.com", "HSID", "b"),
    line("accounts.google.com", "LSID", "c"),
    line(".soundcloud.com", "sc", "d"),
    line(".notyoutube.com", "x", "e"),
    "",
  ].join("\r\n");
  expect(accountCookies(text)).toBe(
    [
      "# Netscape HTTP Cookie File",
      line(".youtube.com", "SID", "a"),
      line("#HttpOnly_.youtube.com", "HSID", "b"),
      line("accounts.google.com", "LSID", "c"),
      "",
    ].join("\n"),
  );
  expect(accountCookies(line(".example.com", "a", "b"))).toBeUndefined();
});

test("gives each run its own copy and keeps rotated cookies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cookies-test-"));
  try {
    const path = join(directory, "cookies.txt");
    await Bun.write(path, line(".youtube.com", "SID", "old"));
    const cookies = new YouTubeCookies(path);
    await cookies.initialize();

    let used = "";
    await cookies.use(async (args) => {
      expect(args[0]).toBe("--cookies");
      used = args[1]!;
      expect(used).not.toBe(path);
      expect((await stat(used)).mode & 0o777).toBe(0o600);
      expect(await Bun.file(used).text()).toContain("\tSID\told");
      // yt-dlp writes back what YouTube rotated, and what other sites set.
      await Bun.write(
        used,
        [
          line(".youtube.com", "SID", "new"),
          line(".example.com", "x", "y"),
        ].join("\n"),
      );
      return { stderr: "" };
    });
    expect(await Bun.file(used).exists()).toBeFalse();
    const saved = await Bun.file(path).text();
    expect(saved).toContain("\tSID\tnew");
    expect(saved).not.toContain("example.com");

    await cookies.use(async (args) => {
      expect(await Bun.file(args[1]!).text()).toContain("\tSID\tnew");
      return { stderr: "" };
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs signed out without usable cookies", async () => {
  const cookies = new YouTubeCookies("/nonexistent/cookies.txt");
  await cookies.initialize();
  expect(await cookies.use(async (args) => ({ stderr: "", args }))).toEqual({
    stderr: "",
    args: [],
  });
});

test("a run finishing late keeps cookies rotated meanwhile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cookies-test-"));
  try {
    const path = join(directory, "cookies.txt");
    await Bun.write(
      path,
      [
        line(".youtube.com", "SID", "s"),
        line(".youtube.com", "PSIDTS", "0"),
      ].join("\n"),
    );
    const cookies = new YouTubeCookies(path);
    await cookies.initialize();
    let finishLong!: () => void;
    const long = cookies.use(async (args) => {
      await new Promise<void>((resolve) => (finishLong = resolve));
      // Rewritten as it started, plus one cookie of its own.
      await Bun.write(
        args[1]!,
        [
          line(".youtube.com", "SID", "s"),
          line(".youtube.com", "PSIDTS", "0"),
          line(".youtube.com", "YSC", "long"),
        ].join("\n"),
      );
      return { stderr: "" };
    });
    while (!finishLong) await Bun.sleep(1);
    await cookies.use(async (args) => {
      await Bun.write(
        args[1]!,
        [
          line(".youtube.com", "SID", "s"),
          line(".youtube.com", "PSIDTS", "1"),
        ].join("\n"),
      );
      return { stderr: "" };
    });
    finishLong();
    await long;
    const saved = await Bun.file(path).text();
    expect(saved).toContain("\tPSIDTS\t1");
    expect(saved).not.toContain("\tPSIDTS\t0");
    expect(saved).toContain("\tYSC\tlong");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
