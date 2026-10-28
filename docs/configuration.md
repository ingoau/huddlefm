# Configuration

Every option HuddleFM reads from `.env`. Only the Slack credentials are required; [`.env.example`](../.env.example) has the rest as commented defaults. See the [README](../README.md#self-hosting) to get started.

## Required

| Variable                | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `SLACK_WORKSPACE_URL`   | Workspace URL, e.g. `https://example.slack.com`                     |
| `SLACK_XOXP`            | User OAuth token used for Slack Web API calls                       |
| `SLACK_XAPP`            | App-level token used for Socket Mode                                |
| `SLACK_XOXC`            | Client token from the bot user's browser session                    |
| `SLACK_ENTERPRISE_XOXC` | Enterprise Grid client token; used instead of `SLACK_XOXC` when set |
| `SLACK_XOXD`            | `d` cookie from the same browser session                            |

## Optional Slack behavior

| Variable                      | Default | Purpose                                                                                                                                                                                      |
| ----------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANAGER_USER_ID`             | unset   | User who is always treated as a host                                                                                                                                                         |
| `CHANNEL_MANAGER_PERMISSIONS` | `end`   | What managers of a huddle's channel may do without joining: `none`, `end` the session, or everything a `host` can                                                                            |
| `WORKSPACE_ADMIN_PERMISSIONS` | `end`   | The same for Slack workspace admins and owners. Replaces `WORKSPACE_ADMINS_AS_MANAGERS=true`, which still means `host` until it is set                                                       |
| `EXCLUDED_USER_IDS`           | unset   | Comma/space-separated users ignored for participation, hosting, permissions, and scrobbling                                                                                                  |
| `FORCE_COMPANION_CHANNEL_IDS` | unset   | Channels that always get a separate HuddleFM controls channel                                                                                                                                |
| `SLACK_TEAM_ID`               | unset   | Workspace for companion channel creation; required for Enterprise Grid credentials                                                                                                           |
| `SLACK_CANVAS_ID`             | unset   | Canvas updated with live sessions and all-time listening stats                                                                                                                               |
| `CANVAS_SECTIONS`             | all     | Comma-separated canvas sections to show, in order: `summary`, `active sessions`, `top artists`, `top tracks`, `top videos`, `top video channels`, `top channels`, `controls`, `integrations` |
| `FOOTER`                      | unset   | Optional mrkdwn footer under the queue controls                                                                                                                                              |

## Optional features

| Variable                                  | Default                    | Purpose                                                                                                               |
| ----------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `LASTFM_API_KEY` / `LASTFM_SHARED_SECRET` | unset                      | Enables Last.fm account linking for scrobbling                                                                        |
| `OPENROUTER_API_KEY`                      | unset                      | Enables @mention AI controls via OpenRouter                                                                           |
| `POSTHOG_API_KEY`                         | unset                      | Enables PostHog analytics and error tracking                                                                          |
| `POSTHOG_HOST`                            | `https://us.i.posthog.com` | PostHog ingestion host                                                                                                |
| `LOCAL_CONTROL_TOKEN`                     | unset                      | Bearer token for local `/join`, `/leave`, `/tone`, and `/data-message` routes; leave unset for typical Docker deploys |

## Playback and limits

| Variable                        | Default          | Purpose                                                                                   |
| ------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `QUEUE_LIMIT`                   | `50`             | Maximum tracks in the queue                                                               |
| `TRACK_DURATION_LIMIT_SECONDS`  | `1200`           | Maximum track duration                                                                    |
| `TRACK_DOWNLOAD_LIMIT_BYTES`    | `100000000`      | Maximum download size                                                                     |
| `INITIAL_VOLUME`                | `0.5`            | Starting volume as a fraction of max                                                      |
| `DUCKING_MODE`                  | `gentle`         | Auto-duck default: `off`, `gentle`, `strong`                                              |
| `LYRICS_OFFSET_MS`              | `0`              | Shift the lyrics' timing; positive shows them later, for when they run ahead of the audio |
| `LOUDNESS_NORMALIZATION`        | `false`          | Set to `true` to level songs and videos to -14 LUFS                                       |
| `TRACK_PREPARATION_CONCURRENCY` | `2`              | Tracks downloaded and analysed at once, across all Huddles                                |
| `MEDIA_CACHE_LIMIT_BYTES`       | `1000000000`     | Disk kept for prepared tracks under `data/cache/media`; `0` disables and clears the cache |
| `MEDIA_CACHE_MAX_AGE_DAYS`      | `30`             | Re-download cached tracks older than this; `0` keeps them until evicted for space         |
| `ALONE_TIMEOUT_MS`              | `120000`         | Leave when alone for this long                                                            |
| `IDLE_TIMEOUT_MS`               | `600000`         | Leave when idle for this long                                                             |
| `PAUSED_TIMEOUT_MS`             | `600000`         | Leave when paused for this long                                                           |
| `CHIME_MEDIA_REGION`            | `ap-southeast-2` | AWS region for Chime media                                                                |

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

| Variable               | Default              | Purpose                                                      |
| ---------------------- | -------------------- | ------------------------------------------------------------ |
| `BGUTIL_SERVER_HOME`   | `/opt/bgutil/server` | BgUtils token server to run; empty turns tokens off          |
| `YOUTUBE_COOKIES_FILE` | unset                | Netscape cookies file of the YouTube account to sign in with |

## Logs

HuddleFM writes structured JSON logs to stdout and, by default, rotated files under `data/logs`. Those files survive container recreation because `data` is bind-mounted from the host. Use `LOG_LEVEL=debug` for detailed API and queue activity, or `trace` for playback-position events.

Logs can include Slack user, channel, session, and track identifiers. Credentials and known token fields are redacted. Rotation keeps the active file plus `LOG_FILE_COUNT` older files.

## Analytics

Set `POSTHOG_API_KEY` to send product events and sanitized errors to PostHog. Events use Slack user IDs as distinct IDs and never include Slack names, messages, search text, lyrics, audio, credentials, or raw API payloads. Active users get current-state person properties for their Last.fm and ListenBrainz connections, enabled settings, and scrobbling mode. HuddleFM keeps a random system identity in `data/posthog-installation-id`. Analytics is best-effort and disabled when the key is absent.
