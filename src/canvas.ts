import { elapsed } from "./coordinator-ui.ts";
import type { CanvasStats } from "./store.ts";

export function canvasMarkdown(
  stats: Omit<CanvasStats, "topChannels"> & {
    topChannels: (CanvasStats["topChannels"][number] & { name?: string })[];
  },
  controls: { label: string; count: number }[],
  updatedAt = Date.now(),
) {
  const requested = stats.tracks.count - stats.tracks.autoplay;
  const average = stats.sessions.count
    ? stats.sessions.listened / stats.sessions.count
    : 0;
  const ranking = <T>(
    entries: T[],
    line: (entry: T, index: number) => string,
  ) => entries.map(line).join("\n") || "Nothing yet.";
  return [
    "All-time listening across every HuddleFM session.",
    "",
    "| Metric | Total |",
    "| --- | ---: |",
    `| Sessions | ${stats.sessions.count} |`,
    `| Active sessions | ${stats.sessions.active} |`,
    `| Time listened | ${elapsed(stats.sessions.listened)} |`,
    `| Average listening per session | ${elapsed(average)} |`,
    `| Longest session | ${elapsed(stats.sessions.longest)} |`,
    `| Songs played | ${stats.tracks.count} |`,
    `| Unique tracks | ${stats.tracks.uniqueTracks} |`,
    `| Average songs per session | ${stats.sessions.count ? (stats.tracks.count / stats.sessions.count).toFixed(1) : "0"} |`,
    `| Unique artists | ${stats.tracks.artists} |`,
    `| Requested / autoplay | ${requested} / ${stats.tracks.autoplay} |`,
    "",
    "## Top artists",
    ranking(
      stats.topArtists,
      ({ artist, count }, index) =>
        `${index + 1}. **${escapeMarkdown(artist)}** — ${count} ${count === 1 ? "play" : "plays"}`,
    ),
    "",
    "## Top tracks",
    ranking(
      stats.topTracks,
      ({ title, artist, count }, index) =>
        `${index + 1}. **${escapeMarkdown(title)}** — ${escapeMarkdown(artist)} · ${count} ${count === 1 ? "play" : "plays"}`,
    ),
    "",
    "## Most active channels",
    ranking(
      stats.topChannels,
      ({ channelId, name, count }, index) =>
        `${index + 1}. **#${escapeMarkdown(name ?? channelId)}** — ${count} ${count === 1 ? "song" : "songs"}`,
    ),
    "",
    "## Controls used",
    "| Control | Uses |",
    "| --- | ---: |",
    ...controls.map(({ label, count }) => `| ${label} | ${count} |`),
    "",
    `_Updated ${new Date(updatedAt).toISOString()}_`,
  ].join("\n");
}

function escapeMarkdown(value: string) {
  return value.replace(/([\\`*_[\]{}()#+.!|])/g, "\\$1");
}
