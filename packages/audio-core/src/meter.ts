export interface AudioMeter {
  readonly peak: number;
  readonly peakDb: number;
  readonly rms: number;
  readonly clipping: boolean;
}

export function computeMeter(samples: Float32Array): AudioMeter {
  let peak = 0;
  let sumSquares = 0;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    const abs = Math.abs(sample);
    if (abs > peak) {
      peak = abs;
    }
    sumSquares += sample * sample;
  }

  const peakDb = 20 * Math.log10(peak + 1e-10);
  const rms = Math.sqrt(sumSquares / samples.length);
  const clipping = peak >= 1.0;

  return { peak, peakDb, rms, clipping };
}
