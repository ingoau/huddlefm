import { expect, test } from "bun:test";
import {
  canvasMarkdown,
  canvasSections,
  parseCanvasSections,
} from "./canvas.ts";

test("formats canvas stats as Slack canvas markdown", () => {
  const markdown = canvasMarkdown(
    {
      sessions: { count: 2, listened: 480, longest: 360, active: 1 },
      tracks: { count: 3, uniqueTracks: 2, artists: 2, autoplay: 1 },
      topArtists: [{ artist: "Artist", count: 2 }],
      topTracks: [{ title: "Song", artist: "Artist", count: 2 }],
      topChannels: [{ channelId: "C123", count: 3 }],
    },
    [{ label: "Next", count: 4 }],
    { updatedAt: 0 },
  );
  expect(markdown).toContain(
    "| Average listening per session | 4m 0s |\n| Longest session | 6m 0s |",
  );
  expect(markdown).not.toContain("requesters");
  expect(markdown).toContain("| Active sessions | 1 |");
  expect(markdown).toContain("| Unique tracks | 2 |");
  expect(markdown).toContain("| Average songs per session | 1.5 |");
  expect(markdown).toContain("| Next | 4 |");
  expect(markdown).toContain("1. ![](#C123) — 3 songs");
  expect(markdown).not.toContain("# HuddleFM stats");
  expect(markdown).not.toContain("## Integrations");
});

const stats = {
  sessions: { count: 0, listened: 0, longest: 0, active: 0 },
  tracks: { count: 0, uniqueTracks: 0, artists: 0, autoplay: 0 },
  topArtists: [],
  topTracks: [{ title: "Song", artist: "Artist", count: 1 }],
  topChannels: [],
};

test("lists integrations by name and ID without mentioning them", () => {
  const markdown = canvasMarkdown(stats, [], {
    integrations: [
      { id: "U123", name: "Deploy Bot" },
      { id: "U456", name: "U456" },
    ],
    updatedAt: 0,
  });
  expect(markdown).toContain(
    "## Integrations\n- **Deploy Bot** · `U123`\n- `U456`\n\n_Updated",
  );
  expect(markdown).not.toContain("@U123");
});

test("renders only the chosen sections in the chosen order", () => {
  const markdown = canvasMarkdown(stats, [], {
    integrations: [{ id: "U123", name: "Deploy Bot" }],
    sections: ["integrations", "top-tracks"],
    updatedAt: 0,
  });
  expect(markdown).toBe(
    [
      "## Integrations",
      "- **Deploy Bot** · `U123`",
      "",
      "## Top tracks",
      "1. **Song** — Artist · 1 play",
      "",
      "_Updated 1970-01-01T00:00:00.000Z_",
    ].join("\n"),
  );
});

test("parses canvas sections", () => {
  expect(parseCanvasSections()).toEqual([...canvasSections]);
  expect(parseCanvasSections(" , ")).toEqual([...canvasSections]);
  expect(parseCanvasSections("Top Songs, summary,top_tracks")).toEqual([
    "top-tracks",
    "summary",
  ]);
  expect(() => parseCanvasSections("constructor")).toThrow();
  expect(() => parseCanvasSections("summary,lyrics")).toThrow(
    'Unknown CANVAS_SECTIONS entry "lyrics"',
  );
});
