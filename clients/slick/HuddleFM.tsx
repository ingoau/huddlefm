// HuddleFM in the huddle bar: the song playing, and a popover with the rest.
// Everything but reaching Slack through Slick is in ../core/mod.tsx.

import { SlickPlugin, type SettingsSchema, type SlickAPI } from "$slick";
import { HuddleFMMod, type SlackElements } from "../core/mod.tsx";
import { Store } from "../core/store.ts";

const settings = {
  collapsePlayer: {
    type: "boolean",
    label: "Shrink HuddleFM's message",
    description:
      "Shrink HuddleFM's message in the huddle thread while it's in the huddle bar",
    default: true,
  },
  hideTile: {
    type: "boolean",
    label: "Hide HuddleFM's tile",
    description:
      "Leave HuddleFM out of the huddle's grid. Its screen share in video mode still shows.",
    default: false,
  },
  hideCaptions: {
    type: "boolean",
    label: "Hide captions of HuddleFM's music",
    description: "Over the huddle and in its Captions tab",
    default: true,
  },
  mediaKeys: {
    type: "boolean",
    label: "Media keys",
    description:
      "Control HuddleFM with your keyboard's media keys, and show its song in your system's media controls",
    default: true,
  },
} as const satisfies SettingsSchema;

export default class HuddleFM extends SlickPlugin<typeof settings> {
  static readonly id = "HuddleFM";
  static readonly pluginName = "HuddleFM";
  static readonly description =
    "HuddleFM in the huddle bar: the song playing, and a popover with the rest";
  static readonly settings = settings;
  static readonly requiredAPIs = ["redux", "members", "messages"] as const;

  private mod: HuddleFMMod | undefined;

  async start() {
    const { api, config } = this;
    // read before anything can choose one, so a choice isn't overwritten
    const botUser = new Store(await api.storage.get<string>("botUserId", ""));
    if (!api.isActive()) return;
    const huddle = activeHuddle(api);
    this.mod = new HuddleFMMod({
      options: {
        collapsePlayer: config.collapsePlayer,
        hideTile: config.hideTile,
        hideCaptions: config.hideCaptions,
        mediaKeys: config.mediaKeys,
      },
      log: (text) => this.log(text),
      setStyle: (css) => {
        api.setStyle(css);
      },
      patchComponent: (name, replace) => {
        api.patchComponent(name, replace as never);
      },
      elements: slackElements(api),
      waitForExport: (match) => api.waitForExport(match),
      waitForThunkCreator: (name) => api.redux.waitForThunkCreator(name),
      dispatchThunk: (name, ...args) => api.redux.dispatchThunk(name, ...args),
      getStore: () => api.redux.getStore(),
      members: {
        selfId: () => api.members.getCurrentMemberId(),
        get: (userId) => api.members.getMember(userId),
        use: (userId) => api.members.useMember(userId),
      },
      messages: {
        raw: (channel, ts) => api.messages.getRawMessage(channel, ts),
        botId: (message) => api.messages.getMessageBotId(message as never),
      },
      userAPI: (method, params) =>
        api.userAPI(method, params, { signal: api.signal }),
      activeHuddleChannel: huddle,
      botUser: {
        get: botUser.get,
        set: (userId) => {
          botUser.set(userId);
          api.storage.set("botUserId", userId).catch(() => {});
        },
        use: () => botUser.use(),
      },
    });
    this.mod.start();
  }

  stop() {
    this.mod?.stop();
    this.mod = undefined;
  }
}

/** Reads the channel of the huddle you're in, from Slack's own selector. */
function activeHuddle(api: SlickAPI) {
  type Selector = (state: unknown) => string | undefined;
  const isSelector = (exp: unknown): exp is Selector =>
    typeof exp === "function" &&
    (exp as { meta?: { name?: string } }).meta?.name ===
      "getActiveHuddleChannelId";
  let selector: Selector | undefined;
  api.waitForExport(isSelector).then((found) => {
    selector = found;
  });
  return () => {
    const state = api.redux.getStore()?.getState();
    return state && selector ? selector(state) : undefined;
  };
}

/**
 * Slack's components, each drawn once its chunk loads. Some names are
 * shared by other components, so those are told apart by the markup they
 * draw, as Taut does.
 */
function slackElements(api: SlickAPI): SlackElements {
  const component = (name: string, marker?: string) => {
    const filter = marker
      ? (exp: unknown) => {
          if (nameOf(exp) !== name) return false;
          try {
            return api
              .getComponentSource(exp as React.ComponentType)
              .includes(marker);
          } catch {
            return false;
          }
        }
      : undefined;
    const found = new Store<React.ComponentType<object> | undefined>(undefined);
    let looked = false;
    const Lazy = (props: object) => {
      if (!looked) {
        looked = true;
        try {
          found.set(api.getComponent(name, false, filter));
        } catch {
          // its chunk isn't loaded yet
          api
            .waitForComponent<object>(name, filter)
            .then((Component) => found.set(Component));
        }
      }
      const Component = found.use();
      return Component ? <Component {...props} /> : null;
    };
    Lazy.displayName = `HuddleFM(${name})`;
    return Lazy;
  };
  return {
    SvgIcon: component("SvgIcon"),
    Button: component("Button", '"c-button"'),
    Tooltip: component("Tooltip", '"data-sk":"tooltip"'),
    IconButtonBase: component("IconButtonBase"),
    BasicSelect: component("BasicSelect"),
    Checkbox: component("Checkbox"),
    Label: component("Label", '"c-label"'),
    FormTextInput: component("FormTextInput"),
    Avatar: component("ConnectedBaseAvatar"),
    Hint: component("Hint"),
    InlineAlert: component("InlineAlert"),
    Popover: component("Popover", '"c-popover"'),
    ConfirmationModal: component("ConfirmationModal"),
    MenuTrigger: component("MenuTrigger"),
    MenuFromTemplate: component("MenuFromTemplate"),
    TabsWithWindow: component("TabsWithWindow"),
  };
}

/** A component's name, through memo and forwardRef, as Slick reads it. */
function nameOf(exp: unknown): string | undefined {
  if (!exp || (typeof exp !== "function" && typeof exp !== "object"))
    return undefined;
  const value = exp as {
    $$typeof?: symbol;
    displayName?: string;
    name?: string;
    type?: unknown;
    render?: { displayName?: string; name?: string };
  };
  if (typeof exp === "function") return value.displayName || value.name;
  if (value.$$typeof === Symbol.for("react.memo"))
    return value.displayName || nameOf(value.type);
  if (value.$$typeof === Symbol.for("react.forward_ref"))
    return value.displayName || value.render?.displayName || value.render?.name;
}
