import { parseCanvasSections } from "./canvas.ts";
import { parseDuckingMode } from "./ducking.ts";

const required = [
  "SLACK_WORKSPACE_URL",
  "SLACK_XOXP",
  "SLACK_XAPP",
  "SLACK_XOXD",
] as const;

export function parseIds(value = "") {
  return new Set(value.split(/[\s,]+/).filter(Boolean));
}

export function optionalText(value?: string) {
  const text = value?.trim();
  return text || undefined;
}

/**
 * A whole number no smaller than `minimum`, or `fallback` when the value is
 * unset or not one. A typo must not leave, say, track preparation with no
 * slots at all.
 */
export function parseWholeNumber(
  value: string | undefined,
  fallback: number,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const text = value?.trim();
  if (!text) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

/**
 * What a Slack role may do in a session without joining its huddle: nothing,
 * end the session, or everything a host can.
 */
export type RolePermissions = "none" | "end" | "host";

const rolePermissionLevels: readonly string[] = ["none", "end", "host"];

/**
 * The permissions channel managers and workspace admins hold, with anything
 * worth telling whoever runs the bot. Both default to ending the session. A
 * value that is not a level falls back to that default rather than failing
 * startup, and the legacy WORKSPACE_ADMINS_AS_MANAGERS still means host when
 * WORKSPACE_ADMIN_PERMISSIONS is unset.
 */
export function parseRolePermissions(env: Record<string, string | undefined>) {
  const warnings: string[] = [];
  const level = (name: string, fallback: RolePermissions) => {
    const text = optionalText(env[name])?.toLowerCase();
    if (!text) return fallback;
    if (rolePermissionLevels.includes(text)) return text as RolePermissions;
    warnings.push(
      `${name} must be none, end, or host; using ${fallback} instead`,
    );
    return fallback;
  };
  const legacyAdmins = optionalText(env.WORKSPACE_ADMINS_AS_MANAGERS);
  const adminsSet = Boolean(optionalText(env.WORKSPACE_ADMIN_PERMISSIONS));
  if (legacyAdmins)
    warnings.push(
      adminsSet
        ? "WORKSPACE_ADMINS_AS_MANAGERS is ignored because WORKSPACE_ADMIN_PERMISSIONS is set"
        : "WORKSPACE_ADMINS_AS_MANAGERS is deprecated; use WORKSPACE_ADMIN_PERMISSIONS instead",
    );
  return {
    channelManagers: level("CHANNEL_MANAGER_PERMISSIONS", "end"),
    workspaceAdmins: level(
      "WORKSPACE_ADMIN_PERMISSIONS",
      !adminsSet && legacyAdmins === "true" ? "host" : "end",
    ),
    warnings,
  };
}

/**
 * What video mode allows, from the VIDEO_* settings. A value that is not a
 * whole number in range keeps its default.
 */
export function parseVideoLimits(env: Record<string, string | undefined>) {
  return {
    durationSeconds: parseWholeNumber(
      env.VIDEO_DURATION_LIMIT_SECONDS,
      3_600,
      1,
    ),
    downloadBytes: parseWholeNumber(
      env.VIDEO_DOWNLOAD_LIMIT_BYTES,
      1_500_000_000,
      1,
    ),
    maxHeight: parseWholeNumber(env.VIDEO_MAX_HEIGHT, 720, 240, 1_080),
    maxFps: parseWholeNumber(env.VIDEO_MAX_FPS, 30, 5, 30),
    // 0 turns video mode off.
    sessionLimit: parseWholeNumber(env.VIDEO_SESSION_LIMIT, 2),
    cacheBytes: parseWholeNumber(env.VIDEO_CACHE_LIMIT_BYTES, 5_000_000_000),
  };
}

export function loadConfig() {
  for (const name of required)
    if (!process.env[name]) throw new Error(`Missing ${name}`);

  const xoxc =
    optionalText(process.env.SLACK_ENTERPRISE_XOXC) ??
    optionalText(process.env.SLACK_XOXC);
  if (!xoxc) throw new Error("Missing SLACK_XOXC or SLACK_ENTERPRISE_XOXC");

  return {
    workspaceUrl: process.env.SLACK_WORKSPACE_URL!,
    xoxp: process.env.SLACK_XOXP!,
    xapp: process.env.SLACK_XAPP!,
    xoxc,
    xoxd: process.env.SLACK_XOXD!,
    teamId: process.env.SLACK_TEAM_ID,
    port: Number(process.env.PORT ?? 3210),
    bindAddress: process.env.BIND_ADDRESS ?? "127.0.0.1",
    mediaRegion: process.env.CHIME_MEDIA_REGION ?? "ap-southeast-2",
    queueLimit: Number(process.env.QUEUE_LIMIT ?? 50),
    durationSeconds: Number(process.env.TRACK_DURATION_LIMIT_SECONDS ?? 1_200),
    downloadBytes: Number(
      process.env.TRACK_DOWNLOAD_LIMIT_BYTES ?? 100_000_000,
    ),
    initialVolume: Number(process.env.INITIAL_VOLUME ?? 0.5),
    duckingMode: parseDuckingMode(process.env.DUCKING_MODE),
    lyricsOffsetMs: parseWholeNumber(
      process.env.LYRICS_OFFSET_MS,
      0,
      -10_000,
      10_000,
    ),
    loudnessNormalization: process.env.LOUDNESS_NORMALIZATION === "true",
    preparationConcurrency: parseWholeNumber(
      process.env.TRACK_PREPARATION_CONCURRENCY,
      2,
      1,
    ),
    mediaCacheBytes: parseWholeNumber(
      process.env.MEDIA_CACHE_LIMIT_BYTES,
      1_000_000_000,
    ),
    mediaCacheMaxAgeDays: parseWholeNumber(
      process.env.MEDIA_CACHE_MAX_AGE_DAYS,
      30,
    ),
    video: parseVideoLimits(process.env),
    aloneMs: Number(process.env.ALONE_TIMEOUT_MS ?? 120_000),
    idleMs: Number(process.env.IDLE_TIMEOUT_MS ?? 600_000),
    pausedMs: Number(process.env.PAUSED_TIMEOUT_MS ?? 600_000),
    warningMs: 120_000,
    managerUserId: process.env.MANAGER_USER_ID,
    rolePermissions: parseRolePermissions(process.env),
    excludedUserIds: parseIds(process.env.EXCLUDED_USER_IDS),
    integrationUserIds: parseIds(process.env.INTEGRATION_USER_IDS),
    forcedCompanionChannelIds: parseIds(
      process.env.FORCE_COMPANION_CHANNEL_IDS,
    ),
    canvasId: process.env.SLACK_CANVAS_ID,
    canvasSections: parseCanvasSections(process.env.CANVAS_SECTIONS),
    footer: optionalText(process.env.FOOTER),
    localControlToken: process.env.LOCAL_CONTROL_TOKEN,
    lastFmApiKey: process.env.LASTFM_API_KEY,
    lastFmSharedSecret: process.env.LASTFM_SHARED_SECRET,
    posthogApiKey: process.env.POSTHOG_API_KEY,
    posthogHost: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
    openRouterApiKey: optionalText(process.env.OPENROUTER_API_KEY),
  };
}
