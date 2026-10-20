import { expect, test } from "bun:test";
import {
  parseIds,
  parseRolePermissions,
  parseVideoLimits,
  parseWholeNumber,
} from "./config.ts";

test("parses comma and whitespace separated IDs", () => {
  expect([...parseIds("C123,C456 C789\nC123")]).toEqual([
    "C123",
    "C456",
    "C789",
  ]);
});

test("falls back when a count is unset, fractional, or too small", () => {
  expect(parseWholeNumber(undefined, 2, 1)).toBe(2);
  expect(parseWholeNumber(" ", 2, 1)).toBe(2);
  expect(parseWholeNumber("4", 2, 1)).toBe(4);
  expect(parseWholeNumber("0", 2, 1)).toBe(2);
  expect(parseWholeNumber("0", 30)).toBe(0);
  expect(parseWholeNumber("1.5", 2, 1)).toBe(2);
  expect(parseWholeNumber("lots", 2, 1)).toBe(2);
});

test("an offset may be negative, within its bounds", () => {
  expect(parseWholeNumber("-250", 0, -10_000)).toBe(-250);
  expect(parseWholeNumber("300", 0, -10_000)).toBe(300);
  expect(parseWholeNumber("-20000", 0, -10_000)).toBe(0);
  expect(parseWholeNumber("150000", 0, -10_000, 10_000)).toBe(0);
});

test("channel managers and workspace admins can end sessions by default", () => {
  expect(parseRolePermissions({})).toEqual({
    channelManagers: "end",
    workspaceAdmins: "end",
    warnings: [],
  });
  expect(
    parseRolePermissions({
      CHANNEL_MANAGER_PERMISSIONS: " Host ",
      WORKSPACE_ADMIN_PERMISSIONS: "none",
    }),
  ).toEqual({ channelManagers: "host", workspaceAdmins: "none", warnings: [] });
});

test("a mistyped role permission falls back to end with a warning", () => {
  const parsed = parseRolePermissions({
    CHANNEL_MANAGER_PERMISSIONS: "hots",
    WORKSPACE_ADMIN_PERMISSIONS: "all",
  });
  expect(parsed.channelManagers).toBe("end");
  expect(parsed.workspaceAdmins).toBe("end");
  expect(parsed.warnings).toEqual([
    "CHANNEL_MANAGER_PERMISSIONS must be none, end, or host; using end instead",
    "WORKSPACE_ADMIN_PERMISSIONS must be none, end, or host; using end instead",
  ]);
});

test("WORKSPACE_ADMINS_AS_MANAGERS still grants host until replaced", () => {
  expect(
    parseRolePermissions({ WORKSPACE_ADMINS_AS_MANAGERS: "true" }),
  ).toEqual({
    channelManagers: "end",
    workspaceAdmins: "host",
    warnings: [
      "WORKSPACE_ADMINS_AS_MANAGERS is deprecated; use WORKSPACE_ADMIN_PERMISSIONS instead",
    ],
  });
  expect(
    parseRolePermissions({ WORKSPACE_ADMINS_AS_MANAGERS: "false" })
      .workspaceAdmins,
  ).toBe("end");
  const replaced = parseRolePermissions({
    WORKSPACE_ADMINS_AS_MANAGERS: "true",
    WORKSPACE_ADMIN_PERMISSIONS: "nope",
  });
  expect(replaced.workspaceAdmins).toBe("end");
  expect(replaced.warnings).toContain(
    "WORKSPACE_ADMINS_AS_MANAGERS is ignored because WORKSPACE_ADMIN_PERMISSIONS is set",
  );
});

test("video limits default to an hour at 720p30 and keep their bounds", () => {
  expect(parseVideoLimits({})).toEqual({
    durationSeconds: 3_600,
    downloadBytes: 1_500_000_000,
    maxHeight: 720,
    maxFps: 30,
    sessionLimit: 2,
    cacheBytes: 5_000_000_000,
  });
  expect(
    parseVideoLimits({
      VIDEO_DURATION_LIMIT_SECONDS: "7200",
      VIDEO_DOWNLOAD_LIMIT_BYTES: "2000000000",
      VIDEO_MAX_HEIGHT: "1080",
      VIDEO_MAX_FPS: "24",
      VIDEO_SESSION_LIMIT: "0",
      VIDEO_CACHE_LIMIT_BYTES: "0",
    }),
  ).toEqual({
    durationSeconds: 7_200,
    downloadBytes: 2_000_000_000,
    maxHeight: 1_080,
    maxFps: 24,
    sessionLimit: 0,
    cacheBytes: 0,
  });
  // Out of range: the default.
  expect(
    parseVideoLimits({ VIDEO_MAX_HEIGHT: "4320", VIDEO_MAX_FPS: "60" }),
  ).toMatchObject({ maxHeight: 720, maxFps: 30 });
});
