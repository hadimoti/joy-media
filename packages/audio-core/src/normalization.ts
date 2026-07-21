import { measureLoudness, measurePeak } from './analysis.js';
import { applyGain } from './processing.js';
import { applyCompressor, applyLimiter } from './effects.js';

export interface DialogueNormalizationConfig {
  readonly targetLoudness: number;
  readonly targetPeak: number;
  readonly mode: 'normalize' | 'compress' | 'limit';
}

export interface NormalizationResult {
  readonly gainAdjustment: number;
  readonly inputLoudness: number;
  readonly outputLoudness: number;
  readonly inputPeak: number;
  readonly outputPeak: number;
  readonly processing: 'normalize' | 'compress' | 'limit';
}

export function normalizeDialogue(
  samples: Float32Array,
  sampleRate: number,
  config: DialogueNormalizationConfig,
): { samples: Float32Array; result: NormalizationResult } {
  const inputLoudness = measureLoudness(samples, sampleRate).integrated;
  const inputPeak = measurePeak(samples).peakDb;

  const loudnessDiff = config.targetLoudness - inputLoudness;
  const gainAdjustment = Math.pow(10, loudnessDiff / 20);

  let processed = applyGain(samples, gainAdjustment);

  if (config.mode === 'compress' || config.mode === 'limit') {
    const currentPeakDb = measurePeak(processed).peakDb;
    const peakDiff = currentPeakDb - config.targetPeak;

    if (peakDiff > 0) {
      if (config.mode === 'compress') {
        processed = applyCompressor(
          processed,
          {
            threshold: config.targetPeak - 6,
            ratio: 4,
            attackUs: 5000,
            releaseUs: 50000,
            knee: 6,
          },
          sampleRate,
        );
      } else {
        processed = applyLimiter(processed, config.targetPeak, 50000, sampleRate);
      }
    }
  }

  const outputLoudness = measureLoudness(processed, sampleRate).integrated;
  const outputPeak = measurePeak(processed).peakDb;

  return {
    samples: processed,
    result: {
      gainAdjustment,
      inputLoudness,
      outputLoudness,
      inputPeak,
      outputPeak,
      processing: config.mode,
    },
  };
}
