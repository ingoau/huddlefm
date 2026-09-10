import { expect, test } from "bun:test";
import {
  eventGroup,
  integrationEventMessage,
  integrationSettingsBlocks,
  integrationSettingsPageValue,
  isAllowlisted,
  mapAgentError,
  parseIntegrationActionValue,
  parseIntegrationMessage,
  parseIntegrationSettingsPage,
  permissionLabelList,
  sessionMatchesChannel,
  slackModalBlockLimit,
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
  expect(
    parseIntegrationMessage(
      JSON.stringify({ v: 1, type: "settings", autoplay: "huddle" }),
    ),
  ).toEqual({
    ok: true,
    command: { type: "settings", autoplayMode: "huddle" },
  });
  expect(
    parseIntegrationMessage(
      JSON.stringify({ v: 1, type: "settings", autoplay: true }),
    ),
  ).toEqual({
    ok: true,
    command: { type: "settings", autoplay: true },
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

test("settings blocks list granted bots with revoke actions", () => {
  expect(integrationSettingsBlocks({ sessionId: "s", grants: [] })).toEqual([]);
  const blocks = integrationSettingsBlocks({
    sessionId: "s",
    grants: [
      { userId: "Ubot", requestId: "r1", permissions: ["pause", "skip"] },
      { userId: "Ubot2", requestId: "r2", permissions: ["volume"] },
    ],
  });
  expect(JSON.stringify(blocks)).toContain('"block_id":"integrations"');
  expect(JSON.stringify(blocks)).toContain("<@Ubot> has control");
  expect(JSON.stringify(blocks)).toContain("<@Ubot2> has control");
  expect(JSON.stringify(blocks)).toContain("Pause or resume");
  expect(JSON.stringify(blocks)).toContain("Change volume");
  expect(JSON.stringify(blocks)).not.toContain('"pause"');
  expect(
    parseIntegrationActionValue(
      (
        blocks.find(
          (block) => block.block_id === "integration_actions_Ubot",
        ) as {
          elements: { value: string }[];
        }
      ).elements[0]!.value,
    ),
  ).toEqual({ sessionId: "s", requestId: "r1" });
});

test("paginates grants so each page stays within the modal block limit", () => {
  const grants = Array.from({ length: 50 }, (_, index) => ({
    userId: `Ubot${index}`,
    requestId: `r${index}`,
    permissions: ["pause"],
  }));
  const maxBlocks = 80;
  expect(1 + grants.length * 2).toBeGreaterThan(slackModalBlockLimit);
  expect(1 + grants.length * 2).toBeGreaterThan(maxBlocks);
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const blocks = integrationSettingsBlocks({
      sessionId: "s",
      grants,
      maxBlocks,
      page,
    });
    expect(blocks.length).toBeLessThanOrEqual(maxBlocks);
    const body = JSON.stringify(blocks);
    for (const grant of grants)
      if (body.includes(`<@${grant.userId}>`)) seen.add(grant.userId);
    if (page === 0) {
      expect(body).toContain('"action_id":"integration_grants_next"');
      expect(body).not.toContain('"action_id":"integration_grants_prev"');
      expect(
        parseIntegrationSettingsPage(integrationSettingsPageValue("s", 1)),
      ).toEqual({
        sessionId: "s",
        page: 1,
      });
    }
    if (!body.includes('"action_id":"integration_grants_next"')) {
      expect(page).toBeGreaterThan(0);
      expect(body).toContain('"action_id":"integration_grants_prev"');
      break;
    }
  }
  expect(seen.size).toBe(grants.length);
});
