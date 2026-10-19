/** Cross-encoder semantic bounds for generated readiness fixtures. */
export const READINESS_TOLERANCES = {
  durationFrames: 1,
  syncFrames: 1,
  normalizedPcmRmsAbsolute: 0.02,
  toneFrequencyHz: 4,
  solidColors: {
    red: { redMin: 200, greenMax: 60, blueMax: 60 },
    blue: { redMax: 60, greenMax: 60, blueMin: 200 },
    white: { redMin: 235, greenMin: 235, blueMin: 235 },
    dark: { redMax: 32, greenMax: 32, blueMax: 32 },
  },
} as const;
