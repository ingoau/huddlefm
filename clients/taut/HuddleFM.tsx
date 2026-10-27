// HuddleFM in the huddle bar: the song playing, and a popover with the rest

import { opt, TautPlugin, type TautAPI } from "$taut";
import { MediaKeys } from "../core/media-keys.ts";
import {
  Panel,
  PlayerBar,
  say,
  type Kit,
  type Platform,
} from "../core/panel.tsx";
import { HuddleFMClient, TOPIC, type DataMessage } from "../core/protocol.ts";
import { Store } from "../core/store.ts";
import { panelCss } from "../core/styles.ts";

/** How long Settings waits for the bot to note the tab it opens on. */
const SETTINGS_TAB_WAIT_MS = 2_000;
/** How long to wait for Slack's huddle code before saying it's missing. */
const SLACK_WAIT_MS = 30_000;
/** What a user's name has in it to be HuddleFM, for finding it to invite. */
const BOT_SEARCH = "HuddleFM";
const memberNames = (member: {
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}) =>
  [
    member.profile?.display_name,
    member.profile?.real_name,
    member.real_name,
    member.name,
  ].filter((name): name is string => Boolean(name));
const isBotName = (name: string) =>
  name.toLowerCase().replace(/\s+/g, "").includes("huddlefm");
/** The most users the search for HuddleFM returns. */
const BOT_SEARCH_LIMIT = 20;
/** How long to wait before searching again when nobody turned up. */
const BOT_SEARCH_RETRY_MS = 1_500;
/** Below this window width the huddle toolbar has room for the note alone. */
const COMPACT_WIDTH = 960;
/** Narrower than this, Slack leaves screen sharing out of the toolbar, and HuddleFM too. */
const HIDDEN_WIDTH = 566;
/** The tallest the popover gets, and the room it leaves above itself. */
const POPOVER_MAX_HEIGHT = 640;
const POPOVER_MIN_HEIGHT = 200;
const POPOVER_MARGIN = 24;

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
  /** set when initialize() starts */
  options?: unknown;
  initialize(...args: unknown[]): Promise<void>;
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
type SlackUser = {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  profile?: { display_name?: string; real_name?: string };
};
type MessageBlocksProps = {
  msg?: { ts?: string; channel?: string };
  [key: string]: unknown;
};
type BlockElement = {
  type?: string;
  action_id?: string;
  value?: string;
  text?: unknown;
};
type Block = {
  block_id?: string;
  elements?: BlockElement[];
  accessory?: BlockElement;
  child_blocks?: Block[];
};

export default class HuddleFM extends TautPlugin<typeof HuddleFM> {
  static readonly id = "HuddleFM";
  static readonly pluginName = "HuddleFM";
  static readonly description =
    "HuddleFM in the huddle bar: the song playing, and a popover with the rest";
  static readonly authors = [
    { name: "Ingo Wolf", url: "https://github.com/ingoau" },
  ];
  static readonly defaultConfig = {
    enabled: false,
    collapsePlayer: opt(
      true,
      "Shrink HuddleFM's message in the huddle thread while it's in the huddle bar",
    ),
    hideTile: opt(false, "Hide HuddleFM's tile from the huddle"),
    hideCaptions: opt(
      true,
      "Hide captions of HuddleFM's music, over the huddle and in its Captions tab",
    ),
    mediaKeys: opt(
      true,
      "Control HuddleFM with your keyboard's media keys, and show its song in your system's media controls",
    ),
  };

  private facade: Facade | undefined;
  /** sessions given a subscriber, since Slack has no way to take one back */
  private attached = new WeakSet<HuddlesSdk>();
  private unpatch: (() => void) | undefined;
  private stopped = false;
  /** the bar whose popover is open, in the window it's in */
  private openedFrom: Element | undefined;
  /** counts the Slack dialogs opened from the popover, which close it */
  private dialogsOpened = new Store(0);
  /** the HuddleFM Start invites, and the only one believed: chosen, or the first heard */
  private botUser = this.api.storage.store<string>("botUserId", "");
  private client = new HuddleFMClient(
    () => this.api.members.getCurrentMemberId(),
    (text) => this.log(text),
    () => this.botUser.get() || undefined,
  );
  private mediaKeys = this.config.mediaKeys
    ? new MediaKeys(this.client, say)
    : undefined;

  private platform: Platform = {
    client: this.client,
    kit: slackKit(this.api, (options) => this.confirmHere(options)),
    selfUserId: () => this.api.members.getCurrentMemberId(),
    useUserName: (userId) => {
      const member = this.api.members.useMember(userId);
      return (
        member?.profile?.display_name ||
        member?.profile?.real_name ||
        member?.real_name ||
        member?.name ||
        "someone"
      );
    },
    openSlackSettings: (tab) => this.openSlackSettings(tab),
    huddleFM: {
      useChosen: () => this.botUser.use() || undefined,
      find: () => this.findBots(),
      choose: (userId) => {
        this.botUser.set(userId).catch(() => {});
      },
      start: () => this.inviteBot(),
    },
  };

  start() {
    this.api.setStyle(panelCss + pluginCss);
    // the huddle plays in Slack's main window, and in its own while it's open
    this.mediaKeys?.start();
    this.mediaKeys?.add(window);
    // with none chosen yet, the HuddleFM heard is kept, if it's named so:
    // anyone in a huddle could claim to be it
    this.client.state.subscribe(() => {
      const bot = this.client.botUserId;
      if (!bot || this.botUser.get()) return;
      this.api.members
        .getMember(bot)
        .then((member) => {
          if (
            member &&
            !this.botUser.get() &&
            memberNames(member).some(isBotName)
          )
            return this.botUser.set(bot);
        })
        .catch(() => {});
    });
    this.patchHuddleBars();
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
    this.mediaKeys?.stop();
    this.client.disconnect();
  }

  // HuddleFM after the thread button in the huddle's toolbar, which is in the
  // huddle's own window, or at the bottom of Slack's main window while that
  // window is closed; and its message in the thread shrunk while it's there.
  private patchHuddleBars() {
    this.api.patchComponent<{
      className?: string;
      buttonToggledOnClassName?: string;
    }>("HuddleToolbarThreadButton", (Original) => (props) => (
      <>
        <Original {...props} />
        <this.Bar
          className={props.className}
          onClassName={props.buttonToggledOnClassName}
        />
      </>
    ));

    // HuddleFM's tile. Each view that lays out tiles counts, sizes and pages
    // them from the huddle's peers itself, so it reads them with the bot
    // never connected; its screen share in video mode is a share, so it stays
    if (this.config.hideTile)
      for (const name of TILE_VIEWS)
        this.api.patchComponent<object>(name, (Original) => (props) => (
          <this.WithoutTile>
            <Original {...props} />
          </this.WithoutTile>
        ));

    // and the grid they draw with, should a view Slack adds still list it
    if (this.config.hideTile)
      this.api.patchComponent<{
        participantsAndScreenshares?: {
          userId?: string;
          isScreenshareEnabled?: boolean;
        }[];
      }>("HuddleGridComponent", (Original) => (props) => {
        this.client.state.use();
        const bot = this.botUserId();
        const tiles = props.participantsAndScreenshares?.filter(
          (tile) => !bot || tile.isScreenshareEnabled || tile.userId !== bot,
        );
        return <Original {...props} participantsAndScreenshares={tiles} />;
      });

    // Slack transcribes the music too: the captions over the huddle, and the
    // side-by-side ones in its Captions tab
    if (this.config.hideCaptions)
      for (const name of ["HuddleClosedCaptionEvent", "HuddleTranscribeEvent"])
        this.api.patchComponent<{ memberId?: string }>(
          name,
          (Original) => (props) => {
            this.client.state.use();
            const bot = this.botUserId();
            if (bot && props.memberId === bot) return null;
            return <Original {...props} />;
          },
        );

    this.api.patchComponent<MessageBlocksProps>(
      "MessageBlocks",
      (Original) => (props) => {
        const player = this.client.state.use()?.session.player;
        const presence = this.client.presence.use();
        const [expanded, setExpanded] = React.useState(false);
        const msg = props.msg;
        if (
          !this.config.collapsePlayer ||
          expanded ||
          presence !== "connected" ||
          !player ||
          msg?.ts !== player.ts ||
          (msg?.channel && msg.channel !== player.channel)
        )
          return <Original {...props} />;
        const { Button } = this.api.elements;
        return (
          <div className="taut-huddlefm-collapsed">
            <span>HuddleFM's controls are in the huddle bar.</span>
            <Button
              type="outline"
              size="small"
              onClick={() => setExpanded(true)}
            >
              Show player
            </Button>
          </div>
        );
      },
    );
  }

  /** The bot's user: the one in this huddle, or the last one seen. */
  private botUserId() {
    return this.client.botUserId ?? (this.botUser.get() || undefined);
  }

  /** Its children, reading Slack's state without the bot in the huddle. */
  private readonly WithoutTile = ({
    children,
  }: {
    children?: React.ReactNode;
  }) => {
    this.client.state.use();
    const bot = this.botUserId();
    const patch = React.useMemo(() => withoutPeer(bot), [bot]);
    const { StateView } = this.api.redux;
    return <StateView patch={patch}>{children}</StateView>;
  };

  /** HuddleFM in a huddle bar, opening the popover with everything else. */
  private readonly Bar = ({
    className,
    onClassName,
  }: {
    className?: string;
    onClassName?: string;
  }) => {
    const { Popover } = this.api.elements;
    const ref = React.useRef<HTMLSpanElement>(null);
    const pressedOutside = React.useRef(false);
    const [anchor, setAnchor] = React.useState<{
      target: HTMLElement;
      bounds: DOMRect;
      window: WeakRef<Window>;
    } | null>(null);
    // a Slack dialog from it goes over it, so it gets out of the way
    React.useEffect(
      () => this.dialogsOpened.subscribe(() => setAnchor(null)),
      [],
    );
    // Slack places a popover once, from its size and where its target is.
    // A panel that grew would run off the window and scroll it, so the
    // popover is as tall as the room above the bar, and the panel sits at
    // its foot, growing upward. It's placed again when the window resizes.
    React.useEffect(() => {
      const win = anchor?.window.deref();
      if (!win) return;
      const place = () =>
        setAnchor((current) =>
          current
            ? { ...current, bounds: current.target.getBoundingClientRect() }
            : null,
        );
      win.addEventListener("resize", place);
      return () => win.removeEventListener("resize", place);
    }, [!!anchor]);
    // the toolbar is a fixed row of buttons, so whether the song fits beside
    // them comes down to how wide its window is
    const [compact, setCompact] = React.useState(false);
    const [hidden, setHidden] = React.useState(false);
    React.useEffect(() => {
      const win = ref.current?.ownerDocument.defaultView;
      if (!win) return;
      this.mediaKeys?.add(win);
      const fit = () => {
        setCompact(win.innerWidth < COMPACT_WIDTH);
        setHidden(win.innerWidth < HIDDEN_WIDTH);
        if (win.innerWidth < HIDDEN_WIDTH) setAnchor(null);
      };
      fit();
      win.addEventListener("resize", fit);
      return () => win.removeEventListener("resize", fit);
    }, []);
    // placed by the whole bar, which stays as the button in it changes
    const open = (button: HTMLElement) =>
      setAnchor((current) => {
        const target = ref.current ?? button;
        // Slack's dialogs from it open in this window
        this.openedFrom = target;
        return current
          ? null
          : {
              target,
              bounds: target.getBoundingClientRect(),
              // the bar may be in the huddle's own window
              window: new WeakRef(target.ownerDocument.defaultView ?? window),
            };
      });
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: it only keeps clicks from reaching Slack's bar; the buttons in it are the controls
      <span
        className="taut-huddlefm-bar"
        ref={ref}
        style={hidden ? { display: "none" } : undefined}
        // In the main window, a click on the huddle bar opens the huddle's
        // window, and the bar and its popover are in it as React sees it.
        onClick={(event) => event.stopPropagation()}
      >
        <PlayerBar
          platform={this.platform}
          open={open}
          expanded={!!anchor}
          className={className}
          onClassName={onClassName}
          compact={compact}
        />
        {anchor && (
          <Popover
            isOpen
            targetBounds={anchor.bounds}
            windowRef={anchor.window}
            position="top"
            offsetY={-8}
            onClose={() => setAnchor(null)}
            ariaRole="dialog"
            ariaLabel="HuddleFM"
          >
            {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a click on the room above the panel is a click outside it; Escape closes the popover as ever */}
            <div
              className="taut-huddlefm-popover"
              style={{
                height: Math.max(
                  POPOVER_MIN_HEIGHT,
                  Math.min(
                    POPOVER_MAX_HEIGHT,
                    anchor.bounds.top - POPOVER_MARGIN,
                  ),
                ),
              }}
              // a press that starts in the panel and ends out of it, as when
              // the panel moves under it, isn't a click outside
              onPointerDown={(event) => {
                pressedOutside.current = event.target === event.currentTarget;
              }}
              onClick={(event) => {
                if (
                  pressedOutside.current &&
                  event.target === event.currentTarget
                )
                  setAnchor(null);
              }}
            >
              <Panel platform={this.platform} />
            </div>
          </Popover>
        )}
      </span>
    );
  };

  /** Invites the chosen HuddleFM to the huddle you're in. */
  private async inviteBot() {
    const huddle = this.api.huddles.getActiveHuddle();
    const bot = this.botUser.get();
    if (!huddle?.channelId || !bot) {
      this.log("Can't start HuddleFM: not in a huddle, or none is chosen");
      return false;
    }
    try {
      // what Slack's own Invite people sends
      await this.api.userAPI("rooms.notifyMember", {
        channel_id: huddle.channelId,
        user_id: bot,
      });
      return true;
    } catch (err) {
      this.log(`Couldn't invite HuddleFM: ${err}`);
      return false;
    }
  }

  /**
   * The workspace's users with HuddleFM in their name, through the people
   * search Slack's own pickers use, so "HuddleFM [bot]" counts too.
   */
  private async findBots() {
    try {
      const search = () =>
        this.api.redux.dispatchThunk<{ members?: SlackUser[] }>(
          "fetchAndUpsertMembersWithQuery",
          { query: { query: BOT_SEARCH, count: BOT_SEARCH_LIMIT } },
        );
      let { members } = await search();
      // just after Slack loads, its search can answer with nobody
      if (!members?.length) {
        await new Promise((resolve) =>
          setTimeout(resolve, BOT_SEARCH_RETRY_MS),
        );
        ({ members } = await search());
      }
      return (members ?? []).flatMap((member) => {
        const names = memberNames(member);
        if (!member.id || member.deleted || !names.some(isBotName)) return [];
        const shown = names[0] ?? member.id;
        return [
          {
            id: member.id,
            name:
              member.name && member.name !== shown
                ? `${shown} (@${member.name})`
                : shown,
          },
        ];
      });
    } catch (err) {
      this.log(`Couldn't search for HuddleFM: ${err}`);
      return [];
    }
  }

  /**
   * Runs one of Slack's thunks as a component where the popover was opened
   * would: with the React context there, so what it opens, a dialog say,
   * opens in that window, as Slack's own buttons in it do. The popover
   * closes for it.
   */
  private async dispatchHere(name: string, args: unknown) {
    const creator = await this.api.within(
      this.api.redux.waitForThunkCreator(name),
      SLACK_WAIT_MS,
      `Slack's ${name}`,
    );
    if (!creator) throw new Error(`Slack's ${name} isn't there`);
    const store = this.api.redux.getStore();
    if (!store) throw new Error("Slack's store isn't ready");
    const values = thunkContexts(this.openedFrom);
    const thunk = creator(args) as (
      dispatch: unknown,
      getState: unknown,
      getContext: (context: {
        key?: unknown;
        defaultValue?: unknown;
      }) => unknown,
    ) => unknown;
    const result = thunk(store.dispatch, store.getState, (context) =>
      values.has(context.key) ? values.get(context.key) : context.defaultValue,
    );
    this.dialogsOpened.set(this.dialogsOpened.get() + 1);
    return result;
  }

  /** Slack's confirmation dialog, in the window the popover is in. */
  private confirmHere(options: Parameters<Kit["confirm"]>[0]) {
    const { ConfirmationModal } = this.api.elements;
    return new Promise<boolean>((resolve) => {
      let handle: { close(): void } | undefined;
      let settled = false;
      const settle = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        handle?.close();
        resolve(confirmed);
      };
      this.dispatchHere("openModal", {
        name: "HuddleFM",
        isStackable: true,
        element: (
          <ConfirmationModal
            title={options.title}
            submitButtonText={options.confirmText}
            cancelButtonText="Cancel"
            submitButtonType={options.danger ? "danger" : "primary"}
            showCancelButton
            showSubmitButton
            onSubmit={() => settle(true)}
            onCancel={() => settle(false)}
            onClose={() => settle(false)}
          >
            {options.body ?? null}
          </ConfirmationModal>
        ),
      })
        .then((opened) => {
          handle = opened as { close(): void } | undefined;
          if (!handle) settle(false);
        })
        .catch((err) => {
          this.log(`Couldn't open a dialog: ${err}`);
          settle(false);
        });
    });
  }

  /**
   * Opens HuddleFM's settings in Slack, as clicking Settings on its message
   * does, so the modal can link accounts and everything else it offers.
   */
  private async openSlackSettings(tab?: "you" | "session" | "host") {
    const player = this.client.state.get()?.session.player;
    if (!player) return false;
    // the tab it opens on, which the bot takes from the click that follows;
    // a bot without it opens where it always does
    if (tab)
      // not waited on long: Settings opens on its usual tab rather than late
      await Promise.race([
        this.client.command({ type: "settings_tab", tab }),
        new Promise((resolve) => setTimeout(resolve, SETTINGS_TAB_WAIT_MS)),
      ]);
    const message = this.api.messages.getRawMessage(player.channel, player.ts);
    const found = findButton(
      (message?.blocks ?? []) as Block[],
      "open_settings",
    );
    const profile = message?.bot_profile as
      { app_id?: string; team_id?: string } | undefined;
    const botId = this.api.messages.getMessageBotId(message);
    const appId = (message?.app_id as string | undefined) ?? profile?.app_id;
    const team = profile?.team_id ?? (message?.team as string | undefined);
    if (!found || !botId || !appId || !team) return false;
    try {
      // Slack's own click handler, which also readies the client for the
      // modal the bot opens in answer
      await this.dispatchHere("sendActions", {
        serviceId: botId,
        appId,
        serviceTeamId: team,
        actions: [
          {
            actionId: found.element.action_id,
            blockId: found.block.block_id,
            text: found.element.text,
            value: found.element.value,
            type: "button",
          },
        ],
        container: {
          type: "message",
          messageTs: player.ts,
          channelId: player.channel,
          isEphemeral: false,
        },
      });
      return true;
    } catch (err) {
      this.log(`Couldn't open Slack's settings: ${err}`);
      return false;
    }
  }

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
    if (sdk.options) {
      this.subscribe(sdk);
      return;
    }
    // Slack hands a new session to the manager before initialize(), which
    // swaps in Slack's own subscriber list, so join that list once it's there
    const plugin = this;
    sdk.initialize = function (this: HuddlesSdk, ...args: unknown[]) {
      // back to the prototype's initialize
      delete (sdk as Partial<HuddlesSdk>).initialize;
      // the list is swapped in before initialize's first await
      const result = sdk.initialize.apply(this, args);
      plugin.subscribe(sdk);
      return result;
    };
  }

  private subscribe(sdk: HuddlesSdk) {
    if (this.stopped) return;
    // this session's own facade: an old huddle's disconnect, coming after a
    // new one has connected, mustn't take the new one down
    let own: Facade | undefined;
    // called straight away if the session is already connected
    sdk.addDataChannelSubscriber({
      onConnectDatachannel: (facade) => {
        if (this.stopped) return;
        own = facade;
        this.facade?.realtimeUnsubscribeFromReceiveDataMessage(TOPIC);
        // drops any callback from an earlier connect, the topic is ours alone
        facade.realtimeUnsubscribeFromReceiveDataMessage(TOPIC);
        facade.realtimeSubscribeToReceiveDataMessage(TOPIC, (message) => {
          if (!this.stopped) this.client.receive(message);
        });
        this.facade = facade;
        this.client.connect((data) =>
          facade.realtimeSendDataMessage(TOPIC, data),
        );
      },
      onDisconnectDataChannel: () => {
        own?.realtimeUnsubscribeFromReceiveDataMessage(TOPIC);
        const current = own !== undefined && this.facade === own;
        own = undefined;
        if (this.stopped || !current) return;
        this.facade = undefined;
        this.client.disconnect();
      },
      onInitializeDataChannelSubscriber() {},
      onShutdownDataChannelSubscriber() {},
    });
  }
}

const pluginCss = `
/* In the huddle's window the popover is in Slack's layer above full
   screen, over the tooltips' own, which would hide its buttons' tooltips */
.c-popover:has(.c-tooltip__tip) {
  z-index: 1054;
}
/* the room above the bar, which the panel grows up into */
.taut-huddlefm-popover {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
.taut-huddlefm-popover > .huddlefm-panel {
  max-height: 100%;
}
.taut-huddlefm-bar {
  display: inline-flex;
  align-items: center;
}
.taut-huddlefm-collapsed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  color: var(--dt_color-content-sec, #454447);
  font-size: 13px;
}
.taut-huddlefm-collapsed span {
  flex: 1 1 140px;
}
`;

/**
 * Slack's views that lay out the huddle's tiles, each from the peers through
 * the same hook: the compact window's video and audio panes, and the full
 * window's grid, strip and smaller layouts.
 */
const TILE_VIEWS = [
  "HuddleCompactVideoPane",
  "HuddleCompactAudioPane",
  "HuddleGridContainer",
  "GridPicker",
  "MiniSideBySideLayoutComponent",
  "MinimizedSelfLayoutComponent",
  "HuddleVideoStrip",
];

type Peer = { userId?: string; isConnected?: boolean };
type Call = { pendingUsers?: Record<string, unknown> };
type HuddleState = {
  peers?: { byId?: Record<string, Peer> };
  allCalls?: { byId?: Record<string, Call> };
};

/**
 * A view of Slack's state where `userId` hasn't connected yet: Slack lists a
 * peer once it has, and it's left out of the call's invites, which would
 * list it as joining. Screen shares come from every peer, so they stay.
 */
function withoutPeer(userId: string | undefined) {
  let peersIn: Record<string, Peer> | undefined;
  let peersOut: Record<string, Peer> | undefined;
  let callsIn: Record<string, Call> | undefined;
  let callsOut: Record<string, Call> | undefined;
  return <S extends HuddleState>(state: S): S => {
    if (!userId || !state) return state;
    const peers = state.peers?.byId;
    if (peers !== peersIn) {
      peersIn = peers;
      peersOut = peers;
      for (const [id, peer] of Object.entries(peers ?? {}))
        if (peer?.userId === userId && peer.isConnected !== undefined)
          peersOut = { ...peersOut, [id]: { ...peer, isConnected: undefined } };
    }
    const calls = state.allCalls?.byId;
    if (calls !== callsIn) {
      callsIn = calls;
      callsOut = calls;
      for (const [id, call] of Object.entries(calls ?? {}))
        if (call?.pendingUsers && userId in call.pendingUsers) {
          const { [userId]: _, ...pendingUsers } = call.pendingUsers;
          callsOut = { ...callsOut, [id]: { ...call, pendingUsers } };
        }
    }
    if (peersOut === peers && callsOut === calls) return state;
    return {
      ...state,
      peers:
        peersOut === peers ? state.peers : { ...state.peers, byId: peersOut },
      allCalls:
        callsOut === calls
          ? state.allCalls
          : { ...state.allCalls, byId: callsOut },
    };
  };
}

/** A button in a message's blocks, with the block it's in, nested or not. */
function findButton(
  blocks: Block[],
  actionId: string,
): { block: Block; element: BlockElement } | undefined {
  for (const block of blocks) {
    for (const element of [...(block.elements ?? []), block.accessory])
      if (element?.action_id === actionId) return { block, element };
    const nested = findButton(block.child_blocks ?? [], actionId);
    if (nested) return nested;
  }
}

/**
 * The thunk contexts a node is inside, nearest first, by key: what Slack's
 * thunks read through their `getContext`, and its components give them with
 * a ThunkContextProvider, like the window they're in.
 */
function thunkContexts(node: Element | undefined) {
  const values = new Map<unknown, unknown>();
  if (!node) return values;
  const key = Object.keys(node).find((name) =>
    name.startsWith("__reactFiber$"),
  );
  type Fiber = {
    type?: { displayName?: string } | string | null;
    memoizedProps?: { contextKey?: unknown; value?: unknown };
    return: Fiber | null;
  };
  for (
    let fiber = key
      ? ((node as unknown as Record<string, Fiber>)[key] ?? null)
      : null;
    fiber;
    fiber = fiber.return
  ) {
    const type = fiber.type;
    if (typeof type !== "function" && typeof type !== "object") continue;
    if (type?.displayName !== "ThunkContextProvider") continue;
    const { contextKey, value } = fiber.memoizedProps ?? {};
    if (contextKey && !values.has(contextKey)) values.set(contextKey, value);
  }
  return values;
}

/** Slack's own components, in the shape the panel takes them. */
function slackKit(api: TautAPI, confirm: Kit["confirm"]): Kit {
  const { elements } = api;
  const { SvgIcon, Button, Tooltip, BasicSelect, Checkbox, Label } = elements;
  const { FormTextInput, IconButtonBase, Avatar } = elements;
  const { Hint, InlineAlert } = elements;
  const Tabs = api.lazyComponent<{
    tabs: { id: string; title: string; content: React.ReactNode }[];
    currentTabId: string;
    onTabChange: (id: string) => void;
    ariaLabel?: string;
  }>("TabsWithWindow");
  return {
    Icon: ({ name, size }) => <SvgIcon name={name} size={size} />,
    Button: ({ type, size, onClick, disabled, className, children }) => (
      <Button
        type={type}
        size={size}
        onClick={onClick}
        disabled={disabled}
        className={className}
      >
        {children}
      </Button>
    ),
    IconButton: ({
      label,
      tip,
      icon,
      onClick,
      size = "medium",
      className,
      disabled,
    }) => (
      <Tooltip tip={tip ?? label} delay={300}>
        <IconButtonBase
          size={size}
          className={[className, disabled && "huddlefm-off"]
            .filter(Boolean)
            .join(" ")}
          aria-label={disabled ? `${label}, unavailable` : label}
          onClick={onClick}
        >
          <SvgIcon name={icon} size={size === "small" ? 16 : 20} />
        </IconButtonBase>
      </Tooltip>
    ),
    Tooltip: ({ tip, position, delay, children }) => (
      <Tooltip tip={tip} position={position} delay={delay}>
        {children}
      </Tooltip>
    ),
    Select: ({ id, options, value, onChange, label, disabled }) => (
      <BasicSelect
        selectId={id}
        options={options}
        selectedOption={options.find((option) => option.value === value)}
        onSelectionChange={(option) => onChange(option.value)}
        width="100%"
        size="small"
        ariaLabel={label}
        isDisabled={disabled}
      />
    ),
    Checkbox: ({ checked, onChange, label, disabled }) => (
      <Label text={label} type="inline" className="huddlefm-check">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      </Label>
    ),
    TextInput: ({ value, onChange, onKeyDown, placeholder, autoFocus }) => (
      <FormTextInput
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        size="small"
        autoFocus={autoFocus}
      />
    ),
    Menu: ({ items, children }) => (
      <api.menu.Menu
        position="bottom-right"
        template={items.map((item, index) =>
          "separator" in item
            ? { key: String(index), type: "separator" as const }
            : {
                key: String(index),
                label: item.label,
                danger: item.danger,
                click: item.onClick,
              },
        )}
      >
        {children}
      </api.menu.Menu>
    ),
    Avatar: ({ userId, size }) => (
      <Avatar userId={userId} size={size} isInteractive={false} />
    ),
    Tabs: ({ label, tabs, current, onChange }) => (
      <Tabs
        ariaLabel={label}
        tabs={tabs}
        currentTabId={current}
        onTabChange={onChange}
      />
    ),
    Hint: ({ children }) => <Hint>{children}</Hint>,
    Alert: ({ children }) => <InlineAlert>{children}</InlineAlert>,
    confirm,
  };
}
