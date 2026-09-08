# HuddleFM bot API

Allowlisted Slack users and bots can control a HuddleFM session by sending JSON in a DM to the HuddleFM **user**. The session host must approve each request. Other Slack apps must be able to DM that user.

Set `INTEGRATION_USER_IDS` to a comma- or space-separated list of Slack user IDs. Senders who are not on the list are ignored with no reply.

## Request control

Send a top-level DM:

```json
{
  "v": 1,
  "type": "request_control",
  "channel": "C123",
  "permissions": ["pause", "skip", "add"],
  "events": ["playback.state", "track"]
}
```

`channel` is required. It must be the huddle source channel, the controls channel, or the companion channel. A miss returns `session_not_found` with no other session details.

A valid request has no immediate success reply. The host gets an ephemeral prompt listing **readable** permission and event names. After they accept, decline, or the request expires (five minutes), HuddleFM replies in a thread under your command (`thread_ts` plus JSON `replyTo`).

```json
{
  "v": 1,
  "replyTo": "123.456",
  "ok": true,
  "type": "grant_accepted",
  "permissions": ["pause", "skip", "add"],
  "events": ["playback.state", "track"]
}
```

`grant_accepted` also includes the same fields as `status`. `grant_declined` and `grant_expired` use the same thread. `grant_revoked` is sent if the host later revokes that grant.

A second `request_control` from the same bot replaces its pending request.

## Commands

After a grant, send another top-level DM. Include `channel` when you hold grants on more than one session. Replies are threaded under the command and include `replyTo`.

Every reply is `{ "v": 1, "ok": true|false, ... }`. Failures add `"error"` (snake_case) and optional `"message"`. Successes add `"type"` matching the command. Host identity is never returned.

| `type`             | Extra fields                                                                   | Capability                    | Success body                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`           |                                                                                | any grant                     | `state`, `volumePercent`, `playbackSeconds`, `displayMode`, `autoplay`, `transitionMode`, `anchorEnabled`, `yourCapabilities` (this grant), `nowPlaying`, `queue`, `queueLimit` |
| `search`           | `query`                                                                        | `add` or `add-bulk`           | `results`: `{ label, reference }[]`                                                                                                                                             |
| `add`              | `reference` (from search, or a media URL)                                      | `add` / `add-bulk`            | `added`: `{ title, artist }[]`                                                                                                                                                  |
| `remove`           | `trackId`                                                                      | `remove-own` / `manage-queue` | `removed`: `{ title, artist }`                                                                                                                                                  |
| `move`             | `trackId`, plus `direction` (`up`/`down`), `playNext`, or `position` (1-based) | `manage-queue`                | `position`, `title`, `artist`                                                                                                                                                   |
| `clear`            |                                                                                | `clear`                       | `cleared` (count)                                                                                                                                                               |
| `skip`             |                                                                                | `skip`                        | `skipped`: `{ title, artist }`, `nowPlaying`                                                                                                                                    |
| `previous`         |                                                                                | `skip`                        | `restarted: true` plus `title`/`artist`, or `nowPlaying`                                                                                                                        |
| `toggle`           |                                                                                | `pause`                       | `state`: `"playing"` or `"paused"`                                                                                                                                              |
| `pause` / `resume` |                                                                                | `pause`                       | `state`; no-ops if already in that state                                                                                                                                        |
| `seek`             | `seconds` (relative; negative goes back)                                       | `skip`                        | `playbackSeconds`                                                                                                                                                               |
| `volume`           | `percent` (0–100)                                                              | `volume`                      | `volumePercent`                                                                                                                                                                 |
| `settings`         | `displayMode`, `autoplay`, `transitionMode`, `anchorEnabled` (all optional)    | `configure-settings`          | `changed`, plus current settings                                                                                                                                                |
| `end`              |                                                                                | `end-session`                 | `ended: true`                                                                                                                                                                   |
| `release_control`  |                                                                                | own grant                     | `released: true`                                                                                                                                                                |

Typical errors: `not_granted`, `missing_permission`, `session_not_found`, `session_inactive`, `nothing_playing`, `queue_full`, `channel_required`, `no_host`, `host_unreachable`.

Unknown or non-JSON DMs from allowlisted senders are ignored.

## Permissions

Bots request the same capability IDs huddle participants can get. The host must approve the set.

| ID                   | Shown to the host as                                  |
| -------------------- | ----------------------------------------------------- |
| `add`                | Add songs                                             |
| `add-bulk`           | Add albums, playlists, and link lists                 |
| `remove-own`         | Remove songs they added                               |
| `manage-queue`       | Manage queue                                          |
| `skip`               | Skip songs (also seek and previous)                   |
| `pause`              | Pause or resume                                       |
| `volume`             | Change volume                                         |
| `configure-settings` | Display, autoplay, transitions, keep-player-at-bottom |
| `clear`              | Clear queue                                           |
| `end-session`        | End session                                           |

Never grantable: transfer or claim host, change the session permission preset, or personal scrobbling. `settings` never accepts `permissionPreset` or `hostUserId`.

Controllers do not need to be in the huddle. Multiple bots can hold grants at once. The player shows them next to Host as `Controlling: <@bot>`.

## Events

Subscribe in `request_control`. Events are top-level DMs (not threaded):

```json
{
  "v": 1,
  "type": "event",
  "channel": "C123",
  "event": "track.started",
  "payload": { "id": "...", "title": "...", "artist": "..." }
}
```

`channel` is the same value you sent in `request_control`. Include it on later commands when you hold more than one grant.

| Subscription     | Events                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| `playback.state` | `playback.playing`, `playback.paused`, `playback.resumed`, `playback.ready` |
| `track`          | `track.started`, `track.finished`, `track.skipped`, `track.failed`          |
| `queue`          | `queue.added`, `queue.removed`, `queue.reordered`, `queue.cleared`          |
| `volume`         | `volume.changed`                                                            |
| `session`        | `session.ended`, `session.suspended`                                        |

Grants are not restored after a restart. Listen for `session.ended` / `session.suspended` and send `request_control` again.
