import { expect, test } from "bun:test";
import { changedSettings, settingsChanges } from "./settings-diff.ts";

test("lists only the settings whose value moved", () => {
  expect(
    settingsChanges(
      { autoplay: "off", loopMode: "off", volume: 0.6 },
      { autoplay: "related", loopMode: "off", volume: 0.8 },
    ),
  ).toEqual([
    { setting: "autoplay", from: "off", to: "related" },
    { setting: "volume", from: 0.6, to: 0.8 },
  ]);
  expect(
    changedSettings(
      settingsChanges({ autoplay: "off" }, { autoplay: "related" }),
    ),
  ).toEqual(["autoplay"]);
});

test("compares permission lists without caring about order", () => {
  expect(
    settingsChanges(
      { permissions: ["add", "skip"] },
      { permissions: ["skip", "add"] },
    ),
  ).toEqual([]);
  expect(
    settingsChanges({ permissions: ["add"] }, { permissions: ["add", "skip"] }),
  ).toEqual([{ setting: "permissions", from: ["add"], to: ["add", "skip"] }]);
  expect(
    settingsChanges({ permissions: ["add"] }, { permissions: "add" }),
  ).toEqual([{ setting: "permissions", from: ["add"], to: "add" }]);
});

test("reports settings that were previously unset", () => {
  expect(settingsChanges({}, { hostId: "U1", anchorEnabled: false })).toEqual([
    { setting: "hostId", from: undefined, to: "U1" },
    { setting: "anchorEnabled", from: undefined, to: false },
  ]);
});

test("ignores settings missing from the newer snapshot", () => {
  expect(settingsChanges({ hostId: "U1" }, {})).toEqual([]);
});
