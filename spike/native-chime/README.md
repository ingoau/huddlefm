# Native Chime spike

Throwaway test code, not part of the bot. It checks whether HuddleFM can join a Slack huddle's Amazon Chime meeting without Chromium. The three tests are:

1. Send audio.
2. Send video.
3. Receive speech signals (volume and presence) for ducking.

Plan: https://claude.ai/artifact/9b2vg5SMvtuHVBZnDuaeqr

It has its own `package.json` and is excluded from the root `tsconfig.json`. Nothing in `src/` imports it. The spike imports `src/ducking.ts` read-only, so it ducks exactly like the browser backend.

## Files

- `chime.ts` holds `rooms.join` and a minimal Chime signaling client: protobuf over WebSocket, JOIN, SUBSCRIBE, ping/pong, LEAVE.
- `recon.ts` joins, prints the JOIN_ACK and INDEX, and leaves. It sends no media.
- `chromium.ts` runs the current Chromium backend for comparison: it builds `src/media-page.ts`, serves it like the bot, launches Chrome with `MediaBrowserPool`'s flags and plays the same arpeggio.
- `bench.ts` runs either backend, samples its whole process tree (RSS and CPU) and times its `MARK` lines. Results go to `bench-results/` (gitignored).
- `media.ts` runs the full attendee. It connects through a `node-datachannel` peer (relay only), sends Opus audio at 128k stereo, optionally sends H.264 video through ffmpeg, logs speech signals and ducks the audio while someone talks. It reconnects when the signaling socket closes, ICE fails, or no signaling frame arrives for 15 s.
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
bun media.ts --ducking strong                    # off | gentle (default) | strong
bun media.ts --video --video-image card.png      # static card instead of a test pattern
bun bench.ts chromium --label chromium -- --seconds 75 --rejoin
bun bench.ts native --label native -- --video --video-image bench-results/card.png --seconds 45
```

- The default channel is `C0BPVPVLQ4D`; override it with `--channel`.
- `CHIME_MEDIA_REGION` defaults to `ap-southeast-2`.
- Ctrl-C sends LEAVE and waits for LEAVE_ACK.

### What participants should notice

- **Audio:** a repeating C-E-G-C arpeggio. The stream is stereo and its pan switches every 4 s, but the Slack client played it as mono in testing.
- **Video:** the ffmpeg `testsrc2` pattern with a "HuddleFM native spike" clock overlay. If ffmpeg has no `drawtext` filter (Homebrew's default build), it falls back to `testsrc`, which has a frame counter instead.
- **Speech signals:** the log prints `presence:`, `volume:` bars and `mute:` lines when someone joins, talks or mutes.
- **Ducking:** the arpeggio drops to 45% (`gentle`) within about 0.12 s of someone talking and comes back 1 s after they stop. The log prints `duck:` lines.

### Output

- A stats line every 10 s: audio and video packets sent, inbound RTP and RTCP, PLI/REMB/NACK counts, send errors, reconnects, speech-signal and duck counters, and undecodable signaling frames.
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

## Results so far (2026-09-29, macOS on a home network, huddle in `C0BPVPVLQ4D`)

All three tests pass, and reconnects work. A person in the huddle confirmed what they heard and saw after each run. No browser was involved.

| Test                 | Result                                                            |
| -------------------- | ----------------------------------------------------------------- |
| 1. Audio             | Pass. Clean, no dropouts; stereo is sent but Slack plays it mono. |
| 2. Video             | Pass, after two fixes (below).                                    |
| 3. Speech signals    | Pass. Presence, volume and mute all arrive; ducking works.        |
| Drops and reconnects | Pass with the reconnect logic added below.                        |

### What had to change

- **SUBSCRIBE was rejected** with `400 "failed to initialize video session"` even with a relay candidate, so the cloud-container result was an SDP problem, not only a network one. The JS SDK always offers an audio and a video m-line (video `inactive` when not sending), sends `duplex: RX` unless it sends video, sends `receive_stream_ids: [0]`, and rewrites `o=-` to `o=mozilla-chrome` (`SDP.withUnifiedPlanFormat()`). The spike now does all four and SUBSCRIBE is accepted.
- **Video was refused** with SUBSCRIBE_ACK `error.status: 206` and `duplex: "RX"`. In the SDK, 206 is `VideoCallSwitchToViewOnly`. INDEX said `at_capacity: true` and listed no sources, even with another participant's camera on. The cause was the spike's JOIN sending `max_num_of_videos: 0`; the SDK never sets it. Without it, INDEX shows `at_capacity: false` and the other camera as a source, and SUBSCRIBE comes back `DUPLEX`.
- **ffmpeg on macOS** (Homebrew) has no `drawtext`, so the spike falls back to `testsrc`.
- **Undecodable signaling frames.** After about 7 minutes the server sent a frame our v3.31.0 proto could not decode (protobufjs: `missing required 'type'`, most likely a newer frame type), which crashed the process. The spike now skips such frames and logs them, as the SDK does. It did not recur in the next run, so its type number is still unknown.

### Audio (120 s run)

- ICE connected through TURN (1 relay candidate, UDP) about 0.2 s after SUBSCRIBE_ACK.
- `audioSent` 5,993 at a steady 128 kbps with no send failures. Inbound: 5,960 audio RTP (the server mix, 50 pps) and 50 RTCP; PLI/REMB/NACK 0. No AUDIO_STATUS errors.
- The encoder is really stereo (TOC stereo bit set) and the answer accepts `stereo=1;sprop-stereo=1`, but the listener could not hear the 4 s pan switch. The Chromium bot also asks for stereo (`fullbandMusicStereo`), so this is Slack downmixing, not a native-only limitation.

### Video (60 s run)

- The listener saw the `testsrc` pattern in the bot's tile.
- 906 frames and 12,416 packets in 60 s (15 fps, about 780 kbps H.264 constrained baseline, 720×720). Inbound: 112 video RTCP, 2 PLI (the Slack client subscribing), 0 REMB, 0 NACK.

### Speech signals and ducking

- `presence:` for join, leave (`stream N left`) and rejoin; `volume:` levels while talking (121 non-zero samples across 1,668 AUDIO_METADATA frames in 120 s, about 14 frames/s); `mute:` for every mute and unmute.
- Ducking feeds these into `src/ducking.ts`'s `DuckingController`, with the SDK's volume normalisation (−42 dB to −14 dB → 0–1). Attendees missing from a frame count as silent, as in the SDK, which is what lets the duck release. In a 210 s run it ducked 15 times, each within one metadata frame of speech and released 1–3 s after it; gaps between words did not release it. The listener said it worked fine.

### Drops and reconnects

Drops were simulated by freezing the bun process with `SIGSTOP`/`SIGCONT`, so the server stops hearing from us. That does not model the local interface going down.

| Freeze | Without reconnect logic                                                                                                                                   | With reconnect logic                                      | What the listener saw                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| 5 s    | Survives; a few NACKs and PLIs.                                                                                                                           | No reconnect needed.                                      | Brief freeze, then seamless.                              |
| 10 s   | The server closes signaling (seen as `1006 "Connection ended"` on resume). Media keeps flowing for another 10–30 s, then ICE fails and every send throws. | —                                                         | —                                                         |
| 15 s   | Same as 10 s. The bot is left as a spinner tile until it times out.                                                                                       | Reconnected in 0.6 s on the first attempt, same attendee. | Frozen video, profile picture, spinner, then video again. |
| 70 s   | —                                                                                                                                                         | Reconnected in 1.2 s on the first attempt, same attendee. | As above, but the bot left the huddle and then rejoined.  |

- The server pings every 10 s and drops the signaling socket after one missed pong, so a native backend has well under 15 s before it must reconnect.
- **Reconnecting needs no new `rooms.join`.** A new signaling socket with the same JoinToken and `audio_session_id`, then JOIN, a new peer connection and SUBSCRIBE, brings the same attendee back, even after 70 s. This matches what the official Slack client does after it goes offline.
- The spike detects a drop from the socket closing, ICE failing, or 15 s without any signaling frame (the server sends BITRATES every 4 s). A real backend should also count missed pongs.

### Resources

| Run                                  | bun RSS  | bun CPU           | ffmpeg RSS | ffmpeg CPU        |
| ------------------------------------ | -------- | ----------------- | ---------- | ----------------- |
| Audio only, 120 s                    | 35–65 MB | 6.4 s (about 5%)  | —          | —                 |
| Audio + video, 420 s, two reconnects | 30–69 MB | 21.1 s (about 5%) | 21–44 MB   | 35.2 s (about 8%) |
| Audio + video + ducking, 210 s       | 28–67 MB | 12.1 s (about 6%) | 24–29 MB   | 18.4 s (about 9%) |

CPU is a share of one Apple Silicon core. The peak RSS is at startup; no run showed RSS growing over time.

### Chromium versus native (one huddle, same machine)

Both played the same arpeggio into the same huddle, one after the other. Chromium ran the real `src/media-page.ts` (Chrome 154, headless, launched like `MediaBrowserPool`) with artwork, title and progress. Native sent a screenshot of that page as a static card (`--video-image`). CPU and memory are the whole process tree in a steady window from 10 s after audio started until leaving.

|                                      | Chromium                                                      | Native                                      |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------------------------- |
| Join, cold (start to audio flowing)  | 9.5 s: launch 5.3, `rooms.join` 0.6, page 2.3, Chime join 1.3 | 1.5–2.2 s over three runs                   |
| Join, warm (browser already running) | 2.8 s                                                         | same as cold                                |
| CPU (share of one M4 core)           | about 40%: renderer 23, GPU 12, other helpers 5               | about 13%: bun 6, ffmpeg 7                  |
| Memory, steady                       | about 460 MB across 11 processes                              | about 88 MB (bun about 55, ffmpeg about 25) |
| Memory, peak                         | about 1 GB (at launch)                                        | 149 MB                                      |
| Audio                                | Opus, 128 kbps                                                | Opus, 128 kbps                              |
| Video                                | VP9 (libvpx), 30 fps, about 50 kbps                           | H.264 baseline, 15 fps, about 190 kbps      |
| Server-reported loss / RTT           | 0 / 25–38 ms                                                  | 0 / 26–34 ms                                |

- The listener heard no real difference in audio quality between the two.
- The harness's own bun process (56 MB, 1% CPU) is not counted for Chromium, since the bot's process exists either way.
- The first native card run used 23% CPU. ffmpeg re-decoded the PNG every frame and filled an 800 kbps target on a still image. Decoding once, looping the frame, CRF 30 and a 3 s keyframe interval brought ffmpeg from 17.5% to 7%. The testsrc pipeline still uses the fixed bitrate.
- Chromium's browser and GPU processes are shared between huddles, so each extra huddle costs it less than the single-huddle figure. That was not measured.
- These are macOS numbers with a GPU. In the Docker image Chromium renders in software, so its CPU cost there is likely higher.
- Native's card is a fixed screenshot. A v1 card redrawn with `@napi-rs/canvas` for progress would add some CPU.

### Not tested

- **The hour-long hold was skipped** by decision. The longest continuous run was 430 s, which is past the 300 s TURN credential TTL with no media interruption. A multi-hour soak test belongs to the real native backend behind a flag, not this spike.
- A real network drop (interface down) rather than a frozen process.
- Real music, artwork or lyrics video; only test tones and test patterns were sent.

### Earlier (2026-09-28, Claude Code cloud container)

Signaling (JOIN, JOIN_ACK, INDEX, ping/pong, LEAVE) worked from a container with no UDP and a TLS-intercepting egress gateway, but TURN never allocated there, so media could not be tested. TURN servers come from JOIN_ACK (`turn:ice.z2.as2.m.chime.aws:3478?transport=udp`, `turns:…:443?transport=tcp`, TTL 300 s). INDEX allows VP8, VP9, AV1 and every H.264 profile, and `video_subscription_limit` is 25.
