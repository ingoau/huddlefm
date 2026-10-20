# HuddleFM

HuddleFM is a self hosted music bot for Slack huddles. Invite it to a Huddle and participants can search for songs, albums, playlists from YouTube, or add supported media links; build and reorder a shared queue; and control playback, seeking, volume, autoplay, loop, and permissions directly through Slack.

HuddleFM uses an automated user account to join the huddle as Slack doesn't provide an API for joining huddles programmatically. Don't warn me about this.

HuddleFM's codebase is primarily AI generated.

## Goals

- Let people start a shared listening session in Slack huddles
- Deliver a stable and polished user experience
- Keep the frontend the users see intuitive, and reduce typing in favor of clicking
- Recover gracefully from restarts, failures, and malformed media
- Support multiple huddles and handle them concurrently and independently
- Protect credentials, user data, and the host network
- Keep deployment simple with a single container

## Architecture

The code in this repo runs in a Docker container, and this is the primary deployment method.

### Application shell

`src/index.ts` is the composition root. It:

- Loads configuration.
- Starts the Bun HTTP server.
- Connects to Slack.
- Initializes track search, persistence, and scrobbling.
- Creates one runtime and coordinator per active Huddle.
- Restores interrupted sessions after a short restart.
- Handles graceful shutdown.

### Slack integration

Slack communication is split between two adapters:

- `src/slack-app.ts` uses Slack Socket Mode and the official Web API for messages, interactive controls, modals, searches, and ephemeral notices.
- `src/slack-huddle.ts` handles Huddle invitations, participant events, Huddle discovery, and joining the underlying Amazon Chime meeting, using an unofficial connection to the Slack API as a user, using session credentials.

### Session coordinator

Each active Huddle gets a Coordinator (`src/coordinator.ts`). It owns:

- Current track, queue, and history.
- Playback state and position.
- Host and participant membership.
- Permission rules.
- Autoplay and recommendations.
- Inactivity and paused-session timers.
- Slack UI rendering.
- Session suspension, restoration, and termination.

User actions are serialized through an internal promise queue, preventing concurrent Slack interactions from corrupting session state.

### Media bridge

`src/native-media/` joins each Huddle's Amazon Chime meeting directly. Each Huddle's media runs in its own Bun process (`main.ts`, supervised by `session.ts`), so a crash ends only that session. Inside it:

- Protobuf signaling (`signaling.ts`) and a relay-only `node-datachannel` peer with reconnects (`chime-link.ts`).
- An audio engine with decks, transitions, volume, ducking and a limiter (`audio-engine.ts`), which decodes downloaded tracks with ffmpeg and sends them as the Huddle microphone input.
- A video card drawn with Skia and encoded with x264 (`video-card.ts`, `video-feed.ts`): a default and a lyrics layout, with Apple Music style synced lyrics (`lyrics-view.ts`) animated on springs and tweens (`motion.ts`). The card and its encoder run in a worker (`video-worker.ts`, driven by `video-thread.ts`) so drawing never delays the audio pacer; the playback position and the encoded video cross between the threads in shared memory (`unit-ring.ts`), because frame-rate messages are costly in Bun.
- In video mode, a second attendee, `<bot>#content`, like the JS SDK's content share (`content-shares.ts` counts other people's shares). It carries the music and a 16:9 picture: the card, scaled, or the playing video, decoded by `video-player.ts` in step with the audio's position, with captions burned in. If it fails, the camera tile and the bot's own audio take over.
- Playback position and errors are reported back to the server.

The coordinator talks to the process with JSON lines over stdin/stdout. Audio files and artwork are exposed through token-protected, loopback-only URLs.

#### Additional services include:

- `src/media-cache.ts`: keeps prepared tracks on disk, keyed by source, so a repeated song is hardlinked into its session instead of downloaded again.
- `src/videos.ts`: video mode's helpers: YouTube search results, a song's official video, captions, chapters and video titles. Video mode itself lives in the coordinator, which prepares each track again for the mode it is in.
- `src/lyrics.ts`: queries multiple lyric providers concurrently and selects the best synchronized result.
- `src/scrobbling.ts`: tracks each participant's actual listening time and submits eligible listens to Last.fm or ListenBrainz.
- `src/audit-log.ts`: writes append-only JSONL audit events.
- `src/canvas.ts`: generates aggregate statistics for an optional Slack Canvas.

In short: Slack is the interface, each coordinator is the session brain, and a native media process is the virtual Huddle participant that actually transmits the music and visuals.

## Glossary

When communicating, use this language:

- you: the agent reading this file and modifying code
- user: the person using the bot in Slack
- bot: the dedicated HuddleFM Slack user

## Contributing

### Testing and formatting

Before committing/pushing changes, run tests and format the code.

If any code that you haven't touched changes after a format, flag it with me, and don't add it to the commit or push it.
