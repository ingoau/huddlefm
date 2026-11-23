import { afterAll, expect, test } from "bun:test";
import { stepCountIs, tool, ToolLoopAgent } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { PostHog } from "posthog-node";
import { z } from "zod";
import { LlmTracing } from "./llm-tracing.ts";

// A stand-in for PostHog, keeping what each trace export sent.
const exports: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    exports.push(await request.text());
    return new Response("{}");
  },
});
afterAll(() => server.stop(true));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

// One agent run that searches, then answers, traced as a user in a session.
async function traced(recordContent: boolean) {
  exports.length = 0;
  const host = `http://127.0.0.1:${server.port}`;
  const client = new PostHog("phc_test", { host, disabled: true });
  const tracing = LlmTracing.create(
    "phc_test",
    host,
    client,
    undefined,
    recordContent,
  );
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () =>
      ++calls === 1
        ? ({
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "search",
                input: JSON.stringify({ query: "secret song request" }),
              },
              {
                type: "tool-call",
                toolCallId: "call-2",
                toolName: "broken",
                input: "{}",
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage,
            warnings: [],
          } as never)
        : ({
            content: [{ type: "text", text: "Queued the hidden reply" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          } as never),
  });
  const agent = new ToolLoopAgent({
    model,
    telemetry: tracing.telemetryOptions(),
    instructions: "private instructions",
    stopWhen: stepCountIs(3),
    tools: {
      search: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: async () => ({ found: "tool result text" }),
      }),
      broken: tool({
        inputSchema: z.object({}),
        execute: async (): Promise<{ ok: boolean }> => {
          throw new Error("tool failure text");
        },
      }),
    },
  });
  await client.withContext(
    { distinctId: "U123", sessionId: "S-trace-42" },
    () => agent.generate({ prompt: "play the private prompt" }),
  );
  await tracing.shutdown();
  return exports.join("\n");
}

const written = [
  "play the private prompt",
  "secret song request",
  "tool result text",
  "Queued the hidden reply",
  "private instructions",
  "tool failure text",
];

test("traces leave out what people wrote by default", async () => {
  const sent = await traced(false);
  // The run is there, credited to its user and session.
  expect(sent).toContain("U123");
  expect(sent).toContain("S-trace-42");
  for (const text of written) expect(sent).not.toContain(text);
});

test("traces carry what people wrote when asked to", async () => {
  const sent = await traced(true);
  expect(sent).toContain("U123");
  for (const text of written) expect(sent).toContain(text);
});
