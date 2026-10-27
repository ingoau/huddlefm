# HuddleFM for Slick

A [Slick](https://github.com/3kh0/slick) plugin that puts HuddleFM's controls in the huddle itself, drawn with Slack's own components. It's the [Taut plugin](../taut/) for Slick: the two share everything in [`../core/`](../core/) and differ only in how they reach Slack, so **[what it does](../taut/README.md#what-it-does)** and **[how it's put together](../taut/README.md#how-its-put-together)** are as the Taut plugin's README describes. It talks to the bot over the huddle's Chime data channel, as [docs/data-channel.md](../../docs/data-channel.md) describes, so it needs nothing from the server but a HuddleFM in the huddle.

### Options

In **Slick Settings → Plugins → HuddleFM**, the same as Taut's:

- **Shrink HuddleFM's message**: the player message in the huddle's thread shrinks to one line while the controls are in the toolbar. On by default.
- **Hide HuddleFM's tile**: leaves the bot out of the huddle's grid. Its screen share in video mode still shows. Off by default.
- **Hide captions of HuddleFM's music**: leaves the bot out of the captions over the huddle and in its Captions tab. On by default.
- **Media keys**: control HuddleFM with the keyboard's media keys, and show its song in the system's media controls. On by default.

## Build and install

The **Slick plugin** workflow builds it on every change here: download the `huddlefm-slick-plugin` artifact of its latest run. It has `HuddleFM.js`, for the desktop app and the browser extension, and `HuddleFM.user.js`, for the userscript.

- **Desktop**: **Slick Settings → Plugins → Install plugin…**, and pick `HuddleFM.js`.
- **Browser extension**: in the Slick toolbar button's Plugins tab, click **Allow user plugins**, then **Install plugin file…**. Chromium also needs **Allow User Scripts** on in the extension's details. Reload Slack after. The Firefox Add-ons version can't run user plugins; Slick's self-hosted `.xpi` can.
- **Userscript**: install `HuddleFM.user.js` in Violentmonkey beside Slick.

Turn it on and join a huddle with HuddleFM. In DevTools (`Ctrl`+`Alt`+`I`, `Cmd`+`Option`+`I`), the plugin logs with `[slick] [HuddleFM]`.

To build it yourself: a Slick user plugin may only import its own files, so put the plugin and `../core` in one folder of a Slick checkout, as the workflow does, and build that:

```sh
mkdir -p src/plugins/HuddleFM/slick
cp /path/to/huddlefm/clients/slick/HuddleFM.tsx src/plugins/HuddleFM/slick/
cp -r /path/to/huddlefm/clients/core src/plugins/HuddleFM/core
rm src/plugins/HuddleFM/core/*.test.ts
echo 'export { default } from "./slick/HuddleFM.tsx";' > src/plugins/HuddleFM/index.tsx
bun run build:plugin src/plugins/HuddleFM
```

That writes `dist/plugins/HuddleFM.js` and `HuddleFM.user.js`. With the folder there, `bun run desktop:dev` also runs it as one of Slick's own plugins, reloading it on every change.

## How it differs from Taut's

`HuddleFM.tsx` is the Slick side: its settings, and the `Host` it hands `../core/mod.tsx`. Where Taut has something Slick doesn't, it does without Taut:

- Slack's components Slick doesn't offer, like `Popover`, `Checkbox` and `TabsWithWindow`, it finds itself, by name and, for names other components share, by the markup they draw, as Taut does.
- The bot it remembers is kept in Slick's plugin storage, by the user you are in each workspace, as Slick's storage is shared by all of them.
- **Start HuddleFM** finds the huddle you're in with Slack's `getActiveHuddleChannelId` selector, found by its name. Taut also learns selector names Slack gives its debugger, which a user plugin starts too late to; if a Slack release drops the name, **Start HuddleFM** says it couldn't invite HuddleFM, and the rest works as ever.
