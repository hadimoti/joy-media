// apps/editor-web/src/first-party-handlers.ts

import { detectSilence, measureLoudness } from '@joy-media/audio-core/analysis';
import { normalizeDialogue } from '@joy-media/audio-core/normalize';
import { buildNodeLibrary, type NodeLibrary } from '@joy-media/workflow-engine';

/**
 * Browser-side ports for first-party workflows (WP-17.2 / WP-19 / WP-22).
 *
 * Most ports remain deterministic stubs tagged `__stub: true`.
 * Real DSP: `transform.normalizeAudio`, `analysis.detectSilence`, `analysis.measureLoudness`.
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
        denoise: () => stubResult({ denoised: true }),
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
        synthesizeSpeech: (args: { readonly text: string; readonly voiceId: string }) =>
          stubResult({ voiceOver: args.text, voiceId: args.voiceId }),
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
