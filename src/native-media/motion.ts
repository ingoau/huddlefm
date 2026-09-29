/** CSS's cubic-bezier() timing function. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let index = 0; index < 8; index++) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-5) return sampleY(t);
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    // Newton stalled on a flat stretch: bisect instead.
    let low = 0;
    let high = 1;
    t = x;
    for (let index = 0; index < 20; index++) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-5) break;
      if (value < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return sampleY(t);
  };
}

export type Easing = (progress: number) => number;
export type Bezier = [number, number, number, number];

export const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));
export const lerp = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;
export const easeOut = cubicBezier(0, 0, 0.58, 1);
export const ease = cubicBezier(0.25, 0.1, 0.25, 1);

/** A value that eases toward a target over a fixed time, like a CSS transition. */
export class Tween {
  private from: number;
  private to: number;
  private startedAt = 0;
  private duration = 0;
  private easing: Easing = ease;

  constructor(value: number) {
    this.from = value;
    this.to = value;
  }

  get target() {
    return this.to;
  }

  set(
    target: number,
    now: number,
    duration: number,
    easing: Easing = ease,
    delay = 0,
  ) {
    if (target === this.to) return;
    this.from = this.value(now);
    this.to = target;
    this.startedAt = now + delay;
    this.duration = duration;
    this.easing = easing;
  }

  snap(value: number) {
    this.from = value;
    this.to = value;
    this.duration = 0;
  }

  value(now: number) {
    if (this.duration <= 0 || now >= this.startedAt + this.duration)
      return this.to;
    if (now <= this.startedAt) return this.from;
    return lerp(
      this.from,
      this.to,
      this.easing((now - this.startedAt) / this.duration),
    );
  }

  settled(now: number) {
    return this.duration <= 0 || now >= this.startedAt + this.duration;
  }
}

export type SpringParams = { stiffness: number; damping: number; mass: number };

/**
 * A damped spring, stepped with the frame delta. A new target can wait out a
 * delay first, which is how the lines stagger into place.
 */
export class Spring {
  position: number;
  velocity = 0;
  private goal: number;
  private pending: { goal: number; in: number } | undefined;

  constructor(
    value: number,
    public params: SpringParams,
  ) {
    this.position = value;
    this.goal = value;
  }

  get target() {
    return this.pending?.goal ?? this.goal;
  }

  set(goal: number, delay = 0) {
    if (goal === this.target) return;
    if (delay > 0) this.pending = { goal, in: delay };
    else {
      this.pending = undefined;
      this.goal = goal;
    }
  }

  snap(value: number) {
    this.pending = undefined;
    this.position = value;
    this.goal = value;
    this.velocity = 0;
  }

  get settled() {
    return (
      !this.pending &&
      Math.abs(this.position - this.goal) < 0.01 &&
      Math.abs(this.velocity) < 0.01
    );
  }

  update(seconds: number) {
    if (this.pending) {
      this.pending.in -= seconds;
      if (this.pending.in <= 0) {
        this.goal = this.pending.goal;
        this.pending = undefined;
      }
    }
    if (this.settled) {
      this.position = this.goal;
      this.velocity = 0;
      return;
    }
    const { stiffness, damping, mass } = this.params;
    // Semi-implicit Euler in small steps stays stable for stiff springs.
    const steps = Math.max(1, Math.ceil(seconds / (1 / 240)));
    const step = seconds / steps;
    for (let index = 0; index < steps; index++) {
      const force =
        -stiffness * (this.position - this.goal) - damping * this.velocity;
      this.velocity += (force / mass) * step;
      this.position += this.velocity * step;
    }
  }
}

/** A spring whose damping ratio is given instead of its damping. */
export const spring = (
  stiffness: number,
  dampingRatio: number,
  mass = 1,
): SpringParams => ({
  stiffness,
  mass,
  damping: dampingRatio * 2 * Math.sqrt(stiffness * mass),
});

/**
 * Everything that sets how the card moves. The presets differ only in feel;
 * each draws the same layout.
 */
export type CardMotion = {
  name: string;
  /** Scrolling between lines. */
  scroll: SpringParams;
  /** Growing into and out of the current line. */
  scale: SpringParams;
  /** Delay between one line starting to scroll and the next, in seconds. */
  stagger: number;
  /** How early the view moves to a line before it is sung, in seconds. */
  lead: number;
  /** How big lines other than the current one are. */
  inactiveScale: number;
  /** Seconds for a line to light up or dim. */
  brighten: number;
  /** Width of a syllable's soft leading edge, in ems. */
  fadeWidth: number;
  /** How far a sung syllable rises, in ems. */
  lift: number;
  /** Strength of the glow and swell on long held words. */
  emphasis: number;
  /** Blur at the top and bottom edges of the lyrics, in pixels. */
  edgeBlur: number;
  /** The default and lyrics layouts swapping. */
  layout: { duration: number; easing: Bezier };
  /** Content fading for a track change or a mode swap, in seconds. */
  fade: number;
};

export const motionPresets = {
  /** Apple Music's feel, a little quicker: the default. */
  snappy: {
    name: "snappy",
    scroll: spring(300, 1, 0.9),
    scale: spring(260, 1),
    stagger: 0.035,
    lead: 0.12,
    inactiveScale: 0.94,
    brighten: 0.18,
    fadeWidth: 0.5,
    lift: 0.05,
    emphasis: 1,
    edgeBlur: 3.5,
    layout: { duration: 0.45, easing: [0.22, 1, 0.36, 1] },
    fade: 0.18,
  },
  /** AMLL's timings, close to Apple Music itself. */
  classic: {
    name: "classic",
    scroll: { stiffness: 200, damping: 2.2 * Math.sqrt(200), mass: 0.9 },
    scale: { stiffness: 100, damping: 25, mass: 2 },
    stagger: 0.05,
    lead: 0,
    inactiveScale: 0.97,
    brighten: 0.3,
    fadeWidth: 0.5,
    lift: 0.05,
    emphasis: 1,
    edgeBlur: 4,
    layout: { duration: 0.7, easing: [0.22, 1, 0.36, 1] },
    fade: 0.25,
  },
  /** Underdamped springs that overshoot a touch, with a bigger size change. */
  bouncy: {
    name: "bouncy",
    scroll: spring(260, 0.62, 0.9),
    scale: spring(320, 0.5),
    stagger: 0.045,
    lead: 0.1,
    inactiveScale: 0.9,
    brighten: 0.15,
    fadeWidth: 0.45,
    lift: 0.08,
    emphasis: 1.35,
    edgeBlur: 3.5,
    layout: { duration: 0.55, easing: [0.34, 1.4, 0.64, 1] },
    fade: 0.16,
  },
  /** Quickest of all: stiff springs, a tight stagger and short fades. */
  instant: {
    name: "instant",
    scroll: spring(520, 1, 0.8),
    scale: spring(480, 1),
    stagger: 0.02,
    lead: 0.15,
    inactiveScale: 0.95,
    brighten: 0.1,
    fadeWidth: 0.35,
    lift: 0.04,
    emphasis: 0.8,
    edgeBlur: 3,
    layout: { duration: 0.3, easing: [0.2, 0.9, 0.3, 1] },
    fade: 0.12,
  },
} satisfies Record<string, CardMotion>;

export type MotionPreset = keyof typeof motionPresets;
export const defaultMotion: CardMotion = motionPresets.snappy;
