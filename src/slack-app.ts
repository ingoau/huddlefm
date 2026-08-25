import { WebClient } from "@slack/web-api";
import { logger } from "./logger.ts";

const log = logger.child({ component: "slack-app" });

type Body = {
  type?: string;
  value?: string;
  action_id?: string;
  trigger_id?: string;
  response_url?: string;
  user?: { id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: {
    action_id?: string;
    value?: string;
    selected_option?: { value?: string };
  }[];
  view?: {
    id?: string;
    hash?: string;
    previous_view_id?: string;
    callback_id?: string;
    private_metadata?: string;
    state?: {
      values?: Record<
        string,
        Record<
          string,
          {
            value?: string;
            selected_user?: string;
            selected_option?: { value?: string };
            selected_options?: { value?: string }[];
          }
        >
      >;
    };
  };
};

export type Interaction = ReturnType<typeof normalizeInteraction>;

export function ackEnvelope(
  socket: Pick<WebSocket, "send"> & Partial<Pick<WebSocket, "readyState">>,
  envelopeId: string,
  payload?: unknown,
) {
  if (socket.readyState !== undefined && socket.readyState !== WebSocket.OPEN)
    return false;
  try {
    socket.send(
      JSON.stringify({
        envelope_id: envelopeId,
        ...(payload === undefined ? {} : { payload }),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function normalizeInteraction(body: Body) {
  const action = body.actions?.[0];
  return {
    type: body.type ?? "unknown",
    userId: body.user?.id ?? "unknown",
    actionId:
      action?.action_id ??
      body.action_id ??
      body.view?.callback_id ??
      "unknown",
    value: action?.selected_option?.value ?? action?.value ?? body.value ?? "",
    channelId: body.container?.channel_id ?? body.channel?.id ?? "",
    messageTs: body.container?.message_ts ?? body.message?.ts ?? "",
    triggerId: body.trigger_id ?? "",
    ...(body.response_url ? { responseUrl: body.response_url } : {}),
    ...(body.view?.id
      ? { viewId: body.view.id, viewHash: body.view.hash ?? "" }
      : {}),
    ...(body.view?.previous_view_id
      ? { previousViewId: body.view.previous_view_id }
      : {}),
    metadata: body.view?.private_metadata ?? "",
    state: body.view?.state?.values ?? {},
  };
}

export class SlackAppAdapter {
  private socket?: WebSocket;
  private web: WebClient;
  private names = new Map<string, Promise<string>>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private stopping = false;
  onAction?: (interaction: Interaction) => void | Promise<void>;
  onSuggestion?: (interaction: Interaction) => Promise<unknown[]>;

  constructor(private config: { xapp: string; xoxp: string }) {
    this.web = new WebClient(config.xoxp);
  }

  async start() {
    this.stopping = false;
    await this.connect();
    log.info({ event: "started" }, "Slack app started");
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    log.info({ event: "stopped" }, "Slack app stopped");
  }

  async post(
    channel: string,
    threadTs: string | undefined,
    text: string,
    blocks?: unknown[],
  ) {
    const result = await this.web.chat.postMessage({
      channel,
      thread_ts: threadTs || undefined,
      text,
      blocks: blocks as never,
    });
    if (!result.ts) throw new Error("chat.postMessage returned no timestamp");
    log.debug(
      {
        event: "message_posted",
        channelId: channel,
        threadTs,
        messageTs: result.ts,
      },
      "Slack message posted",
    );
    return result.ts;
  }

  async update(channel: string, ts: string, text: string, blocks: unknown[]) {
    await this.web.chat.update({ channel, ts, text, blocks: blocks as never });
    log.debug(
      { event: "message_updated", channelId: channel, messageTs: ts },
      "Slack message updated",
    );
  }

  async updateCanvas(canvasId: string, markdown: string) {
    await this.web.apiCall("canvases.edit", {
      canvas_id: canvasId,
      changes: [
        {
          operation: "replace",
          document_content: { type: "markdown", markdown },
        },
      ],
    });
    log.debug({ event: "canvas_updated", canvasId }, "Slack Canvas updated");
  }

  async delete(channel: string, ts: string) {
    try {
      await this.web.chat.delete({ channel, ts });
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("data" in error) ||
        !error.data ||
        typeof error.data !== "object" ||
        !("error" in error.data) ||
        error.data.error !== "message_not_found"
      )
        throw error;
    }
    log.debug(
      { event: "message_deleted", channelId: channel, messageTs: ts },
      "Slack message deleted",
    );
  }

  async deleteOriginal(responseUrl: string) {
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete_original: true }),
    });
    if (!response.ok)
      throw new Error(`response_url deletion failed: ${response.status}`);
    log.debug(
      { event: "original_response_deleted" },
      "Slack original response deleted",
    );
  }

  async ephemeral(
    channel: string,
    user: string,
    text: string,
    threadTs?: string,
    blocks?: unknown[],
  ) {
    await this.web.chat.postEphemeral({
      channel,
      user,
      text,
      thread_ts: threadTs || undefined,
      blocks: blocks as never,
    });
    log.debug(
      { event: "ephemeral_posted", channelId: channel, userId: user, threadTs },
      "Slack ephemeral message posted",
    );
  }

  async modal(triggerId: string, view: unknown) {
    const result = await this.web.views.open({
      trigger_id: triggerId,
      view: view as never,
    });
    log.debug(
      { event: "modal_opened", viewId: result.view?.id },
      "Slack modal opened",
    );
    return result.view;
  }

  async pushModal(triggerId: string, view: unknown) {
    await this.web.views.push({ trigger_id: triggerId, view: view as never });
    log.debug({ event: "modal_pushed" }, "Slack modal pushed");
  }

  async updateModal(viewId: string, hash: string | undefined, view: unknown) {
    const result = await this.web.views.update({
      view_id: viewId,
      ...(hash ? { hash } : {}),
      view: view as never,
    });
    log.debug({ event: "modal_updated", viewId }, "Slack modal updated");
    return result.view;
  }

  userName(userId: string) {
    const cached = this.names.get(userId);
    if (cached) return cached;
    const name = this.web.users
      .info({ user: userId })
      .then(
        (result) =>
          result.user?.profile?.real_name?.trim() ||
          result.user?.real_name?.trim() ||
          result.user?.profile?.display_name?.trim() ||
          result.user?.name ||
          userId,
      )
      .catch((error) => {
        log.warn(
          { event: "user_lookup_failed", userId, err: error },
          "Slack user lookup failed",
        );
        return userId;
      });
    this.names.set(userId, name);
    return name;
  }

  async dm(userId: string, text: string) {
    const opened = await this.web.conversations.open({ users: userId });
    if (!opened.channel?.id)
      throw new Error("conversations.open returned no channel");
    await this.web.chat.postMessage({ channel: opened.channel.id, text });
    log.debug({ event: "dm_posted", userId }, "Slack direct message posted");
  }

  private async connect() {
    const startedAt = Date.now();
    log.info(
      { event: "connection_started", attempt: this.reconnectAttempts + 1 },
      "Connecting Slack Socket Mode",
    );
    const response = await fetch(
      "https://slack.com/api/apps.connections.open",
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.xapp}` },
      },
    );
    const result = (await response.json()) as {
      ok?: boolean;
      error?: string;
      url?: string;
    };
    if (!result.ok || !result.url)
      throw new Error(
        `apps.connections.open failed: ${result.error ?? response.status}`,
      );

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(result.url!);
      this.socket = socket;
      socket.addEventListener("message", (event) => {
        const envelope = JSON.parse(String(event.data));
        if (envelope.type === "hello") {
          this.reconnectAttempts = 0;
          log.info(
            {
              event: "connected",
              durationMs: Date.now() - startedAt,
            },
            "Slack Socket Mode connected",
          );
          resolve();
        } else void this.handleEnvelope(socket, envelope);
      });
      socket.addEventListener("error", () =>
        reject(new Error("Socket Mode connection failed")),
      );
      socket.addEventListener("close", () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        if (!this.stopping)
          log.warn({ event: "connection_closed" }, "Slack socket closed");
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts++);
    log.warn(
      { event: "reconnect_scheduled", delayMs: delay },
      "Slack reconnect scheduled",
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error) => {
        log.error(
          { event: "reconnect_failed", err: error },
          "Slack reconnect failed",
        );
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async handleEnvelope(
    socket: WebSocket,
    envelope: { envelope_id?: string; type?: string; payload?: Body },
  ) {
    if (!envelope.envelope_id) return;
    const ack = (payload?: unknown) =>
      ackEnvelope(socket, envelope.envelope_id!, payload);
    if (envelope.type !== "interactive" || !envelope.payload) return ack();

    const interaction = normalizeInteraction(envelope.payload);
    if (envelope.payload.type === "block_suggestion") {
      try {
        ack({ options: (await this.onSuggestion?.(interaction)) ?? [] });
      } catch (error) {
        log.warn(
          {
            event: "suggestion_failed",
            userId: interaction.userId,
            channelId: interaction.channelId,
            err: error,
          },
          "Slack suggestion failed",
        );
        ack({ options: [] });
      }
      return;
    }
    ack();
    log.info(
      {
        event: "interaction_received",
        interactionType: interaction.type,
        actionId: interaction.actionId,
        userId: interaction.userId,
        channelId: interaction.channelId,
      },
      "Slack interaction received",
    );
    void Promise.resolve(this.onAction?.(interaction)).catch((error) =>
      log.error(
        {
          event: "action_failed",
          actionId: interaction.actionId,
          userId: interaction.userId,
          channelId: interaction.channelId,
          err: error,
        },
        "Slack action failed",
      ),
    );
  }
}
