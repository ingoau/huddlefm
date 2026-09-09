import { expect, test } from "bun:test";
import { readFileSync } from "fs";

test("media-page CSS keeps long lyric highlight overlays from collapsing", () => {
  const css = readFileSync("src/media-page.css", "utf8");

  // Long unbroken tokens need a real containing box before the karaoke
  // highlight clone resolves width: 100%, or it stacks into a ~100px column.
  expect(css).toMatch(
    /\.blyrics-word-group-long\s+\.blyrics--word\s*\{[^}]*display:\s*inline-block;[^}]*max-width:\s*100%;/s,
  );
  expect(css).toMatch(
    /\.blyrics-word-group-long\s+\.blyrics-word-highlight\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/s,
  );

  // Line-synced mode already fades word color; leaving the highlight visible
  // doubles the glyph layer once the swipe animation finishes opaque.
  expect(css).toMatch(
    /\.blyrics-container\[data-sync="synced"\]\s+\.blyrics-word-highlight\s*\{[^}]*display:\s*none\s*!important;/s,
  );
});
