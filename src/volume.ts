export const volumeGain = (volume: number) =>
  volume === 0 ? 0 : 10 ** (2 * (volume - 1));
