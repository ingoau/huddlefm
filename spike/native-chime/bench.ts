// Throwaway spike: run one backend (media.ts or chromium.ts), sample its whole
// process tree, and time its MARK lines, so both are measured the same way.
// Usage: bun bench.ts <native|chromium> [--label L] -- <args for the backend>
import { writeFileSync, mkdirSync } from "node:fs";

const [kind, ...rest] = process.argv.slice(2);
if (kind !== "native" && kind !== "chromium") {
  console.error("usage: bun bench.ts <native|chromium> [--label L] -- ...");
  process.exit(2);
}
const sep = rest.indexOf("--");
const own = sep < 0 ? rest : rest.slice(0, sep);
const passArgs = sep < 0 ? [] : rest.slice(sep + 1);
const label = own[own.indexOf("--label") + 1] ?? kind;
const script = kind === "native" ? "media.ts" : "chromium.ts";

const t0 = performance.now();
const at = () => (performance.now() - t0) / 1000;
const marks: Record<string, number> = {};
const child = Bun.spawn(["bun", script, ...passArgs], {
  cwd: import.meta.dir,
  stdout: "pipe",
  stderr: "inherit",
  env: process.env,
});

// ---- process tree sampling ---------------------------------------------------
type Proc = {
  pid: number;
  ppid: number;
  rss: number;
  cpu: number;
  comm: string;
};
function cpuSeconds(time: string) {
  // ps TIME is [[dd-]hh:]mm:ss.cc
  const [day, rest] = time.includes("-") ? time.split("-") : ["0", time];
  return (
    rest
      .split(":")
      .map(Number)
      .reduce((acc, part) => acc * 60 + part, 0) +
    Number(day) * 86400
  );
}
function tree(root: number): Proc[] {
  const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,rss=,time=,comm="])
    .stdout.toString()
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, rss, time, ...comm] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        rss: Number(rss) * 1024,
        cpu: cpuSeconds(time),
        comm: comm.join(" ").split("/").pop()!,
      };
    });
  const kids = new Map<number, Proc[]>();
  for (const p of out) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const result: Proc[] = [];
  const walk = (pid: number) => {
    for (const p of kids.get(pid) ?? []) {
      result.push(p);
      walk(p.pid);
    }
  };
  const self = out.find((p) => p.pid === root);
  if (self) result.push(self);
  walk(root);
  return result;
}
const samples: {
  t: number;
  rss: number;
  cpu: number;
  procs: number;
  byName: Record<string, { rss: number; cpu: number; n: number }>;
}[] = [];
const sampler = setInterval(() => {
  const procs = tree(child.pid);
  if (!procs.length) return;
  const byName: Record<string, { rss: number; cpu: number; n: number }> = {};
  for (const p of procs) {
    // Chromium helpers keep their role, e.g. "Google Chrome Helper (Renderer)".
    const entry = (byName[p.comm] ??= { rss: 0, cpu: 0, n: 0 });
    entry.rss += p.rss;
    entry.cpu += p.cpu;
    entry.n++;
  }
  samples.push({
    t: at(),
    rss: procs.reduce((a, p) => a + p.rss, 0),
    cpu: procs.reduce((a, p) => a + p.cpu, 0),
    procs: procs.length,
    byName,
  });
}, 1000);

// ---- output + marks ------------------------------------------------------------
const decoder = new TextDecoder();
let pending = "";
const lines: string[] = [];
for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
  pending += decoder.decode(chunk, { stream: true });
  let nl;
  while ((nl = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    lines.push(line);
    const mark = line.match(/MARK (\w+)/);
    if (mark && marks[mark[1]] === undefined) marks[mark[1]] = at();
    console.log(line);
  }
}
await child.exited;
clearInterval(sampler);

// ---- summary -------------------------------------------------------------------
// Steady state: from 10 s after audio starts flowing.
const steadyFrom = (marks.audio_flowing ?? 0) + 10;
// It ends when the backend leaves (Chromium's processes exit after that).
const steadyTo = marks.left ?? Infinity;
const steady = samples.filter((s) => s.t >= steadyFrom && s.t < steadyTo);
const first = steady[0],
  last = steady.at(-1);
const mb = (b: number) => Math.round(b / 1048576);
const summary = {
  label,
  kind,
  marks: Object.fromEntries(
    Object.entries(marks).map(([k, v]) => [k, Number(v.toFixed(2))]),
  ),
  steadySeconds: first && last ? Number((last.t - first.t).toFixed(1)) : 0,
  cpuPercent:
    first && last && last.t > first.t
      ? Number((((last.cpu - first.cpu) / (last.t - first.t)) * 100).toFixed(1))
      : null,
  rssMbPeak: mb(Math.max(...samples.map((s) => s.rss))),
  rssMbSteadyMean: steady.length
    ? mb(steady.reduce((a, s) => a + s.rss, 0) / steady.length)
    : null,
  processes: Math.max(...samples.map((s) => s.procs)),
  byName:
    first && last
      ? Object.fromEntries(
          Object.entries(last.byName).map(([name, v]) => [
            name,
            {
              n: v.n,
              rssMb: mb(v.rss),
              cpuPercent: Number(
                (
                  ((v.cpu - (first.byName[name]?.cpu ?? 0)) /
                    (last.t - first.t)) *
                  100
                ).toFixed(1),
              ),
            },
          ]),
        )
      : {},
};
console.log("SUMMARY", JSON.stringify(summary, null, 1));
mkdirSync(new URL("./bench-results", import.meta.url).pathname, {
  recursive: true,
});
writeFileSync(
  new URL(`./bench-results/${label}.json`, import.meta.url).pathname,
  JSON.stringify({ summary, samples, lines }, null, 1),
);
