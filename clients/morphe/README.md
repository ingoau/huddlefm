# HuddleFM for Slack on Android

A [Morphe](https://morphe.software) patch for Slack's Android app that puts HuddleFM in the huddle, the way the [Taut](../taut/) and [Slick](../slick/) plugins do on desktop. It talks to the bot over the huddle's Chime data channel, as [docs/data-channel.md](../../docs/data-channel.md) describes, so it needs nothing from the server but a HuddleFM in the huddle.

It's a bundle of its own, so it can be applied alone or beside [Slick Android](https://github.com/3kh0/slick-morphe), which it doesn't need. It targets the same Slack release as Slick Android, **26.11.30.0**.

## What it does

- **A now playing card**, above the huddle's buttons while HuddleFM is in the huddle: the song and its artwork, how many are up next, play/pause and next, and its progress along the foot. The huddle's tiles make room for it rather than going under it. A tap anywhere else on it opens the controls.
- **HuddleFM in More Options** (the huddle's ⋮), after Slack's own Play music, with what's playing under it. It opens the controls too.
- **The controls**, a sheet over the huddle in its dark look:
  - the song, with a seek bar, previous, play/pause, next and volume, or **Play something** and **Load a saved session** when nothing is playing
  - search, or a pasted link, to add songs. The sparkle beside it opens what Slack's Add songs offers before anything's typed: recommendations and recently added songs. Something on Jellyfin that needs picking first asks which.
  - **Up next**, with a menu on each song to play it now, keep an autoplay pick, move it to the start or end, up or down, or remove it, and shuffle and clear
  - **Lyrics** in music mode: the song's synced lyrics, the line being sung lit and followed, and a tap on a line jumping there
  - **Take over** when nobody is host
  - **Settings**, in Session, Host and You groups, drawn from the bot's own settings, so they match its Settings in Slack, and **End session**, which asks, as Slack's does, whether to save the session for next time
- **Android's media controls**: the song, its artwork and position in the quick settings' player and on the lock screen, with play/pause, previous, next and seeking, run as the card's buttons are. **Settings → On this phone → Show in media controls** turns it off, on that phone only. Headphone buttons don't reach it: during a call, which a huddle is, Android sends them to the call, where play/pause hangs up, as it does in Slack without the patch.
- When HuddleFM isn't in the huddle, **Start HuddleFM** invites it as the huddle's Invite people does. It invites the HuddleFM last heard in a huddle of that workspace, so the first time, invite it with Invite people.
- A control someone may not use is dimmed, and says who to ask when tapped. The bot still decides: when it says no, a toast says why.
- Everything counts as the user's own, as if they had used the player in Slack: the bot runs the same code for it, and its audit log notes it came over the data channel. What's for one user comes sealed to them, as for the plugins.

## Install

On Android, install [Morphe Manager](https://morphe.software), then tap **Add to Morphe** under Android in the [website's plugins](https://ingoau.github.io/huddlefm/#plugins). Morphe asks before it adds HuddleFM as a patch source, for Slack only, and keeps it up to date from this repository's releases. Add [Slick Android](https://github.com/3kh0/slick-morphe) the same way if you want it too, then patch Slack 26.11.30.0 with **HuddleFM** selected.

## Build

You need JDK 21 or newer. The build fetches Morphe, Kotlin, R8 and the Android platform at the same pinned, checksummed versions as Slick Android's, into `work/`:

```sh
export JAVA_HOME=/path/to/jdk
bash build.sh   # writes dist/huddlefm-android-0.0.0-dev.mpp and dist/patches-list.json
```

The **Client plugins** workflow also builds it for every branch and pull request that changes it, as the `huddlefm-morphe-patch` artifact. In Morphe Manager, a built `.mpp` can be added as a local patch source. With Morphe's desktop CLI, from the split APKs of Slack 26.11.30.0 (as an `.apkm`, a zip of `base.apk` and its config splits), give it both bundles, or only HuddleFM's, with absolute paths:

```sh
java -jar morphe.jar patch \
  -p /path/to/slick-android.mpp \
  -p /path/to/huddlefm-android.mpp \
  -o /path/to/slack-patched.apk /path/to/slack-26.11.30.0.apkm
```

## Release

Pushing a `morphe-v1.2.3` tag runs the **Morphe release** workflow: it builds that version, attaches `huddlefm-android-1.2.3.mpp` to a GitHub release, and commits `patches-bundle.json` and `patches-list.json` to the root of `main`, which is where Morphe Manager looks for updates. A pre-release tag, like `morphe-v1.3.0-beta.1`, is released without them, so Morphe Manager doesn't offer it.

The patch targets the Slack release Slick Android does, so the two can be applied together. The **Morphe target** workflow checks Slick Android's target every day, and opens an issue when it has moved to another Slack release.

## Debugging

Join a huddle with HuddleFM. It logs to logcat with the tag `HuddleFM` (`adb logcat -s HuddleFM`).

## How it's put together

`patches/HuddleFM.kt` is the patch: a handful of small hooks into Slack, each calling a static method of the extension. `extension/` is the extension, in Java, compiled to `huddlefm-extension.dex`, which the patch adds to the app. `stubs/` are the few Slack classes the extension compiles against; the app has the real ones, so they aren't in the dex.

- `Client.java` and `Seal.java` port `../core/protocol.ts` and `../core/seal.ts`: the session's state, chunks, requests and their results, pings, and opening what the bot seals with ECDH on P-256 and AES-GCM.
- `Channel.java` reaches the data channel. Slack's huddle session, `ChimeMeetingSessionImpl`, listens on its own topic once the huddle's audio has started; the patch hooks that observer's constructor, and the extension adds its own observer on the `huddlefm` topic to the same Chime facade, and sends with its `realtimeSendDataMessage`. The user is the one in the session's Chime external user id.
- `Card.java` is the now playing card, put in the huddle with Compose's `AndroidView`.
- `Media.java` is the media session behind Android's media controls.
- `Menu.java` is the More Options row, and `Panel.java` the controls, drawn with Android's views, Slack's Lato and its icons.
- `Invite.java` invites HuddleFM through Slack's own invitees manager.

### Slack's pieces it relies on

These are Slack's internals, so any Slack release can change them, and the patch checks each before it changes anything:

- `SlackApp.onCreate`, to start
- `ChimeMeetingSessionImpl$addMonitoringForDataMessages$observer$1`'s constructor, and the session's `chimeAudioVideo` and `chimeHostExternalUserId`; `ChimeMeetingSessionImpl.leaveCall`, for leaving
- `HuddleGalleryUiKt.HeaderBannerGrid`, the huddle's column, where the card goes between the tiles' box and `HuddleBottomBarScreen`
- `HuddleSettingsDataUseCaseImpl.getMoreOptionsSection`, where the row is added after the `id_jukebox_options` row it's made like, and `HuddleSettingsPresenter`'s click handler, which the row's clicks stop at
- `HuddleState$Active`, for the huddle's channel and workspace, and `HuddleInviteesManagerImpl.inviteUserToHuddle`, for **Start HuddleFM**

### What it doesn't do

- Settings that pick a person, like **Transfer host**, show who's set but are changed in Slack, as the patch can't name people.
- **Accounts and more** (scrobbling, Jellyfin linking) stay in HuddleFM's Settings in Slack.
