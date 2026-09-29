import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { Lyric, LyricPart } from "@braccato/core";
import { fonts } from "./fonts.ts";
import { clamp, cubicBezier, easeOut, lerp, motion, Spring } from "./motion.ts";

const fontSize = 40;
const rowHeight = fontSize * 1.2;
const backgroundFontSize = 26;
const backgroundRowHeight = backgroundFontSize * 1.25;
const romanFontSize = 18;
const romanRowHeight = romanFontSize * 1.4;
/** Space between a line and its background vocals. */
const backgroundGap = 10;
/** How far below its place a line starts when lyrics fly in. */
const enterDistance = 90;
/** The credits come up this long after the last line ends. */
const creditsDelayMs = 1_500;
const creditsGap = 18;
/** Space above and below each line. */
const linePadding = 13;
/**
 * Room around a line's own canvas for lift, glow and blur: an emphasised
 * letter's glow reaches 24px past it, and the letter itself moves 5px or so.
 */
const bleed = 36;
/** Duets leave this much of the width to the other side. */
const duetInset = 0.15;
/** Where the current line sits, as a share of the view's height. */
export const focusPosition = 0.35;
/** A gap this long between lines gets the breathing dots. */
const interludeGapMs = 7_000;
/** So does an intro this long before the first line. */
const introGapMs = 3_000;
const dotsHeight = 40;
const dotSize = 11;
const dotGap = 7;

/** How bright text is on a line that is not being sung. */
const idleAlpha = 0.3;
/** How bright a current line's syllables are before they are sung. */
const unsungAlpha = 0.42;

type Align = "left" | "right";

type Glyph = { text: string; x: number; width: number };
type Syllable = {
  text: string;
  start: number;
  end: number;
  x: number;
  row: number;
  width: number;
  word: number;
  glyphs?: Glyph[];
};
type Word = {
  start: number;
  end: number;
  first: number;
  last: number;
  emphasis?: { amount: number; glow: number; duration: number };
};
type TextBlock = {
  syllables: Syllable[];
  words: Word[];
  rows: number;
  timed: boolean;
  size: number;
  rowHeight: number;
  height: number;
  /** Where the scale pivots, in line coordinates. */
  anchor: number;
};

type LineItem = {
  kind: "line";
  start: number;
  /** When the line stops counting as current. */
  end: number;
  align: Align;
  main: TextBlock;
  roman?: {
    rows: { text: string; x: number; width: number }[];
    height: number;
  };
  background?: TextBlock;
  mainHeight: number;
  /** Where the line's text starts and ends across the view. */
  left: number;
  right: number;
  y: Spring;
  scale: Spring;
  shown: Spring;
  bright: number;
  active: boolean;
  canvas?: Canvas;
  blurred?: Canvas;
  contentKey?: string;
  blurKey?: string;
};
type DotsItem = {
  kind: "dots";
  start: number;
  end: number;
  align: Align;
  y: Spring;
  active: boolean;
};
/** Who wrote the song and where the lyrics came from, after the last line. */
type CreditsItem = {
  kind: "credits";
  start: number;
  end: number;
  align: Align;
  y: Spring;
  active: boolean;
  rows: { text: string; size: number; alpha: number }[];
  height: number;
  canvas?: Canvas;
};
type Item = LineItem | DotsItem | CreditsItem;

export type LyricsCredits = { songwriters?: string[]; source?: string };

type Piece = { text: string; start: number; end: number };

const empIn = cubicBezier(0.2, 0.4, 0.58, 1);
const empOut = cubicBezier(0.3, 0, 0.58, 1);
const emphasisCurve = (x: number) =>
  x < 0.5 ? empIn(x / 0.5) : 1 - empOut((x - 0.5) / 0.5);
const dotEnter = cubicBezier(0.34, 1.56, 0.64, 1);
const dotLight = cubicBezier(0.56, 0.01, 0.45, 1);

const white = (alpha: number) =>
  `rgba(255, 255, 255, ${clamp(alpha).toFixed(3)})`;

const cjk = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;

/** AMLL's rule for words held long enough to glow. */
function shouldEmphasize(text: string, duration: number) {
  const trimmed = text.trim();
  if (duration < 1_000) return false;
  if (cjk.test(trimmed)) return true;
  const length = [...trimmed].length;
  return length > 1 && length <= 7;
}

function emphasisFor(duration: number, lastWord: boolean) {
  let span = Math.max(1_000, duration);
  let amount = span / 2_000;
  amount = amount > 1 ? Math.sqrt(amount) : amount ** 3;
  let glow = span / 3_000;
  glow = glow > 1 ? Math.sqrt(glow) : glow ** 3;
  amount *= 0.6;
  glow *= 0.5;
  if (lastWord) {
    amount *= 1.6;
    glow *= 1.5;
    span *= 1.2;
  }
  return {
    amount: Math.min(1.2, amount),
    glow: Math.min(0.8, glow),
    duration: span,
  };
}

/** A letter from a script that romanization is for. */
const nonLatin = /(?=\p{L})\P{Script=Latin}/u;
const comparable = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Apple Music style synced lyrics drawn with Skia: lines scroll on springs
 * with a stagger, the current one grows and lights up syllable by syllable,
 * background vocals slide out beneath it, other voices sit on the right, long
 * gaps breathe three dots, and lines soften toward the top and bottom.
 *
 * Each line draws into its own canvas and keeps it until it changes, and
 * blurred copies are kept per blur step: blurring the whole view each frame
 * is far too slow in Skia.
 */
export class LyricsView {
  private items: Item[] = [];
  private focus = 0;
  private lastTime: number | undefined;
  private entering = false;
  private sprite: Canvas | undefined;
  readonly synced: boolean;

  /**
   * @param width - Width in layout pixels, which the card draws at 720 wide
   * @param ratio - Device pixels per layout pixel for the line canvases
   */
  constructor(
    lines: Lyric[],
    readonly width: number,
    private ratio = 1,
    credits: LyricsCredits = {},
  ) {
    const measure = createCanvas(1, 1).getContext("2d");
    this.items = this.build(lines, measure);
    this.synced = lines.some((line) => line.startTimeMs > 0);
    const last = this.items.at(-1);
    const creditsItem = last && this.credits(credits, last.end, measure);
    if (creditsItem) this.items.push(creditsItem);
  }

  get empty() {
    return this.items.length === 0;
  }

  /** Makes the first frame fly the lines up into place instead of snapping. */
  enter() {
    this.entering = true;
  }

  /** Whether nothing is still moving toward where it was last sent. */
  get settled() {
    return this.items.every(
      (item) =>
        item.y.settled &&
        (item.kind !== "line" ||
          (item.scale.settled &&
            item.shown.settled &&
            (item.bright === 0 || item.bright === 1))),
    );
  }

  /** The line or interlude the view is centred on. */
  get focusIndex() {
    return this.focus;
  }

  /** What each item is doing, for tests. */
  describe() {
    return this.items.map((item) => ({
      kind: item.kind,
      active: item.active,
      y: item.y.target,
      align: item.align,
      ...(item.kind === "line"
        ? {
            text: item.main.syllables.map((value) => value.text).join(""),
            background: item.background?.syllables
              .map((value) => value.text)
              .join(""),
            roman: item.roman?.rows.map((row) => row.text).join(" "),
            timed: item.main.timed,
            rows: item.main.rows,
            scale: item.scale.target,
            shown: item.shown.target,
          }
        : {}),
    }));
  }

  /**
   * Moves the view to a song time in seconds. A jump (a seek, or the first
   * frame) moves everything into place without animating.
   */
  update(seconds: number, delta: number, height: number) {
    const time = seconds * 1_000;
    const jumped =
      this.lastTime === undefined ||
      time < this.lastTime - 50 ||
      time > this.lastTime + 1_500;
    this.lastTime = time;
    const ahead = time + motion.lead * 1_000;

    let focus = -1;
    let latest = -1;
    for (const [index, item] of this.items.entries()) {
      item.active = item.start <= ahead && ahead < item.end;
      if (item.active && focus < 0) focus = index;
      if (item.start <= ahead) latest = index;
    }
    // Between lines, hold on the last one; before the first, wait on it.
    if (focus < 0) focus = Math.max(0, latest);
    this.focus = focus;

    const heights = this.items.map((item) => this.layoutHeight(item));
    const focusY = height * focusPosition;
    const targets: number[] = [];
    let top = focusY - heights[focus]! / 2;
    for (let index = focus; index >= 0; index--) {
      targets[index] = top;
      top -= heights[index - 1] ?? 0;
    }
    top = focusY - heights[focus]! / 2;
    for (let index = focus + 1; index < this.items.length; index++) {
      top += heights[index - 1]!;
      targets[index] = top;
    }

    const entering = jumped && this.entering;
    this.entering = false;
    let delay = 0;
    let step = jumped && !entering ? 0 : motion.stagger;
    for (const [index, item] of this.items.entries()) {
      const target = targets[index]!;
      if (entering) {
        item.y.snap(target + enterDistance);
        item.y.set(target, delay);
      } else if (jumped) item.y.snap(target);
      else if (Math.abs(item.y.target - target) > 0.5)
        item.y.set(target, delay);
      if (target + heights[index]! >= 0) {
        delay += step;
        if (index >= focus) step /= 1.05;
      }
      if (item.kind !== "line") continue;
      const scale = item.active ? 1 : motion.inactiveScale;
      const shown = item.active ? 1 : 0;
      if (jumped) {
        item.scale.snap(scale);
        item.shown.snap(shown);
        item.bright = shown;
      } else {
        item.scale.set(scale);
        item.shown.set(shown);
        const rate = 1 - Math.exp(-delta / (motion.brighten / 3));
        item.bright += (shown - item.bright) * rate;
        if (Math.abs(item.bright - shown) < 0.002) item.bright = shown;
      }
    }
    if (!jumped || entering)
      for (const item of this.items) {
        item.y.update(delta);
        if (item.kind === "line") {
          item.scale.update(delta);
          item.shown.update(delta);
        }
      }
  }

  /**
   * Draws the view at the time last given to update(), faded out toward the
   * top and bottom like the page's mask. Each line takes the fade at its far
   * edge, so it is gone by the time it reaches the view's edge: no layer to
   * mask, and nothing to clip.
   */
  draw(context: SKRSContext2D, height: number, alpha = 1) {
    const time = this.lastTime ?? 0;
    const focusY = height * focusPosition;
    const fadeAt = (y: number) =>
      clamp(Math.min(y / (height * 0.12), (height - y) / (height * 0.22)));
    for (const item of this.items) {
      const top = item.y.position;
      if (item.kind === "dots") {
        const fade = fadeAt(top + dotsHeight / 2) * alpha;
        if (fade > 0.001) this.drawDots(context, item, time, fade);
        continue;
      }
      if (item.kind === "credits") {
        const fade =
          alpha *
          Math.min(
            fadeAt(top + creditsGap),
            fadeAt(top + item.height - linePadding),
          );
        if (fade > 0.001) this.drawCredits(context, item, fade);
        continue;
      }
      const extent = item.mainHeight + backgroundExtent(item) + linePadding * 2;
      if (top + extent < -bleed || top > height + bleed) {
        // Off screen: let the canvases go until the line comes back.
        item.canvas = item.blurred = undefined;
        item.contentKey = item.blurKey = undefined;
        continue;
      }
      const centre = top + linePadding + item.mainHeight / 2;
      const distance =
        centre < focusY
          ? (focusY - centre) / focusY
          : (centre - focusY) / Math.max(1, height - focusY);
      const edge = clamp((distance - 0.12) / 0.88);
      const blur =
        Math.round(motion.edgeBlur * edge * edge * (1 - item.bright) * 4) / 4;
      const bottom =
        top +
        linePadding +
        item.mainHeight +
        item.shown.position * backgroundExtent(item);
      const fade =
        alpha * (centre < focusY ? fadeAt(top + linePadding) : fadeAt(bottom));
      if (fade <= 0.001) continue;
      const image = this.lineImage(item, time, blur);
      const scale = item.scale.position;
      const pivotX = item.align === "right" ? this.width : 0;
      const pivotY = top + linePadding + item.main.anchor;
      context.save();
      context.globalAlpha = fade;
      context.translate(pivotX, pivotY);
      context.scale(scale, scale);
      context.translate(-pivotX, -pivotY);
      context.drawImage(
        image,
        item.left - bleed,
        top + linePadding - bleed,
        item.right - item.left + bleed * 2,
        item.mainHeight + backgroundExtent(item) + bleed * 2,
      );
      context.restore();
    }
  }

  private layoutHeight(item: Item) {
    if (item.kind === "dots") return item.active ? dotsHeight : 0;
    if (item.kind === "credits") return item.height;
    return (
      item.mainHeight +
      (item.active ? backgroundExtent(item) : 0) +
      linePadding * 2
    );
  }

  private build(lines: Lyric[], measure: SKRSContext2D) {
    const duet = lines.some((line) => this.alignOf(line) === "right");
    const items: Item[] = [];
    const sorted = [...lines].sort((a, b) => a.startTimeMs - b.startTimeMs);
    for (const line of sorted) {
      if (line.isInstrumental) {
        items.push({
          kind: "dots",
          start: line.startTimeMs,
          end: line.startTimeMs + line.durationMs,
          align: "left",
          y: new Spring(0, motion.scroll),
          active: false,
        });
        continue;
      }
      const item = this.buildLine(line, duet, measure);
      if (item) items.push(item);
    }

    // Interludes: dots in long gaps and before a late first line, and each line
    // stays current until the next one when the gap is short.
    const withDots: Item[] = [];
    for (const [index, item] of items.entries()) {
      const previous = withDots.at(-1);
      if (item.kind === "line") {
        if (!previous && item.start >= introGapMs)
          withDots.push(this.dots(0, item.start, item.align));
        else if (
          previous?.kind === "line" &&
          item.start - previous.end >= interludeGapMs
        )
          withDots.push(this.dots(previous.end, item.start, item.align));
      }
      withDots.push(item);
      const next = items[index + 1];
      if (item.kind === "line" && next?.kind === "line")
        if (next.start - item.end < interludeGapMs)
          item.end = Math.max(item.end, next.start);
    }
    for (const [index, item] of withDots.entries())
      if (item.kind === "dots") {
        const next = withDots
          .slice(index + 1)
          .find((value) => value.kind === "line");
        if (next) item.align = next.align;
      }
    return withDots;
  }

  private credits(
    credits: LyricsCredits,
    lastEnd: number,
    measure: SKRSContext2D,
  ): CreditsItem | undefined {
    const rows: CreditsItem["rows"] = [];
    const add = (text: string, size: number, alpha: number) => {
      measure.font = `600 ${size}px ${fonts()}`;
      for (const row of wrapText(measure, text, this.width))
        rows.push({ text: row, size, alpha });
    };
    const writers = credits.songwriters?.filter(Boolean) ?? [];
    if (writers.length) add(`Written by: ${writers.join(", ")}`, 17, 0.5);
    if (credits.source) add(`Lyrics from ${credits.source}`, 13, 0.32);
    if (!rows.length) return;
    const height =
      creditsGap +
      rows.reduce((sum, row) => sum + row.size * 1.45, 0) +
      linePadding;
    return {
      kind: "credits",
      start: lastEnd + creditsDelayMs,
      end: Infinity,
      align: "left",
      y: new Spring(0, motion.scroll),
      active: false,
      rows,
      height,
    };
  }

  /** Drawn once into its own canvas, then moved about like the lines. */
  private drawCredits(context: SKRSContext2D, item: CreditsItem, fade: number) {
    if (!item.canvas) {
      item.canvas = createCanvas(
        Math.ceil(this.width * this.ratio),
        Math.ceil(item.height * this.ratio),
      );
      const target = item.canvas.getContext("2d");
      target.scale(this.ratio, this.ratio);
      target.textBaseline = "alphabetic";
      let y = creditsGap;
      for (const row of item.rows) {
        target.font = `600 ${row.size}px ${fonts()}`;
        target.fillStyle = white(row.alpha);
        target.fillText(row.text, 0, y + row.size);
        y += row.size * 1.45;
      }
    }
    context.save();
    context.globalAlpha = fade;
    context.drawImage(item.canvas, 0, item.y.position, this.width, item.height);
    context.restore();
  }

  private dots(start: number, end: number, align: Align): DotsItem {
    return {
      kind: "dots",
      start,
      end,
      align,
      y: new Spring(0, motion.scroll),
      active: false,
    };
  }

  private alignOf(line: Lyric): Align {
    const agent = line.agent;
    return agent && agent !== "v1" && agent !== "v1000" ? "right" : "left";
  }

  private buildLine(
    line: Lyric,
    duet: boolean,
    measure: SKRSContext2D,
  ): LineItem | undefined {
    const align = this.alignOf(line);
    const inset = duet ? this.width * duetInset : 0;
    const box = {
      left: align === "right" ? inset : 0,
      width: this.width - inset,
      align,
    };
    const parts = (line.parts ?? []).filter((part) => part.words.length > 0);
    const timed = parts.some((part) => part.durationMs > 0);
    const lineEnd = line.startTimeMs + line.durationMs;
    const piece = (part: LyricPart): Piece => ({
      text: part.words,
      start: part.startTimeMs,
      end: part.startTimeMs + Math.max(0, part.durationMs),
    });
    let main: Piece[];
    let background: Piece[] = [];
    if (timed) {
      main = parts.filter((part) => !part.isBackground).map(piece);
      background = parts.filter((part) => part.isBackground).map(piece);
      // A line of only background vocals is still the line.
      if (!main.some((value) => value.text.trim())) {
        main = background;
        background = [];
      }
    } else {
      // Line synced: one piece per word, all lit at once.
      main = (line.words.match(/\S+\s*/g) ?? []).map((text) => ({
        text,
        start: line.startTimeMs,
        end: line.startTimeMs,
      }));
    }
    trimPieces(main);
    trimPieces(background, true);
    if (!main.length) return;

    const mainBlock = layoutBlock(measure, main, {
      ...box,
      size: fontSize,
      rowHeight,
      timed,
    });
    let end = Math.max(lineEnd, ...main.map((value) => value.end));
    // Romanization covers the whole line; the background vocals have their own.
    let romanText = line.romanization?.trim();
    if (romanText && background.length)
      romanText = romanText.replace(/\s*\([^()]*\)\s*$/, "");
    let roman: LineItem["roman"];
    const mainText = main.map((value) => value.text).join("");
    if (
      romanText &&
      nonLatin.test(mainText) &&
      comparable(romanText) !== comparable(mainText)
    ) {
      measure.font = `600 ${romanFontSize}px ${fonts()}`;
      const rows = wrapText(measure, romanText, box.width).map((text) => {
        const width = measure.measureText(text).width;
        return {
          text,
          x: box.left + (align === "right" ? box.width - width : 0),
          width,
        };
      });
      roman = { rows, height: rows.length * romanRowHeight + 4 };
    }
    let backgroundBlock: TextBlock | undefined;
    if (background.length) {
      backgroundBlock = layoutBlock(measure, background, {
        ...box,
        size: backgroundFontSize,
        rowHeight: backgroundRowHeight,
        timed,
      });
      end = Math.max(end, ...background.map((value) => value.end));
    }
    const spans = [
      ...mainBlock.syllables,
      ...(backgroundBlock?.syllables ?? []),
      ...(roman?.rows ?? []),
    ];
    return {
      kind: "line",
      start: line.startTimeMs,
      end,
      align,
      main: mainBlock,
      roman,
      background: backgroundBlock,
      mainHeight: mainBlock.height + (roman?.height ?? 0),
      left: Math.floor(Math.min(...spans.map((span) => span.x))),
      right: Math.ceil(Math.max(...spans.map((span) => span.x + span.width))),
      y: new Spring(0, motion.scroll),
      scale: new Spring(motion.inactiveScale, motion.scale),
      shown: new Spring(0, motion.scale),
      bright: 0,
      active: false,
    };
  }

  private lineImage(item: LineItem, time: number, blur: number) {
    const moving =
      item.bright > 0 || item.shown.position > 0.001 || !item.shown.settled;
    const contentKey =
      moving && item.main.timed
        ? `t${time.toFixed(1)}|${item.bright}|${item.shown.position}`
        : `${item.bright.toFixed(3)}|${item.shown.position.toFixed(3)}`;
    const width = Math.ceil((item.right - item.left + bleed * 2) * this.ratio);
    const height = Math.ceil(
      (item.mainHeight + backgroundExtent(item) + bleed * 2) * this.ratio,
    );
    if (!item.canvas) item.canvas = createCanvas(width, height);
    if (contentKey !== item.contentKey) {
      item.contentKey = contentKey;
      item.blurKey = undefined;
      this.drawLine(item.canvas.getContext("2d"), item, time);
    }
    if (blur <= 0) return item.canvas;
    // Blurred text has no fine detail to keep: blur at half size, which is
    // far cheaper, and let the draw scale it back up.
    const blurKey = `${contentKey}|${blur}`;
    const halfWidth = Math.ceil(width / 2);
    const halfHeight = Math.ceil(height / 2);
    if (!item.blurred) item.blurred = createCanvas(halfWidth, halfHeight);
    if (blurKey !== item.blurKey) {
      item.blurKey = blurKey;
      const context = item.blurred.getContext("2d");
      context.clearRect(0, 0, halfWidth, halfHeight);
      context.filter = `blur(${(blur * this.ratio) / 2}px)`;
      context.drawImage(item.canvas, 0, 0, width / 2, height / 2);
      context.filter = "none";
    }
    return item.blurred;
  }

  private drawLine(context: SKRSContext2D, item: LineItem, time: number) {
    const canvas = item.canvas!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.scale(this.ratio, this.ratio);
    context.translate(bleed - item.left, bleed);
    this.drawBlock(context, item.main, time, item.bright, false);
    if (item.roman) {
      context.font = `600 ${romanFontSize}px ${fonts()}`;
      context.textBaseline = "alphabetic";
      context.fillStyle = white(lerp(0.38, 0.78, item.bright));
      for (const [index, row] of item.roman.rows.entries())
        context.fillText(
          row.text,
          row.x,
          item.main.height + 4 + index * romanRowHeight + romanFontSize,
        );
    }
    const background = item.background;
    const shown = clamp(item.shown.position, 0, 1.2);
    if (background && shown > 0.001) {
      // AMLL's reveal: slide out from behind the line, grow from 80%.
      const top =
        item.mainHeight +
        backgroundGap -
        (1 - shown) * 0.8 * (background.height + backgroundGap);
      const scale = 0.8 + 0.2 * shown;
      const pivotX = item.align === "right" ? this.width : 0;
      context.save();
      context.globalAlpha = clamp(shown);
      context.translate(pivotX, top);
      context.scale(scale, scale);
      context.translate(-pivotX, 0);
      this.drawBlock(context, background, time, item.bright, true);
      context.restore();
    }
    context.restore();
  }

  private drawBlock(
    context: SKRSContext2D,
    block: TextBlock,
    time: number,
    bright: number,
    isBackground: boolean,
  ) {
    const size = block.size;
    context.font = `700 ${size}px ${fonts()}`;
    context.textBaseline = "alphabetic";
    const sung = lerp(idleAlpha, 1, bright);
    const unsung = lerp(idleAlpha, unsungAlpha, bright);
    if (!block.timed) {
      // No syllable timing: the whole line lights at once, never swept.
      context.fillStyle = white(sung);
      for (const syllable of block.syllables)
        context.fillText(
          syllable.text,
          syllable.x,
          syllable.row * block.rowHeight + size * 0.95,
        );
      return;
    }
    const fade = size * motion.fadeWidth;
    const float = (isBackground ? 2 : 1) * motion.lift * size;
    for (const syllable of block.syllables) {
      const word = block.words[syllable.word]!;
      const baseline = syllable.row * block.rowHeight + size * 0.95;
      const span = syllable.end - syllable.start;
      const progress =
        span > 0
          ? clamp((time - syllable.start) / span)
          : time >= syllable.start
            ? 1
            : 0;
      const paint = (target: SKRSContext2D) => {
        target.font = context.font;
        target.textBaseline = "alphabetic";
        if (progress <= 0) target.fillStyle = white(unsung);
        else if (progress >= 1) target.fillStyle = white(sung);
        else {
          // The soft leading edge sweeps across the syllable as it is sung.
          const edge = syllable.x - fade + progress * (syllable.width + fade);
          const gradient = target.createLinearGradient(edge, 0, edge + fade, 0);
          gradient.addColorStop(0, white(sung));
          gradient.addColorStop(1, white(unsung));
          target.fillStyle = gradient;
        }
      };
      paint(context);
      const emphasis = word.emphasis;
      if (!emphasis || !syllable.glyphs || bright <= 0) {
        const rise =
          float *
          bright *
          easeOut(
            clamp((time - word.start) / Math.max(1_000, word.end - word.start)),
          );
        if (rise < 0.01) context.fillText(syllable.text, syllable.x, baseline);
        else
          this.drawSprite(
            context,
            {
              x: syllable.x - 4,
              y: baseline - size * 1.2,
              width: syllable.width + 8,
              height: size * 1.6,
            },
            (target) => {
              paint(target);
              target.fillText(syllable.text, syllable.x, baseline);
            },
            { dy: -rise },
          );
        continue;
      }
      this.drawEmphasis(
        context,
        block,
        syllable,
        word,
        time,
        baseline,
        bright,
        paint,
      );
    }
    context.shadowBlur = 0;
    context.shadowColor = "transparent";
  }

  /** AMLL's emphasis: each letter swells, spreads, lifts and glows in turn. */
  private drawEmphasis(
    context: SKRSContext2D,
    block: TextBlock,
    syllable: Syllable,
    word: Word,
    time: number,
    baseline: number,
    bright: number,
    paint: (target: SKRSContext2D) => void,
  ) {
    const emphasis = word.emphasis!;
    const size = block.size;
    const strength = motion.emphasis;
    const letters = block.syllables
      .slice(word.first, word.last + 1)
      .flatMap((value) => value.glyphs ?? []);
    const count = Math.max(1, letters.length);
    let index = 0;
    for (const value of block.syllables.slice(word.first, word.last + 1)) {
      if (value === syllable) break;
      index += value.glyphs?.length ?? 0;
    }
    for (const glyph of syllable.glyphs!) {
      const delay = word.start + (emphasis.duration / 2.5 / count) * index;
      const x = clamp((time - delay) / emphasis.duration);
      const swell = emphasisCurve(x) * bright;
      const amount = emphasis.amount * strength;
      const scale = 1 + swell * 0.1 * amount;
      const offsetX = -swell * 0.03 * amount * (count / 2 - index) * size;
      const floatProgress = clamp(
        (time - (delay - 400)) / (emphasis.duration * 1.4),
      );
      const offsetY =
        (-swell * 0.025 * amount -
          Math.sin(floatProgress * Math.PI) * motion.lift) *
        size;
      const centreX = syllable.x + glyph.x + glyph.width / 2;
      const centreY = baseline - size * 0.35;
      const glow = swell * emphasis.glow * strength;
      const reach = size * 0.7;
      this.drawSprite(
        context,
        {
          x: syllable.x + glyph.x - reach,
          y: baseline - size - reach,
          width: glyph.width + reach * 2,
          height: size * 1.3 + reach * 2,
        },
        (target) => {
          paint(target);
          if (glow > 0.01) {
            target.shadowColor = white(glow);
            // Shadows ignore the transform, so this one is in device pixels.
            target.shadowBlur =
              Math.min(0.3, emphasis.glow * 0.3) *
              size *
              2 *
              target.getTransform().a;
          }
          target.fillText(glyph.text, syllable.x + glyph.x, baseline);
          target.shadowBlur = 0;
          target.shadowColor = "transparent";
        },
        { dx: offsetX, dy: offsetY, scale, pivotX: centreX, pivotY: centreY },
      );
      index++;
    }
  }

  /**
   * Draws text that moves by fractions of a pixel. Skia snaps glyphs to whole
   * pixels vertically, so a word rising a pixel or two would step instead of
   * glide. Instead the text is drawn unmoved into a sprite lined up with the
   * pixel grid, and the sprite is moved and scaled, which Skia filters
   * smoothly.
   *
   * @param bounds - Where the unmoved text can reach, in the context's units
   * @param paint - Draws the text in the context's units
   */
  private drawSprite(
    context: SKRSContext2D,
    bounds: { x: number; y: number; width: number; height: number },
    paint: (target: SKRSContext2D) => void,
    place: {
      dx?: number;
      dy?: number;
      scale?: number;
      pivotX?: number;
      pivotY?: number;
    },
  ) {
    const { dx = 0, dy = 0, scale = 1 } = place;
    const { pivotX = bounds.x, pivotY = bounds.y } = place;
    const matrix = context.getTransform();
    const left = Math.floor(matrix.a * bounds.x + matrix.e);
    const top = Math.floor(matrix.d * bounds.y + matrix.f);
    const width = Math.ceil(matrix.a * bounds.width) + 2;
    const height = Math.ceil(matrix.d * bounds.height) + 2;
    if (
      !this.sprite ||
      this.sprite.width < width ||
      this.sprite.height < height
    )
      this.sprite = createCanvas(
        Math.max(width, this.sprite?.width ?? 0),
        Math.max(height, this.sprite?.height ?? 0),
      );
    const sprite = this.sprite.getContext("2d");
    sprite.setTransform(1, 0, 0, 1, 0, 0);
    sprite.clearRect(0, 0, width, height);
    sprite.setTransform(
      matrix.a,
      0,
      0,
      matrix.d,
      matrix.e - left,
      matrix.f - top,
    );
    paint(sprite);
    // Where the sprite's corner lands once moved and scaled about the pivot.
    const cornerX = (left - matrix.e) / matrix.a;
    const cornerY = (top - matrix.f) / matrix.d;
    const x = pivotX + dx + (cornerX - pivotX) * scale;
    const y = pivotY + dy + (cornerY - pivotY) * scale;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(
      this.sprite,
      0,
      0,
      width,
      height,
      matrix.a * x + matrix.e,
      matrix.d * y + matrix.f,
      width * scale,
      height * scale,
    );
    context.restore();
  }

  private drawDots(
    context: SKRSContext2D,
    item: DotsItem,
    time: number,
    fade: number,
  ) {
    const total = item.end - item.start;
    const elapsed = time - item.start;
    if (elapsed < 0 || elapsed >= total) return;
    const exit = Math.min(600, total * 0.25);
    const enter = Math.min(500, total * 0.2);
    const body = Math.max(1, total - exit);
    let scale = dotEnter(clamp(elapsed / enter));
    let alpha = clamp(elapsed / (enter * 0.6));
    scale *= 1 + 0.07 * Math.sin((elapsed / 2_500) * Math.PI * 2);
    if (elapsed > body) {
      const x = (elapsed - body) / exit;
      if (x < 0.65) scale *= 1 + 0.15 * easeOut(x / 0.65);
      else {
        const y = (x - 0.65) / 0.35;
        scale *= 1.15 * (1 - y * y);
        alpha *= 1 - y;
      }
    }
    alpha *= fade;
    if (alpha <= 0 || scale <= 0) return;
    const progress = clamp(elapsed / body);
    const groupWidth = dotSize * 3 + dotGap * 2;
    const left = item.align === "right" ? this.width - groupWidth : 4;
    const centreY = item.y.position + dotsHeight / 2;
    const pivotX = item.align === "right" ? this.width : left;
    context.save();
    context.translate(pivotX, centreY);
    context.scale(scale, scale);
    context.translate(-pivotX, -centreY);
    for (let index = 0; index < 3; index++) {
      const light = dotLight(clamp(progress * 3 - index));
      context.fillStyle = white(alpha * lerp(0.25, 0.95, light));
      context.beginPath();
      context.arc(
        left + dotSize / 2 + index * (dotSize + dotGap),
        centreY,
        dotSize / 2,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    context.restore();
  }
}

/** The room background vocals take under their line while it is current. */
const backgroundExtent = (item: LineItem) =>
  item.background ? item.background.height + backgroundGap : 0;

/** Drops the whitespace and brackets a line starts and ends with. */
function trimPieces(pieces: Piece[], brackets = false) {
  while (pieces.length && !pieces[0]!.text.trim()) pieces.shift();
  while (pieces.length && !pieces.at(-1)!.text.trim()) pieces.pop();
  if (!pieces.length) return;
  const first = pieces[0]!;
  const last = pieces.at(-1)!;
  first.text = first.text.trimStart();
  last.text = last.text.trimEnd();
  if (brackets) {
    if (first.text.startsWith("(")) first.text = first.text.slice(1);
    if (last.text.endsWith(")")) last.text = last.text.slice(0, -1);
    if (!first.text && pieces.length > 1) pieces.shift();
  }
}

function wrapText(context: SKRSContext2D, text: string, width: number) {
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(/\s+/)) {
    const candidate = row ? `${row} ${word}` : word;
    if (row && context.measureText(candidate).width > width) {
      rows.push(row);
      row = word;
    } else row = candidate;
  }
  if (row) rows.push(row);
  return rows;
}

type BlockBox = {
  left: number;
  width: number;
  align: Align;
  size: number;
  rowHeight: number;
  timed: boolean;
};

/**
 * Splits pieces into words at whitespace, wraps them into balanced rows (no
 * lone word left on the last one), and places every syllable.
 */
function layoutBlock(
  context: SKRSContext2D,
  pieces: Piece[],
  box: BlockBox,
): TextBlock {
  context.font = `700 ${box.size}px ${fonts()}`;
  const syllables: Syllable[] = [];
  const words: Word[] = [];
  let word: Word | undefined;
  for (const piece of pieces) {
    if (!word || /^\s/.test(piece.text)) {
      word = {
        start: piece.start,
        end: piece.end,
        first: syllables.length,
        last: syllables.length,
      };
      words.push(word);
    }
    word.last = syllables.length;
    word.end = Math.max(word.end, piece.end);
    syllables.push({
      text: piece.text,
      start: piece.start,
      end: piece.end,
      x: 0,
      row: 0,
      width: context.measureText(piece.text).width,
      word: words.length - 1,
    });
    if (/\s$/.test(piece.text)) word = undefined;
  }
  // Glyph positions for the words that will glow.
  for (const [index, value] of words.entries()) {
    const text = syllables
      .slice(value.first, value.last + 1)
      .map((syllable) => syllable.text)
      .join("");
    if (!box.timed || !shouldEmphasize(text, value.end - value.start)) continue;
    value.emphasis = emphasisFor(
      value.end - value.start,
      index === words.length - 1,
    );
    for (const syllable of syllables.slice(value.first, value.last + 1)) {
      const letters = [...syllable.text];
      let prefix = "";
      syllable.glyphs = letters.map((letter) => {
        const x = context.measureText(prefix).width;
        prefix += letter;
        return { text: letter, x, width: context.measureText(letter).width };
      });
    }
  }

  // Measured once: the balanced wrap below tries a dozen widths.
  const widths = words.map((value) =>
    syllables
      .slice(value.first, value.last + 1)
      .reduce((sum, syllable) => sum + syllable.width, 0),
  );
  const trailings = words.map((value) => {
    const last = syllables[value.last]!;
    return last.width - context.measureText(last.text.trimEnd()).width;
  });
  const wrap = (limit: number) => {
    const rows: number[][] = [[]];
    let x = 0;
    for (let index = 0; index < words.length; index++) {
      const width = widths[index]!;
      if (x > 0 && x + width - trailings[index]! > limit) {
        rows.push([]);
        x = 0;
      }
      rows.at(-1)!.push(index);
      x += width;
    }
    return rows;
  };
  let rows = wrap(box.width);
  if (rows.length > 1) {
    let low = box.width / rows.length;
    let high = box.width;
    for (let step = 0; step < 12; step++) {
      const middle = (low + high) / 2;
      if (wrap(middle).length > rows.length) low = middle;
      else high = middle;
    }
    rows = wrap(high);
  }
  for (const [rowIndex, row] of rows.entries()) {
    const last = row.at(-1);
    const rowWidth =
      row.reduce((sum, index) => sum + widths[index]!, 0) -
      (last === undefined ? 0 : trailings[last]!);
    let x = box.left + (box.align === "right" ? box.width - rowWidth : 0);
    for (const index of row) {
      const value = words[index]!;
      for (const syllable of syllables.slice(value.first, value.last + 1)) {
        syllable.x = x;
        syllable.row = rowIndex;
        x += syllable.width;
      }
    }
  }
  const height = rows.length * box.rowHeight;
  return {
    syllables,
    words,
    rows: rows.length,
    timed: box.timed,
    size: box.size,
    rowHeight: box.rowHeight,
    height,
    anchor: height / 2,
  };
}
