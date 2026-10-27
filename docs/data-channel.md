# HuddleFM data channel

Client mods, like the [Taut plugin](../clients/taut/), talk to the bot over the huddle's Amazon Chime data channel, on the topic `huddlefm`. Chime stamps each message with its sender's attendee and external user id, so the bot knows which Slack user sent it without any token. Everyone in the huddle receives every message on the topic, so nothing secret goes over it.

Every message is JSON, `{ "v": 1, "type": "…", … }`. Messages with another `v` or no `type` are ignored.

## Size

Chime refuses data messages over 2048 bytes. The bot sends a larger message as `chunk`s, each a slice of the message's JSON text:

```json
{
  "v": 1,
  "type": "chunk",
  "id": "k3",
  "i": 0,
  "n": 3,
  "data": "{\"v\":1,\"type\":\"state\",…"
}
```

`id` is unique per message from that sender, `i` counts from 0 to `n - 1`, and joining every `data` in order gives the message. A client drops a message still missing chunks after 5 seconds and sends `sync`. Clients' own messages must fit in one data message; the bot ignores chunks from clients.

## Bot to everyone

### `hello`

Sent when the bot connects to the huddle.

```json
{
  "v": 1,
  "type": "hello",
  "protocol": 1,
  "features": ["state", "commands", "search", "settings"]
}
```

A client checks `protocol` and `features` before relying on anything here, and answers with `sync`. A client that doesn't support the bot's `protocol` says so and leaves the Slack controls alone.

### `state`

The whole session, sent after every change (merged, at most every 250 ms) and after each `sync`. `seq` grows by one with each `state`, so a client can tell an old one from a new one.

```json
{
  "v": 1,
  "type": "state",
  "seq": 12,
  "session": {
    "id": "…",
    "mode": "music",
    "state": "playing",
    "position": 63.2,
    "volume": 50,
    "hostId": "U123",
    "allowed": ["add", "remove-own"],
    "loopMode": "off",
    "queueLimit": 50,
    "player": { "channel": "C123", "ts": "1793055831.760359" }
  },
  "nowPlaying": {
    "id": "…",
    "title": "…",
    "artist": "…",
    "album": "…",
    "artwork": "https://…",
    "duration": 215,
    "kind": "song",
    "live": false,
    "automatic": false,
    "addedBy": "U123"
  },
  "queue": [
    {
      "id": "…",
      "title": "…",
      "artist": "…",
      "artwork": "https://…",
      "duration": 180,
      "kind": "song",
      "live": false,
      "automatic": false,
      "addedBy": "U123",
      "status": "ready"
    }
  ],
  "participants": ["U123", "U456"],
  "settings": []
}
```

- `session.state` is `ready` (nothing playing), `playing`, `paused`, `ended`, or `suspended` (the bot is restarting and will pick the session up again). The last `state` before the bot stops answering says `ended` or `suspended`.
- `session.position` is the playback position in seconds when the message was sent. While `playing`, a client adds the time since it received the message.
- `session.volume` is in percent, rounded.
- `session.player` is the HuddleFM message in the huddle's thread, which a client can hide while it shows its own controls, or `null` before it is posted.
- `participants` are the Slack users in the huddle, without the bot.
- `nowPlaying` is `null` when nothing is playing. `artwork` is a public URL, or absent.
- `settings` lists the session's and host's settings as [settings fields](#settings-fields). Each has a `requires`: `volume`, `configure` or `admin`. A client shows each to a user who has that capability (see [`you`](#you)).

## Bot to one user

These carry `to`, the Slack user they are for. Other clients ignore them.

### `you`

What one user may do, and their own settings. Sent after that user's `sync`, after they change any setting, and to everyone who has synced after the host or permissions change.

```json
{
  "v": 1,
  "type": "you",
  "to": "U123",
  "capabilities": ["add", "remove-own", "volume", "configure-settings"],
  "admin": false,
  "settings": []
}
```

- `capabilities` are the [permission names](bot-api.md) the user holds; a host or manager holds all of them.
- `admin` means they may change `admin` settings: switch mode, transfer host and set permissions.
- `settings` are their own settings, the ones Settings shows on its **You** tab, as [settings fields](#settings-fields) with `requires: "self"`. It is empty when the bot has no scrobbling set up.

### `result`

The answer to a `command` or `setting`, with its `id`.

```json
{
  "v": 1,
  "type": "result",
  "to": "U123",
  "id": "r7",
  "command": "skip",
  "ok": false,
  "error": "missing_permission",
  "message": "You do not have permission for that."
}
```

It names what it answers in `command` (the command's type) or `setting` (the field id). On success, `ok` is `true` and the rest is what the matching [bot API](bot-api.md#commands) command returns; a setting's lists what `changed`. `search` results are `results: { label, reference }[]`. Failures carry `error` and `message` as the bot API's do.

## Clients to the bot

### `sync`

Asks for the session. The bot broadcasts `state` and answers the sender with `you`.

```json
{ "v": 1, "type": "sync" }
```

### `command`

Runs one of the [bot API commands](bot-api.md#commands) as the sender, with their own permissions in the session, and answers with a `result`. The command's fields are the bot API's. A client picks `id`, at most 64 characters; a message without a valid `id` gets no answer.

```json
{ "v": 1, "type": "command", "id": "r7", "command": { "type": "skip" } }
```

These commands work here: `search`, `add`, `remove`, `move`, `shuffle`, `clear`, `skip`, `previous`, `toggle`, `pause`, `resume`, `seek`, `volume`, `end`, and `claim_host`, which makes the sender host when the session has none, as the player's Take over button does.

### `setting`

Changes one setting, by its field `id`, as the sender, and answers with a `result`. `value` takes the field's own shape: a string for `select` (and `user`), a boolean for `toggle`, and a list for `multi`. `volume` also takes a number.

```json
{ "v": 1, "type": "setting", "id": "r8", "setting": "loop", "value": "queue" }
```

A permission preset is a `setting` of `permissions` with `preset` in place of `value`: `{ "setting": "permissions", "preset": "collaborative" }`.

### `ping`

The bot answers with `pong`, naming the sender in `to`, at most once a second per attendee. A `pong` echoes an `id` of up to 64 characters.

## Settings fields

The bot's settings modal is drawn from the same list (`src/settings-schema.ts`), so a client shows what Slack does without knowing each setting.

```json
{
  "id": "loop",
  "tab": "session",
  "label": "Loop",
  "hint": "…",
  "requires": "configure",
  "kind": "select",
  "options": [
    { "value": "off", "label": "Off", "description": "Do not repeat" }
  ],
  "value": "off"
}
```

- `kind` is `select` (one of `options`, `value` a string), `toggle` (`text` beside a checkbox, `value` a boolean), `multi` (any of `options`, `value` a list), or `user` (a Slack user id, or `null`).
- `section` starts a group of settings under a heading.
- The `permissions` field also lists `presets`, each `{ value, label, permissions }`.

## Limits

The bot answers each user's `command`, `setting` and `sync` at most 10 times a second, and drops the rest.
