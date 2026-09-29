import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FallbackReports } from "./fallback-reports.ts";

const reportId = "0f8fad5b-d9cb-469f-a165-70867728950e";

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "huddlefm-reports-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("merges each part of a report into one file", () =>
  withDirectory(async (directory) => {
    const reports = new FallbackReports(directory);
    void reports.update(reportId, { trigger: "report", appLogs: ["before"] });
    void reports.update(reportId, {
      outcome: { status: "joined" },
      appLogs: ["before", "after"],
    });
    await reports.update(reportId, { answers: { problems: ["no_sound"] } });
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toEndWith(`-${reportId}.json`);
    expect(files[0]).not.toContain(":");
    const report = JSON.parse(
      await readFile(join(directory, files[0]!), "utf8"),
    );
    expect(report).toEqual({
      reportId,
      createdAt: expect.any(String),
      trigger: "report",
      outcome: { status: "joined" },
      appLogs: ["before", "after"],
      answers: { problems: ["no_sound"] },
    });
  }));

test("ignores report IDs that are not UUIDs", () =>
  withDirectory(async (directory) => {
    const reports = new FallbackReports(directory);
    await reports.update("../../escape", { trigger: "report" });
    expect(await readdir(directory)).toEqual([]);
  }));

test("keeps only the newest reports, and none past their age", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "2001-01-01T00-00-00.000Z-old.json"), "{}");
    const recent = new Date(Date.now() - 60_000)
      .toISOString()
      .replaceAll(":", "-");
    for (const name of ["a", "b"])
      await writeFile(join(directory, `${recent}-${name}.json`), "{}");
    const reports = new FallbackReports(directory, 2);
    await reports.update(reportId, { trigger: "automatic" });
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith(`-${reportId}.json`))).toBe(true);
    // The oldest recent report went, and so did the one past its age.
    expect(files).toContain(`${recent}-b.json`);
  }));

test("drops reports past their age even under the count limit", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "2001-01-01T00-00-00.000Z-old.json"), "{}");
    const reports = new FallbackReports(directory, 200);
    await reports.update(reportId, { trigger: "automatic" });
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toEndWith(`-${reportId}.json`);
  }));
