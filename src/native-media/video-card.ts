import {
  createCanvas,
  loadImage,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from "@napi-rs/canvas";
import type { Lyric } from "@braccato/core";
import { fonts } from "./fonts.ts";
import { LyricsView, type LyricsCredits } from "./lyrics-view.ts";
import { clamp, ease, easeOut, lerp, motion, Tween } from "./motion.ts";

/** The card is laid out at the media page's 720px viewport... */
const layoutSize = 720;
/** ...and drawn and sent at this size, which costs about half as much. */
export const cardSize = 540;
const ratio = cardSize / layoutSize;
const maxArtworkBytes = 15_000_000;

// The media page's geometry at its 720px viewport (see media-page.css).
const unit = layoutSize / 100;
const coverSmall = { x: 6 * unit, y: 6.7 * unit, scale: 0.15 };
const coverRadius = 106;
const headerDefault = { x: 7 * unit, y: 73 * unit };
// The page puts the header at 9.5vh, which sits the title and artist 3.4px
// above the middle of the artwork beside them; 10vh centres them.
const headerLyrics = { x: 26 * unit, y: 10 * unit };
const headerWidth = 66 * unit;
const frame = {
  x: 7 * unit,
  y: 29 * unit,
  width: Math.round(86 * unit),
  height: Math.round(layoutSize - 29 * unit - 34),
};
// The backdrop: the artwork three times over, turning and drifting, drawn
// tiny over half as much again as the card and blurred, then scaled up.
const flowSize = 128;
const flowReach = 1.5;
const flowBlur = (76 * flowSize) / (layoutSize * flowReach);
/** Seconds for the backdrop to wind down on pause, or back up on resume. */
const flowEase = 0.35;
const backdropFps = 12;
/** How far down the lyrics layout's cover, shadow and header reach. */
const foregroundBand = 190;
const flowLayers = [
  { size: 1.5, spin: 0.11, orbit: 0.08, speed: 0.21, phase: 0, alpha: 1 },
  { size: 1.05, spin: -0.17, orbit: 0.14, speed: 0.29, phase: 2.1, alpha: 0.8 },
  { size: 0.75, spin: 0.23, orbit: 0.18, speed: 0.37, phase: 4.2, alpha: 0.65 },
];

// A track change, in seconds. The backdrop crossfades while the cover, the
// title, the artist and the lyrics each leave and arrive on their own.
const leave = 0.2;
const headerEnter = 0.38;
const artistDelay = 0.05;
const coverEnter = 0.42;
const backdropFade = 0.7;
const lyricsEnter = 0.3;
/** How long a cover waits for its artwork before showing the placeholder. */
const artworkPatience = 1.5;

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

const progressOf = (now: number, since: number | undefined, span: number) =>
  since === undefined ? 0 : clamp((now - since) / span);

export type CardProgress = { position: number; duration?: number };

export type VideoCardOptions = {
  /** Milliseconds, for animation; a fixed clock lets a test step frames. */
  now?: () => number;
  /** Seconds the lyrics trail the audio position, to match what is heard. */
  lyricsOffset?: number;
};

type Track = {
  title: string;
  artist: string;
  /** The artwork cropped to a square at the card's size. */
  cover?: Canvas;
  backdrop?: Canvas;
  view?: LyricsView;
  /** Waiting for setTrack() after beginChange(): nothing to draw yet. */
  pending?: boolean;
  enteredAt: number;
  coverAt?: number;
  artworkAt?: number;
  viewAt?: number;
};

type Outgoing = Track & { leftAt: number };

/**
 * The video card: the media page's layouts drawn with Skia instead of a
 * browser. The default layout is full-bleed artwork with the title and the
 * timeline; the lyrics layout shrinks the artwork into the corner over its
 * blurred backdrop and scrolls synced lyrics beneath. Swapping layouts or
 * tracks animates. A frame is only redrawn while something moves; otherwise
 * the last one is handed out again.
 */
export class VideoCard {
  private canvas = createCanvas(cardSize, cardSize);
  private context = this.canvas.getContext("2d");
  /** The background and foreground together, as the lyrics go over them. */
  private stage = createCanvas(cardSize, cardSize);
  /** The covers, the shade and the header, which only move on a change. */
  private foreground = createCanvas(cardSize, cardSize);
  private flow = createCanvas(flowSize, flowSize);
  private flowGraded = createCanvas(flowSize, flowSize);
  private flowTime = 0;
  private flowSpeed = 0;
  private backgroundAt = -Infinity;
  private track: Track = {
    title: "Ready for music",
    artist: "Waiting for the next track",
    enteredAt: -Infinity,
    coverAt: -Infinity,
  };
  private outgoing: Outgoing | undefined;
  private backdrop: { current?: Canvas; previous?: Canvas; at: number } = {
    at: -Infinity,
  };
  private artworkRequest = 0;
  private artworkUrl: string | undefined;
  private artworkLoad: Promise<Image> | undefined;
  private frameKey = "";
  private frame: Buffer | undefined;
  private stageDirty = true;
  private now: () => number;
  private lyricsOffset: number;

  private preferredMode: DisplayMode = "default";
  private lyricsAvailable: boolean | undefined;
  private lastFrameAt: number | undefined;
  private clock = { position: -1, changedAt: -Infinity, shown: 0 };

  private layout = new Tween(0);
  private rounding = new Tween(0);
  private shade = new Tween(1);
  private lyricsIn = new Tween(0);
  private lyricsShift = new Tween(18);

  constructor(
    private progress: () => CardProgress | undefined,
    private onError: (message: string) => void = () => {},
    options: VideoCardOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.lyricsOffset = options.lyricsOffset ?? 0;
  }

  /**
   * Starts the track change: the cover, title and lyrics leave while the
   * backdrop stays. The artwork starts loading now, ahead of setTrack().
   */
  beginChange(artworkUrl?: string) {
    const now = this.seconds();
    this.leave(now);
    this.track = { title: "", artist: "", pending: true, enteredAt: now };
    if (artworkUrl) this.fetchArtwork(artworkUrl);
    this.stageDirty = true;
  }

  setTrack(title: string, artist: string, artworkUrl?: string) {
    const now = this.seconds();
    this.leave(now);
    const track: Track = {
      title: title || "Unknown title",
      artist,
      enteredAt: now,
    };
    this.track = track;
    this.lyricsAvailable = undefined;
    this.applyMode();
    this.stageDirty = true;
    const request = ++this.artworkRequest;
    if (!artworkUrl) {
      this.artworkUrl = undefined;
      this.showCover(track, now);
      return;
    }
    void this.fetchArtwork(artworkUrl)
      .then((image) => {
        if (request === this.artworkRequest) this.showArtwork(image);
      })
      .catch((error) => {
        if (request === this.artworkRequest) this.showCover(track);
        this.onError(error instanceof Error ? error.message : String(error));
      });
  }

  /** Shows artwork that is already decoded, skipping the fetch. */
  showArtwork(image: Image) {
    const now = this.seconds();
    const track = this.track;
    track.cover = this.croppedCover(image);
    track.backdrop = this.flowSource(image);
    // Late artwork fades in over the placeholder; on time, it arrives with
    // the cover.
    if (track.coverAt !== undefined) {
      track.artworkAt = now;
      this.fadeBackdrop(track, now);
    } else this.showCover(track, now);
    this.stageDirty = true;
  }

  reset() {
    this.artworkRequest++;
    this.setTrack("Ready for music", "Waiting for the next track");
  }

  setDisplayMode(mode: DisplayMode) {
    this.preferredMode = mode;
    this.applyMode();
  }

  setLyrics(lines: Lyric[], credits: LyricsCredits = {}) {
    const view = new LyricsView(lines, frame.width, ratio, credits);
    const usable = !view.empty && view.synced;
    this.track.view = usable ? view : undefined;
    this.track.viewAt = this.seconds();
    this.lyricsAvailable = usable;
    view.enter();
    this.lastFrameAt = undefined;
    this.applyMode();
  }

  setLyricsUnavailable() {
    this.track.view = undefined;
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
    this.waitForArtwork(now);
    this.dropOutgoing(now);
    this.advanceFlow(now, delta);

    const lyricsAlpha = this.lyricsIn.value(now);
    const view = this.track.view;
    if (view && lyricsAlpha > 0)
      view.update(songTime - this.lyricsOffset, delta, frame.height);
    const lyricsMoving =
      lyricsAlpha > 0 &&
      ((Boolean(view) &&
        (this.clockRunning(now) ||
          !view!.settled ||
          progressOf(now, this.track.viewAt, lyricsEnter) < 1)) ||
        Boolean(this.outgoing?.view));
    const foregroundMoving = this.foregroundMoving(now);
    // The backdrop is all blur and moves slowly: half the frame rate is
    // plenty, and the frames between can go unsent when nothing else moves.
    const backgroundDue =
      this.backgroundMoving(now) && now - this.backgroundAt >= 1 / backdropFps;
    const stageMoving = foregroundMoving || backgroundDue;
    const key = `${formatTime(position)}|${formatTime(duration)}|${Math.round(amount * 528 * ratio)}`;
    if (
      this.frame &&
      key === this.frameKey &&
      !lyricsMoving &&
      !stageMoving &&
      !this.stageDirty
    )
      return this.frame;
    this.frameKey = key;
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    if (foregroundMoving || this.stageDirty) this.drawForeground(now);
    if (stageMoving || this.stageDirty) {
      const stage = this.stage.getContext("2d");
      this.drawBackground(stage);
      // In the settled lyrics layout only the top of the foreground has
      // anything in it.
      const band =
        !foregroundMoving && this.layout.value(now) >= 1
          ? Math.ceil(foregroundBand * ratio)
          : cardSize;
      stage.drawImage(
        this.foreground,
        0,
        0,
        cardSize,
        band,
        0,
        0,
        cardSize,
        band,
      );
      this.backgroundAt = now;
      this.stageDirty = foregroundMoving;
    }
    context.drawImage(this.stage, 0, 0);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (lyricsAlpha > 0.001) this.drawLyrics(now, lyricsAlpha);
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

  /** Sends what is showing on its way out. */
  private leave(now: number) {
    if (this.track.pending) return;
    this.outgoing = { ...this.track, leftAt: now };
  }

  private dropOutgoing(now: number) {
    const outgoing = this.outgoing;
    if (!outgoing || now - outgoing.leftAt < leave) return;
    // In the default layout the old cover stays up until the new one covers
    // it.
    if (
      this.layout.value(now) < 1 &&
      progressOf(now, this.track.coverAt, coverEnter) < 1
    )
      return;
    this.outgoing = undefined;
    this.stageDirty = true;
  }

  private fetchArtwork(url: string) {
    if (url !== this.artworkUrl || !this.artworkLoad) {
      this.artworkUrl = url;
      this.artworkLoad = this.loadArtwork(url);
      // Nobody may wait on it if the change is abandoned.
      this.artworkLoad.catch(() => {});
    }
    return this.artworkLoad;
  }

  private showCover(track: Track, now = this.seconds()) {
    if (track !== this.track || track.coverAt !== undefined) return;
    track.coverAt = now;
    this.fadeBackdrop(track, now);
    this.stageDirty = true;
  }

  /** Stops a slow download holding the placeholder back forever. */
  private waitForArtwork(now: number) {
    const track = this.track;
    if (
      !track.pending &&
      track.coverAt === undefined &&
      now - track.enteredAt > artworkPatience
    )
      this.showCover(track, now);
  }

  private fadeBackdrop(track: Track, now: number) {
    if (this.backdrop.current === track.backdrop) return;
    this.backdrop = {
      previous: this.backdrop.current,
      current: track.backdrop,
      at: now,
    };
  }

  private applyMode() {
    const lyrics =
      this.preferredMode === "lyrics" && this.lyricsAvailable !== false;
    const now = this.seconds();
    const { duration, easing } = motion.layout;
    const target = lyrics ? 1 : 0;
    if (this.layout.target === target) return;
    this.layout.set(target, now, duration, easing);
    this.rounding.set(target, now, duration, ease);
    this.shade.set(1 - target, now, duration / 2, ease);
    this.lyricsShift.set(lyrics ? 0 : 18, now, duration, easing);
    // Like the page: the lyrics wait for the artwork to get going, but leave
    // at once.
    this.lyricsIn.set(
      target,
      now,
      motion.fade * 1.4,
      ease,
      lyrics ? duration * 0.26 : 0,
    );
    this.stageDirty = true;
  }

  private foregroundMoving(now: number) {
    const track = this.track;
    return (
      [this.layout, this.rounding, this.shade].some(
        (tween) => !tween.settled(now),
      ) ||
      Boolean(this.outgoing) ||
      now - track.enteredAt < headerEnter + artistDelay ||
      progressOf(now, track.coverAt, coverEnter) < 1 ||
      (track.artworkAt !== undefined && now - track.artworkAt < coverEnter)
    );
  }

  private backgroundMoving(now: number) {
    const backdrop = this.backdrop;
    return (
      now - backdrop.at < backdropFade ||
      // Hidden under the full-bleed cover in the default layout.
      (this.flowSpeed > 0 &&
        this.layout.value(now) > 0.001 &&
        Boolean(backdrop.current ?? backdrop.previous))
    );
  }

  /**
   * The backdrop moves while the track plays, winding down on a pause and
   * back up on resume rather than stopping dead.
   */
  private advanceFlow(now: number, delta: number) {
    const playing = this.clockRunning(now);
    const target = playing ? 1 : 0;
    this.flowSpeed +=
      (target - this.flowSpeed) * (1 - Math.exp(-delta / flowEase));
    if (!playing && this.flowSpeed < 0.002) this.flowSpeed = 0;
    this.flowTime += delta * this.flowSpeed;
  }

  /** The card's clock, in seconds like the motion settings. */
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

  /** background-size: cover, done once so each frame draws a small square. */
  private croppedCover(image: Image) {
    const canvas = createCanvas(cardSize, cardSize);
    const context = canvas.getContext("2d");
    const fit = Math.max(cardSize / image.width, cardSize / image.height);
    context.drawImage(
      image,
      (cardSize - image.width * fit) / 2,
      (cardSize - image.height * fit) / 2,
      image.width * fit,
      image.height * fit,
    );
    return canvas;
  }

  /** The artwork, small, for the moving backdrop to turn and drift. */
  private flowSource(image: Image) {
    const size = 64;
    const canvas = createCanvas(size, size);
    const scale = Math.max(size / image.width, size / image.height);
    canvas
      .getContext("2d")
      .drawImage(
        image,
        (size - image.width * scale) / 2,
        (size - image.height * scale) / 2,
        image.width * scale,
        image.height * scale,
      );
    return canvas;
  }

  /**
   * #artwork under #stage::before, drawn on the tiny flow canvas (it is all
   * blur and gradient, so nothing is lost) and scaled up in one opaque pass.
   */
  private drawBackground(context: SKRSContext2D) {
    const now = this.seconds();
    const mix = ease(progressOf(now, this.backdrop.at, backdropFade));
    const flow = this.flow.getContext("2d");
    flow.clearRect(0, 0, flowSize, flowSize);
    for (const [image, alpha] of [
      [this.backdrop.previous, 1 - mix],
      [this.backdrop.current, mix],
    ] as const)
      if (image && alpha > 0.001) this.drawFlow(flow, image, alpha);
    const graded = this.flowGraded.getContext("2d");
    graded.setTransform(1, 0, 0, 1, 0, 0);
    graded.fillStyle = "#0a0a0c";
    graded.fillRect(0, 0, flowSize, flowSize);
    graded.globalAlpha = 0.86;
    graded.filter = `blur(${flowBlur}px) brightness(0.54) saturate(1.55)`;
    graded.drawImage(this.flow, 0, 0);
    graded.filter = "none";
    graded.globalAlpha = 1;
    // #stage::before, in card units.
    const size = layoutSize;
    const scale = flowSize / (size * flowReach);
    const inset = ((flowReach - 1) / 2) * flowSize;
    graded.setTransform(scale, 0, 0, scale, inset, inset);
    const angle = (115 * Math.PI) / 180;
    const dx = (Math.sin(angle) * size) / 2;
    const dy = (-Math.cos(angle) * size) / 2;
    const wash = graded.createLinearGradient(
      size / 2 - dx,
      size / 2 - dy,
      size / 2 + dx,
      size / 2 + dy,
    );
    wash.addColorStop(0, "rgba(0, 0, 0, 0.22)");
    wash.addColorStop(0.48, "rgba(5, 5, 8, 0.5)");
    wash.addColorStop(1, "rgba(0, 0, 0, 0.66)");
    graded.fillStyle = wash;
    graded.fillRect(0, 0, size, size);
    // Just the card's part of the flow canvas, stretched over the card.
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(
      this.flowGraded,
      inset,
      inset,
      flowSize - inset * 2,
      flowSize - inset * 2,
      0,
      0,
      cardSize,
      cardSize,
    );
    context.restore();
  }

  private drawFlow(context: SKRSContext2D, image: Canvas, alpha: number) {
    const time = this.flowTime;
    for (const layer of flowLayers) {
      const angle = layer.phase + time * layer.speed;
      const side = flowSize * layer.size;
      context.save();
      context.globalAlpha = alpha * layer.alpha;
      context.translate(
        flowSize * (0.5 + layer.orbit * Math.cos(angle)),
        flowSize * (0.5 + layer.orbit * Math.sin(angle * 0.8)),
      );
      context.rotate(layer.phase + time * layer.spin);
      context.drawImage(image, -side / 2, -side / 2, side, side);
      context.restore();
    }
  }

  /** The covers, the shade and the header, on a transparent layer. */
  private drawForeground(now: number) {
    const context = this.foreground.getContext("2d");
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, cardSize, cardSize);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const size = layoutSize;
    const layout = this.layout.value(now);
    const track = this.track;
    const coverIn = easeOut(progressOf(now, track.coverAt, coverEnter));
    const outgoing = this.outgoing;
    if (outgoing) {
      // Shrinks away as a thumbnail; stays put as the full-bleed cover until
      // the new one is over it.
      const gone = easeOut(clamp((now - outgoing.leftAt) / leave));
      this.drawCover(
        context,
        outgoing,
        layout,
        1 - 0.12 * gone * layout,
        lerp(1, 1 - gone, layout) * (1 - coverIn * (1 - layout)),
        now,
      );
    }
    if (!track.pending && track.coverAt !== undefined)
      this.drawCover(
        context,
        track,
        layout,
        lerp(lerp(1.04, 0.88, layout), 1, coverIn),
        clamp(coverIn * 1.4),
        now,
      );

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

    if (outgoing) {
      const gone = easeOut(clamp((now - outgoing.leftAt) / leave));
      this.drawHeader(
        context,
        outgoing,
        layout,
        1 - gone,
        -12 * gone,
        1 - gone,
        -12 * gone,
      );
    }
    if (!track.pending) {
      const title = easeOut(clamp((now - track.enteredAt) / headerEnter));
      const artist = easeOut(
        clamp((now - track.enteredAt - artistDelay) / headerEnter),
      );
      this.drawHeader(
        context,
        track,
        layout,
        title,
        14 * (1 - title),
        artist,
        14 * (1 - artist),
      );
    }
  }

  private drawHeader(
    context: SKRSContext2D,
    track: Track,
    layout: number,
    titleAlpha: number,
    titleShift: number,
    artistAlpha: number,
    artistShift: number,
  ) {
    const left = lerp(headerDefault.x, headerLyrics.x, layout);
    const top = lerp(headerDefault.y, headerLyrics.y, layout);
    context.textBaseline = "top";
    context.textAlign = "left";
    if (titleAlpha > 0.001) {
      context.globalAlpha = titleAlpha;
      context.fillStyle = "#ffffff";
      context.font = `700 34px ${fonts()}`;
      context.fillText(
        ellipsize(context, track.title, headerWidth),
        left,
        top + 2 + titleShift,
      );
    }
    if (artistAlpha > 0.001) {
      context.globalAlpha = artistAlpha;
      context.fillStyle = `rgba(255, 255, 255, ${lerp(0.76, 0.58, clamp(layout)).toFixed(3)})`;
      context.font = `600 20px ${fonts()}`;
      context.fillText(
        ellipsize(context, track.artist, headerWidth),
        left,
        top + 45 + artistShift,
      );
    }
    context.globalAlpha = 1;
  }

  /** #cover: full bleed by default, a rounded thumbnail in the lyrics layout. */
  private drawCover(
    context: SKRSContext2D,
    track: Track,
    layout: number,
    grow: number,
    alpha: number,
    now: number,
  ) {
    if (alpha <= 0.001) return;
    const size = layoutSize;
    const scale = lerp(1, coverSmall.scale, layout);
    const side = size * scale * grow;
    const x = lerp(0, coverSmall.x, layout) + (size * scale - side) / 2;
    const y = lerp(0, coverSmall.y, layout) + (size * scale - side) / 2;
    const radius = coverRadius * this.rounding.value(now) * scale * grow;
    context.save();
    context.globalAlpha = alpha;
    if (layout > 0.001) {
      // box-shadow: 0 40px 120px rgb(0 0 0 / 0.32), scaled with the cover.
      context.shadowColor = "rgba(0, 0, 0, 0.32)";
      context.shadowBlur = 120 * scale * ratio;
      context.shadowOffsetY = 40 * scale * ratio;
    }
    context.beginPath();
    context.roundRect(x, y, side, side, Math.max(0, radius));
    const artworkIn =
      track.artworkAt === undefined
        ? 1
        : ease(clamp((now - track.artworkAt) / coverEnter));
    const cover = track.cover;
    context.fillStyle =
      cover && artworkIn >= 1 ? "#0a0a0c" : "rgba(255, 255, 255, 0.06)";
    context.fill();
    context.shadowColor = "transparent";
    if (cover) {
      context.clip();
      context.globalAlpha = alpha * artworkIn;
      context.drawImage(cover, x, y, side, side);
    }
    context.restore();
  }

  private drawLyrics(now: number, alpha: number) {
    const context = this.context;
    context.save();
    context.translate(frame.x, frame.y + this.lyricsShift.value(now));
    const outgoing = this.outgoing;
    if (outgoing?.view) {
      const gone = easeOut(clamp((now - outgoing.leftAt) / leave));
      if (gone < 1) {
        context.save();
        context.translate(0, -24 * gone);
        outgoing.view.draw(context, frame.height, alpha * (1 - gone));
        context.restore();
      }
    }
    const view = this.track.view;
    if (view)
      view.draw(
        context,
        frame.height,
        alpha * ease(progressOf(now, this.track.viewAt, lyricsEnter)),
      );
    context.restore();
  }

  private drawTimeline(
    context: SKRSContext2D,
    position: number,
    duration: number,
    amount: number,
  ) {
    const size = layoutSize;
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
