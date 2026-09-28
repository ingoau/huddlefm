import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  ToolLoopAgent,
  stepCountIs,
  tool,
  type ToolExecutionOptions,
} from "ai";
import { z } from "zod";
import { capture as captureAnalytics } from "./analytics.ts";
import type { Coordinator } from "./coordinator.ts";
import {
  autoplayModes,
  displayModes,
  loopModes,
  permissionPresets,
  transitionModes,
} from "./store.ts";
import { logger } from "./logger.ts";

const log = logger.child({ component: "agent" });
const agentTimeoutMs = 60_000;
const activeAgentUsers = new Set<string>();

export const agentModel = "google/gemini-3.5-flash-lite";

const mentionPattern = (botUserId: string) =>
  new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g");

/** Strip bot @mentions so the model sees the user's request. */
export function stripMentions(text: string, botUserId: string) {
  return text.replace(mentionPattern(botUserId), "").trim();
}

/** True when the message is only an @mention (plus whitespace). */
export function isBareMention(text: string, botUserId: string) {
  return stripMentions(text, botUserId) === "";
}

export function agentConfigured() {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

function openRouterModel() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return createOpenRouter({
    apiKey,
    compatibility: "strict",
    headers: {
      "HTTP-Referer": "https://github.com/ingoau/huddlefm",
      "X-Title": "HuddleFM",
    },
  })(agentModel);
}

function agentTools(coordinator: Coordinator, userId: string) {
  // A tool that takes no input and only needs the abort signal.
  const action = <Output>(
    description: string,
    run: (signal: AbortSignal | undefined) => Output,
  ) => ({
    description,
    inputSchema: z.object({}),
    execute: async (
      _input: Record<string, never>,
      { abortSignal }: ToolExecutionOptions<Record<string, unknown>>,
    ) => run(abortSignal),
  });
  return {
    get_status: action(
      "Get what's playing, the queue, volume, settings, host, and this user's permissions.",
      (signal) => coordinator.agentStatus(userId, signal),
    ),
    search_tracks: tool({
      description:
        "Search YouTube Music (and resolve media URLs) for songs, albums, or playlists. Use the returned reference values with add_tracks.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Song, artist, album, playlist name, or media URL"),
      }),
      execute: async ({ query }, { abortSignal }) =>
        coordinator.agentSearch(userId, query, abortSignal),
    }),
    add_tracks: tool({
      description:
        "Add a search result or media URL reference to the queue. Prefer a reference from search_tracks.",
      inputSchema: z.object({
        reference: z
          .string()
          .min(1)
          .describe("Reference value from search_tracks, or a media URL"),
      }),
      execute: async ({ reference }, { abortSignal }) =>
        coordinator.agentAdd(userId, reference, abortSignal),
    }),
    remove_from_queue: tool({
      description: "Remove a track from the upcoming queue by id.",
      inputSchema: z.object({
        trackId: z.string().min(1).describe("Queue track id from get_status"),
      }),
      execute: async ({ trackId }, { abortSignal }) =>
        coordinator.agentRemove(userId, trackId, abortSignal),
    }),
    move_in_queue: tool({
      description:
        "Reorder the queue. Use direction for one-step moves, playNext to jump a track to the front, or position (1-based) to place it exactly.",
      inputSchema: z.object({
        trackId: z.string().min(1),
        direction: z
          .enum(["up", "down"])
          .optional()
          .describe("Move one slot up or down"),
        playNext: z
          .boolean()
          .optional()
          .describe("If true, move the track to play next"),
        position: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based queue position"),
      }),
      execute: async ({ trackId, ...move }, { abortSignal }) =>
        coordinator.agentMove(userId, trackId, move, abortSignal),
    }),
    shuffle_queue: action(
      "Randomize the order of the upcoming queue. The playing track is unaffected.",
      (signal) => coordinator.agentShuffle(userId, signal),
    ),
    clear_queue: action("Clear all upcoming tracks from the queue.", (signal) =>
      coordinator.agentClear(userId, signal),
    ),
    skip: action("Skip to the next track.", (signal) =>
      coordinator.agentSkip(userId, signal),
    ),
    previous: action(
      "Go to the previous track, or restart the current track if it has been playing for more than a few seconds.",
      (signal) => coordinator.agentPrevious(userId, signal),
    ),
    pause_or_resume: action(
      "Toggle pause and resume for the current track.",
      (signal) => coordinator.agentToggle(userId, signal),
    ),
    seek: tool({
      description: "Seek relative to the current playback position.",
      inputSchema: z.object({
        seconds: z
          .number()
          .describe("Seconds to move; negative seeks backward"),
      }),
      execute: async ({ seconds }, { abortSignal }) =>
        coordinator.agentSeek(userId, seconds, abortSignal),
    }),
    set_volume: tool({
      description: "Set playback volume as a percentage from 0 to 100.",
      inputSchema: z.object({
        percent: z.number().min(0).max(100),
      }),
      execute: async ({ percent }, { abortSignal }) =>
        coordinator.agentSetVolume(userId, percent, abortSignal),
    }),
    update_settings: tool({
      description:
        "Change session settings the user is allowed to configure (display, autoplay, loop, transitions, keep-player-at-bottom, permission preset, or host).",
      inputSchema: z.object({
        displayMode: z.enum(displayModes).optional(),
        autoplay: z.boolean().optional(),
        autoplayMode: z
          .enum(autoplayModes)
          .optional()
          .describe("off, related (YouTube up-next), or huddle mix"),
        loopMode: z
          .enum(loopModes)
          .optional()
          .describe("off, track (repeat current song), or queue (cycle queue)"),
        transitionMode: z.enum(transitionModes).optional(),
        anchorEnabled: z
          .boolean()
          .optional()
          .describe("Keep the player message at the bottom of the thread"),
        permissionPreset: z
          .enum(
            Object.keys(permissionPresets) as [
              keyof typeof permissionPresets,
              ...(keyof typeof permissionPresets)[],
            ],
          )
          .optional(),
        hostUserId: z
          .string()
          .optional()
          .describe("Transfer host to this Slack user id"),
      }),
      execute: async (input, { abortSignal }) =>
        coordinator.agentUpdateSettings(userId, input, abortSignal),
    }),
    claim_host: action(
      "Claim host when there is currently no host.",
      (signal) => coordinator.agentClaimHost(userId, signal),
    ),
    set_session_scrobbling: tool({
      description:
        "Enable or disable scrobbling for this user in the current session. Requires Last.fm or ListenBrainz to already be connected in Settings.",
      inputSchema: z.object({
        enabled: z
          .boolean()
          .describe("True to scrobble this session, false to disable"),
      }),
      execute: async ({ enabled }, { abortSignal }) =>
        coordinator.agentSetSessionScrobbling(userId, enabled, abortSignal),
    }),
    end_session: action(
      "End the listening session and leave the huddle.",
      (signal) => coordinator.agentEnd(userId, signal),
    ),
  };
}

export function isAgentBusy(userId: string) {
  return activeAgentUsers.has(userId);
}

type AgentGeneration = {
  readonly text?: string;
  readonly steps: ReadonlyArray<{
    readonly toolResults: ReadonlyArray<{ readonly output: unknown }>;
  }>;
};

function isFailedToolOutcome(
  output: unknown,
): output is { ok: false; error: unknown } {
  return (
    typeof output === "object" &&
    output !== null &&
    "ok" in output &&
    output.ok === false &&
    "error" in output
  );
}

export function agentCommandResult(result: AgentGeneration) {
  const failedToolOutcome = result.steps
    .flatMap((step) => step.toolResults)
    .map((toolResult) => toolResult.output)
    .find(isFailedToolOutcome);
  if (failedToolOutcome) {
    const error = failedToolOutcome.error;
    return {
      ok: false as const,
      text:
        typeof error === "string" && error.trim()
          ? error
          : "I couldn't complete that request. Try again in a moment.",
    };
  }
  return { ok: true as const, text: result.text?.trim() || "Done." };
}

export async function runAgentCommand(options: {
  coordinator: Coordinator;
  userId: string;
  text: string;
  botUserId: string;
  timeoutMs?: number;
}) {
  const prompt = stripMentions(options.text, options.botUserId);
  if (!prompt)
    return { ok: false, text: "What should I do with the queue or playback?" };
  if (activeAgentUsers.has(options.userId))
    return {
      ok: false,
      text: "I'm already handling your last request. Try again in a moment.",
    };

  activeAgentUsers.add(options.userId);
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? agentTimeoutMs;
  let reply: { ok: boolean; text: string };
  try {
    // The tools below check permissions synchronously, so resolve whether this
    // user counts as a manager before any of them runs.
    await options.coordinator.primeManager(options.userId);
    const agent = new ToolLoopAgent({
      id: "huddlefm-session",
      model: openRouterModel(),
      instructions: `You are HuddleFM, a Slack huddle music bot assistant.
The user @mentioned you in the huddle thread (player controls may live in a companion channel). Help them control this listening session. Reply briefly; your reply is shown privately to them.
Use tools for any playback, queue, search, settings, or session scrobbling change. Respect tool errors about permissions — the user only has the same access as the Slack UI buttons.
Be concise. After taking actions, briefly confirm what changed. Do not invent track ids; search or read status first. Session scrobbling only works after the user has connected Last.fm or ListenBrainz in Settings.
Do not use emojis.
Display modes: ${displayModes.join(", ")}. Loop modes: ${loopModes.join(", ")}. Transition modes: ${transitionModes.join(", ")}.`,
      tools: agentTools(options.coordinator, options.userId),
      stopWhen: stepCountIs(10),
      temperature: 0.2,
    });
    const result = await agent.generate({
      prompt,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    reply = agentCommandResult(result);
  } catch (error) {
    log.error(
      { event: "agent_failed", userId: options.userId, err: error },
      "Agent command failed",
    );
    reply = {
      ok: false,
      text: "I couldn't complete that request. Try again in a moment.",
    };
  } finally {
    activeAgentUsers.delete(options.userId);
  }
  captureAnalytics(reply.ok ? "agent.completed" : "agent.failed", {
    distinctId: options.userId,
    sessionId: options.coordinator.id,
    properties: { durationMs: Date.now() - startedAt },
  });
  return reply;
}
