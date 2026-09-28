import {
  createCanvas,
  GlobalFonts,
  loadImage,
  type Image,
  type SKRSContext2D,
} from "@napi-rs/canvas";

export const cardSize = 720;
const maxArtworkBytes = 15_000_000;

// Inter for Latin like the media page, then whatever the host has for other
// scripts and emoji: the Noto families in the Docker image, the system ones on
// macOS. Skia falls back glyph by glyph along this list.
const fallbackFamilies = [
  "Noto Sans",
  "Noto Sans CJK JP",
  "Noto Sans CJK KR",
  "Noto Sans CJK SC",
  "Noto Sans CJK TC",
  "Noto Sans Arabic",
  "Noto Sans Hebrew",
  "Noto Sans Thai",
  "Noto Sans Devanagari",
  "Hiragino Sans",
  "PingFang SC",
  "Apple SD Gothic Neo",
  "WenQuanYi Zen Hei",
  "DejaVu Sans",
  "Noto Color Emoji",
  "Apple Color Emoji",
];

let fontStack: string | undefined;
function fonts() {
  if (fontStack) return fontStack;
  for (const weight of [600, 700])
    try {
      GlobalFonts.registerFromPath(
        Bun.resolveSync(
          `@fontsource/inter/files/inter-latin-${weight}-normal.woff2`,
          import.meta.dir,
        ),
        "Inter",
      );
    } catch {}
  const available = fallbackFamilies.filter((family) =>
    GlobalFonts.has(family),
  );
  fontStack = ["Inter", ...available]
    .map((family) => `"${family}"`)
    .concat("sans-serif")
    .join(", ");
  return fontStack;
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

function ellipsize(context: SKRSContext2D, text: string, width: number) {
  if (context.measureText(text).width <= width) return text;
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("").trimEnd()}…`;
    if (context.measureText(candidate).width <= width) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join("").trimEnd()}…`;
}

export type CardProgress = { position: number; duration?: number };

/**
 * The static video card: the media page's default layout (full-bleed artwork,
 * title, artist and requester, and the timeline) drawn with Skia instead of a
 * browser. The artwork and text are drawn once per track; each frame only
 * redraws the timeline, and only when it visibly changed.
 */
export class VideoCard {
  private canvas = createCanvas(cardSize, cardSize);
  private context = this.canvas.getContext("2d");
  private base = createCanvas(cardSize, cardSize);
  private title = "Ready for music";
  private artist = "Waiting for the next track";
  private artwork: Image | undefined;
  private artworkRequest = 0;
  private frameKey = "";
  private frame: Buffer | undefined;

  constructor(
    private progress: () => CardProgress | undefined,
    private onError: (message: string) => void = () => {},
  ) {
    this.drawBase();
  }

  setTrack(title: string, artist: string, artworkUrl?: string) {
    this.title = title || "Unknown title";
    this.artist = artist;
    this.artwork = undefined;
    const request = ++this.artworkRequest;
    this.drawBase();
    if (artworkUrl)
      void this.loadArtwork(artworkUrl)
        .then((image) => {
          if (request !== this.artworkRequest) return;
          this.artwork = image;
          this.drawBase();
        })
        .catch((error) =>
          this.onError(error instanceof Error ? error.message : String(error)),
        );
  }

  reset() {
    this.setTrack("Ready for music", "Waiting for the next track");
  }

  /** The current frame as raw RGBA, redrawn only when it changed. */
  rgba() {
    const progress = this.progress();
    const position = progress?.position ?? 0;
    const duration = progress?.duration ?? 0;
    const amount =
      duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
    const key = `${formatTime(position)}|${formatTime(duration)}|${Math.round(amount * 528)}`;
    if (this.frame && key === this.frameKey) return this.frame;
    this.frameKey = key;
    const context = this.context;
    context.drawImage(this.base, 0, 0);
    this.drawTimeline(context, position, duration, amount);
    this.frame = Buffer.from(
      context.getImageData(0, 0, cardSize, cardSize).data.buffer,
    );
    return this.frame;
  }

  png() {
    this.frame = undefined;
    this.rgba();
    return this.canvas.toBuffer("image/png");
  }

  private async loadArtwork(url: string) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Artwork HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > maxArtworkBytes) throw new Error("Artwork is too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxArtworkBytes) throw new Error("Artwork is too large");
    return loadImage(bytes);
  }

  private drawBase() {
    this.frame = undefined;
    const context = this.base.getContext("2d");
    const size = cardSize;
    context.fillStyle = "#0a0a0c";
    context.fillRect(0, 0, size, size);
    const artwork = this.artwork;
    if (artwork) {
      // background-size: cover, centred.
      const scale = Math.max(size / artwork.width, size / artwork.height);
      const width = artwork.width * scale;
      const height = artwork.height * scale;
      context.drawImage(
        artwork,
        (size - width) / 2,
        (size - height) / 2,
        width,
        height,
      );
    } else {
      // #stage::before under an empty, faintly lit cover.
      const angle = (115 * Math.PI) / 180;
      const dx = (Math.sin(angle) * size) / 2;
      const dy = (-Math.cos(angle) * size) / 2;
      const wash = context.createLinearGradient(
        size / 2 - dx,
        size / 2 - dy,
        size / 2 + dx,
        size / 2 + dy,
      );
      wash.addColorStop(0, "rgba(0, 0, 0, 0.22)");
      wash.addColorStop(0.48, "rgba(5, 5, 8, 0.5)");
      wash.addColorStop(1, "rgba(0, 0, 0, 0.66)");
      context.fillStyle = wash;
      context.fillRect(0, 0, size, size);
      context.fillStyle = "rgba(255, 255, 255, 0.06)";
      context.fillRect(0, 0, size, size);
    }
    // #stage::after, which keeps the text legible over bright artwork.
    const shade = context.createLinearGradient(0, 0, 0, size);
    shade.addColorStop(0, "rgba(0, 0, 0, 0)");
    shade.addColorStop(0.38, "rgba(0, 0, 0, 0)");
    shade.addColorStop(0.55, "rgba(0, 0, 0, 0.14)");
    shade.addColorStop(1, "rgba(0, 0, 0, 0.82)");
    context.fillStyle = shade;
    context.fillRect(0, 0, size, size);

    const left = size * 0.07;
    const width = size * 0.66;
    const top = size * 0.73;
    context.textBaseline = "top";
    context.textAlign = "left";
    context.fillStyle = "#ffffff";
    context.font = `700 34px ${fonts()}`;
    context.fillText(ellipsize(context, this.title, width), left, top + 2);
    context.fillStyle = "rgba(255, 255, 255, 0.76)";
    context.font = `600 20px ${fonts()}`;
    context.fillText(ellipsize(context, this.artist, width), left, top + 45);
  }

  private drawTimeline(
    context: SKRSContext2D,
    position: number,
    duration: number,
    amount: number,
  ) {
    const size = cardSize;
    const centre = size - 82 - 9;
    const barLeft = 48 + 36 + 12;
    const barRight = size - 48 - 36 - 12;
    const barWidth = barRight - barLeft;
    context.fillStyle = "rgba(255, 255, 255, 0.76)";
    context.font = `600 14px ${fonts()}`;
    context.textBaseline = "middle";
    context.textAlign = "left";
    context.fillText(formatTime(position), 48, centre);
    context.textAlign = "right";
    context.fillText(formatTime(duration), size - 48, centre);
    context.fillStyle = "rgba(255, 255, 255, 0.16)";
    context.beginPath();
    context.roundRect(barLeft, centre - 1.5, barWidth, 3, 1.5);
    context.fill();
    if (amount > 0) {
      context.fillStyle = "rgba(255, 255, 255, 0.88)";
      context.beginPath();
      context.roundRect(barLeft, centre - 1.5, barWidth * amount, 3, 1.5);
      context.fill();
    }
  }
}
