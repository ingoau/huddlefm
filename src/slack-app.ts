import { WebClient } from "@slack/web-api";

type InteractiveEnvelope = {
  body: {
    type?: string;
    value?: string;
    action_id?: string;
    user?: { id?: string };
    actions?: { action_id?: string; value?: string }[];
  };
  ack(response?: unknown): Promise<void>;
};

export function normalizeInteraction(body: InteractiveEnvelope["body"]) {
  const action = body.actions?.[0];
  return {
    type: body.type ?? "unknown",
    userId: body.user?.id ?? "unknown",
    actionId: action?.action_id ?? body.action_id ?? "unknown",
    value: action?.value ?? body.value ?? "",
  };
}

export class SlackAppAdapter {
  private socket?: WebSocket;
  private web: WebClient;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private stopping = false;
  readonly events: ReturnType<typeof normalizeInteraction>[] = [];

  constructor(private config: { xapp: string; xoxp: string }) {
    this.web = new WebClient(config.xoxp);
  }

  async start() {
    this.stopping = false;
    await this.connect();
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private async connect() {
    const response = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.xapp}` },
    });
    const result = (await response.json()) as {
      ok?: boolean;
      error?: string;
      url?: string;
    };
    if (!result.ok || !result.url)
      throw new Error(`apps.connections.open failed: ${result.error ?? response.status}`);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(result.url!);
      this.socket = socket;
      socket.addEventListener("message", event => {
        const envelope = JSON.parse(String(event.data));
        if (envelope.type === "hello") {
          this.reconnectAttempts = 0;
          resolve();
        } else {
          void this.handleEnvelope(envelope);
        }
      });
      socket.addEventListener("error", () => reject(new Error("Socket Mode connection failed")));
      socket.addEventListener("close", () => this.scheduleReconnect());
    });
  }

  private scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(error => {
        console.error(error instanceof Error ? error.message : error);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async handleEnvelope(envelope: {
    envelope_id?: string;
    type?: string;
    payload?: InteractiveEnvelope["body"];
  }) {
    if (!envelope.envelope_id) return;
    const ack = (payload?: unknown) => {
      this.socket?.send(
        JSON.stringify({
          envelope_id: envelope.envelope_id,
          ...(payload === undefined ? {} : { payload }),
        }),
      );
    };
    if (envelope.type !== "interactive" || !envelope.payload) return ack();

    const interaction = normalizeInteraction(envelope.payload);
    if (envelope.payload.type === "block_suggestion") {
      ack({
        options: [
          {
            text: {
              type: "plain_text",
              text: `Test result: ${interaction.value}`.slice(0, 75),
            },
            value: "gate2_result",
          },
        ],
      });
    } else {
      ack();
    }
    this.events.push(interaction);
    console.log(
      `[slack-app] ${interaction.type} ${interaction.actionId} ${interaction.userId}`,
    );
  }

  async postGate2Test(channel: string) {
    const result = await this.web.chat.postMessage({
      channel,
      text: "HuddleFM interaction test",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*HuddleFM gate 2 test*\nUse both controls to verify Socket Mode actions and suggestions.",
          },
        },
        {
          type: "actions",
          block_id: `gate2_${crypto.randomUUID()}`,
          elements: [
            {
              type: "button",
              action_id: "gate2_ping",
              text: { type: "plain_text", text: "Test action" },
              value: "ping",
            },
            {
              type: "external_select",
              action_id: "gate2_search",
              placeholder: { type: "plain_text", text: "Type three characters" },
              min_query_length: 3,
            },
          ],
        },
      ],
    });
    if (!result.ts) throw new Error("chat.postMessage returned no timestamp");
    return result.ts;
  }

  async deleteMessage(channel: string, ts: string) {
    await this.web.chat.delete({ channel, ts });
  }
}
