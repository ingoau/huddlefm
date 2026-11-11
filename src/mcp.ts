import { timingSafeEqual } from "node:crypto";
import type { IntegrationCommand } from "./integration.ts";

/** What the MCP server needs of the running app. */
export type McpHost = {
  token?: string;
  // Channels the MCP server may act in; empty means any with a session.
  channels: Set<string>;
  // Who commands run as, with that user's permissions in the session.
  actorId?: string;
  version: string;
  // The active session in a channel, when there is one.
  session(channel: string):
    | {
        id: string;
        run(
          userId: string,
          command: IntegrationCommand,
        ): Promise<{ ok: boolean; [key: string]: unknown }>;
      }
    | undefined;
  // Brings HuddleFM into the active Huddle of a thread, hosted by userId.
  join(
    channel: string,
    threadTs: string,
    userId: string,
  ): Promise<{ ok: boolean; [key: string]: unknown }>;
};

const channel = {
  type: "string",
  description: "Slack channel ID of the Huddle (its channel or HuddleFM's)",
};
const tool = (
  name: string,
  description: string,
  type: IntegrationCommand["type"],
  properties: Record<string, unknown> = {},
  required: string[] = [],
) => ({
  name,
  description,
  type,
  inputSchema: {
    type: "object",
    properties: { channel, ...properties },
    required: ["channel", ...required],
    additionalProperties: false,
  },
});

// Joining is a Huddle's alone: it needs the thread of a Huddle that is on,
// and someone in it to host, as a mention does.
const joinTool = {
  name: "join",
  description:
    "Bring HuddleFM into the active Huddle of a thread; user must be in the Huddle and becomes host",
  inputSchema: {
    type: "object",
    properties: {
      channel,
      thread_ts: {
        type: "string",
        description: "Timestamp of the Huddle's message (its thread)",
      },
      user: {
        type: "string",
        description: "Slack user ID of who asked; must be in the Huddle",
      },
    },
    required: ["channel", "thread_ts", "user"],
    additionalProperties: false,
  },
};

export const mcpTools = [
  tool("status", "What is playing, the queue and settings", "status"),
  tool(
    "search",
    "Search songs; returns references to add",
    "search",
    {
      query: { type: "string" },
    },
    ["query"],
  ),
  tool(
    "add",
    "Add a song by a reference from search, or a link",
    "add",
    {
      reference: { type: "string" },
    },
    ["reference"],
  ),
  tool("skip", "Skip to the next song", "skip"),
  tool("previous", "Go back to the previous song", "previous"),
  tool("pause", "Pause playback", "pause"),
  tool("resume", "Resume playback", "resume"),
  tool(
    "volume",
    "Set the volume",
    "volume",
    {
      percent: { type: "number", minimum: 0, maximum: 100 },
    },
    ["percent"],
  ),
];

function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: any };

/**
 * HuddleFM as an MCP server over streamable HTTP, without sessions: each
 * POST is one JSON-RPC message, answered as JSON. Off without MCP_TOKEN.
 */
export async function mcpResponse(request: Request, host: McpHost) {
  if (!host.token) return new Response("Not found", { status: 404 });
  const auth = request.headers.get("authorization") ?? "";
  if (!same(auth, `Bearer ${host.token}`))
    return new Response("Unauthorized", { status: 401 });
  if (request.method !== "POST")
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  let rpc: Rpc;
  try {
    rpc = (await request.json()) as Rpc;
  } catch {
    return Response.json(error(null, -32700, "Parse error"));
  }
  // Notifications are only acknowledged.
  if (rpc.id === undefined) return new Response(null, { status: 202 });
  return Response.json(await answer(rpc, host));
}

function error(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function result(id: unknown, value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function answer(rpc: Rpc, host: McpHost) {
  switch (rpc.method) {
    case "initialize":
      return result(rpc.id, {
        protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "huddlefm", version: host.version },
      });
    case "ping":
      return result(rpc.id, {});
    case "tools/list":
      return result(rpc.id, {
        tools: [joinTool, ...mcpTools.map(({ type: _type, ...rest }) => rest)],
      });
    case "tools/call":
      return result(rpc.id, await call(rpc.params ?? {}, host));
    default:
      return error(rpc.id, -32601, "Method not found");
  }
}

async function call(
  params: { name?: string; arguments?: Record<string, unknown> },
  host: McpHost,
) {
  const args = params.arguments ?? {};
  const target = typeof args.channel === "string" ? args.channel : "";
  const allowed = () => !host.channels.size || host.channels.has(target);
  if (params.name === joinTool.name) {
    const threadTs = typeof args.thread_ts === "string" ? args.thread_ts : "";
    const user = typeof args.user === "string" ? args.user : "";
    if (!target || !threadTs || !user)
      return text({ error: "channel, thread_ts and user are required" }, true);
    if (!allowed())
      return text(
        { error: "This channel is not one HuddleFM's MCP may control" },
        true,
      );
    const outcome = await host.join(target, threadTs, user);
    return text(outcome, !outcome.ok);
  }
  const definition = mcpTools.find((item) => item.name === params.name);
  if (!definition) return text({ error: "Unknown tool" }, true);
  // Only a session running in the channel the caller names, and only in
  // MCP_CHANNEL_IDS when that is set.
  if (!target) return text({ error: "channel is required" }, true);
  if (!allowed())
    return text(
      { error: "This channel is not one HuddleFM's MCP may control" },
      true,
    );
  const session = host.session(target);
  if (!session)
    return text({ error: "No HuddleFM session in that channel" }, true);
  if (!host.actorId)
    return text({ error: "MCP_USER_ID or ADMIN_USER_IDS is not set" }, true);
  const command: IntegrationCommand = {
    type: definition.type,
    channel: target,
  };
  if (typeof args.query === "string") command.query = args.query;
  if (typeof args.reference === "string") command.reference = args.reference;
  if (typeof args.percent === "number") command.percent = args.percent;
  const outcome = await session.run(host.actorId, command);
  return text(outcome, !outcome.ok);
}
