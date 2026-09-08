import { expect, test } from "bun:test";
import {
  eventGroup,
  integrationEventMessage,
  isAllowlisted,
  mapAgentError,
  parseIntegrationActionValue,
  parseIntegrationMessage,
  permissionLabelList,
  sessionMatchesChannel,
  wrapIntegrationResult,
} from "./integration.ts";

test("ignores non-JSON and missing protocol version", () => {
  expect(parseIntegrationMessage("hello")).toEqual({
    ok: false,
    error: "ignored",
  });
  expect(parseIntegrationMessage("{")).toEqual({
    ok: false,
    error: "ignored",
  });
  expect(parseIntegrationMessage(JSON.stringify({ type: "status" }))).toEqual({
    ok: false,
    error: "unsupported_version",
    message: "Use protocol version 1.",
  });
});

test("rejects unknown types and request_control without a channel", () => {
  expect(
    parseIntegrationMessage(JSON.stringify({ v: 1, type: "sessions" })),
  ).toEqual({ ok: false, error: "unknown_type" });
  expect(
    parseIntegrationMessage(
      JSON.stringify({
        v: 1,
        type: "request_control",
        permissions: ["pause"],
        events: ["track"],
      }),
    ),
  ).toEqual({ ok: false, error: "channel_required" });
});

test("rejects unknown permissions and events without listing the catalog", () => {
  expect(
    parseIntegrationMessage(
      JSON.stringify({
        v: 1,
        type: "request_control",
        channel: "C123",
        permissions: ["pause", "host", "skip"],
        events: ["track"],
      }),
    ),
  ).toEqual({
    ok: false,
    error: "unknown_permissions",
    permissions: ["host"],
  });
  expect(
    parseIntegrationMessage(
      JSON.stringify({
        v: 1,
        type: "request_control",
        channel: "C123",
        permissions: ["pause"],
        events: ["track", "secrets"],
      }),
    ),
  ).toEqual({
    ok: false,
    error: "unknown_events",
    events: ["secrets"],
  });
});

test("parses a valid request_control and command with optional channel", () => {
  expect(
    parseIntegrationMessage(
      JSON.stringify({
        v: 1,
        type: "request_control",
        channel: "C123",
        permissions: ["pause", "skip", "add"],
        events: ["playback.state", "track"],
      }),
    ),
  ).toEqual({
    ok: true,
    command: {
      type: "request_control",
      channel: "C123",
      permissions: ["pause", "skip", "add"],
      events: ["playback.state", "track"],
    },
  });
  expect(
    parseIntegrationMessage(
      JSON.stringify({
        v: 1,
        type: "skip",
        channel: "C123",
      }),
    ),
  ).toEqual({
    ok: true,
    command: { type: "skip", channel: "C123" },
  });
});

test("matches sessions by source, UI, or companion channel", () => {
  const room = {
    uiChannelId: "CUI",
    sourceChannelId: "CSOURCE",
    companionChannelId: "CCOMP",
  };
  expect(sessionMatchesChannel(room, "CSOURCE")).toBe(true);
  expect(sessionMatchesChannel(room, "CUI")).toBe(true);
  expect(sessionMatchesChannel(room, "CCOMP")).toBe(true);
  expect(sessionMatchesChannel(room, "COTHER")).toBe(false);
});

test("allowlists user or bot ids", () => {
  const allowed = new Set(["U123", "B456"]);
  expect(isAllowlisted(allowed, "U123")).toBe(true);
  expect(isAllowlisted(allowed, "U999", "B456")).toBe(true);
  expect(isAllowlisted(allowed, "U999", "B000")).toBe(false);
});

test("maps agent errors and event groups", () => {
  expect(mapAgentError("Join the huddle before using the player.")).toBe(
    "not_granted",
  );
  expect(mapAgentError("You do not have permission for that.")).toBe(
    "missing_permission",
  );
  expect(mapAgentError("The queue is full.")).toBe("queue_full");
  expect(eventGroup("playback.paused")).toBe("playback.state");
  expect(eventGroup("track.started")).toBe("track");
  expect(eventGroup("queue.added")).toBe("queue");
  expect(permissionLabelList(["pause", "skip"])).toEqual([
    "Pause or resume",
    "Skip songs",
  ]);
});

test("wraps agent results with replyTo and does not parse action values loosely", () => {
  expect(
    wrapIntegrationResult("skip", "1.0", {
      ok: true,
      skipped: { title: "Song", artist: "Artist" },
      nowPlaying: null,
    }),
  ).toBe(
    JSON.stringify({
      v: 1,
      replyTo: "1.0",
      ok: true,
      type: "skip",
      skipped: { title: "Song", artist: "Artist" },
      nowPlaying: null,
    }),
  );
  expect(
    wrapIntegrationResult("skip", "1.0", {
      ok: false,
      error: "Nothing is playing.",
    }),
  ).toBe(
    JSON.stringify({
      v: 1,
      replyTo: "1.0",
      ok: false,
      type: "skip",
      error: "nothing_playing",
      message: "Nothing is playing.",
    }),
  );
  expect(
    parseIntegrationActionValue('{"sessionId":"s","requestId":"r"}'),
  ).toEqual({
    sessionId: "s",
    requestId: "r",
  });
  expect(parseIntegrationActionValue("session")).toBeUndefined();
  expect(
    JSON.parse(
      integrationEventMessage("C123", "track.started", {
        title: "Song",
        artist: "Artist",
      }),
    ),
  ).toEqual({
    v: 1,
    type: "event",
    channel: "C123",
    event: "track.started",
    payload: { title: "Song", artist: "Artist" },
  });
});
