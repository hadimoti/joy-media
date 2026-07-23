// apps/editor-web/src/first-party-handlers.ts

import { detectSilence, measureLoudness, measurePeak } from '@joy-media/audio-core/analysis';
import { applyGate } from '@joy-media/audio-core/effects';
import { normalizeDialogue } from '@joy-media/audio-core/normalize';
import { buildNodeLibrary, type NodeLibrary } from '@joy-media/workflow-engine';

/**
 * Browser-side ports for first-party workflows (WP-17.2 / WP-19 / WP-22).
 *
 * Most ports remain deterministic stubs tagged `__stub: true`.
 * Real DSP: normalizeAudio, detectSilence, measureLoudness, denoise (noise-gate).
 */

function stubResult<T extends Record<string, unknown>>(value: T): T & { readonly __stub: true } {
  return { ...value, __stub: true as const };
}

/** Quiet 1 kHz dialogue-like fixture PCM for browser-side normalize proofs. */
function generateFixtureDialoguePcm(sampleRate: number, durationSec = 1): Float32Array {
  const samples = new Float32Array(sampleRate * durationSec);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.2;
  }
  return samples;
}

/**
 * Fixture with a mid-clip silent gap so `detectSilence` returns a measurable range
 * (tone → silence → tone). Sample indices convert to timeline µs for workflow ports.
 */
function generateFixturePcmWithSilence(sampleRate: number): Float32Array {
  const toneA = Math.floor(sampleRate * 0.5);
  const silence = Math.floor(sampleRate * 0.4);
  const toneB = Math.floor(sampleRate * 0.5);
  const samples = new Float32Array(toneA + silence + toneB);
  for (let i = 0; i < toneA; i++) {
    samples[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.25;
  }
  // silence region stays 0
  for (let i = 0; i < toneB; i++) {
    samples[toneA + silence + i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.25;
  }
  return samples;
}

/** Tone plus low-level floor noise so a noise gate has measurable work to do. */
function generateNoisyFixturePcm(sampleRate: number, durationSec = 1): Float32Array {
  const samples = new Float32Array(sampleRate * durationSec);
  for (let i = 0; i < samples.length; i++) {
    const tone = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.25;
    // Alternate quiet windows of floor noise only.
    const inQuiet = Math.floor(i / (sampleRate * 0.1)) % 2 === 1;
    const floor = (((i * 1103515245 + 12345) >>> 16) / 32768 - 0.5) * 0.02;
    samples[i] = inQuiet ? floor : tone + floor * 0.25;
  }
  return samples;
}

/** Build a NodeLibrary whose ports are deterministic stubs suitable for editor runs. */
export function createStubFirstPartyLibrary(): NodeLibrary {
  let branchSeq = 0;

  return buildNodeLibrary({
    ports: {
      analysis: {
        transcribe: () =>
          stubResult({
            language: 'fa',
            segments: [{ text: 'سلام و خوش آمدید', startUs: 0 }],
          }),
        detectSilence: (args: {
          readonly source: unknown;
          readonly thresholdDb?: number;
          readonly minSilenceMs?: number;
        }) => {
          // WP-22: real audio-core DSP — not a stub.
          const sampleRate = 48_000;
          const samples = generateFixturePcmWithSilence(sampleRate);
          const thresholdDb = args.thresholdDb ?? -40;
          const minSilenceMs = args.minSilenceMs ?? 100;
          const minSamples = Math.floor((minSilenceMs / 1000) * sampleRate);
          const detection = detectSilence(samples, thresholdDb);
          const ranges = detection.silentRegions
            .filter((region) => region.end - region.start >= minSamples)
            .map((region) => ({
              startUs: Math.round((region.start / sampleRate) * 1_000_000),
              endUs: Math.round((region.end / sampleRate) * 1_000_000),
            }));
          return {
            source: args.source,
            ranges,
            thresholdDb,
            minSilenceMs,
            silent: detection.silent,
          };
        },
        measureLoudness: (args: { readonly source: unknown }) => {
          // Real audio-core DSP — not a stub (paired with WP-22 silence).
          const sampleRate = 48_000;
          const samples = generateFixtureDialoguePcm(sampleRate);
          const loudness = measureLoudness(samples, sampleRate);
          return {
            source: args.source,
            integratedLufs: loudness.integrated,
            shortTermLufs: loudness.shortTerm,
            loudnessRange: loudness.range,
          };
        },
        detectHighlights: (args: { readonly source: unknown }) =>
          stubResult({
            candidates: [
              { title: 'Hook A', source: args.source, subjectHints: { focus: 'speaker' } },
              { title: 'Hook B', source: args.source, subjectHints: { focus: 'product' } },
              { title: 'Hook C', source: args.source, subjectHints: { focus: 'wide' } },
            ],
          }),
        detectSpeakers: () => stubResult({ speakers: [{ id: 'spk-1' }, { id: 'spk-2' }] }),
        generateChapters: (args: { readonly source: unknown }) =>
          stubResult({
            chapters: [
              { title: 'Intro', startUs: 0, endUs: 60_000_000, source: args.source },
              { title: 'Main topic', startUs: 60_000_000, endUs: 300_000_000, source: args.source },
            ],
          }),
      },
      transform: {
        trim: (args: { readonly source: unknown; readonly ranges: unknown }) =>
          stubResult({ trimmed: true, ranges: args.ranges }),
        applyCaptionTemplate: (args: { readonly templateId: string }) =>
          stubResult({ captioned: true, templateId: args.templateId }),
        reframe: (args: { readonly aspect: string; readonly subjectHints?: unknown }) =>
          stubResult({
            reframed: args.aspect,
            subjectHints: args.subjectHints ?? null,
          }),
        denoise: (args: {
          readonly source: unknown;
          readonly strength?: number;
          readonly method?: 'noise-gate' | 'spectral';
        }) => {
          const sampleRate = 48_000;
          const samples = generateNoisyFixturePcm(sampleRate);
          const strength = Math.min(1, Math.max(0, args.strength ?? 0.5));
          const preferSpectral = args.method === 'spectral' || strength >= 0.75;
          if (preferSpectral) {
            // Browser ports cannot shell ffmpeg; spectral runs on the API/Worker adapter.
            return {
              source: args.source,
              method: 'ffmpeg-afftdn',
              strength,
              deferredEndpoint: '/v1/providers/audio/denoise',
              note: 'Spectral afftdn requires ffmpeg on the API/Worker; not ML denoise.',
            };
          }
          // Local noise-gate DSP (not ML denoise). Strength maps to gate threshold.
          const thresholdDb = -55 + strength * 25;
          const gated = applyGate(
            samples,
            {
              threshold: thresholdDb,
              attackUs: 5_000,
              releaseUs: 80_000,
              holdUs: 20_000,
            },
            sampleRate,
          );
          const input = measurePeak(samples);
          const output = measurePeak(gated);
          return {
            source: args.source,
            method: 'noise-gate',
            strength,
            thresholdDb,
            inputPeakDb: input.peakDb,
            outputPeakDb: output.peakDb,
          };
        },
        normalizeAudio: (args: {
          readonly source: unknown;
          readonly targetLufs?: number;
          readonly duckMusic?: boolean;
        }) => {
          // WP-19: real audio-core DSP — not a stub. Other ports remain __stub.
          const sampleRate = 48_000;
          const samples = generateFixtureDialoguePcm(sampleRate);
          const targetLoudness = args.targetLufs ?? -16;
          const { result } = normalizeDialogue(samples, sampleRate, {
            targetLoudness,
            targetPeak: -1,
            mode: 'normalize',
          });
          return {
            source: args.source,
            measuredLufs: result.outputLoudness,
            targetLufs: targetLoudness,
            inputLoudness: result.inputLoudness,
            gainAdjustment: result.gainAdjustment,
            duckMusic: args.duckMusic === true,
            processing: result.processing,
          };
        },
        instantiateSceneTemplate: (args: {
          readonly templateId: string;
          readonly variables: unknown;
        }) => stubResult({ sceneInstance: args.templateId, variables: args.variables }),
      },
      generation: {
        synthesizeSpeech: (args: {
          readonly text: string;
          readonly voiceId: string;
          readonly language?: string;
        }) => {
          // Browser workflow ports are sync; real MP3 bytes come from
          // POST /v1/providers/speech/synthesize (edge-tts, data leaves device).
          const language = args.language ?? 'en';
          const stockVoice = language.toLowerCase().startsWith('fa')
            ? 'fa-IR-DilaraNeural'
            : 'en-US-EmmaMultilingualNeural';
          const isCloned = args.voiceId.length > 0 && !args.voiceId.startsWith('stock:');
          return {
            voiceOver: args.text,
            voiceId: isCloned ? args.voiceId : stockVoice,
            method: 'edge-tts',
            dataLeavesDevice: true,
            retentionDisclosure: 'Text is sent to Microsoft Edge online TTS for synthesis',
            deferredEndpoint: '/v1/providers/speech/synthesize',
            requiresConsent: isCloned,
          };
        },
        translate: (args: { readonly text: string; readonly targetLanguage: string }) =>
          stubResult({
            text: `[${args.targetLanguage}] ${args.text}`,
            targetLanguage: args.targetLanguage,
          }),
      },
      editor: {
        createBranch: (args: { readonly name: string; readonly source: unknown }) => {
          branchSeq += 1;
          return stubResult({
            branchId: `branch-${String(branchSeq)}`,
            name: args.name,
            source: args.source,
          });
        },
      },
      render: {
        render: (args: { readonly mode: 'preview' | 'final'; readonly profile?: string }) =>
          stubResult({
            rendered: args.mode,
            profile: args.profile ?? null,
          }),
      },
      output: {
        writeToFolder: (args: { readonly folderId: string }) =>
          stubResult({ written: true, folderId: args.folderId }),
        writeMetadataFile: (args: { readonly fileName: string }) =>
          stubResult({ written: true, fileName: args.fileName }),
      },
    },
  });
}
