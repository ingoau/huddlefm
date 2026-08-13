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
    mediaRegion: process.env.CHIME_MEDIA_REGION ?? "ap-southeast-2",
    chromePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  };
}
