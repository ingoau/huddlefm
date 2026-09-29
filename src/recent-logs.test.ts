import { expect, test } from "bun:test";
import { RecentLogs } from "./recent-logs.ts";

test("files lines under each session they mention, oldest first", () => {
  const logs = new RecentLogs();
  logs.record("info", { sessionId: "s1", event: "started" }, "Started");
  logs.record("warn", { mediaSessionId: "m1", event: "stalled" }, "Stalled");
  logs.record(
    "info",
    { sessionId: "s1", mediaSessionId: "m1", event: "joined" },
    "Joined",
  );
  logs.record("info", { sessionId: "s2", event: "other" }, "Elsewhere");
  logs.record("info", { event: "unrelated" }, "No session");
  expect(logs.take("s1", "m1").map(({ time: _time, ...line }) => line)).toEqual(
    [
      { level: "info", sessionId: "s1", event: "started", msg: "Started" },
      { level: "warn", mediaSessionId: "m1", event: "stalled", msg: "Stalled" },
      {
        level: "info",
        sessionId: "s1",
        mediaSessionId: "m1",
        event: "joined",
        msg: "Joined",
      },
    ],
  );
  expect(logs.take(undefined, "missing")).toEqual([]);
});

test("keeps secrets and objects out, and errors as text", () => {
  const logs = new RecentLogs();
  logs.record(
    "error",
    {
      sessionId: "s1",
      token: "secret",
      bridgeToken: "secret",
      pid: 1,
      details: { nested: true },
      err: new Error("Boom"),
      attempt: 2,
      restored: false,
    },
    "Failed",
  );
  const [line] = logs.take("s1");
  expect(line).toMatchObject({
    sessionId: "s1",
    error: "Boom",
    attempt: 2,
    restored: false,
  });
  expect(line).not.toHaveProperty("token");
  expect(line).not.toHaveProperty("bridgeToken");
  expect(line).not.toHaveProperty("pid");
  expect(line).not.toHaveProperty("details");
});

test("keeps a bounded number of lines and sessions", () => {
  const logs = new RecentLogs(3, 2);
  for (let index = 0; index < 5; index++)
    logs.record("info", { sessionId: "s1" }, String(index));
  expect(logs.take("s1").map((line) => line.msg)).toEqual(["2", "3", "4"]);
  logs.record("info", { sessionId: "s2" }, "two");
  // s1 was active more recently than nothing, s2 newer; s3 evicts s1.
  logs.record("info", { sessionId: "s3" }, "three");
  expect(logs.take("s1")).toEqual([]);
  expect(logs.take("s2")).toHaveLength(1);
  expect(logs.take("s3")).toHaveLength(1);
});
