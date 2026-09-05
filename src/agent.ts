import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { Coordinator } from "./coordinator.ts";
import {
  displayModes,
  permissionPresets,
  transitionModes,
  type DisplayMode,
  type TransitionMode,
} from "./store.ts";
import { logger } from "./logger.ts";

const log = logger.child({ component: "agent" });

export const agentModel = "google/gemini-3.5-flash-lite";

const mentionPattern = (botUserId: string) =>
  new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g");

/** True when the message is only an @mention (plus whitespace). */
export function isBareMention(text: string, botUserId: string) {
  return text.replace(mentionPattern(botUserId), "").trim() === "";
}

/** Strip bot @mentions so the model sees the user's request. */
export function stripMentions(text: string, botUserId: string) {
  return text.replace(mentionPattern(botUserId), "").trim();
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

function trackSummary(track: {
  id: string;
  title: string;
  artist: string;
  album?: string;
  requesterId?: string;
  automatic?: boolean;
  status?: string;
}) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    ...(track.album ? { album: track.album } : {}),
    ...(track.requesterId ? { addedBy: track.requesterId } : {}),
    ...(track.automatic ? { automatic: true } : {}),
    ...(track.status ? { status: track.status } : {}),
  };
}

function agentTools(coordinator: Coordinator, userId: string) {
  return {
    get_status: tool({
      description:
        "Get what's playing, the queue, volume, settings, host, and this user's permissions.",
      inputSchema: z.object({}),
      execute: async () => coordinator.agentStatus(userId),
    }),
    search_tracks: tool({
      description:
        "Search YouTube Music (and resolve media URLs) for songs, albums, or playlists. Use the returned reference values with add_tracks.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Song, artist, album, playlist name, or media URL"),
      }),
      execute: async ({ query }) => coordinator.agentSearch(userId, query),
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
      execute: async ({ reference }) => coordinator.agentAdd(userId, reference),
    }),
    remove_from_queue: tool({
      description: "Remove a track from the upcoming queue by id.",
      inputSchema: z.object({
        trackId: z.string().min(1).describe("Queue track id from get_status"),
      }),
      execute: async ({ trackId }) => coordinator.agentRemove(userId, trackId),
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
      execute: async ({ trackId, direction, playNext, position }) =>
        coordinator.agentMove(userId, trackId, {
          direction,
          playNext,
          position,
        }),
    }),
    clear_queue: tool({
      description: "Clear all upcoming tracks from the queue.",
      inputSchema: z.object({}),
      execute: async () => coordinator.agentClear(userId),
    }),
    skip: tool({
      description: "Skip to the next track.",
      inputSchema: z.object({}),
      execute: async () => coordinator.agentSkip(userId),
    }),
    previous: tool({
      description:
        "Go to the previous track, or restart the current track if it has been playing for more than a few seconds.",
      inputSchema: z.object({}),
      execute: async () => coordinator.agentPrevious(userId),
    }),
    pause_or_resume: tool({
      description: "Toggle pause and resume for the current track.",
      inputSchema: z.object({}),
      execute: async () => coordinator.agentToggle(userId),
    }),
    seek: tool({
      description: "Seek relative to the current playback position.",
      inputSchema: z.object({
        seconds: z
          .number()
          .describe("Seconds to move; negative seeks backward"),
      }),
      execute: async ({ seconds }) => coordinator.agentSeek(userId, seconds),
    }),
    set_volume: tool({
      description: "Set playback volume as a percentage from 0 to 100.",
      inputSchema: z.object({
        percent: z.number().min(0).max(100),
      }),
      execute: async ({ percent }) =>
        coordinator.agentSetVolume(userId, percent),
    }),
    update_settings: tool({
      description:
        "Change session settings the user is allowed to configure (display, autoplay, transitions, keep-player-at-bottom, permission preset, or host).",
      inputSchema: z.object({
        displayMode: z.enum(displayModes).optional(),
        autoplay: z.boolean().optional(),
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
      execute: async (input) => coordinator.agentUpdateSettings(userId, input),
    }),
    claim_host: tool({
      description: "Claim host when there is currently no host.",
      inputSchema: z.object({}),
      execute: async () => coordinator.agentClaimHost(userId),
    }),
    end_session: tool({
      description: "End the listening session and leave the huddle.",
      inputSchema: z.object({}),
      execute: async () => coordinator.agentEnd(userId),
    }),
  };
}

export async function runAgentCommand(options: {
  coordinator: Coordinator;
  userId: string;
  text: string;
  botUserId: string;
}) {
  const prompt = stripMentions(options.text, options.botUserId);
  if (!prompt) return "What should I do with the queue or playback?";

  const agent = new ToolLoopAgent({
    id: "huddlefm-session",
    model: openRouterModel(),
    instructions: `You are HuddleFM, a Slack huddle music bot assistant.
The user @mentioned you in the huddle controls thread. Help them control this listening session.
Use tools for any playback, queue, search, or settings change. Respect tool errors about permissions — the user only has the same access as the Slack UI buttons.
Be concise. After taking actions, briefly confirm what changed. Do not invent track ids; search or read status first.
Display modes: ${displayModes.join(", ")}. Transition modes: ${transitionModes.join(", ")}.`,
    tools: agentTools(options.coordinator, options.userId),
    stopWhen: stepCountIs(10),
    temperature: 0.2,
  });

  try {
    const result = await agent.generate({ prompt });
    const text = result.text?.trim();
    return text || "Done.";
  } catch (error) {
    log.error(
      { event: "agent_failed", userId: options.userId, err: error },
      "Agent command failed",
    );
    return "I couldn't complete that request. Try again in a moment.";
  }
}

export type AgentSettingsPatch = {
  displayMode?: DisplayMode;
  autoplay?: boolean;
  transitionMode?: TransitionMode;
  anchorEnabled?: boolean;
  permissionPreset?: keyof typeof permissionPresets;
  hostUserId?: string;
};

export { trackSummary };
