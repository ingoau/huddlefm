import { expect, test } from "bun:test";
import {
  parseIds,
  parseMediaBackend,
  parseRolePermissions,
  parseWholeNumber,
} from "./config.ts";

test("parses comma and whitespace separated IDs", () => {
  expect([...parseIds("C123,C456 C789\nC123")]).toEqual([
    "C123",
    "C456",
    "C789",
  ]);
});

test("uses the browser media backend unless native is chosen", () => {
  const browser = { backend: "browser", fallback: false } as const;
  expect(parseMediaBackend(undefined)).toEqual(browser);
  expect(parseMediaBackend("")).toEqual(browser);
  expect(parseMediaBackend("chromium")).toEqual(browser);
  expect(parseMediaBackend(" Native ")).toEqual({
    backend: "native",
    fallback: false,
  });
});

test("native media can fall back to the browser", () => {
  expect(parseMediaBackend("native-with-fallback")).toEqual({
    backend: "native",
    fallback: true,
  });
  expect(parseMediaBackend(" Native-With-Fallback ")).toEqual({
    backend: "native",
    fallback: true,
  });
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
