# HuddleFM

Gate 1 of the prototype joins an active Slack Huddle through the dedicated user's private Slack session and publishes a generated tone through Amazon Chime.

Install dependencies:

```bash
bun install
```

Run the loopback service:

```bash
bun run start
```

Join an active Huddle in a channel:

```bash
curl -X POST http://127.0.0.1:3210/join \
  -H 'content-type: application/json' \
  -d '{"channelId":"C0BPVPVLQ4D"}'
```

Use `POST /tone` with a numeric `frequency`, or `POST /leave`. The service binds only to loopback, authenticates its media WebSocket, and never sends Slack credentials to the media page.
