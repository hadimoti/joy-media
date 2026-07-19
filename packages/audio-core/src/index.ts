/** @joy-media/audio-core — deterministic waveform, playback clock, and local WAV export (WP-00.7). */
export const PACKAGE_NAME = '@joy-media/audio-core' as const;

export type { WaveformBucket, PcmWavExport, DriftMeasurement } from './audio.js';
export {
  AudioSpikeError,
  sampleIndexAtUs,
  sampleStartUs,
  buildWaveform,
  AudioPreviewClock,
  exportPcm16Wav,
  measureAudioClockDrift,
} from './audio.js';
