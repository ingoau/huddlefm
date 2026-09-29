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
