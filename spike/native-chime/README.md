# Native Chime spike

Throwaway test code, not part of the bot. It checks whether HuddleFM can join a Slack huddle's Amazon Chime meeting without Chromium. The three tests are:

1. Send audio.
2. Send video.
3. Receive speech signals (volume and presence) for ducking.

Plan: https://claude.ai/artifact/9b2vg5SMvtuHVBZnDuaeqr

It has its own `package.json` and is excluded from the root `tsconfig.json`. Nothing in `src/` imports it.

## Files

- `chime.ts` holds `rooms.join` and a minimal Chime signaling client: protobuf over WebSocket, JOIN, SUBSCRIBE, ping/pong, LEAVE.
- `recon.ts` joins, prints the JOIN_ACK and INDEX, and leaves. It sends no media.
- `media.ts` runs the full attendee. It connects through a `node-datachannel` peer (relay only), sends Opus audio at 128k stereo, optionally sends H.264 video through ffmpeg, and logs speech signals.
- `SignalingProtocol.proto` is copied from `amazon-chime-sdk-js` v3.31.0 (Apache-2.0, see `SignalingProtocol.LICENSE` and `.NOTICE`).

## Setup

You need Bun. The video test also needs ffmpeg with libx264.

```sh
cd spike/native-chime
bun install
```

Create `.env` in this folder (it is gitignored) with:

```
SLACK_XOXD="xoxd-..."
SLACK_ENTERPRISE_XOXC="xoxc-..."
SLACK_TEAM_XOXC="xoxc-..."
```

`npx hc-slack-auth@latest hc-alt@ingo.au` writes exactly these variables; see "Auth" below. Set `SPIKE_ENV=/path/to/.env` to use a file somewhere else.

## Run

```sh
bun recon.ts [channelId]                         # signaling only, a few seconds
bun media.ts --seconds 120                       # audio + speech signals
bun media.ts --video --seconds 120               # adds a video tile
bun media.ts --video --no-audio --seconds 60     # video only
```

- The default channel is `C0BPVPVLQ4D`; override it with `--channel`.
- `CHIME_MEDIA_REGION` defaults to `ap-southeast-2`.
- Ctrl-C sends LEAVE and waits for LEAVE_ACK.

### What participants should notice

- **Audio:** a repeating C-E-G-C arpeggio. The pan switches between left-leaning and right-leaning every 4 s, which confirms stereo.
- **Video:** the ffmpeg `testsrc2` pattern with a "HuddleFM native spike" clock overlay.
- **Speech signals:** the log prints `presence:`, `volume:` bars and `mute:` lines when someone joins, talks or mutes.

### Output

- A stats line every 10 s: audio and video packets sent, inbound RTP and RTCP, PLI/REMB/NACK counts, and speech-signal counters.
- `last-sdp.txt` saves the offer and answer, with ICE passwords redacted.
- `last-frames.json` saves the signaling log, with tokens and TURN credentials redacted and `AUDIO_METADATA` omitted.

## Auth (`hc-slack-auth`)

`hc-slack-auth` is the repo owner's CLI. It signs into auth.hackclub.com, SSOs into Hack Club Slack, and exports the xoxc/xoxd tokens. The bot account is `hc-alt@ingo.au` (Slack user `U0A3976S3QV`, workspace `T0266FRGM` at https://hackclub.slack.com, enterprise `E09V59WQY1E`).

1. Run `npx hc-slack-auth@latest hc-alt@ingo.au` in this folder. It is an interactive TUI, so it needs a real TTY. An agent can drive it through `tmux`.
2. It asks for the **email login code**. The code arrives at hc-alt@ingo.au (the Fastmail "OTP Codes" folder) from `auth@hackclub.com`, with subject `NNN-NNN is your Hack Club login code`.
3. Type the code without the dash and press Enter. In a tmux-driven session the first Enter sometimes doesn't submit; press Enter again.
4. On the tokens screen, press `E` (save all) and confirm with `y`. It writes `.env` to the current directory with `SLACK_XOXD`, `SLACK_TEAM_XOXC` and `SLACK_ENTERPRISE_XOXC`. Press `q` to quit.
5. Check the session with `auth.test`, which is read-only:
   `curl -s https://hackclub.slack.com/api/auth.test -H "Cookie: d=$SLACK_XOXD" -F token="$SLACK_TEAM_XOXC"`

Never print or commit the tokens.

## Results so far (2026-09-28, from a Claude Code cloud container)

- **Signaling works natively from Bun.** The container reached `rooms.join`, the signaling WebSocket, JOIN, JOIN_ACK, INDEX, ping/pong and LEAVE/LEAVE_ACK. No browser was involved.
- **Slack's Chime is stock Chime.** TURN credentials arrive in JOIN_ACK:
  - `turn:ice.z2.as2.m.chime.aws:3478?transport=udp`
  - `turns:ice.z2.as2.m.chime.aws:443?transport=tcp`
  - The TTL is 300 s and `wants_compressed_sdp` is false.
- **INDEX** allows VP8, VP9, AV1 and every H.264 profile, and `video_subscription_limit` is 25. It also reported `at_capacity: true`; watch whether that blocks sending video.
- **Media was not tested.** That container has no UDP, and its egress gateway terminates TLS on 443 (the certificate issuer is "Anthropic Egress Gateway"), so TURN never allocated. Gathering produced 0 relay candidates, and SUBSCRIBE came back `{"status":400,"description":"failed to initialize video session"}`. That is expected without candidates, but it could also point to an SDP problem. Check again on a normal network.
