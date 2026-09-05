import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import { capture as captureAnalytics } from "./analytics.ts";
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
const agentTimeoutMs = 60_000;
const activeAgentUsers = new Set<string>();

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
      execute: async (_input, { abortSignal }) =>
        coordinator.agentStatus(userId, abortSignal),
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
      execute: async (
        { trackId, direction, playNext, position },
        { abortSignal },
      ) =>
        coordinator.agentMove(
          userId,
          trackId,
          {
            direction,
            playNext,
            position,
          },
          abortSignal,
        ),
    }),
    clear_queue: tool({
      description: "Clear all upcoming tracks from the queue.",
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) =>
        coordinator.agentClear(userId, abortSignal),
    }),
    skip: tool({
      description: "Skip to the next track.",
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) =>
        coordinator.agentSkip(userId, abortSignal),
    }),
    previous: tool({
      description:
        "Go to the previous track, or restart the current track if it has been playing for more than a few seconds.",
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) =>
        coordinator.agentPrevious(userId, abortSignal),
    }),
    pause_or_resume: tool({
      description: "Toggle pause and resume for the current track.",
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) =>
        coordinator.agentToggle(userId, abortSignal),
    }),
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
      execute: async (input, { abortSignal }) =>
        coordinator.agentUpdateSettings(userId, input, abortSignal),
    }),
    claim_host: tool({
      description: "Claim host when there is currently no host.",
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) =>
        coordinator.agentClaimHost(userId, abortSignal),
    }),
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
    end_session: tool({
      description: "End the listening session and leave the huddle.",
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) =>
        coordinator.agentEnd(userId, abortSignal),
    }),
  };
}

export function isAgentBusy(userId: string) {
  return activeAgentUsers.has(userId);
}

export async function runAgentCommand(options: {
  coordinator: Coordinator;
  userId: string;
  text: string;
  botUserId: string;
  timeoutMs?: number;
}) {
  const prompt = stripMentions(options.text, options.botUserId);
  if (!prompt) return "What should I do with the queue or playback?";
  if (activeAgentUsers.has(options.userId))
    return "I'm already handling your last request. Try again in a moment.";

  activeAgentUsers.add(options.userId);
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? agentTimeoutMs;
  try {
    const agent = new ToolLoopAgent({
      id: "huddlefm-session",
      model: openRouterModel(),
      instructions: `You are HuddleFM, a Slack huddle music bot assistant.
The user @mentioned you in the huddle thread (player controls may live in a companion channel). Help them control this listening session. Reply briefly; your reply is shown privately to them.
Use tools for any playback, queue, search, settings, or session scrobbling change. Respect tool errors about permissions — the user only has the same access as the Slack UI buttons.
Be concise. After taking actions, briefly confirm what changed. Do not invent track ids; search or read status first. Session scrobbling only works after the user has connected Last.fm or ListenBrainz in Settings.
Display modes: ${displayModes.join(", ")}. Transition modes: ${transitionModes.join(", ")}.`,
      tools: agentTools(options.coordinator, options.userId),
      stopWhen: stepCountIs(10),
      temperature: 0.2,
    });
    const result = await agent.generate({
      prompt,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    const text = result.text?.trim() || "Done.";
    captureAnalytics("agent.completed", {
      distinctId: options.userId,
      sessionId: options.coordinator.id,
      properties: { durationMs: Date.now() - startedAt },
    });
    return text;
  } catch (error) {
    captureAnalytics("agent.failed", {
      distinctId: options.userId,
      sessionId: options.coordinator.id,
      properties: { durationMs: Date.now() - startedAt },
    });
    log.error(
      { event: "agent_failed", userId: options.userId, err: error },
      "Agent command failed",
    );
    return "I couldn't complete that request. Try again in a moment.";
  } finally {
    activeAgentUsers.delete(options.userId);
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
