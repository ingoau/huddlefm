const toDecibels = (gain: number) => (gain ? 20 * Math.log10(gain) : -1000);
const toGain = (decibels: number) => 10 ** (decibels / 20);
const clean = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback;

/** Chromium recomputes the attack or release rate every 32 frames. */
const divisionFrames = 32;
/** The largest look-ahead the delay line holds, as in Chromium. */
const maxDelayFrames = 1024;
/** How fast the detector lets go of a peak: 2.5 ms. */
const detectorReleaseSeconds = 0.0025;
/** Release speed at 15, 10, 5 and 0 dB of gain still to recover, as a share of the release time. */
const releaseZones = [0.09, 0.16, 0.42, 0.98] as const;

/**
 * A port of Chromium's DynamicsCompressorKernel with the Web Audio
 * DynamicsCompressorNode defaults the media page ran the music through:
 * threshold -24 dB, a 30 dB knee above it, ratio 12, 3 ms attack, 250 ms
 * release, a 6 ms look-ahead, adaptive release and Chromium's makeup gain.
 * It keeps the native backend as loud and as dynamic as the browser one.
 */
export class Compressor {
  private linearThreshold: number;
  private kneeThreshold: number;
  private kneeThresholdDecibels: number;
  private kneeOutputDecibels: number;
  private slope: number;
  private k: number;
  private makeup: number;
  private attackFrames: number;
  private detectorReleaseFrames: number;
  private release: [number, number, number, number, number];

  private left = new Float32Array(maxDelayFrames);
  private right = new Float32Array(maxDelayFrames);
  private readIndex = 0;
  private writeIndex: number;

  private detectorAverage = 0;
  private compressorGain = 1;
  private maxAttackDifference = -1;
  private divisionFrame = 0;
  private envelopeRate = 1;
  private desiredGain = 1;

  constructor(
    sampleRate = 48_000,
    threshold = -24,
    knee = 30,
    ratio = 12,
    attackSeconds = 0.003,
    releaseSeconds = 0.25,
    preDelaySeconds = 0.006,
  ) {
    this.linearThreshold = toGain(threshold);
    this.slope = 1 / ratio;
    this.kneeThresholdDecibels = threshold + knee;
    this.kneeThreshold = toGain(this.kneeThresholdDecibels);
    this.k = this.kAtSlope(this.slope);
    this.kneeOutputDecibels = toDecibels(
      this.kneeCurve(this.kneeThreshold, this.k),
    );
    // Chromium raises the output by (1 / gain at 0 dBFS) ^ 0.6.
    this.makeup = (1 / this.saturate(1)) ** 0.6;
    this.attackFrames = Math.max(0.001, attackSeconds) * sampleRate;
    this.detectorReleaseFrames = detectorReleaseSeconds * sampleRate;
    // A quartic through the four release zones at x = 0, 1, 2 and 3.
    const [y1, y2, y3, y4] = releaseZones.map(
      (zone) => zone * releaseSeconds * sampleRate,
    ) as [number, number, number, number];
    this.release = [
      0.9999999999999998 * y1 +
        1.8432219684323923e-16 * y2 -
        1.9373394351676423e-16 * y3 +
        8.824516011816245e-18 * y4,
      -1.5788320352845888 * y1 +
        2.3305837032074286 * y2 -
        0.9141194204840429 * y3 +
        0.1623677525612032 * y4,
      0.5334142869106424 * y1 -
        1.272736789213631 * y2 +
        0.9258856042207512 * y3 -
        0.18656310191776226 * y4,
      0.08783463138207234 * y1 -
        0.1694162967925622 * y2 +
        0.08588057951595272 * y3 -
        0.00429891410546283 * y4,
      -0.042416883008123074 * y1 +
        0.1115693827987602 * y2 -
        0.09764676325265872 * y3 +
        0.028494263462021576 * y4,
    ];
    this.writeIndex = Math.min(
      maxDelayFrames - 1,
      Math.floor(preDelaySeconds * sampleRate),
    );
  }

  /** Output level in dB, before makeup, for a steady input level in dB. */
  curve(input: number) {
    return toDecibels(this.saturate(toGain(input)));
  }

  /** Compresses interleaved stereo samples in place. */
  process(samples: Float32Array) {
    for (let index = 0; index + 1 < samples.length; index += 2) {
      if (this.divisionFrame === 0) this.updateEnvelope();
      this.divisionFrame = (this.divisionFrame + 1) % divisionFrames;

      const left = samples[index]!;
      const right = samples[index + 1]!;
      this.left[this.writeIndex] = left;
      this.right[this.writeIndex] = right;

      // The detector reads the undelayed input, so the gain is already down
      // when a peak comes out of the delay line.
      const input = Math.max(Math.abs(left), Math.abs(right));
      const attenuation = input <= 0.0001 ? 1 : this.saturate(input) / input;
      const attenuationDecibels = Math.max(2, -toDecibels(attenuation));
      const releaseRate =
        toGain(attenuationDecibels / this.detectorReleaseFrames) - 1;
      const rate = attenuation > this.detectorAverage ? releaseRate : 1;
      this.detectorAverage += (attenuation - this.detectorAverage) * rate;
      this.detectorAverage = clean(Math.min(1, this.detectorAverage), 1);

      if (this.envelopeRate < 1)
        this.compressorGain +=
          (this.desiredGain - this.compressorGain) * this.envelopeRate;
      else
        this.compressorGain = Math.min(
          1,
          this.compressorGain * this.envelopeRate,
        );

      // Chromium warps the gain to smooth the exponential's sharp corners.
      const gain = this.makeup * Math.sin((Math.PI / 2) * this.compressorGain);
      samples[index] = this.left[this.readIndex]! * gain;
      samples[index + 1] = this.right[this.readIndex]! * gain;
      this.readIndex = (this.readIndex + 1) % maxDelayFrames;
      this.writeIndex = (this.writeIndex + 1) % maxDelayFrames;
    }
    return samples;
  }

  /** Picks the attack or release rate for the next 32 frames. */
  private updateEnvelope() {
    const detected = clean(this.detectorAverage, 1);
    this.detectorAverage = detected;
    // Pre-warped so the sine warp lands on the detected gain.
    this.desiredGain = Math.asin(detected) / (Math.PI / 2);
    const releasing = this.desiredGain > this.compressorGain;
    let difference = toDecibels(this.compressorGain / this.desiredGain);
    if (releasing) {
      this.maxAttackDifference = -1;
      difference = clean(difference, -1);
      // The more gain is left to recover, the faster it releases.
      const x = 0.25 * (Math.min(0, Math.max(-12, difference)) + 12);
      const [a, b, c, d, e] = this.release;
      const frames = a + x * (b + x * (c + x * (d + x * e)));
      this.envelopeRate = toGain(5 / frames);
    } else {
      difference = clean(difference, 1);
      if (
        this.maxAttackDifference === -1 ||
        this.maxAttackDifference < difference
      )
        this.maxAttackDifference = difference;
      const effective = Math.max(0.5, this.maxAttackDifference);
      this.envelopeRate = 1 - (0.25 / effective) ** (1 / this.attackFrames);
    }
  }

  /** Linear below the threshold, then the knee, then the ratio. */
  private saturate(x: number) {
    if (x < this.kneeThreshold) return this.kneeCurve(x, this.k);
    return toGain(
      this.kneeOutputDecibels +
        this.slope * (toDecibels(x) - this.kneeThresholdDecibels),
    );
  }

  private kneeCurve(x: number, k: number) {
    if (x < this.linearThreshold) return x;
    return (
      this.linearThreshold + (1 - Math.exp(-k * (x - this.linearThreshold))) / k
    );
  }

  private slopeAt(x: number, k: number) {
    if (x < this.linearThreshold) return 1;
    const x2 = x * 1.001;
    return (
      (toDecibels(this.kneeCurve(x2, k)) - toDecibels(this.kneeCurve(x, k))) /
      (toDecibels(x2) - toDecibels(x))
    );
  }

  /** The knee sharpness whose slope at the knee's top matches the ratio. */
  private kAtSlope(slope: number) {
    let low = 0.1;
    let high = 10_000;
    let k = 5;
    for (let step = 0; step < 15; step++) {
      if (this.slopeAt(this.kneeThreshold, k) < slope) high = k;
      else low = k;
      k = Math.sqrt(low * high);
    }
    return k;
  }
}
