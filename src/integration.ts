import { capabilities, displayModes, transitionModes } from "./store.ts";
import { confirm, permissionLabels, plain } from "./coordinator-ui.ts";
import type { JoinedHuddle } from "./slack-huddle.ts";

export const integrationEvents = [
  "playback.state",
  "track",
  "queue",
  "volume",
  "session",
] as const;

export type IntegrationEvent = (typeof integrationEvents)[number];
export type IntegrationCapability = (typeof capabilities)[number];

export const integrationEventLabels: Record<IntegrationEvent, string> = {
  "playback.state": "Playback state",
  track: "Track changes",
  queue: "Queue changes",
  volume: "Volume",
  session: "Session lifecycle",
};

export const integrationCommandTypes = [
  "request_control",
  "status",
  "search",
  "add",
  "remove",
  "move",
  "clear",
  "skip",
  "previous",
  "toggle",
  "pause",
  "resume",
  "seek",
  "volume",
  "settings",
  "end",
  "release_control",
] as const;

export type IntegrationCommandType = (typeof integrationCommandTypes)[number];

export const integrationGrantTimeoutMs = 5 * 60_000;

const capabilitySet = new Set<string>(capabilities);
const eventSet = new Set<string>(integrationEvents);
const commandSet = new Set<string>(integrationCommandTypes);

export type IntegrationCommand = {
  type: IntegrationCommandType;
  channel?: string;
  permissions?: string[];
  events?: string[];
  query?: string;
  reference?: string;
  trackId?: string;
  direction?: "up" | "down";
  playNext?: boolean;
  position?: number;
  seconds?: number;
  percent?: number;
  displayMode?: (typeof displayModes)[number];
  autoplay?: boolean;
  transitionMode?: (typeof transitionModes)[number];
  anchorEnabled?: boolean;
};

export type IntegrationParseResult =
  | { ok: true; command: IntegrationCommand }
  | { ok: false; error: string; message?: string; [key: string]: unknown };

export function isAllowlisted(
  allowed: Set<string>,
  userId: string,
  botId?: string,
) {
  return allowed.has(userId) || Boolean(botId && allowed.has(botId));
}

export function sessionMatchesChannel(
  room: Pick<
    JoinedHuddle,
    "uiChannelId" | "sourceChannelId" | "companionChannelId"
  >,
  channel: string,
) {
  return (
    room.uiChannelId === channel ||
    room.sourceChannelId === channel ||
    room.companionChannelId === channel
  );
}

export function parseIntegrationMessage(text: string): IntegrationParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "ignored" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "ignored" };
  const body = raw as Record<string, unknown>;
  if (body.v !== 1)
    return {
      ok: false,
      error: "unsupported_version",
      message: "Use protocol version 1.",
    };
  if (typeof body.type !== "string" || !commandSet.has(body.type))
    return { ok: false, error: "unknown_type" };
  const type = body.type as IntegrationCommandType;
  if (type === "request_control") {
    if (typeof body.channel !== "string" || !body.channel)
      return { ok: false, error: "channel_required" };
    const permissions = stringList(body.permissions);
    const events = stringList(body.events);
    if (!permissions) return { ok: false, error: "invalid_permissions" };
    if (!events) return { ok: false, error: "invalid_events" };
    const unknownPermissions = permissions.filter(
      (value) => !capabilitySet.has(value),
    );
    if (unknownPermissions.length)
      return {
        ok: false,
        error: "unknown_permissions",
        permissions: unknownPermissions,
      };
    const unknownEvents = events.filter((value) => !eventSet.has(value));
    if (unknownEvents.length)
      return { ok: false, error: "unknown_events", events: unknownEvents };
    return {
      ok: true,
      command: {
        type,
        channel: body.channel,
        permissions,
        events,
      },
    };
  }
  const command: IntegrationCommand = { type };
  if (typeof body.channel === "string" && body.channel)
    command.channel = body.channel;
  if (typeof body.query === "string") command.query = body.query;
  if (typeof body.reference === "string") command.reference = body.reference;
  if (typeof body.trackId === "string") command.trackId = body.trackId;
  if (body.direction === "up" || body.direction === "down")
    command.direction = body.direction;
  if (typeof body.playNext === "boolean") command.playNext = body.playNext;
  if (typeof body.position === "number") command.position = body.position;
  if (typeof body.seconds === "number") command.seconds = body.seconds;
  if (typeof body.percent === "number") command.percent = body.percent;
  if (
    typeof body.displayMode === "string" &&
    displayModes.includes(body.displayMode as (typeof displayModes)[number])
  )
    command.displayMode = body.displayMode as (typeof displayModes)[number];
  if (typeof body.autoplay === "boolean") command.autoplay = body.autoplay;
  if (
    typeof body.transitionMode === "string" &&
    transitionModes.includes(
      body.transitionMode as (typeof transitionModes)[number],
    )
  )
    command.transitionMode =
      body.transitionMode as (typeof transitionModes)[number];
  if (typeof body.anchorEnabled === "boolean")
    command.anchorEnabled = body.anchorEnabled;
  return { ok: true, command };
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return;
  if (!value.every((item) => typeof item === "string")) return;
  return value as string[];
}

export function integrationReply(
  replyTo: string,
  body: Record<string, unknown>,
) {
  return JSON.stringify({ v: 1, replyTo, ...body });
}

export function integrationEventMessage(
  channel: string,
  event: string,
  payload: Record<string, unknown> = {},
) {
  return JSON.stringify({
    v: 1,
    type: "event",
    channel,
    event,
    payload,
  });
}

export function eventGroup(event: string): IntegrationEvent | undefined {
  if (event.startsWith("playback.")) return "playback.state";
  if (event.startsWith("track.")) return "track";
  if (event.startsWith("queue.")) return "queue";
  if (event.startsWith("volume.")) return "volume";
  if (event.startsWith("session.")) return "session";
}

export function mapAgentError(message: string) {
  if (message.includes("Join the huddle")) return "not_granted";
  if (message.includes("do not have permission")) return "missing_permission";
  if (message.includes("Nothing is playing")) return "nothing_playing";
  if (message.toLowerCase().includes("queue") && message.includes("full"))
    return "queue_full";
  if (message.includes("room for")) return "queue_full";
  if (message.includes("not active")) return "session_inactive";
  if (message.includes("not in the queue")) return "not_found";
  return "failed";
}

export function permissionLabelList(ids: string[]) {
  return ids.map(
    (id) => permissionLabels[id as keyof typeof permissionLabels] ?? id,
  );
}

export function eventLabelList(ids: string[]) {
  return ids.map((id) => integrationEventLabels[id as IntegrationEvent] ?? id);
}

export function integrationActionValue(sessionId: string, requestId: string) {
  return JSON.stringify({ sessionId, requestId });
}

export function parseIntegrationActionValue(value: string) {
  try {
    const parsed = JSON.parse(value) as {
      sessionId?: unknown;
      requestId?: unknown;
    };
    if (
      typeof parsed.sessionId === "string" &&
      typeof parsed.requestId === "string"
    )
      return { sessionId: parsed.sessionId, requestId: parsed.requestId };
  } catch {
    return;
  }
}

export function integrationRequestBlocks(options: {
  sessionId: string;
  requestId: string;
  userId: string;
  channel: string;
  permissions: string[];
  events: string[];
}) {
  const value = integrationActionValue(options.sessionId, options.requestId);
  const permissions = permissionLabelList(options.permissions)
    .map((label) => `• ${label}`)
    .join("\n");
  const events = eventLabelList(options.events)
    .map((label) => `• ${label}`)
    .join("\n");
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<@${options.userId}> wants to control this session in <#${options.channel}>.`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Permissions*\n${permissions || "• None"}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Events*\n${events || "• None"}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "integration_accept",
          text: plain("Accept"),
          style: "primary",
          value,
        },
        {
          type: "button",
          action_id: "integration_decline",
          text: plain("Decline"),
          style: "danger",
          value,
        },
      ],
    },
  ];
}

export function integrationGrantedBlocks(options: {
  sessionId: string;
  requestId: string;
  userId: string;
  permissions: string[];
}) {
  const value = integrationActionValue(options.sessionId, options.requestId);
  const permissions = permissionLabelList(options.permissions)
    .map((label) => `• ${label}`)
    .join("\n");
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Granted <@${options.userId}> control of this session.\n${permissions}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "integration_revoke",
          text: plain("Revoke"),
          style: "danger",
          value,
        },
      ],
    },
  ];
}

export const slackModalBlockLimit = 100;
const integrationGrantBlockCount = 2;

export function integrationSettingsPageValue(sessionId: string, page: number) {
  return JSON.stringify({ sessionId, page });
}

export function parseIntegrationSettingsPage(value: string) {
  try {
    const parsed = JSON.parse(value) as {
      sessionId?: unknown;
      page?: unknown;
    };
    if (
      typeof parsed.sessionId === "string" &&
      typeof parsed.page === "number" &&
      Number.isInteger(parsed.page) &&
      parsed.page >= 0
    )
      return { sessionId: parsed.sessionId, page: parsed.page };
  } catch {
    return;
  }
}

export function integrationSettingsBlocks(options: {
  sessionId: string;
  grants: { userId: string; requestId: string; permissions: string[] }[];
  maxBlocks?: number;
  page?: number;
}) {
  if (!options.grants.length) return [];
  const maxBlocks = Math.max(
    2 + integrationGrantBlockCount,
    options.maxBlocks ?? slackModalBlockLimit,
  );
  const header = (text: string) => ({
    type: "header" as const,
    block_id: "integrations",
    text: plain(text),
  });
  if (1 + options.grants.length * integrationGrantBlockCount <= maxBlocks)
    return [
      header("Integrations"),
      ...integrationGrantBlocks(options.sessionId, options.grants),
    ];
  const pageSize = Math.max(
    1,
    Math.floor((maxBlocks - 2) / integrationGrantBlockCount),
  );
  const pageCount = Math.ceil(options.grants.length / pageSize);
  const page = Math.min(Math.max(0, options.page ?? 0), pageCount - 1);
  const start = page * pageSize;
  const slice = options.grants.slice(start, start + pageSize);
  const elements = [
    ...(page > 0
      ? [
          {
            type: "button" as const,
            action_id: "integration_grants_prev",
            text: plain("Previous"),
            value: integrationSettingsPageValue(options.sessionId, page - 1),
          },
        ]
      : []),
    ...(page < pageCount - 1
      ? [
          {
            type: "button" as const,
            action_id: "integration_grants_next",
            text: plain("Next"),
            value: integrationSettingsPageValue(options.sessionId, page + 1),
          },
        ]
      : []),
  ];
  return [
    header(`Integrations (${page + 1}/${pageCount})`),
    ...integrationGrantBlocks(options.sessionId, slice),
    {
      type: "actions",
      block_id: "integration_grants_page",
      elements,
    },
  ];
}

function integrationGrantBlocks(
  sessionId: string,
  grants: { userId: string; requestId: string; permissions: string[] }[],
) {
  return grants.flatMap((grant) => {
    const permissions = permissionLabelList(grant.permissions)
      .map((label) => `• ${label}`)
      .join("\n");
    return [
      {
        type: "section",
        block_id: `integration_${grant.userId}`,
        text: {
          type: "mrkdwn",
          text: `<@${grant.userId}> has control of this session.\n${permissions || "• None"}`,
        },
      },
      {
        type: "actions",
        block_id: `integration_actions_${grant.userId}`,
        elements: [
          {
            type: "button",
            action_id: "integration_revoke",
            text: plain("Revoke"),
            style: "danger",
            value: integrationActionValue(sessionId, grant.requestId),
            confirm: confirm(
              "Revoke control?",
              `This stops <@${grant.userId}> from controlling this session.`,
              "Revoke",
            ),
          },
        ],
      },
    ];
  });
}

export function wrapIntegrationResult(
  type: string,
  replyTo: string,
  result: { ok: boolean; error?: string; [key: string]: unknown },
) {
  if (!result.ok)
    return integrationReply(replyTo, {
      ok: false,
      type,
      error: mapAgentError(String(result.error ?? "failed")),
      message: result.error,
    });
  const { ok: _ok, ...rest } = result;
  return integrationReply(replyTo, { ok: true, type, ...rest });
}
