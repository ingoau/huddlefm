import { expect, test } from "bun:test";
import {
  settingFields,
  type SessionSettingsView,
  type SettingsContext,
  type UserSettingsView,
} from "./settings-schema.ts";

const session: SessionSettingsView = {
  hostId: "UHOST",
  mediaMode: "music",
  volume: 0.6,
  displayMode: "default",
  autoplayMode: "off",
  videoAutoplay: false,
  loopMode: "off",
  transitionMode: "none",
  duckingMode: "gentle",
  anchorEnabled: false,
  progressBar: true,
  allowed: new Set(["add", "skip"]),
};

const user: UserSettingsView = {
  lastFmAvailable: true,
  lastFmConnected: true,
  lastFmEnabled: true,
  listenBrainzConnected: false,
  listenBrainzEnabled: false,
  huddleMixSources: ["added"],
  huddleMixUsable: ["added", "lastfm"],
  mode: "always",
  configured: true,
  sessionEnabled: true,
};

const everything = { volume: true, configure: true, admin: true };

function ids(context: Partial<SettingsContext>) {
  return settingFields({ access: everything, session, ...context }).map(
    (field) => field.id,
  );
}

test("fields follow the viewer's access and the session's mode", () => {
  expect(ids({})).toEqual([
    "media_mode",
    "volume",
    "display",
    "autoplay",
    "loop",
    "transition",
    "ducking",
    "anchor",
    "host",
    "permissions",
  ]);
  expect(
    ids({ access: { volume: true, configure: false, admin: false } }),
  ).toEqual(["volume"]);
  expect(ids({ session: { ...session, mediaMode: "video" } })).toEqual([
    "media_mode",
    "volume",
    "video_autoplay",
    "loop",
    "progress_bar",
    "anchor",
    "host",
    "permissions",
  ]);
});

test("the You tab needs the viewer's own settings", () => {
  expect(ids({}).some((id) => id.startsWith("scrobbl"))).toBe(false);
  const fields = settingFields({ access: everything, session, user });
  const you = fields.filter((field) => field.tab === "you");
  expect(you.map((field) => field.id)).toEqual([
    "huddle_mix",
    "session_scrobbling",
    "scrobbling_mode",
    "scrobble_to",
  ]);
  expect(you.find((field) => field.id === "scrobble_to")).toMatchObject({
    options: [{ value: "lastfm", label: "Last.fm" }],
    value: ["lastfm"],
  });
});

test("overrides stand in for current values", () => {
  const fields = settingFields(
    { access: everything, session },
    { loop: "queue", anchor: true, permissions: ["pause"], host: null },
  );
  const value = (id: string) => fields.find((field) => field.id === id)?.value;
  expect(value("loop")).toBe("queue");
  expect(value("anchor")).toBe(true);
  expect(value("permissions")).toEqual(["pause"]);
  expect(value("host")).toBeNull();
  expect(value("display")).toBe("default");
});

test("the volume's steps include a current volume between them", () => {
  const volume = settingFields({
    access: everything,
    session: { ...session, volume: 0.625 },
  }).find((field) => field.id === "volume");
  expect(volume?.value).toBe("62.5");
  expect(
    volume?.kind === "select" &&
      volume.options.map((option) => option.value).slice(12, 15),
  ).toEqual(["60", "62.5", "65"]);
});
