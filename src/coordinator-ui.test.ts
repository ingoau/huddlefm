import { expect, test } from "bun:test";
import { icon, useStandardEmoji, withEmoji } from "./coordinator-ui.ts";

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
