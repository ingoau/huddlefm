const required = [
  "SLACK_WORKSPACE_URL",
  "SLACK_XOXP",
  "SLACK_XAPP",
  "SLACK_XOXC",
  "SLACK_XOXD",
] as const;

export function parseIds(value = "") {
  return new Set(value.split(/[\s,]+/).filter(Boolean));
}

export function loadConfig() {
  for (const name of required)
    if (!process.env[name]) throw new Error(`Missing ${name}`);

  return {
    workspaceUrl: process.env.SLACK_WORKSPACE_URL!,
    xoxp: process.env.SLACK_XOXP!,
    xapp: process.env.SLACK_XAPP!,
    xoxc: process.env.SLACK_XOXC!,
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
    loudnessNormalization: process.env.LOUDNESS_NORMALIZATION === "true",
    aloneMs: Number(process.env.ALONE_TIMEOUT_MS ?? 120_000),
    idleMs: Number(process.env.IDLE_TIMEOUT_MS ?? 600_000),
    pausedMs: Number(process.env.PAUSED_TIMEOUT_MS ?? 600_000),
    warningMs: 120_000,
    managerUserId: process.env.MANAGER_USER_ID,
    excludedUserIds: parseIds(process.env.EXCLUDED_USER_IDS),
    forcedCompanionChannelIds: parseIds(
      process.env.FORCE_COMPANION_CHANNEL_IDS,
    ),
    canvasId: process.env.SLACK_CANVAS_ID,
    localControlToken: process.env.LOCAL_CONTROL_TOKEN,
    lastFmApiKey: process.env.LASTFM_API_KEY,
    lastFmSharedSecret: process.env.LASTFM_SHARED_SECRET,
    chromePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  };
}
