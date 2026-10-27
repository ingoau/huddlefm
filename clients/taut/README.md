# HuddleFM for Taut

A [Taut](https://github.com/jeremy46231/taut) plugin that puts HuddleFM's controls in the huddle itself, drawn with Slack's own components. It talks to the bot over the huddle's Chime data channel, as [docs/data-channel.md](../../docs/data-channel.md) describes, so it needs nothing from the server but a HuddleFM in the huddle.

## What it does

- **In the huddle's toolbar**, after the thread button: the song playing, with its artwork, play/pause and next, shown as on while its popover is open. When the window is too narrow for that, a music note stands in for it, and narrower still, where Slack leaves out screen sharing, HuddleFM goes too. The toolbar is in the huddle's own window, or at the bottom of Slack's main window while that window is closed.
- **A popover** from either holds the rest:
  - the song, with a seek bar that shows the time under the pointer and volume, or **Play something** and **Load a saved session** when nothing is playing
  - search, or a pasted link, to add songs. The sparkle beside it opens a page of what Slack's Add songs offers before anything's typed, in tabs: **Recommended**, **Recently added** and **Discover**. Someone who has linked Jellyfin can search it too, and pick a show's episodes or where to resume a film there.
  - the queue, to drag into order, or double-click a song to play it now, with a menu on each to move it to the start or end, up or down, or remove it, and to keep an autoplay pick with **Add to queue**
  - **Lyrics** beside the queue in music mode: the song's synced lyrics, the line being sung lit and kept in view, and a click on a line jumping there
  - **Take over** when nobody is host
- **Settings**, in Session, Host and You tabs, show what each person may change: mode, volume, autoplay, loop, permissions, host and their own scrobbling. These come from the bot, so they match its Settings in Slack, which **Accounts and more in Slack** opens for linking accounts and the rest. **End session** asks, as Slack's does, whether to save the session for next time.
- When HuddleFM isn't in the huddle, the note offers **Start HuddleFM**, which invites it like the huddle's Invite people does. It searches the workspace for users with HuddleFM in their name, so "HuddleFM [bot]" counts. If there's more than one, the popover asks which, and keeps that choice, which it offers again to change. The HuddleFM last heard in a huddle is the default.
- A control someone may not use is greyed out, and says on hover who to ask. The bot still decides: when it says no, the popover says why.
- **Media keys** play, pause, skip and go back, and the song shows in the system's media controls.
- Everything counts as the user's own, as if they had used the player in Slack: the bot runs the same code for it, and its audit log notes it came over the data channel.

### Options

In Slack's **Preferences → Taut → HuddleFM**:

- **Shrink HuddleFM's message**: the player message in the huddle's thread shrinks to one line while the controls are in the toolbar. On by default.
- **Hide HuddleFM's tile**: leaves the bot out of the huddle's grid. Its screen share in video mode still shows. Off by default.
- **Hide captions of HuddleFM's music**: Slack transcribes the music too; this leaves the bot out of the captions over the huddle and in its Captions tab. On by default.
- **Media keys**: control HuddleFM with the keyboard's media keys, and show its song in the system's media controls. On by default.

## Build and install

The **Taut plugin** workflow builds it on every change here: download `HuddleFM.js` from the `huddlefm-taut-plugin` artifact of its latest run. To build it yourself, from a checkout of Taut after `npm install`:

```sh
npm run build:user-plugin -- /path/to/huddlefm/clients/taut/HuddleFM.tsx
```

That writes `HuddleFM.js` next to the source. Install it from Slack's **Preferences → Taut**, turn it on, and join a huddle with HuddleFM. On desktop, `Ctrl`+`Alt`+`I` (`Cmd`+`Option`+`I`) opens DevTools, where the plugin logs with `[Taut] [HuddleFM]`.

To work on it, link `HuddleFM.tsx` and `../core` into a Taut checkout (`plugins/HuddleFM.tsx`, and `core` beside `plugins/`, as the workflow copies them) and run Taut's dev server, which rebuilds on every change.

## How it's put together

- `../core/` has no Taut in it: the protocol client (`protocol.ts`), the bar and popover (`panel.tsx`), which draw with a kit of Slack components the mod hands in (`kit.ts`), and the media keys (`media-keys.ts`). A plugin for another client mod, like Slick, can reuse it with its own kit.
- `HuddleFM.tsx` is the Taut side: the data channel, the kit, and the patches that place the bar and hide the tile, the captions and the player message.

### Reaching the data channel

Slack's huddle session (from `HuddleConnectionManager.getInstance().getHuddlesSdk()`) takes data channel subscribers through `addDataChannelSubscriber`, and hands each one Chime's `AudioVideoFacade` once audio connects. The plugin adds one to every session, which it catches by wrapping `setHuddlesSdk`. A new session gets its subscriber list from `initialize`, which runs after that, so the plugin adds itself only once `initialize` has started. Then it uses the facade's `realtimeSendDataMessage` and `realtimeSubscribeToReceiveDataMessage` on its own topic. Slack's own messages use other topics, so it doesn't notice.

### Slack's pieces it relies on

These are Slack's internals, so any Slack release can change them:

- `HuddleToolbarThreadButton`, to place the bar after it, and its `className` and `buttonToggledOnClassName` for the toolbar's look
- for the tile, the views that lay out the huddle's tiles (`HuddleCompactVideoPane`, `HuddleCompactAudioPane`, `HuddleGridContainer`, `GridPicker`, `MiniSideBySideLayoutComponent`, `MinimizedSelfLayoutComponent` and `HuddleVideoStrip`), rendered with Taut's `StateView` over state where the bot's peers in `peers.byId` have no `isConnected` and it's left out of each call's `pendingUsers` in `allCalls.byId`, as Slack counts, sizes and pages tiles from only connected peers; and `HuddleGridComponent`'s `participantsAndScreenshares` in case a view is missed
- `HuddleClosedCaptionEvent` and `HuddleTranscribeEvent`'s `memberId`, for the captions
- `MessageBlocks`, for the player message
- the `sendActions` thunk, for **Accounts and more in Slack** and linking Jellyfin, and `openModal`, for its confirmations, both run with the thunk contexts (`ThunkContextProvider`) above the bar, so they open in the huddle's window; `fetchAndUpsertMembersWithQuery`, to find HuddleFM; and `rooms.notifyMember`, for **Start HuddleFM**
- the main window's huddle bar opening the huddle's window on a click, which the bar keeps its clicks from
- `TabsWithWindow`, beside the components Taut's own API offers
