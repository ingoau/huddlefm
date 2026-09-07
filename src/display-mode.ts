import type { DisplayMode } from "./store.ts";

/** Resolve the visual display mode, falling back to album art when lyrics aren't available. */
export function effectiveDisplayMode(
  preferred: DisplayMode,
  lyricsAvailable: boolean | undefined,
): DisplayMode {
  if (preferred === "lyrics" && lyricsAvailable === false) return "default";
  return preferred;
}
