import { expect, test } from "bun:test";
import {
  settingFields,
  volumePercent,
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
  communism: false,
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
  scrobbleOwnTracks: false,
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
  // Communism mode has no host to change or permissions to set.
  expect(ids({ session: { ...session, communism: true } })).toEqual([
    "media_mode",
    "volume",
    "display",
    "autoplay",
    "loop",
    "transition",
    "ducking",
    "anchor",
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
    "scrobble_own_tracks",
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

test("the volume is a percent from 0 to 100, kept to the hundredth", () => {
  const volume = settingFields({
    access: everything,
    session: { ...session, volume: 0.625 },
  }).find((field) => field.id === "volume");
  expect(volume).toMatchObject({
    kind: "number",
    label: "Volume (%)",
    min: 0,
    max: 100,
    value: "62.5",
  });
});

test("the volume shown stays within 0 to 100 whatever it was set to", () => {
  expect(volumePercent(0.35)).toBe("35");
  expect(volumePercent(50)).toBe("100");
  expect(volumePercent(-1)).toBe("0");
  expect(volumePercent(Number.NaN)).toBe("0");
});

test("a volume override stands in for the session's volume", () => {
  const volume = settingFields(
    { access: everything, session },
    { volume: "37.25" },
  ).find((field) => field.id === "volume");
  expect(volume?.value).toBe("37.25");
});

test("permissions offer each preset, the default first", () => {
  const permissions = settingFields({ access: everything, session }).find(
    (field) => field.id === "permissions",
  );
  expect(permissions?.kind === "multi" && permissions.presets).toEqual([
    {
      value: "default",
      label: "Default",
      permissions: ["add", "remove-own", "skip", "pause", "volume"],
    },
    {
      value: "add-only",
      label: "Add songs only",
      permissions: ["add", "remove-own"],
    },
    { value: "host-only", label: "Host only", permissions: [] },
    expect.objectContaining({ value: "collaborative" }),
  ]);
});
