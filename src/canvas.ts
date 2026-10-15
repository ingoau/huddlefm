import { elapsed } from "./coordinator-ui.ts";
import type { CanvasStats } from "./store.ts";

export const canvasSections = [
  "summary",
  "active-sessions",
  "top-artists",
  "top-tracks",
  "top-channels",
  "controls",
  "integrations",
] as const;

export type CanvasSection = (typeof canvasSections)[number];

/** A Huddle HuddleFM is in right now, as the canvas lists it. */
export type ActiveCanvasSession = {
  channelId: string;
  listeners: number;
  state: string;
  track?: { title: string; artist: string };
};

const sectionAliases = new Map<string, CanvasSection>([
  ["top-songs", "top-tracks"],
  ["active", "active-sessions"],
  ["now-playing", "active-sessions"],
]);

/**
 * Reads a comma-separated list of canvas sections, in display order. Names are
 * case-insensitive and treat spaces, underscores, and hyphens alike, so
 * `top songs`, `Top_Tracks`, and `top-tracks` all work. Unset shows everything.
 */
export function parseCanvasSections(value = ""): CanvasSection[] {
  const names = value
    .split(",")
    .map((name) =>
      name
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, "-"),
    )
    .filter(Boolean);
  if (!names.length) return [...canvasSections];
  const sections = names.map((name) => {
    const section =
      sectionAliases.get(name) ??
      canvasSections.find((candidate) => candidate === name);
    if (!section)
      throw new Error(
        `Unknown CANVAS_SECTIONS entry "${name}"; expected ${canvasSections.join(", ")}`,
      );
    return section;
  });
  return [...new Set(sections)];
}

export function canvasMarkdown(
  stats: CanvasStats,
  controls: { label: string; count: number }[],
  {
    active = [],
    integrations = [],
    sections = canvasSections,
    updatedAt = Date.now(),
  }: {
    active?: ActiveCanvasSession[];
    integrations?: { id: string; name: string }[];
    sections?: readonly CanvasSection[];
    updatedAt?: number;
  } = {},
) {
  const requested = stats.tracks.count - stats.tracks.autoplay;
  const average = stats.sessions.count
    ? stats.sessions.listened / stats.sessions.count
    : 0;
  const ranking = <T>(
    entries: T[],
    line: (entry: T, index: number) => string,
  ) => entries.map(line).join("\n") || "Nothing yet.";
  const plural = (count: number, noun: string) =>
    `${count} ${count === 1 ? noun : `${noun}s`}`;
  const render: Record<CanvasSection, () => string[]> = {
    summary: () => [
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
    ],
    "active-sessions": () => [
      "## Active sessions",
      active
        .map(({ channelId, listeners, state, track }) => {
          const playing = track
            ? `${state === "paused" ? "Paused" : "Playing"} **${escapeMarkdown(track.title)}** — ${escapeMarkdown(track.artist)}`
            : "Nothing playing";
          return `- ![](#${channelId}) · ${plural(listeners, "listener")} · ${playing}`;
        })
        .join("\n") || "No Huddles right now.",
    ],
    "top-artists": () => [
      "## Top artists",
      ranking(
        stats.topArtists,
        ({ artist, count }, index) =>
          `${index + 1}. **${escapeMarkdown(artist)}** — ${plural(count, "play")}`,
      ),
    ],
    "top-tracks": () => [
      "## Top tracks",
      ranking(
        stats.topTracks,
        ({ title, artist, count }, index) =>
          `${index + 1}. **${escapeMarkdown(title)}** — ${escapeMarkdown(artist)} · ${plural(count, "play")}`,
      ),
    ],
    "top-channels": () => [
      "## Most active channels",
      ranking(
        stats.topChannels,
        ({ channelId, count }, index) =>
          `${index + 1}. ![](#${channelId}) — ${plural(count, "song")}`,
      ),
    ],
    controls: () => [
      "## Controls used",
      "| Control | Uses |",
      "| --- | ---: |",
      ...controls.map(({ label, count }) => `| ${label} | ${count} |`),
    ],
    // Plain text rather than user mentions, so listing them never pings anyone.
    integrations: () =>
      integrations.length
        ? [
            "## Integrations",
            ...integrations.map(({ id, name }) =>
              name === id
                ? `- \`${id}\``
                : `- **${escapeMarkdown(name)}** · \`${id}\``,
            ),
          ]
        : [],
  };
  return [
    ...sections
      .map((section) => render[section]())
      .filter((lines) => lines.length)
      .flatMap((lines) => [...lines, ""]),
    `_Updated ${new Date(updatedAt).toISOString()}_`,
  ].join("\n");
}

function escapeMarkdown(value: string) {
  return value.replace(/([\\`*_[\]{}()#+.!|])/g, "\\$1");
}
