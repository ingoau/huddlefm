import { expect, test } from "bun:test";
import {
  parsePlaybackReport,
  playbackProblems,
  playbackReportView,
} from "./playback-report.ts";

test("the report form lists every problem, Other included", () => {
  const view = playbackReportView({
    sessionId: "session",
    reportId: "report",
    switched: true,
  });
  const text = JSON.stringify(view);
  for (const label of Object.values(playbackProblems))
    expect(text).toContain(label);
  expect(text).toContain('"text":"Other"');
  expect(JSON.parse(view.private_metadata)).toEqual({
    sessionId: "session",
    reportId: "report",
    switched: true,
  });
  expect(
    JSON.stringify(
      playbackReportView({
        sessionId: "session",
        reportId: "report",
        switched: false,
      }),
    ),
  ).toContain("already using the backup player");
});

test("reads the ticked problems and any details", () => {
  expect(
    parsePlaybackReport({
      metadata: JSON.stringify({
        sessionId: "session",
        reportId: "report",
        switched: true,
      }),
      state: {
        problems: {
          selection: {
            selected_options: [
              { value: "no_sound" },
              { value: "made_up" },
              { value: "other" },
            ],
          },
        },
        details: { text: { value: "  It cut out after the chorus  " } },
      },
    }),
  ).toEqual({
    sessionId: "session",
    reportId: "report",
    switched: true,
    problems: ["no_sound", "other"],
    details: "It cut out after the chorus",
  });
});

test("leaves details out when none were given", () => {
  expect(
    parsePlaybackReport({
      metadata: JSON.stringify({ sessionId: "session", reportId: "report" }),
      state: { details: { text: { value: "   " } } },
    }),
  ).toEqual({
    sessionId: "session",
    reportId: "report",
    switched: false,
    problems: [],
  });
});

test("ignores submissions that are not reports", () => {
  expect(parsePlaybackReport({ metadata: "", state: {} })).toBeUndefined();
  expect(
    parsePlaybackReport({
      metadata: JSON.stringify({ sessionId: "session" }),
      state: {},
    }),
  ).toBeUndefined();
});
