import { expect, test } from "bun:test";
import { agentConfigured, isBareMention, stripMentions } from "./agent.ts";

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
  delete process.env.OPENROUTER_API_KEY;
  expect(agentConfigured()).toBe(false);
  process.env.OPENROUTER_API_KEY = "test-key";
  expect(agentConfigured()).toBe(true);
  if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = previous;
});
