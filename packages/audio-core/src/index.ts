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
export { decodeWaveformPeaks, encodeWaveformPeaks } from './peaks.js';

export type {
  AudioClipConfig,
  AudioBus,
  EqBand,
  AudioEffect,
  AudioEffectInstance,
  AudioGraphState,
} from './graph.js';
export { DEFAULT_CLIP_CONFIG } from './graph.js';

export { applyGain, applyPan, applyFade, applyCrossfade, mixBuses } from './processing.js';

export type { CompressorConfig, GateConfig } from './effects.js';
export { applyEq, applyCompressor, applyLimiter, applyGate } from './effects.js';

export type {
  PeakMeasurement,
  ClippingDetection,
  LoudnessMeasurement,
  SilenceDetection,
} from './analysis.js';
export { measurePeak, detectClipping, measureLoudness, detectSilence } from './analysis.js';

export type { AudioMeter } from './meter.js';
export { computeMeter } from './meter.js';

export type { DialogueNormalizationConfig, NormalizationResult } from './normalization.js';
export { normalizeDialogue } from './normalization.js';

export type { VoiceOverSession } from './voiceover.js';
export {
  createVoiceOverSession,
  startRecording,
  pauseRecording,
  resumeRecording,
  stopRecording,
  appendSamples,
} from './voiceover.js';

export type { PreviewStem } from './stems.js';
export { PreviewStemCache, computeStemHash } from './stems.js';

export type {
  OfflineRenderConfig,
  OfflineAudioAutomation,
  AudioClipRenderSpec,
  OfflineRenderResult,
  AudioRenderJob,
  AudioRenderRequest,
} from './offline.js';
export { renderOfflineAudio } from './offline.js';

export type {
  AudioChannelObservation,
  AudioCompositionTimeMapping,
  AudioObservationAnalysis,
  AudioObservationAnalysisOptions,
  AudioObservationSource,
  AudioObservationWindow,
  AudioObservationWindowRequest,
  AudioPeakEvidence,
  AudioRateRatio,
  AudioResamplingDeclaration,
} from './observation-analysis.js';
export {
  analyzeAudioObservationWindow,
  assertAudioObservationWindow,
  AudioObservationError,
  DEFAULT_AUDIO_SILENCE_THRESHOLD_DB,
  extractAudioObservationWindow,
  mapSourceTimeToCompositionTime,
  MAX_AUDIO_OBSERVATION_CHANNELS,
  MAX_AUDIO_OBSERVATION_SAMPLES_PER_CHANNEL,
  sourceTimeAtAudioObservationSample,
} from './observation-analysis.js';

export type {
  AudioEnvelopePoint,
  AudioOnsetEvidence,
  BeatEnvelopeEstimate,
  BeatEnvelopeOptions,
} from './beat-envelope.js';
export {
  BEAT_ENVELOPE_ALGORITHM_VERSION,
  buildBeatEnvelope,
  MAX_AUDIO_ENVELOPE_POINTS,
  MAX_AUDIO_ENVELOPE_SAMPLE_VISITS,
} from './beat-envelope.js';
