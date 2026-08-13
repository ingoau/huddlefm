# HuddleFM

Single-workspace Slack Huddle music player. Inviting the dedicated HuddleFM user joins the Huddle, posts an interactive thread player, searches YouTube Music, validates direct media URLs, and publishes prepared audio through Amazon Chime.

Requirements: Bun, Chrome, Node.js 20+, npm, git, `uv`, Python 3.13, FFmpeg, and network access. On first start HuddleFM installs the pinned BgUtils provider under `data/`, then manages its loopback-only token server for subsequent `yt-dlp` calls.

```bash
bun install
bun run check
bun test
bun run start
```

Configure `.env` with `SLACK_WORKSPACE_URL`, `SLACK_XOXP`, `SLACK_XAPP`, `SLACK_XOXC`, and `SLACK_XOXD`. Optional settings are `MANAGER_USER_ID`, `LOCAL_CONTROL_TOKEN`, `QUEUE_LIMIT`, `TRACK_DURATION_LIMIT_SECONDS`, `TRACK_DOWNLOAD_LIMIT_BYTES`, `INITIAL_VOLUME`, `IDLE_TIMEOUT_MS`, `BGUTIL_PORT`, `CHIME_MEDIA_REGION`, `CHROME_PATH`, and `PORT`. The local `/join`, `/leave`, and `/tone` development routes require `Authorization: Bearer $LOCAL_CONTROL_TOKEN` and remain disabled when it is unset.

The service binds to loopback. It keeps Slack and Chime credentials in memory, authenticates its media bridge and audio URLs, stores session audit data but never restores queues, and removes prepared media when the session ends.
