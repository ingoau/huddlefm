// Tests HuddleFM's Chime data channel: pings the bot and logs what it hears

import { TautPlugin } from "$taut";

// The topic and protocol version, as in src/native-media/data-channel.ts.
const TOPIC = "huddlefm";
const VERSION = 1;
/** How many messages the settings panel keeps. */
const LOG_SIZE = 20;
/** How long to wait for Slack's huddle code before saying it's missing. */
const SLACK_WAIT_MS = 30_000;

/** A data message as Slack's Chime SDK delivers it. */
type DataMessage = {
  topic: string;
  data: Uint8Array;
  senderAttendeeId: string;
  senderExternalUserId: string;
  /** Chime refused your own message and sent it back */
  throttled: boolean;
};
/** The parts of Chime's AudioVideoFacade the data channel uses. */
type Facade = {
  realtimeSendDataMessage(
    topic: string,
    data: Uint8Array,
    lifetimeMs?: number,
  ): void;
  realtimeSubscribeToReceiveDataMessage(
    topic: string,
    callback: (message: DataMessage) => void,
  ): void;
  realtimeUnsubscribeFromReceiveDataMessage(topic: string): void;
};
/** What Slack's huddle session hands its facade to, on every (re)connect. */
type DataChannelSubscriber = {
  onConnectDatachannel(facade: Facade): void;
  onDisconnectDataChannel(): void;
  onInitializeDataChannelSubscriber(): void;
  onShutdownDataChannelSubscriber(): void;
};
type HuddlesSdk = {
  addDataChannelSubscriber(subscriber: DataChannelSubscriber): void;
};
type ConnectionManager = {
  getHuddlesSdk(): HuddlesSdk | null;
  setHuddlesSdk(sdk: HuddlesSdk): void;
};
type ConnectionManagerClass = {
  getInstance(): ConnectionManager;
  prototype: ConnectionManager;
};
type LogEntry = { at: number; text: string };

export default class HuddleFM extends TautPlugin<typeof HuddleFM> {
  static readonly id = "HuddleFM";
  static readonly pluginName = "HuddleFM";
  static readonly description =
    "Tests HuddleFM's Chime data channel: pings the bot and logs what it hears";
  static readonly authors = [
    { name: "Ingo Wolf", url: "https://github.com/ingoau" },
  ];
  static readonly defaultConfig = { enabled: false };

  private facade: Facade | undefined;
  /** sessions given a subscriber, since Slack has no way to take one back */
  private attached = new WeakSet<HuddlesSdk>();
  private unpatch: (() => void) | undefined;
  private stopped = false;
  private entries = new this.api.Store<LogEntry[]>([]);

  start() {
    this.api
      .within(
        this.api.waitForExport<ConnectionManagerClass>(
          this.api.byName("HuddleConnectionManager"),
        ),
        SLACK_WAIT_MS,
        "Slack's huddle connection manager",
      )
      .then((Manager) => {
        if (!Manager || this.stopped) return;
        this.patchSessions(Manager);
        // a huddle you were already in when the plugin started
        this.attach(Manager.getInstance().getHuddlesSdk());
      });
  }

  stop() {
    this.stopped = true;
    this.unpatch?.();
    this.facade?.realtimeUnsubscribeFromReceiveDataMessage(TOPIC);
    this.facade = undefined;
  }

  dataPanel() {
    return <this.DataPanel />;
  }

  private readonly DataPanel = () => {
    const entries = this.entries.use();
    const { Button } = this.api.elements;
    return (
      <div>
        <Button size="small" type="outline" onClick={() => this.ping()}>
          Ping
        </Button>
        {entries.length ? (
          <ul>
            {entries.map((entry, index) => (
              <li key={index}>
                {new Date(entry.at).toLocaleTimeString()} {entry.text}
              </li>
            ))}
          </ul>
        ) : (
          <p>Nothing yet. Join a huddle with HuddleFM in it.</p>
        )}
      </div>
    );
  };

  /** Slack makes a session for each huddle and gives it to the manager */
  private patchSessions(Manager: ConnectionManagerClass) {
    const proto = Manager.prototype;
    const original = proto.setHuddlesSdk;
    const plugin = this;
    const patched = function (this: ConnectionManager, sdk: HuddlesSdk) {
      original.call(this, sdk);
      // the manager keeps the old session while it's still live
      plugin.attach(this.getHuddlesSdk());
    };
    proto.setHuddlesSdk = patched;
    this.unpatch = () => {
      if (proto.setHuddlesSdk === patched) proto.setHuddlesSdk = original;
    };
  }

  private attach(sdk: HuddlesSdk | null) {
    if (!sdk || this.stopped || this.attached.has(sdk)) return;
    this.attached.add(sdk);
    // called straight away if the session is already connected
    sdk.addDataChannelSubscriber({
      onConnectDatachannel: (facade) => {
        if (this.stopped) return;
        this.facade?.realtimeUnsubscribeFromReceiveDataMessage(TOPIC);
        // drops any callback from an earlier connect, the topic is ours alone
        facade.realtimeUnsubscribeFromReceiveDataMessage(TOPIC);
        facade.realtimeSubscribeToReceiveDataMessage(TOPIC, (message) =>
          this.receive(message),
        );
        this.facade = facade;
        this.ping();
      },
      onDisconnectDataChannel: () => {
        if (this.stopped) return;
        this.facade?.realtimeUnsubscribeFromReceiveDataMessage(TOPIC);
        this.facade = undefined;
        this.note("Huddle data channel closed");
      },
      onInitializeDataChannelSubscriber() {},
      onShutdownDataChannelSubscriber() {},
    });
  }

  private ping() {
    this.send({ type: "ping", id: crypto.randomUUID() });
  }

  private send(payload: Record<string, unknown>) {
    if (!this.facade) {
      this.note("Not in a huddle");
      return;
    }
    try {
      this.facade.realtimeSendDataMessage(
        TOPIC,
        new TextEncoder().encode(JSON.stringify({ ...payload, v: VERSION })),
      );
      this.note(`Sent ${payload.type}`);
    } catch (err) {
      this.note(`Couldn't send ${payload.type}: ${err}`);
    }
  }

  private receive(message: DataMessage) {
    if (this.stopped) return;
    if (message.throttled) {
      this.note("Chime throttled a message you sent");
      return;
    }
    let payload: { v?: unknown; type?: unknown };
    try {
      payload = JSON.parse(new TextDecoder().decode(message.data));
    } catch {
      return;
    }
    if (payload?.v !== VERSION) return;
    // Slack's external user ids are `<prefix>-<callId>-<userId>`
    const sender = message.senderExternalUserId?.split("-")[2] ?? "someone";
    this.note(`${sender} sent ${JSON.stringify(payload)}`);
  }

  private note(text: string) {
    this.log(text);
    this.entries.set(
      [{ at: Date.now(), text }, ...this.entries.get()].slice(0, LOG_SIZE),
    );
  }
}
