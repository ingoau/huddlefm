import {
  createCanvas,
  loadImage,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from "@napi-rs/canvas";
import type { Lyric } from "@braccato/core";
import { fonts } from "./fonts.ts";
import { LyricsView } from "./lyrics-view.ts";
import {
  clamp,
  cubicBezier,
  defaultMotion,
  ease,
  lerp,
  Tween,
  type CardMotion,
} from "./motion.ts";

export const cardSize = 720;
const maxArtworkBytes = 15_000_000;

// The media page's geometry at its 720px viewport (see media-page.css).
const unit = cardSize / 100;
const coverSmall = { x: 6 * unit, y: 6.7 * unit, scale: 0.15 };
const coverRadius = 106;
const headerDefault = { x: 7 * unit, y: 73 * unit };
const headerLyrics = { x: 26 * unit, y: 9.5 * unit };
const headerWidth = 66 * unit;
const frame = {
  x: 7 * unit,
  y: 29 * unit,
  width: Math.round(86 * unit),
  height: Math.round(cardSize - 29 * unit - 34),
};
/** The blurred backdrop is drawn this much smaller, then scaled up. */
const backdropScale = 0.25;

export type DisplayMode = "default" | "lyrics" | "off";

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

export type VideoCardOptions = {
  motion?: CardMotion;
  /** Milliseconds, for animation; a fixed clock lets a test step frames. */
  now?: () => number;
};

/**
 * The video card: the media page's layouts drawn with Skia instead of a
 * browser. The default layout is full-bleed artwork with the title and the
 * timeline; the lyrics layout shrinks the artwork into the corner over its
 * blurred backdrop and scrolls synced lyrics beneath. Swapping layouts or
 * tracks animates like the page does. A frame is only redrawn while something
 * moves; otherwise the last one is handed out again.
 */
export class VideoCard {
  private canvas = createCanvas(cardSize, cardSize);
  private context = this.canvas.getContext("2d");
  private stage = createCanvas(cardSize, cardSize);
  private lyricsCanvas = createCanvas(frame.width, frame.height);
  private title = "Ready for music";
  private artist = "Waiting for the next track";
  private artwork: Image | undefined;
  private backdrop: Canvas | undefined;
  private artworkRequest = 0;
  private frameKey = "";
  private frame: Buffer | undefined;
  private stageDirty = true;
  private motion: CardMotion;
  private now: () => number;

  private preferredMode: DisplayMode = "default";
  private lyricsAvailable: boolean | undefined;
  private view: LyricsView | undefined;
  private lastFrameAt: number | undefined;
  private clock = { position: -1, changedAt: -Infinity, shown: 0 };

  private layout = new Tween(0);
  private rounding = new Tween(0);
  private shade = new Tween(1);
  private lyricsIn = new Tween(0);
  private lyricsShift = new Tween(18);
  private viewIn = new Tween(0);
  private changing = new Tween(0);
  private backdropOut = new Tween(0);
  private artworkIn = new Tween(1);

  constructor(
    private progress: () => CardProgress | undefined,
    private onError: (message: string) => void = () => {},
    options: VideoCardOptions = {},
  ) {
    this.motion = options.motion ?? defaultMotion;
    this.now = options.now ?? (() => performance.now());
  }

  setTrack(title: string, artist: string, artworkUrl?: string) {
    this.title = title || "Unknown title";
    this.artist = artist;
    this.artwork = undefined;
    this.backdrop = undefined;
    this.clearLyrics();
    this.endChange();
    const request = ++this.artworkRequest;
    this.stageDirty = true;
    if (artworkUrl)
      void this.loadArtwork(artworkUrl)
        .then((image) => {
          if (request !== this.artworkRequest) return;
          this.showArtwork(image);
        })
        .catch((error) =>
          this.onError(error instanceof Error ? error.message : String(error)),
        );
  }

  /** Shows artwork that is already decoded, skipping the fetch. */
  showArtwork(image: Image) {
    this.artwork = image;
    this.backdrop = this.blurredBackdrop(image);
    const now = this.seconds();
    this.artworkIn.snap(0);
    this.artworkIn.set(1, now, this.motion.fade * 1.5);
    this.stageDirty = true;
  }

  reset() {
    this.artworkRequest++;
    this.title = "Ready for music";
    this.artist = "Waiting for the next track";
    this.artwork = undefined;
    this.backdrop = undefined;
    this.clearLyrics();
    this.endChange();
    this.stageDirty = true;
  }

  /** Fades the card out ahead of the next setTrack(), like the page's swap. */
  beginChange() {
    const now = this.seconds();
    this.changing.set(1, now, this.motion.fade);
    this.backdropOut.set(1, now, this.motion.fade * 2.6);
  }

  setDisplayMode(mode: DisplayMode) {
    this.preferredMode = mode;
    this.applyMode();
  }

  setLyrics(lines: Lyric[]) {
    const view = new LyricsView(lines, frame.width, this.motion);
    this.view = view.empty || !view.synced ? undefined : view;
    this.lyricsAvailable = Boolean(this.view);
    this.lastFrameAt = undefined;
    const now = this.seconds();
    this.viewIn.snap(0);
    this.viewIn.set(1, now, this.motion.fade * 1.5);
    this.applyMode();
  }

  setLyricsUnavailable() {
    this.view = undefined;
    this.lyricsAvailable = false;
    this.applyMode();
  }

  /** The current frame as raw RGBA, redrawn only when it changed. */
  rgba() {
    const now = this.seconds();
    const progress = this.progress();
    const position = progress?.position ?? 0;
    const duration = progress?.duration ?? 0;
    const amount =
      duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
    const songTime = this.songTime(position, now);
    const delta = clamp(
      this.lastFrameAt === undefined ? 0 : now - this.lastFrameAt,
      0,
      0.1,
    );
    this.lastFrameAt = now;
    const lyricsAlpha =
      this.lyricsIn.value(now) * (1 - this.changing.value(now));
    const lyricsMoving =
      Boolean(this.view) &&
      lyricsAlpha > 0 &&
      (this.clockRunning(now) || !this.view!.settled);
    if (this.view && lyricsAlpha > 0)
      this.view.update(songTime, delta, frame.height);
    const stageMoving = this.stageMoving(now);
    const key = `${formatTime(position)}|${formatTime(duration)}|${Math.round(amount * 528)}`;
    if (
      this.frame &&
      key === this.frameKey &&
      !lyricsMoving &&
      !stageMoving &&
      !this.stageDirty
    )
      return this.frame;
    this.frameKey = key;
    if (stageMoving || this.stageDirty) {
      this.drawStage(now);
      this.stageDirty = stageMoving;
    }
    const context = this.context;
    context.drawImage(this.stage, 0, 0);
    if (lyricsAlpha > 0.001 && this.view) this.drawLyrics(now, lyricsAlpha);
    this.drawTimeline(context, position, duration, amount);
    // A copy of the pixels, RGBA and premultiplied, which is the same thing
    // for an opaque card. Five times quicker than getImageData().
    this.frame = this.canvas.data();
    return this.frame;
  }

  png() {
    this.frame = undefined;
    this.stageDirty = true;
    this.rgba();
    return this.canvas.toBuffer("image/png");
  }

  private clearLyrics() {
    this.view = undefined;
    this.lyricsAvailable = undefined;
    this.applyMode();
  }

  private endChange() {
    const now = this.seconds();
    this.changing.set(0, now, this.motion.fade);
    this.backdropOut.set(0, now, this.motion.fade * 2.6);
  }

  private applyMode() {
    const lyrics =
      this.preferredMode === "lyrics" && this.lyricsAvailable !== false;
    const now = this.seconds();
    const { duration, easing } = this.motion.layout;
    const curve = cubicBezier(...easing);
    const target = lyrics ? 1 : 0;
    if (this.layout.target === target) return;
    this.layout.set(target, now, duration, curve);
    this.rounding.set(target, now, duration, ease);
    this.shade.set(1 - target, now, duration / 2, ease);
    this.lyricsShift.set(lyrics ? 0 : 18, now, duration, curve);
    // Like the page: the lyrics wait for the artwork to get going, but leave
    // at once.
    this.lyricsIn.set(
      target,
      now,
      this.motion.fade * 1.4,
      ease,
      lyrics ? duration * 0.26 : 0,
    );
    this.stageDirty = true;
  }

  private stageMoving(now: number) {
    return [
      this.layout,
      this.rounding,
      this.shade,
      this.changing,
      this.backdropOut,
      this.artworkIn,
    ].some((tween) => !tween.settled(now));
  }

  /** The card's clock, in seconds like the motion presets. */
  private seconds() {
    return this.now() / 1_000;
  }

  private clockRunning(now: number) {
    return now - this.clock.changedAt < 0.15;
  }

  /**
   * The engine's position moves in 20 ms steps; between them the card runs on
   * its own clock and drifts back toward the engine, so the lyrics glide.
   */
  private songTime(position: number, now: number) {
    const clock = this.clock;
    const previous = this.lastFrameAt ?? now;
    if (position !== clock.position) {
      clock.position = position;
      clock.changedAt = now;
    }
    if (!this.clockRunning(now)) clock.shown = position;
    else {
      clock.shown += now - previous;
      const error = position - clock.shown;
      if (Math.abs(error) > 0.3) clock.shown = position;
      else clock.shown += error * 0.15;
    }
    return clock.shown;
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

  /** #artwork: the cover blurred, darkened and saturated behind everything. */
  private blurredBackdrop(image: Image) {
    // inset: -18%, drawn small so the 76px blur is cheap.
    const size = Math.round(cardSize * 1.36 * backdropScale);
    const canvas = createCanvas(size, size);
    const context = canvas.getContext("2d");
    const scale = Math.max(size / image.width, size / image.height);
    context.filter = `blur(${76 * backdropScale}px) brightness(0.54) saturate(1.55)`;
    context.drawImage(
      image,
      (size - image.width * scale) / 2,
      (size - image.height * scale) / 2,
      image.width * scale,
      image.height * scale,
    );
    context.filter = "none";
    return canvas;
  }

  /** Everything but the lyrics and the timeline. */
  private drawStage(now: number) {
    const context = this.stage.getContext("2d");
    const size = cardSize;
    const layout = this.layout.value(now);
    const changing = this.changing.value(now);
    const content = 1 - changing;
    context.fillStyle = "#0a0a0c";
    context.fillRect(0, 0, size, size);

    const backdrop = this.backdrop;
    if (backdrop) {
      const out = this.backdropOut.value(now);
      const scale = lerp(1.1, 1.16, out);
      const drawn = size * 1.36 * scale;
      context.globalAlpha = 0.86 * (1 - out) * this.artworkIn.value(now);
      context.drawImage(
        backdrop,
        (size - drawn) / 2,
        (size - drawn) / 2,
        drawn,
        drawn,
      );
      context.globalAlpha = 1;
    }
    // #stage::before
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

    this.drawCover(context, layout, content, now);

    // #stage::after, which keeps the text legible over bright artwork.
    const shade = this.shade.value(now);
    if (shade > 0.001) {
      const gradient = context.createLinearGradient(0, 0, 0, size);
      gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
      gradient.addColorStop(0.38, "rgba(0, 0, 0, 0)");
      gradient.addColorStop(0.55, "rgba(0, 0, 0, 0.14)");
      gradient.addColorStop(1, "rgba(0, 0, 0, 0.82)");
      context.globalAlpha = shade;
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
      context.globalAlpha = 1;
    }

    const left = lerp(headerDefault.x, headerLyrics.x, layout);
    const top = lerp(headerDefault.y, headerLyrics.y, layout);
    context.globalAlpha = content;
    context.textBaseline = "top";
    context.textAlign = "left";
    context.fillStyle = "#ffffff";
    context.font = `700 34px ${fonts()}`;
    context.fillText(
      ellipsize(context, this.title, headerWidth),
      left,
      top + 2,
    );
    context.fillStyle = `rgba(255, 255, 255, ${lerp(0.76, 0.58, clamp(layout)).toFixed(3)})`;
    context.font = `600 20px ${fonts()}`;
    context.fillText(
      ellipsize(context, this.artist, headerWidth),
      left,
      top + 45,
    );
    context.globalAlpha = 1;
  }

  /** #cover: full bleed by default, a rounded thumbnail in the lyrics layout. */
  private drawCover(
    context: SKRSContext2D,
    layout: number,
    content: number,
    now: number,
  ) {
    if (content <= 0.001) return;
    const size = cardSize;
    const scale = lerp(1, coverSmall.scale, layout);
    const x = lerp(0, coverSmall.x, layout);
    const y = lerp(0, coverSmall.y, layout);
    const side = size * scale;
    const radius = coverRadius * this.rounding.value(now) * scale;
    context.save();
    context.globalAlpha = content;
    if (layout > 0.001) {
      // box-shadow: 0 40px 120px rgb(0 0 0 / 0.32), scaled with the cover.
      context.shadowColor = "rgba(0, 0, 0, 0.32)";
      context.shadowBlur = 120 * scale;
      context.shadowOffsetY = 40 * scale;
    }
    context.beginPath();
    context.roundRect(x, y, side, side, Math.max(0, radius));
    context.fillStyle = this.artwork ? "#0a0a0c" : "rgba(255, 255, 255, 0.06)";
    context.fill();
    context.shadowColor = "transparent";
    const artwork = this.artwork;
    if (artwork) {
      context.clip();
      context.globalAlpha = content * this.artworkIn.value(now);
      // background-size: cover, centred.
      const fit = Math.max(side / artwork.width, side / artwork.height);
      const width = artwork.width * fit;
      const height = artwork.height * fit;
      context.drawImage(
        artwork,
        x + (side - width) / 2,
        y + (side - height) / 2,
        width,
        height,
      );
    }
    context.restore();
  }

  private drawLyrics(now: number, alpha: number) {
    const view = this.view!;
    const context = this.lyricsCanvas.getContext("2d");
    context.clearRect(0, 0, frame.width, frame.height);
    view.draw(context, frame.height);
    // mask-image: fade out toward the top and bottom edges. Only the two
    // bands need touching; the middle is fully opaque.
    const topBand = Math.ceil(frame.height * 0.12);
    const bottomBand = Math.floor(frame.height * 0.78);
    const top = context.createLinearGradient(0, 0, 0, topBand);
    top.addColorStop(0, "rgba(0, 0, 0, 0)");
    top.addColorStop(1, "rgba(0, 0, 0, 1)");
    const bottom = context.createLinearGradient(0, bottomBand, 0, frame.height);
    bottom.addColorStop(0, "rgba(0, 0, 0, 1)");
    bottom.addColorStop(1, "rgba(0, 0, 0, 0)");
    // destination-in composites the whole canvas, so each band is clipped.
    for (const [fill, y, height] of [
      [top, 0, topBand],
      [bottom, bottomBand, frame.height - bottomBand],
    ] as const) {
      context.save();
      context.beginPath();
      context.rect(0, y, frame.width, height);
      context.clip();
      context.globalCompositeOperation = "destination-in";
      context.fillStyle = fill;
      context.fillRect(0, y, frame.width, height);
      context.restore();
    }
    this.context.globalAlpha = alpha * this.viewIn.value(now);
    this.context.drawImage(
      this.lyricsCanvas,
      frame.x,
      frame.y + this.lyricsShift.value(now),
    );
    this.context.globalAlpha = 1;
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
