// What the video tile is, shared by the thread that draws and encodes it and
// the one that sends it, which must not load Skia just for these.

/** The card is drawn and sent at this size, about half the cost of 720. */
export const cardSize = 540;
/**
 * Smooth enough for the lyrics and the layout swaps, and a fifth cheaper than
 * the page's 30.
 */
export const videoFps = 24;
/** The Chime JS SDK's default ceiling for a camera. */
export const videoMaxKbps = 1_400;

/** One video stream as Chime is told about it and the encoder makes it. */
export type VideoFormat = {
  width: number;
  height: number;
  fps: number;
  maxKbps: number;
  /** The H.264 profile-level-id offered in the SDP: constrained baseline. */
  profileLevelId: string;
};

/** The camera tile: the square card. */
export const cameraFormat: VideoFormat = {
  width: cardSize,
  height: cardSize,
  fps: videoFps,
  maxKbps: videoMaxKbps,
  profileLevelId: "42e01f",
};

/** The size and rate a screen share is sent at, from the host's limits. */
export type ShareLimits = { maxHeight: number; maxFps: number };

export const defaultShareLimits: ShareLimits = { maxHeight: 720, maxFps: 30 };

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/**
 * The screen share: 16:9 at the configured height. The bitrate follows the
 * pixel rate, about what a 720p30 share needs at 2.5 Mbps, and stays within
 * what Chime takes for content. Level 3.1 covers up to 720p30; anything
 * bigger is offered as level 4.0, which covers 1080p30.
 */
export function shareFormat(limits: ShareLimits = defaultShareLimits) {
  const height = even(Math.min(1_080, Math.max(240, limits.maxHeight)));
  const width = even((height * 16) / 9);
  const fps = Math.min(30, Math.max(5, Math.round(limits.maxFps)));
  const maxKbps = Math.min(
    4_000,
    Math.max(600, Math.round((width * height * fps * 0.09) / 1_000)),
  );
  const level31 = width * height <= 1280 * 720 && fps <= 30;
  return {
    width,
    height,
    fps,
    maxKbps,
    profileLevelId: level31 ? "42e01f" : "42e028",
  } satisfies VideoFormat;
}
