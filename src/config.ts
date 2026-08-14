const required = [
  "SLACK_WORKSPACE_URL",
  "SLACK_XOXP",
  "SLACK_XAPP",
  "SLACK_XOXC",
  "SLACK_XOXD",
] as const;

export function loadConfig() {
  for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`);

  return {
    workspaceUrl: process.env.SLACK_WORKSPACE_URL!,
    xoxp: process.env.SLACK_XOXP!,
    xapp: process.env.SLACK_XAPP!,
    xoxc: process.env.SLACK_XOXC!,
    xoxd: process.env.SLACK_XOXD!,
    port: Number(process.env.PORT ?? 3210),
    bindAddress: process.env.BIND_ADDRESS ?? "127.0.0.1",
    mediaRegion: process.env.CHIME_MEDIA_REGION ?? "ap-southeast-2",
    queueLimit: Number(process.env.QUEUE_LIMIT ?? 50),
    durationSeconds: Number(process.env.TRACK_DURATION_LIMIT_SECONDS ?? 1_200),
    downloadBytes: Number(process.env.TRACK_DOWNLOAD_LIMIT_BYTES ?? 100_000_000),
    initialVolume: Number(process.env.INITIAL_VOLUME ?? 0.1),
    idleMs: Number(process.env.IDLE_TIMEOUT_MS ?? 120_000),
    pausedMs: Number(process.env.PAUSED_TIMEOUT_MS ?? 600_000),
    managerUserId: process.env.MANAGER_USER_ID ?? "U0923H02Y3B",
    localControlToken: process.env.LOCAL_CONTROL_TOKEN,
    chromePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  };
}
