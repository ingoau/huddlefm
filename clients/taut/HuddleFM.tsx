// HuddleFM in the huddle bar: the song playing, and a popover with the rest

import { opt, TautPlugin, type TautAPI } from "$taut";
import { Panel, PlayerBar, type Kit, type Platform } from "../core/panel.tsx";
import { HuddleFMClient, TOPIC, type DataMessage } from "../core/protocol.ts";
import { panelCss } from "../core/styles.ts";

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
  };

  private facade: Facade | undefined;
  /** sessions given a subscriber, since Slack has no way to take one back */
  private attached = new WeakSet<HuddlesSdk>();
  private unpatch: (() => void) | undefined;
  private stopped = false;
  /** the HuddleFM Start invites, and the only one believed: chosen, or the first heard */
  private botUser = this.api.storage.store<string>("botUserId", "");
  private client = new HuddleFMClient(
    () => this.api.members.getCurrentMemberId(),
    (text) => this.log(text),
    () => this.botUser.get() || undefined,
  );

  private platform: Platform = {
    client: this.client,
    kit: slackKit(this.api),
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
    openSlackSettings: () => this.openSlackSettings(),
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
    this.client.disconnect();
  }

  dataPanel() {
    return <Panel platform={this.platform} />;
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

    // HuddleFM's tile, by the bot's user, in the grid every layout draws;
    // its screen share in video mode is a share, so it stays
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
    const [anchor, setAnchor] = React.useState<{
      target: HTMLElement;
      bounds: DOMRect;
      window: WeakRef<Window>;
    } | null>(null);
    // Slack places a popover once, from where its target is, so as the
    // panel changes size it's placed again, or a taller one runs off the
    // window
    const panel = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      const element = panel.current;
      const win = element?.ownerDocument.defaultView;
      if (!element || !win) return;
      const observer = new win.ResizeObserver(() =>
        setAnchor((current) =>
          current
            ? { ...current, bounds: current.target.getBoundingClientRect() }
            : null,
        ),
      );
      observer.observe(element);
      return () => observer.disconnect();
    }, [!!anchor]);
    // the toolbar is a fixed row of buttons, so whether the song fits beside
    // them comes down to how wide its window is
    const [compact, setCompact] = React.useState(false);
    React.useEffect(() => {
      const win = ref.current?.ownerDocument.defaultView;
      if (!win) return;
      const fit = () => setCompact(win.innerWidth < COMPACT_WIDTH);
      fit();
      win.addEventListener("resize", fit);
      return () => win.removeEventListener("resize", fit);
    }, []);
    // placed by the whole bar, which stays as the button in it changes
    const open = (button: HTMLElement) =>
      setAnchor((current) => {
        const target = ref.current ?? button;
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
      <span className="taut-huddlefm-bar" ref={ref}>
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
            <div ref={panel}>
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
   * Opens HuddleFM's settings in Slack, as clicking Settings on its message
   * does, so the modal can link accounts and everything else it offers.
   */
  private async openSlackSettings() {
    const player = this.client.state.get()?.session.player;
    if (!player) return false;
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
      await this.api.redux.dispatchThunk("sendActions", {
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
      // the modal opens in Slack's main window
      window.focus();
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

/** Slack's own components, in the shape the panel takes them. */
function slackKit(api: TautAPI): Kit {
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
    IconButton: ({ label, icon, onClick, size = "medium", className }) => (
      <Tooltip tip={label} delay={300}>
        <IconButtonBase
          size={size}
          className={className}
          aria-label={label}
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
    confirm: ({ title, body, confirmText, danger }) => {
      // Slack's dialogs open in the main window, maybe behind the huddle's
      window.focus();
      return api.modal.confirm({ title, body, confirmText, danger });
    },
  };
}
