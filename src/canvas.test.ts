import { expect, test } from "bun:test";
import { canvasMarkdown } from "./canvas.ts";

test("formats canvas stats as Slack canvas markdown", () => {
  const markdown = canvasMarkdown(
    {
      sessions: { count: 2, listened: 480, longest: 360, active: 1 },
      tracks: { count: 3, uniqueTracks: 2, artists: 2, autoplay: 1 },
      topArtists: [{ artist: "Artist", count: 2 }],
      topTracks: [{ title: "Song", artist: "Artist", count: 2 }],
      topChannels: [{ channelId: "C123", name: "music", count: 3 }],
    },
    [{ label: "Next", count: 4 }],
    0,
  );
  expect(markdown).toContain(
    "| Average listening per session | 4m 0s |\n| Longest session | 6m 0s |",
  );
  expect(markdown).not.toContain("requesters");
  expect(markdown).toContain("| Active sessions | 1 |");
  expect(markdown).toContain("| Unique tracks | 2 |");
  expect(markdown).toContain("| Average songs per session | 1.5 |");
  expect(markdown).toContain("| Next | 4 |");
  expect(markdown).toContain("1. **#music** — 3 songs");
  expect(markdown).not.toContain("# HuddleFM stats");
});
