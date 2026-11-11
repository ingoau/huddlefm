import { expect, test } from "bun:test";
import { z } from "zod";
import type { Coordinator } from "./coordinator.ts";
import {
  agentCommandResult,
  agentConfigured,
  agentTools,
  isAgentBusy,
  isBareMention,
  RateLimiter,
  resetAgentRateLimits,
  runAgentCommand,
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

test("the tools follow the mode, like the player does", () => {
  const tools = (videoMode: boolean) =>
    agentTools(
      { videoMode } as unknown as Coordinator,
      "U1",
    ) as unknown as Record<string, { inputSchema: z.ZodObject }>;
  const fields = (tool: { inputSchema: z.ZodObject }) =>
    Object.keys(tool.inputSchema.shape);
  const music = tools(false);
  expect(music.jump_to).toBeUndefined();
  expect(music.set_captions).toBeUndefined();
  expect(fields(music.add_tracks!)).toEqual(["reference", "withVideoMode"]);
  expect(fields(music.update_settings!)).toContain("autoplayMode");
  expect(fields(music.update_settings!)).toContain("mode");
  const video = tools(true);
  expect(video.jump_to).toBeDefined();
  expect(video.set_captions).toBeDefined();
  expect(fields(video.add_tracks!)).toEqual(["reference"]);
  for (const field of ["displayMode", "autoplayMode", "transitionMode"])
    expect(fields(video.update_settings!)).not.toContain(field);
  // Autoplay in video mode is related videos, on or off.
  expect(fields(video.update_settings!)).toEqual(
    expect.arrayContaining(["mode", "autoplay", "loopMode", "hostUserId"]),
  );
});

test("RateLimiter allows each window's limit, then says how long to wait", () => {
  let now = 0;
  const limiter = new RateLimiter(
    [
      { limit: 2, windowMs: 1_000 },
      { limit: 3, windowMs: 10_000 },
    ],
    () => now,
  );
  for (const at of [0, 100]) {
    now = at;
    expect(limiter.retryAfter("U1")).toBe(0);
    limiter.record("U1");
  }
  now = 200;
  expect(limiter.retryAfter("U1")).toBe(800);
  expect(limiter.retryAfter("U2")).toBe(0);
  now = 1_000;
  expect(limiter.retryAfter("U1")).toBe(0);
  limiter.record("U1");
  // the longer window is full until the first use is 10 seconds old
  now = 5_000;
  expect(limiter.retryAfter("U1")).toBe(5_000);
  now = 10_000;
  expect(limiter.retryAfter("U1")).toBe(0);
});

test("runAgentCommand stops a user after a few requests a minute", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  resetAgentRateLimits();
  const coordinator = {
    id: "S1",
    videoMode: false,
    communismMode: false,
    primeManager: async () => {},
  } as unknown as Coordinator;
  const ask = (userId: string) =>
    runAgentCommand({
      coordinator,
      userId,
      text: "<@UBOT> add some jazz",
      botUserId: "UBOT",
    });
  try {
    // Without a key each request fails, but still counts.
    for (let index = 0; index < 3; index++)
      expect((await ask("U1")).text).not.toContain("asked me a lot");
    const limited = await ask("U1");
    expect(limited.ok).toBe(false);
    expect(limited.text).toContain("You've asked me a lot just now.");
    expect((await ask("U2")).text).not.toContain("asked me a lot");
  } finally {
    resetAgentRateLimits();
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});
