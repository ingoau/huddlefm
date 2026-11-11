import { expect, test } from "bun:test";
import {
  icon,
  trackSource,
  useStandardEmoji,
  withEmoji,
} from "./coordinator-ui.ts";

test("shows custom emoji the workspace lacks as standard ones", () => {
  try {
    useStandardEmoji(["ms-play"]);
    expect(withEmoji(":ms-play: :ms-pause: :smile:")).toBe(
      ":arrow_forward: :ms-pause: :smile:",
    );
    expect(icon(":ms-play:").text).toBe(":arrow_forward:");
  } finally {
    useStandardEmoji([]);
  }
});

test("names the platform a track plays from", () => {
  const track = (canonicalUrl: string, sourceId = "x") => ({
    canonicalUrl,
    sourceId,
  });
  expect(trackSource(track("https://www.youtube.com/watch?v=a"))).toBe(
    "YouTube",
  );
  expect(trackSource(track("https://music.youtube.com/watch?v=a"))).toBe(
    "YouTube Music",
  );
  expect(trackSource(track("https://soundcloud.com/a/b"))).toBe("SoundCloud");
  expect(trackSource(track("jellyfin://s/i", "jellyfin:s:i"))).toBe("Jellyfin");
  expect(trackSource(track("https://example.com/song.mp3"))).toBe(
    "example.com",
  );
  expect(
    trackSource({
      ...track("https://www.youtube.com/watch?v=a"),
      playedFrom: { source: "SoundCloud" },
    }),
  ).toBe("SoundCloud");
});
