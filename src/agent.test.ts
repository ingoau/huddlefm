import { expect, test } from "bun:test";
import {
  agentCommandResult,
  agentConfigured,
  agentFailureReason,
  isAgentBusy,
  isBareMention,
  stripMentions,
} from "./agent.ts";

test("isBareMention accepts only the bot mention", () => {
  expect(isBareMention("<@UBOT>", "UBOT")).toBe(true);
  expect(isBareMention("  <@UBOT|huddlefm>  ", "UBOT")).toBe(true);
  expect(isBareMention("<@UBOT> add lo-fi", "UBOT")).toBe(false);
  expect(isBareMention("hey <@UBOT>", "UBOT")).toBe(false);
  expect(isBareMention("<@UOTHER>", "UBOT")).toBe(false);
});

test("stripMentions removes bot tags", () => {
  expect(stripMentions("<@UBOT> queue up radiohead", "UBOT")).toBe(
    "queue up radiohead",
  );
  expect(stripMentions("<@UBOT|HuddleFM> skip", "UBOT")).toBe("skip");
});

test("agentConfigured reflects OpenRouter credentials", () => {
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    expect(agentConfigured()).toBe(false);
    process.env.OPENROUTER_API_KEY = "test-key";
    expect(agentConfigured()).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("isAgentBusy starts false", () => {
  expect(isAgentBusy("UTEST")).toBe(false);
});

test("agentCommandResult fails when a coordinator tool reports an error", () => {
  expect(
    agentCommandResult({
      text: "Skipped the current track.",
      steps: [
        {
          toolResults: [
            {
              output: { ok: false, error: "Nothing is playing." },
            },
          ],
        },
      ],
    }),
  ).toEqual({ ok: false, text: "Nothing is playing." });
});

test("agentFailureReason separates credit limits from timeouts", () => {
  const credit = new Error(
    "This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 59602.",
  );
  credit.name = "AI_APICallError";
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";

  expect(agentFailureReason(credit)).toBe("credit_limit");
  expect(agentFailureReason(timeout)).toBe("timeout");
  expect(agentFailureReason(new Error("YouTube Music is unreachable"))).toBe(
    "error",
  );
});
