# HuddleFM

Single-workspace Slack Huddle music player. Inviting the dedicated HuddleFM user joins the Huddle, posts an interactive thread player, searches YouTube Music, validates direct media URLs, and publishes prepared audio through Amazon Chime.

Requirements: Bun, Chrome, `uv`, Python 3.13, Deno, FFmpeg, and network access. HuddleFM runs the current yt-dlp nightly release and lets it select supported YouTube clients automatically.

```bash
bun install
bun run check
bun test
bun run start
```

Configure `.env` with `SLACK_WORKSPACE_URL`, `SLACK_XOXP`, `SLACK_XAPP`, `SLACK_XOXC`, and `SLACK_XOXD`. Optional settings are `MANAGER_USER_ID`, `LOCAL_CONTROL_TOKEN`, `QUEUE_LIMIT`, `TRACK_DURATION_LIMIT_SECONDS`, `TRACK_DOWNLOAD_LIMIT_BYTES`, `INITIAL_VOLUME`, `IDLE_TIMEOUT_MS`, `CHIME_MEDIA_REGION`, `CHROME_PATH`, and `PORT`. The local `/join`, `/leave`, and `/tone` development routes require `Authorization: Bearer $LOCAL_CONTROL_TOKEN` and remain disabled when it is unset.

The service binds to loopback. It keeps Slack and Chime credentials in memory, authenticates its media bridge and audio URLs, stores session audit data but never restores queues, and removes prepared media when the session ends.
