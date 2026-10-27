// HuddleFM in the huddle bar: the song playing, and a popover with the rest.
// Everything but reaching Slack through Taut is in ../core/mod.tsx.

import { opt, TautPlugin } from "$taut";
import { HuddleFMMod } from "../core/mod.tsx";

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

  private mod: HuddleFMMod | undefined;

  start() {
    const { api, config } = this;
    const botUser = api.storage.store<string>("botUserId", "");
    const { elements } = api;
    this.mod = new HuddleFMMod({
      options: {
        collapsePlayer: config.collapsePlayer,
        hideTile: config.hideTile,
        hideCaptions: config.hideCaptions,
        mediaKeys: config.mediaKeys,
      },
      log: (text) => this.log(text),
      setStyle: (css) => api.setStyle(css),
      patchComponent: (name, replace) => {
        api.patchComponent(name, replace as never);
      },
      elements: {
        ...elements,
        TabsWithWindow: api.lazyComponent("TabsWithWindow"),
      },
      waitForExport: (match) => api.waitForExport(match),
      waitForThunkCreator: (name) => api.redux.waitForThunkCreator(name),
      dispatchThunk: (name, ...args) => api.redux.dispatchThunk(name, ...args),
      getStore: () => api.redux.getStore(),
      StateView: api.redux.StateView,
      members: {
        selfId: () => api.members.getCurrentMemberId(),
        get: (userId) => api.members.getMember(userId),
        use: (userId) => api.members.useMember(userId),
      },
      messages: {
        raw: (channel, ts) => api.messages.getRawMessage(channel, ts),
        botId: (message) => api.messages.getMessageBotId(message as never),
      },
      userAPI: (method, params) => api.userAPI(method, params),
      activeHuddleChannel: () => api.huddles.getActiveHuddle()?.channelId,
      botUser: {
        get: () => botUser.get(),
        set: (userId) => {
          botUser.set(userId).catch(() => {});
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
