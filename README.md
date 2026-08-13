# HuddleFM

Single-workspace Slack Huddle music player. Inviting the dedicated HuddleFM user joins the Huddle, posts an interactive thread player, searches YouTube Music, validates direct media URLs, and publishes prepared audio through Amazon Chime. It also fetches timed lyrics from Better Lyrics' Unison service, renders them with Better Lyrics' Braccato engine, and sends the square page capture as the Huddle camera.

Requirements: Bun, Chrome, yt-dlp, Deno, FFmpeg, and network access. HuddleFM lets yt-dlp select supported YouTube clients automatically.

```bash
bun install
bun run check
bun test
bun run start
```

Configure `.env` with `SLACK_WORKSPACE_URL`, `SLACK_XOXP`, `SLACK_XAPP`, `SLACK_XOXC`, and `SLACK_XOXD`. Optional settings are `MANAGER_USER_ID`, `LOCAL_CONTROL_TOKEN`, `QUEUE_LIMIT`, `TRACK_DURATION_LIMIT_SECONDS`, `TRACK_DOWNLOAD_LIMIT_BYTES`, `INITIAL_VOLUME`, `IDLE_TIMEOUT_MS`, `CHIME_MEDIA_REGION`, `CHROME_PATH`, `BIND_ADDRESS`, and `PORT`. The local `/join`, `/leave`, and `/tone` development routes require `Authorization: Bearer $LOCAL_CONTROL_TOKEN` and remain disabled when it is unset.

## Docker

The image installs the current yt-dlp nightly release at build time.

```bash
docker build --pull -t huddlefm .
docker run --rm --init --env-file .env -p 3210:3210 -v huddlefm-data:/app/data huddlefm
```

Published images are available as `ghcr.io/ingoau/huddlefm:latest`.

The service binds to loopback by default; the container binds to all interfaces. It keeps Slack and Chime credentials in memory, authenticates its media bridge and audio URLs, stores session data without restoring queues, and removes prepared media when the session ends. Audit events are appended as JSON Lines to `data/audit.jsonl`; Compose bind-mounts that directory so the file can be opened directly on the host.
