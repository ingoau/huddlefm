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

`id` is unique per message from that sender, `i` counts from 0 to `n - 1`, and joining every `data` in order gives the message. A client drops a message still missing chunks after 5 seconds and sends `sync`. Clients' own messages must fit in one data message; the bot ignores chunks from clients. A message takes at most 64 chunks, and clients drop larger ones; so the bot's `state` stays within them, its `queue` lists only the first 100 songs, and `queueLength` counts them all.

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
  "queueLength": 1,
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

These carry `to`, the Slack user they are for. Other clients ignore them, but everyone in the huddle hears them, so they come [sealed](#sealed) to a client that sent a key with its `sync`.

### `you`

What one user may do, and their own settings. Sent after that user's `sync`, after they change any setting, after they link, unlink or lose a Jellyfin server, and to everyone who has synced after the host or permissions change.

```json
{
  "v": 1,
  "type": "you",
  "to": "U123",
  "capabilities": ["add", "remove-own", "volume", "configure-settings"],
  "admin": false,
  "settings": [],
  "jellyfin": false
}
```

- `capabilities` are the [permission names](bot-api.md) the user holds; a host or manager holds all of them.
- `admin` means they may change `admin` settings: switch mode, transfer host and set permissions.
- `settings` are their own settings, the ones Settings shows on its **You** tab, as [settings fields](#settings-fields) with `requires: "self"`. It is empty when the bot has no scrobbling set up.
- `jellyfin` says whether they've linked a Jellyfin server, and is absent when the bot doesn't play from Jellyfin. Linking shows a code to approve, which only Slack's own dialogs show: everyone in the huddle hears this channel.

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

It names what it answers in `command` (the command's type) or `setting` (the field id). On success, `ok` is `true`, and some commands add what they found, as their rows below say. A failure carries `message`, what the player would have told the user in Slack, and an `error` code where there is one.

### `sealed`

What's for one user, sealed for one of their clients. Search results, saved sessions, recent songs and a Jellyfin library are theirs alone, so `you` and `result` come sealed to every client of that user that sent a key with its `sync`. While one of their clients sent none, as an older client, they come plainly too.

```json
{
  "v": 1,
  "type": "sealed",
  "to": "U123",
  "key": "BD9…",
  "iv": "…",
  "data": "…"
}
```

`key` is the bot's P-256 public key for the session, raw and in base64. The client derives an AES-GCM key from it and its own private key by ECDH, and opens `data` with `iv` (both base64): the message inside is the whole `you` or `result`, with its own `v`, `type` and `to`. A client that can't open one ignores it, as one sealed for another of the user's clients. Chime stamps who sent each `sync`, so no one can put their key in place of another user's.

## Clients to the bot

### `sync`

Asks for the session. The bot broadcasts `state` and answers the sender with `you`. `key`, the client's P-256 public key, raw and in base64, has what's for this user come [sealed](#sealed).

```json
{ "v": 1, "type": "sync", "key": "BHk…" }
```

### `command`

Does what one of the player's buttons or dialogs does, as the sender: the bot runs the same code as for a click in Slack, with the sender's permissions, so it counts as theirs. The audit log notes `via: "data_channel"` on what it records. What the player would have said in an ephemeral notice is the `result`'s `message` instead. A client picks `id`, at most 64 characters; a message without a valid `id` gets no answer.

```json
{ "v": 1, "type": "command", "id": "r7", "command": { "type": "skip" } }
```

| `type`           | Fields                                                                                        | As the player's                                   |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `search`         | `query`, and `source: "jellyfin"` for theirs                                                  | Add songs' search, as it's typed                  |
| `add`            | `reference`, from `search`, or a link; or `recent` or `recommend`, an `id` from `suggestions` | Add songs                                         |
| `suggestions`    |                                                                                               | Add songs' recommendations and recent songs       |
| `remove`         | `trackId`                                                                                     | queue's Remove                                    |
| `move`           | `trackId`, and `direction` (`up`/`down`) or `position`                                        | queue's Move up, Move down, Play next and Move to |
| `shuffle`        |                                                                                               | Shuffle                                           |
| `clear`          |                                                                                               | Clear queue                                       |
| `skip`           |                                                                                               | Next                                              |
| `previous`       |                                                                                               | Previous                                          |
| `toggle`         |                                                                                               | Play/pause                                        |
| `pause`/`resume` |                                                                                               | Play/pause, when it isn't already so              |
| `seek`           | `to`, in seconds                                                                              | Jump to                                           |
| `volume`         | `percent`                                                                                     | Settings' Volume                                  |
| `claim_host`     |                                                                                               | Take over                                         |
| `play_something` |                                                                                               | Play something, in music mode                     |
| `keep`           | `trackId`, an autoplay pick                                                                   | queue's Add to queue                              |
| `end`            | `save` (`none`, `channel` or `user`), and maybe `name`                                        | End session's dialog, saving the session if asked |
| `saves`          |                                                                                               | Load saved session's list                         |
| `load`           | `saveId`, and `forget: true` to delete it after                                               | Load saved session                                |
| `lyrics`         | `trackId`, the song playing                                                                   | the video card's lyrics                           |
| `settings_tab`   | `tab`: `you`, `session`, `channel` or `host`                                                  | Settings' tabs, for its next opening in Slack     |

`end` is answered by the final `state` instead, since the bot stops answering once the session is over; how saving went is posted in Slack, as for the dialog.

What some answer with, besides `ok`:

- `search`: `results: { label, reference }[]`, each a `reference` for `add`.
- `add`: `message` when it says how it went, as "Added 3 of 10 songs". Something on Jellyfin that needs picking first, like a show or a film left part way, answers with `choices: { label, reference }[]` instead, each another `add`. `linkNeeded: true` on a failure means the user hasn't linked that Jellyfin server; they link it in Slack.
- `suggestions`: `recommended` and `recent`, each a list of `{ id, title, artist?, artwork? }`; recommendations also have their `group`, like `Discover`. Both are empty in video mode, as in Slack, and for someone who can't add songs one at a time, as each adds one.
- `saves`: `saves: { id, name, owner, songs, savedAt, deletable }[]`, newest first. `owner` is `channel` or `user`, `savedAt` is in milliseconds, and `deletable` says whether `forget` would delete it.
- `lyrics`: `lines: { start, end, text, instrumental? }[]`, in milliseconds, `synced`, whether they have times at all, the `trackId` they're for and the `source` they came from. No lyrics is an empty `lines`, as in video mode and for live streams. A `trackId` that isn't playing any more is a failure.
- `settings_tab` makes the user's next opening of Settings in Slack, within 15 seconds, start on that tab. A client sends it before it opens Settings from the player's button.

### `setting`

Changes one setting, by its field `id`, as the sender saving Settings with only that field changed would, and answers with a `result`. Only the fields Settings shows them now can be changed: video's autoplay only in video mode, for example. `value` takes the field's own shape: a string for `select` (and `user`), a boolean for `toggle`, and a list for `multi`. `volume` also takes a number.

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

The bot answers each user's `command`, `setting` and `sync` at most 10 times a second, and drops the rest. Searches reach YouTube, so a user's third `search` within a second is answered with `error: "rate_limited"`.
