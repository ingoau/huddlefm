# HuddleFM for Taut

A [Taut](https://github.com/jeremy46231/taut) plugin that talks to HuddleFM over the huddle's Chime data channel, on the topic `huddlefm`. For now it only tests the channel: when you join a huddle it pings the bot, and its settings page lists what it sent and heard, with a button to ping again. HuddleFM answers each ping with a `pong` naming the Slack user Chime says sent it, and says `hello` when it connects.

## Build and install

The **Taut plugin** workflow builds it on every change here: download `HuddleFM.js` from the `huddlefm-taut-plugin` artifact of its latest run. To build it yourself, from a checkout of Taut after `npm install`:

```sh
npm run build:user-plugin -- /path/to/huddlefm/clients/taut/HuddleFM.tsx
```

That writes `HuddleFM.js` next to the source. Install it from Slack's **Preferences → Taut**, turn it on, and join a huddle with HuddleFM. The plugin's settings page shows the messages; on desktop, `Ctrl`+`Alt`+`I` (`Cmd`+`Option`+`I`) opens DevTools, where they're logged with `[Taut] [HuddleFM]`.

To send your own message to everyone in a huddle from the server, with `LOCAL_CONTROL_TOKEN` set:

```sh
curl -X POST -H "authorization: Bearer $LOCAL_CONTROL_TOKEN" \
  -d '{"type":"test","text":"hi"}' http://127.0.0.1:3210/data-message
```

## How it reaches the data channel

Slack's huddle session (from `HuddleConnectionManager.getInstance().getHuddlesSdk()`) takes data channel subscribers through `addDataChannelSubscriber`, and hands each one Chime's `AudioVideoFacade` once audio connects. The plugin adds one to every session, which it catches by wrapping `setHuddlesSdk`. A new session gets its subscriber list from `initialize`, which runs after that, so the plugin adds itself only once `initialize` has started. Then it uses the facade's `realtimeSendDataMessage` and `realtimeSubscribeToReceiveDataMessage` on its own topic. Slack's own messages use other topics, so it doesn't notice. These are Slack's internals, so they can change with any Slack release.
