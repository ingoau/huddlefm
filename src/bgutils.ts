import { mkdir, rename, rm } from "node:fs/promises";

const version = "1.3.1";

export class BgUtilsProvider {
  readonly url: string;
  private process?: ReturnType<typeof Bun.spawn>;

  constructor(private port: number) {
    this.url = `http://127.0.0.1:${port}`;
  }

  async start() {
    const running = await this.ping();
    if (running) {
      if (running !== version) throw new Error(`BgUtils server version ${running} does not match ${version}`);
      return;
    }
    const directory = await this.install();
    this.process = Bun.spawn(["node", "build/main.js", "--port", String(this.port)], {
      cwd: `${directory}/server`,
      stdout: "ignore",
      stderr: "inherit",
    });
    for (let attempt = 0; attempt < 150; attempt++) {
      const running = await this.ping();
      if (running === version) return;
      if (this.process.exitCode !== null) break;
      await Bun.sleep(100);
    }
    await this.close();
    throw new Error("BgUtils server failed to start");
  }

  async close() {
    if (!this.process) return;
    this.process.kill();
    await this.process.exited;
    this.process = undefined;
  }

  private async ping() {
    try {
      const response = await fetch(`${this.url}/ping`);
      if (!response.ok) return;
      return String((await response.json() as { version?: unknown }).version ?? "");
    } catch {
      return;
    }
  }

  private async install() {
    const directory = `data/bgutils/${version}`;
    if (await Bun.file(`${directory}/server/build/main.js`).exists()) return directory;
    await mkdir("data/bgutils", { recursive: true });
    const temporary = `${directory}-${crypto.randomUUID()}`;
    try {
      await run(["git", "clone", "--depth", "1", "--branch", version,
        "https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git", temporary]);
      const main = `${temporary}/server/src/main.ts`;
      const source = await Bun.file(main).text();
      if (!source.includes('host: "::"') || !source.includes('host: "0.0.0.0"'))
        throw new Error("Could not restrict BgUtils server to loopback");
      await Bun.write(main, source.replace('host: "::"', 'host: "127.0.0.1"')
        .replace('host: "0.0.0.0"', 'host: "127.0.0.1"'));
      const sessionManager = `${temporary}/server/src/session_manager.ts`;
      const sessions = await Bun.file(sessionManager).text();
      await Bun.write(sessionManager, sessions.replace(
        "        return async (url: any, options: any): Promise<any> => {",
        "        return Object.assign(async (url: any, options: any): Promise<any> => {",
      ).replace(
        "        };\n    }\n\n    async generatePoToken",
        "        }, { preconnect() {} });\n    }\n\n    async generatePoToken",
      ));
      await run(["npm", "ci"], `${temporary}/server`);
      await run(["npm", "exec", "tsc"], `${temporary}/server`);
      await rename(temporary, directory);
      return directory;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}

async function run(command: string[], cwd?: string) {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code) throw new Error(`${command.join(" ")} failed:\n${stderr || stdout}`.trim());
}
