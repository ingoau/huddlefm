// The bar along the bottom of a playing video on the screen share, drawn
// straight into the decoder's yuv420p frames so turning it on or off, or
// seeking, never restarts ffmpeg the way burned-in captions do.

type Size = { width: number; height: number };

// Limited-range luma, as ffmpeg's scale leaves the frames.
const white = 235;
const neutral = 128;
/** How much of the picture shows through the unplayed part of the bar. */
const trackShow = 0.5;
/** How much white is laid over the unplayed part. */
const trackWhite = 0.22;
/** The darkest the shade above the bar gets, for a bar over a bright picture. */
const shadeDepth = 0.45;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** Where the bar goes in a frame: its rows, and the shade above it. */
export function barLayout({ height }: Size) {
  // Rows come in pairs, so the bar starts and ends on a chroma row.
  const bar = even(height / 120);
  const shade = even(height / 30);
  return { top: height - bar, bar, shadeTop: height - bar - shade, shade };
}

/**
 * Draws the bar into `frame`, a yuv420p frame of `size`, `amount` of the way
 * along: white where the video has played, the picture dimmed and lightened
 * where it has not, under a shade that keeps it apart from a bright picture.
 */
export function drawProgressBar(frame: Buffer, size: Size, amount: number) {
  const { width, height } = size;
  const { top, shadeTop, shade } = barLayout(size);
  const played = Math.round(width * Math.min(1, Math.max(0, amount)));
  const chromaWidth = width / 2;
  const uPlane = width * height;
  const vPlane = uPlane + chromaWidth * (height / 2);
  for (let y = shadeTop; y < height; y++) {
    const row = y * width;
    if (y < top) {
      // Darkest next to the bar.
      const keep = 1 - shadeDepth * ((y - shadeTop + 1) / shade) ** 2;
      for (let x = 0; x < width; x++)
        frame[row + x] = Math.round(frame[row + x]! * keep);
      continue;
    }
    frame.fill(white, row, row + played);
    for (let x = played; x < width; x++)
      frame[row + x] = Math.round(
        frame[row + x]! * trackShow + white * trackWhite,
      );
  }
  // Chroma is a pixel for every two by two; the shade leaves the colours be,
  // and the bar takes them out.
  const chromaPlayed = Math.round(played / 2);
  for (let y = top / 2; y < height / 2; y++) {
    const row = y * chromaWidth;
    for (const plane of [uPlane, vPlane]) {
      const start = plane + row;
      frame.fill(neutral, start, start + chromaPlayed);
      for (let x = start + chromaPlayed; x < start + chromaWidth; x++)
        frame[x] = Math.round(neutral + (frame[x]! - neutral) * trackShow);
    }
  }
}

/**
 * Lays the bar over a video's frames. A frame is copied before it is drawn
 * on, since the decoder's frame stays up until the next one, and the same
 * frame with the bar where it was comes back as the same buffer, which the
 * feed then knows not to send again, as while paused. The copies take turns
 * in two pieces of memory, the one before last being long sent, but each is
 * a Buffer of its own, so a new picture is never mistaken for the last.
 */
export class ProgressBarOverlay {
  private source: Buffer | undefined;
  private played = -1;
  private drawn: Buffer | undefined;
  private memory: ArrayBuffer[] = [];
  private turn = 0;

  constructor(private size: Size) {}

  over(frame: Buffer, amount: number) {
    const played = Math.round(
      this.size.width * Math.min(1, Math.max(0, amount)),
    );
    if (frame === this.source && played === this.played && this.drawn)
      return this.drawn;
    this.turn = 1 - this.turn;
    let memory = this.memory[this.turn];
    if (memory?.byteLength !== frame.length)
      memory = this.memory[this.turn] = new ArrayBuffer(frame.length);
    const drawn = Buffer.from(memory);
    frame.copy(drawn);
    drawProgressBar(drawn, this.size, played / this.size.width);
    this.source = frame;
    this.played = played;
    this.drawn = drawn;
    return drawn;
  }

  clear() {
    this.source = undefined;
    this.drawn = undefined;
    this.played = -1;
    this.memory = [];
  }
}
