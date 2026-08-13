import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit-log.ts";

test("appends JSONL records with resolved actors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "huddlefm-audit-"));
  const path = join(directory, "audit.jsonl");
  const audit = new AuditLog(path, async id => id === "U123" ? "Sam Smith" : id);
  audit.record("track.skipped", "U123", { sessionId: "session", trackId: "track" });
  audit.record("session.ended", undefined, { sessionId: "session" });
  await audit.flush();
  expect(readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
    expect.objectContaining({ event: "track.skipped", actor: { id: "U123", name: "Sam Smith" }, sessionId: "session", trackId: "track" }),
    expect.objectContaining({ event: "session.ended", actor: { id: "system", name: "HuddleFM" }, sessionId: "session" }),
  ]);
  rmSync(directory, { recursive: true });
});
