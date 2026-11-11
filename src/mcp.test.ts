import { expect, test } from "bun:test";
import { mcpResponse, type McpHost } from "./mcp.ts";
import type { IntegrationCommand } from "./integration.ts";

const ran: { userId: string; command: IntegrationCommand }[] = [];
const joined: { channel: string; threadTs: string; userId: string }[] = [];
const host = (change: Partial<McpHost> = {}): McpHost => ({
  token: "secret",
  actorId: "U01TESTADMIN",
  version: "1",
  session: (channel) =>
    channel === "C01ALLOWED" || channel === "C02OTHER"
      ? {
          id: "session",
          run: async (userId, command) => {
            ran.push({ userId, command });
            return { ok: true, type: command.type };
          },
        }
      : undefined,
  join: async (channel, threadTs, userId) => {
    joined.push({ channel, threadTs, userId });
    return { ok: true, joined: true };
  },
  ...change,
});
const post = (body: unknown, token = "secret") =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const call = async (name: string, args: Record<string, unknown>) => {
  const response = await mcpResponse(
    post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    host(),
  );
  const { result } = (await response.json()) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  return {
    isError: !!result.isError,
    value: JSON.parse(result.content[0]!.text),
  };
};

test("is off without a token and refuses a wrong one", async () => {
  expect((await mcpResponse(post({}), host({ token: undefined }))).status).toBe(
    404,
  );
  expect((await mcpResponse(post({}, "wrong"), host())).status).toBe(401);
});

test("lists its tools", async () => {
  const response = await mcpResponse(
    post({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    host(),
  );
  const { result } = (await response.json()) as {
    result: { tools: { name: string }[] };
  };
  expect(result.tools.map((item) => item.name)).toContain("skip");
});

test("acts on the session in the named channel, as the configured user", async () => {
  ran.length = 0;
  expect((await call("skip", {})).isError).toBe(true);
  expect((await call("skip", { channel: "C09NOSESSION" })).isError).toBe(true);
  expect(ran).toHaveLength(0);
  expect(await call("volume", { channel: "C01ALLOWED", percent: 40 })).toEqual({
    isError: false,
    value: { ok: true, type: "volume" },
  });
  expect(ran).toEqual([
    {
      userId: "U01TESTADMIN",
      command: { type: "volume", channel: "C01ALLOWED", percent: 40 },
    },
  ]);
  expect((await call("sessions", {})).isError).toBe(true);
});

test("joins a Huddle only with its thread and who asked", async () => {
  joined.length = 0;
  expect((await call("join", { channel: "C01ALLOWED" })).isError).toBe(true);
  expect(
    await call("join", { channel: "C01ALLOWED", thread_ts: "1.0", user: "U1" }),
  ).toEqual({ isError: false, value: { ok: true, joined: true } });
  expect(joined).toEqual([
    { channel: "C01ALLOWED", threadTs: "1.0", userId: "U1" },
  ]);
});
