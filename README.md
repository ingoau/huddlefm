# HuddleFM

Single-workspace Slack Huddle music player. Inviting the dedicated HuddleFM user joins the Huddle, posts an interactive thread player, searches YouTube Music, validates direct media URLs, and publishes prepared audio through Amazon Chime.

Requirements: Bun, Chrome, `uv`, Python 3.13, FFmpeg, and network access. `uv` runs current `yt-dlp` with its maintained browser-based proof-of-origin plugin; its Chrome profile is isolated and unsigned-in.

```bash
bun install
bun run check
bun test
bun run start
```

Configure `.env` with `SLACK_WORKSPACE_URL`, `SLACK_XOXP`, `SLACK_XAPP`, `SLACK_XOXC`, and `SLACK_XOXD`. Optional limits are `QUEUE_LIMIT`, `TRACK_DURATION_LIMIT_SECONDS`, `TRACK_DOWNLOAD_LIMIT_BYTES`, `INITIAL_VOLUME`, `IDLE_TIMEOUT_MS`, `CHIME_MEDIA_REGION`, `CHROME_PATH`, and `PORT`.

The service binds to loopback. It keeps Slack and Chime credentials in memory, authenticates its media bridge and audio URLs, stores only session/queue state in `data/huddlefm.sqlite`, and removes prepared media when the session ends.
