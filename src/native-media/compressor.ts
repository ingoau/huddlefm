const toDecibels = (gain: number) => 20 * Math.log10(gain);
const toGain = (decibels: number) => 10 ** (decibels / 20);

/**
 * A stereo-linked compressor with the defaults of the Web Audio
 * DynamicsCompressorNode the media page ran the music through: threshold
 * -24 dB, 30 dB soft knee, ratio 12, 3 ms attack, 250 ms release, and
 * Chromium's automatic makeup gain. It keeps the native backend about as loud
 * and as even as the browser one.
 */
export class Compressor {
  private reductionDecibels = 0;
  private attack: number;
  private release: number;
  private makeup: number;

  constructor(
    sampleRate = 48_000,
    private threshold = -24,
    private knee = 30,
    private ratio = 12,
    attackSeconds = 0.003,
    releaseSeconds = 0.25,
  ) {
    this.attack = 1 - Math.exp(-1 / (attackSeconds * sampleRate));
    this.release = 1 - Math.exp(-1 / (releaseSeconds * sampleRate));
    // Chromium raises the output by (1 / gain at 0 dBFS) ^ 0.6.
    this.makeup = toGain(-0.6 * (this.curve(0) - 0));
  }

  /** Output level in dB for a steady input level in dB. */
  curve(input: number) {
    const over = input - this.threshold;
    if (2 * over < -this.knee) return input;
    if (2 * Math.abs(over) <= this.knee)
      return (
        input +
        ((1 / this.ratio - 1) * (over + this.knee / 2) ** 2) / (2 * this.knee)
      );
    return this.threshold + over / this.ratio;
  }

  /** Compresses interleaved stereo samples in place. */
  process(samples: Float32Array) {
    for (let index = 0; index + 1 < samples.length; index += 2) {
      const left = samples[index]!;
      const right = samples[index + 1]!;
      const peak = Math.max(Math.abs(left), Math.abs(right));
      const level = peak > 1e-6 ? toDecibels(peak) : -120;
      const target = level - this.curve(level);
      const coefficient =
        target > this.reductionDecibels ? this.attack : this.release;
      this.reductionDecibels += (target - this.reductionDecibels) * coefficient;
      const gain = toGain(-this.reductionDecibels) * this.makeup;
      samples[index] = left * gain;
      samples[index + 1] = right * gain;
    }
    return samples;
  }
}
