# Configuration

Every option HuddleFM reads from `.env`. Only the Slack credentials are required; [`.env.example`](../.env.example) has the rest as commented defaults. See the [README](../README.md#self-hosting) to get started.

## Required

| Variable                | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `SLACK_WORKSPACE_URL`   | Workspace URL, e.g. `https://example.slack.com`                          |
| `SLACK_XOXP`            | User OAuth token used for Slack Web API calls; ignored with `SLACK_XOXB` |
| `SLACK_XAPP`            | App-level token used for Socket Mode                                     |
| `SLACK_XOXC`            | Client token from the bot user's browser session                         |
| `SLACK_ENTERPRISE_XOXC` | Enterprise Grid client token; used instead of `SLACK_XOXC` when set      |
| `SLACK_XOXD`            | `d` cookie from the same browser session                                 |

## Optional Slack behavior

| Variable                      | Default | Purpose                                                                                                                                                                                        |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANAGER_USER_ID`             | unset   | User who is always treated as a host                                                                                                                                                           |
| `ADMIN_USER_IDS`              | unset   | Comma-separated user IDs of HuddleFM admins: hosts and channel managers everywhere, and the only ones who see Settings' Admin tab, which lists the admins and takes a new YouTube cookies file |
| `CHANNEL_MANAGER_PERMISSIONS` | `end`   | What managers of a huddle's channel may do without joining: `none`, `end` the session, or everything a `host` can                                                                              |
| `WORKSPACE_ADMIN_PERMISSIONS` | `end`   | The same for Slack workspace admins and owners. Replaces `WORKSPACE_ADMINS_AS_MANAGERS=true`, which still means `host` until it is set                                                         |
| `EXCLUDED_USER_IDS`           | unset   | Comma/space-separated users ignored for participation, hosting, permissions, and scrobbling                                                                                                    |
| `FORCE_COMPANION_CHANNEL_IDS` | unset   | Channels that always get a separate HuddleFM controls channel                                                                                                                                  |
| `SLACK_TEAM_ID`               | unset   | Workspace for companion channel creation; required for Enterprise Grid credentials                                                                                                             |
| `SLACK_CANVAS_ID`             | unset   | Canvas updated with live sessions and all-time listening stats                                                                                                                                 |
| `CANVAS_SECTIONS`             | all     | Comma-separated canvas sections to show, in order: `summary`, `active sessions`, `top artists`, `top tracks`, `top videos`, `top video channels`, `top channels`, `controls`, `integrations`   |
| `FOOTER`                      | unset   | Optional mrkdwn footer under the queue controls                                                                                                                                                |

## Optional features

| Variable                                  | Default                    | Purpose                                                                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LASTFM_API_KEY` / `LASTFM_SHARED_SECRET` | unset                      | Enables Last.fm account linking for scrobbling                                                                                                                                                                                                            |
| `OPENROUTER_API_KEY`                      | unset                      | Enables @mention AI controls via OpenRouter                                                                                                                                                                                                               |
| `POSTHOG_API_KEY`                         | unset                      | Enables PostHog analytics and error tracking                                                                                                                                                                                                              |
| `POSTHOG_HOST`                            | `https://us.i.posthog.com` | PostHog ingestion host                                                                                                                                                                                                                                    |
| `LOCAL_CONTROL_TOKEN`                     | unset                      | Bearer token for local `/join`, `/leave`, `/tone`, and `/data-message` routes; leave unset for typical Docker deploys                                                                                                                                     |
| `MCP_TOKEN`                               | unset                      | Turns on HuddleFM's MCP server at `/mcp` (streamable HTTP, `Authorization: Bearer <token>`), with tools that each name a `channel`: join (a Huddle's thread, hosted by the user who asked), status, search, add, skip, previous, pause, resume, volume    |
| `MCP_CHANNEL_IDS`                         | unset                      | Optional comma-separated Slack channel IDs the MCP server may act in. Every tool call names its `channel` and acts only on the session running there; when this is set, other channels are refused too                                                    |
| `MCP_USER_ID`                             | first of `ADMIN_USER_IDS`  | Who MCP commands run as, with that user's permissions in the session                                                                                                                                                                                      |
| `SLACK_XOXB`                              | unset                      | Bot token. Messages and modals come from the app's bot user, mentions of that bot user trigger HuddleFM, and thread messages are read from the app's events (`message.channels`, `message.groups`, `app_mention`) instead of the signed-in account's feed |

## Bot user mode

By default the Slack app acts as the signed-in account: its user token
(`SLACK_XOXP`) posts the player, and mentions of that account in a Huddle
thread trigger HuddleFM. With `SLACK_XOXB` set, everything but the Huddle
itself moves to the app's bot user:

- The player, replies, ephemerals and modals come from the bot user.
- Mentioning the bot user is the trigger; mentions of the signed-in account are
  ignored.
- Thread messages are read from the app's own events, so the signed-in
  account's messages and DMs are not processed. Its realtime connection is
  still used for Huddle events (started, joined, left) and to join Huddles.
- That account counts as a listener, as its owner may be in the Huddle on
  another device. HuddleFM so stays in a Huddle with nobody else in it until
  it is ended from the player, or nothing plays for `IDLE_TIMEOUT_MS`.

| Variable              | Bot user mode                                      |
| --------------------- | -------------------------------------------------- |
| `SLACK_WORKSPACE_URL` | Required                                           |
| `SLACK_XAPP`          | Required, for Socket Mode events and button clicks |
| `SLACK_XOXB`          | Required, the app's bot token                      |
| `SLACK_XOXC`          | Required, to join Huddles                          |
| `SLACK_XOXD`          | Required, with `SLACK_XOXC`                        |

`SLACK_XOXP` is ignored in this mode. The Slack app needs Socket Mode,
Interactivity, the bot events `message.channels`, `message.groups` and
`app_mention`, and these bot scopes; this manifest sets them up:

```json
{
  "display_information": {
    "name": "HuddleFM",
    "description": "Music for Slack Huddles. Mention me in a Huddle thread to start.",
    "background_color": "#1d1d1d"
  },
  "features": {
    "bot_user": { "display_name": "HuddleFM", "always_online": true }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "canvases:write",
        "channels:history",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "emoji:read",
        "files:read",
        "groups:history",
        "groups:read",
        "im:read",
        "im:write",
        "mpim:read",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": ["app_mention", "message.channels", "message.groups"]
    },
    "interactivity": { "is_enabled": true },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

After installing it, the bot token is `SLACK_XOXB`, and an app-level token
with `connections:write` (Basic Information, App-Level Tokens) is `SLACK_XAPP`.
`canvases:write` is only needed with `SLACK_CANVAS_ID`, and `chat:write.public`
only to post in public channels the bot was not invited to. `files:read` lets admins upload YouTube cookies from Settings.

Invite the bot user to every channel whose Huddles it should hear about; it only
receives events from channels it is in.

## Playback and limits

| Variable                        | Default          | Purpose                                                                                                                                                                                                                   |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUEUE_LIMIT`                   | `50`             | Maximum tracks in the queue                                                                                                                                                                                               |
| `TRACK_DURATION_LIMIT_SECONDS`  | `1200`           | Maximum track duration                                                                                                                                                                                                    |
| `TRACK_DOWNLOAD_LIMIT_BYTES`    | `100000000`      | Maximum download size                                                                                                                                                                                                     |
| `INITIAL_VOLUME`                | `0.35`           | Starting volume as a fraction of max                                                                                                                                                                                      |
| `DUCKING_MODE`                  | `gentle`         | Auto-duck default: `off`, `gentle`, `strong`                                                                                                                                                                              |
| `LYRICS_OFFSET_MS`              | `0`              | Shift the lyrics' timing; positive shows them later, for when they run ahead of the audio                                                                                                                                 |
| `LOUDNESS_NORMALIZATION`        | `false`          | Set to `true` to level songs and videos to -14 LUFS                                                                                                                                                                       |
| `TRACK_PREPARATION_CONCURRENCY` | `2`              | Tracks downloaded and analysed at once, across all Huddles                                                                                                                                                                |
| `MEDIA_CACHE_LIMIT_BYTES`       | `1000000000`     | Disk kept for prepared tracks under `data/cache/media`; `0` disables and clears the cache                                                                                                                                 |
| `MEDIA_CACHE_MAX_AGE_DAYS`      | `30`             | Re-download cached tracks older than this; `0` keeps them until evicted for space                                                                                                                                         |
| `AUTOPLAY`                      | `off`            | Autoplay for a new session: `off`, `related` (songs like the last one) or `huddle` (a mix of what people in the Huddle listen to); with it on, a session starts playing by itself. A channel's saved defaults override it |
| `AUTOPLAY_QUEUE`                | `10`             | How many autoplay picks are kept queued while autoplay is on and nobody has queued a song; each can be removed from the queue                                                                                             |
| `ALONE_TIMEOUT_MS`              | `120000`         | Leave when alone for this long                                                                                                                                                                                            |
| `IDLE_TIMEOUT_MS`               | `600000`         | Leave when idle for this long                                                                                                                                                                                             |
| `PAUSED_TIMEOUT_MS`             | `600000`         | Leave when paused for this long                                                                                                                                                                                           |
| `CHIME_MEDIA_REGION`            | `ap-southeast-2` | AWS region for Chime media                                                                                                                                                                                                |

## Video mode

| Variable                       | Default      | Purpose                                                                                                       |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `VIDEO_DURATION_LIMIT_SECONDS` | `3600`       | Longest video allowed                                                                                         |
| `VIDEO_DOWNLOAD_LIMIT_BYTES`   | `1500000000` | Largest video download                                                                                        |
| `VIDEO_MAX_HEIGHT`             | `720`        | Height videos are downloaded and shared at, from `240` to `1080`; the share is 16:9                           |
| `VIDEO_MAX_FPS`                | `30`         | Frame rate videos are downloaded and shared at, up to `30`                                                    |
| `VIDEO_SESSION_LIMIT`          | `2`          | Huddles that may be in video mode at once; each takes about a CPU core. `0` turns it off                      |
| `VIDEO_CACHE_LIMIT_BYTES`      | `5000000000` | Disk kept for prepared videos under `data/cache/video`, apart from the song cache; `0` disables and clears it |
| `JELLYFIN_ENABLED`             | `true`       | Lets users link their own Jellyfin servers; `false` turns it off                                              |

## Runtime and logging

| Variable         | Default                    | Purpose                                                              |
| ---------------- | -------------------------- | -------------------------------------------------------------------- |
| `BIND_ADDRESS`   | `127.0.0.1`                | HTTP bind address (loopback is fine; Compose does not publish ports) |
| `PORT`           | `3210`                     | HTTP port                                                            |
| `LOG_LEVEL`      | `info`                     | Minimum operational log level (`debug`, `trace`, …)                  |
| `LOG_FILE`       | `data/logs/huddlefm.jsonl` | Rotated JSON log path; set empty to disable file logging             |
| `LOG_FILE_SIZE`  | `10m`                      | Maximum size of each log file                                        |
| `LOG_FILE_COUNT` | `7`                        | Rotated files retained in addition to the active file                |

## Media

Chime media needs outbound UDP 3478 or TLS on port 443 to `*.chime.aws`.

Each Huddle's media runs in its own process, so a crash ends only that session. Live streams, YouTube videos in video mode and Jellyfin items stream as they play rather than downloading first; a YouTube video also downloads into the video cache behind it.

With `LOUDNESS_NORMALIZATION` on, songs are re-encoded at -14 LUFS as they download. Videos are measured instead and turned to the same level as they play (lifting a quiet one by at most 6 dB); each measurement is kept, so a video is levelled from its first second every time after.

## YouTube

YouTube sometimes stops downloads with "Sign in to confirm you're not a bot", more often from datacenter addresses. The image includes the [BgUtils](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) proof-of-origin token server, which the bot starts once and keeps running, so yt-dlp's requests carry the tokens a browser's would. It reaches YouTube only through the bot's public-network proxy. Set `BGUTIL_SERVER_HOME` empty to turn it off.

If the bot check keeps coming back, sign yt-dlp in to a YouTube account with its cookies:

1. Use a separate Google account made for the bot, not your own: Google can lock accounts used for automated downloads.
2. In a private browser window, sign in to that account on youtube.com, then open `https://www.youtube.com/robots.txt` in the same tab.
3. Export the window's `youtube.com` cookies in Netscape format, with an extension like [Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY), to `data/youtube-cookies.txt`.
4. Close the private window without signing out, so the browser never rotates those cookies.
5. Set `YOUTUBE_COOKIES_FILE=data/youtube-cookies.txt` and restart.

The bot keeps only the file's YouTube and Google cookies, and writes the ones YouTube rotates back to it, so it stays signed in. If YouTube rejects the cookies, the log says so; export them again.

| Variable               | Default              | Purpose                                                                                                                                                                  |
| ---------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BGUTIL_SERVER_HOME`   | `/opt/bgutil/server` | BgUtils token server to run; empty turns tokens off                                                                                                                      |
| `YOUTUBE_COOKIES_FILE` | unset                | Netscape cookies file of the YouTube account to sign in with; admins can also upload one from Settings' Admin tab, kept at `data/youtube-cookies.txt` when this is unset |

## Logs

HuddleFM writes structured JSON logs to stdout and, by default, rotated files under `data/logs`. Those files survive container recreation because `data` is bind-mounted from the host. Use `LOG_LEVEL=debug` for detailed API and queue activity, or `trace` for playback-position events.

Logs can include Slack user, channel, session, and track identifiers. Credentials and known token fields are redacted. Rotation keeps the active file plus `LOG_FILE_COUNT` older files.

## Analytics

Set `POSTHOG_API_KEY` to send product events and sanitized errors to PostHog. Events use Slack user IDs as distinct IDs and never include Slack names, messages, search text, lyrics, audio, credentials, or raw API payloads. Active users get current-state person properties for their Last.fm and ListenBrainz connections, enabled settings, and scrobbling mode. HuddleFM keeps a random system identity in `data/posthog-installation-id`. Analytics is best-effort and disabled when the key is absent.
