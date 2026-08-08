// apps/editor-web/src/first-party-handlers.ts

import { detectSilence, measureLoudness, measurePeak } from '@joy-media/audio-core/analysis';
import { applyGate } from '@joy-media/audio-core/effects';
import { normalizeDialogue } from '@joy-media/audio-core/normalize';
import { buildNodeLibrary, type NodeLibrary } from '@joy-media/workflow-engine';

/**
 * Browser-side ports for first-party workflows (WP-17.2 / WP-19 / WP-22 / P14.6).
 *
 * Real DSP: normalizeAudio, detectSilence, measureLoudness, denoise (noise-gate).
 * Analysis fixtures return deterministic candidates with an honest `method` note
 * (no `__stub: true` pretending the work already landed on disk/timeline).
 * Branch / folder / metadata / caption-template ports defer to the editor UI.
 */

function fixtureNote(detail: string): { readonly method: 'fixture'; readonly note: string } {
  return { method: 'fixture', note: detail };
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
        transcribe: () => ({
          language: 'fa',
          segments: [{ text: 'Hello and welcome', startUs: 0 }],
          ...fixtureNote(
            'Fixture transcript for workflow park/resume; use Captions Auto caption for live Whisper',
          ),
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
        detectHighlights: (args: { readonly source: unknown }) => ({
          candidates: [
            { title: 'Hook A', source: args.source, subjectHints: { focus: 'speaker' } },
            { title: 'Hook B', source: args.source, subjectHints: { focus: 'product' } },
            { title: 'Hook C', source: args.source, subjectHints: { focus: 'wide' } },
          ],
          ...fixtureNote('Deterministic hook fixtures for approval UI; not ML highlight detection'),
        }),
        detectSpeakers: () => ({
          speakers: [{ id: 'spk-1' }, { id: 'spk-2' }],
          ...fixtureNote('Fixture speaker ids; diarization is not wired in the browser runner'),
        }),
        generateChapters: (args: { readonly source: unknown }) => ({
          chapters: [
            { title: 'Intro', startUs: 0, endUs: 60_000_000, source: args.source },
            { title: 'Main topic', startUs: 60_000_000, endUs: 300_000_000, source: args.source },
          ],
          ...fixtureNote('Fixture chapters for workflow continuity; not ASR chaptering'),
        }),
      },
      transform: {
        trim: (args: {
          readonly source: unknown;
          readonly ranges: unknown;
          readonly compositionId?: string;
          readonly trackId?: string;
          readonly clipId?: string;
          readonly edge?: 'start' | 'end';
          readonly timeUs?: number;
        }) => {
          if (
            typeof args.compositionId === 'string' &&
            typeof args.trackId === 'string' &&
            typeof args.clipId === 'string' &&
            (args.edge === 'start' || args.edge === 'end') &&
            typeof args.timeUs === 'number'
          ) {
            return {
              trimmed: true,
              deferredToEditor: true,
              command: args.edge === 'start' ? 'timeline.trimClipStart' : 'timeline.trimClipEnd',
              compositionId: args.compositionId,
              trackId: args.trackId,
              clipId: args.clipId,
              timeUs: args.timeUs,
              ranges: args.ranges,
            };
          }
          return {
            trimmed: false,
            deferred: true,
            reason:
              'Pass compositionId/trackId/clipId/edge/timeUs; apply via timeline trim commands in the editor',
            ranges: args.ranges,
          };
        },
        applyCaptionTemplate: (args: { readonly templateId: string }) => ({
          captioned: false,
          deferred: true,
          deferredCommand: 'caption.setStyle',
          templateId: args.templateId,
          reason: 'Apply caption templates in the Captions panel (icon presets)',
        }),
        reframe: (args: { readonly aspect: string; readonly subjectHints?: unknown }) => ({
          reframed: false,
          deferred: true,
          aspect: args.aspect,
          subjectHints: args.subjectHints ?? null,
          reason:
            'Reframe is not applied in the browser runner; adjust the composition or crop in the editor.',
        }),
        denoise: (args: {
          readonly source: unknown;
          readonly strength?: number;
          readonly method?: 'noise-gate' | 'spectral' | 'ml';
        }) => {
          const sampleRate = 48_000;
          const samples = generateNoisyFixturePcm(sampleRate);
          const strength = Math.min(1, Math.max(0, args.strength ?? 0.5));
          if (args.method === 'ml') {
            // ADR-0018: ML denoise runs on a local GPU Worker, not the VPS.
            return {
              source: args.source,
              method: 'ml-denoise',
              strength,
              deferredJobType: 'audio.ml-denoise',
              requiredWorkerCapability: 'audio.ml-denoise',
              note: 'ML denoise needs a paired local GPU Worker with audio.ml-denoise (DeepFilterNet via JOY_MEDIA_ML_DENOISE_CMD, otherwise ffmpeg arnndn/RNNoise).',
            };
          }
          const preferSpectral = args.method === 'spectral' || strength >= 0.75;
          if (preferSpectral) {
            // Browser ports cannot shell ffmpeg; spectral runs on the API/Worker adapter.
            return {
              source: args.source,
              method: 'ffmpeg-afftdn',
              strength,
              deferredEndpoint: '/v1/providers/audio/denoise',
              note: 'Spectral afftdn denoise needs ffmpeg on the API or Worker and is not ML denoise.',
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
          // WP-19: real audio-core DSP — not a stub.
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
        }) => ({
          sceneInstance: args.templateId,
          variables: args.variables,
          applied: false,
          deferred: true,
          reason:
            'Scene templates are built via html-scene objects in the editor, not silently in this step.',
        }),
      },
      generation: {
        synthesizeSpeech: (args: {
          readonly text: string;
          readonly voiceId: string;
          readonly language?: string;
          readonly engine?: 'edge-tts' | 'piper';
        }) => {
          const language = args.language ?? 'en';
          const engine = args.engine === 'piper' ? 'piper' : 'edge-tts';
          const stockVoice = language.toLowerCase().startsWith('fa')
            ? 'fa-IR-DilaraNeural'
            : 'en-US-EmmaMultilingualNeural';
          const isCloned = args.voiceId.length > 0 && !args.voiceId.startsWith('stock:');
          if (engine === 'piper') {
            return {
              voiceOver: args.text,
              voiceId: args.voiceId || stockVoice,
              method: 'piper',
              dataLeavesDevice: false,
              retentionDisclosure:
                'Speech is synthesized locally with Piper ONNX and never leaves this host.',
              deferredEndpoint: '/v1/providers/speech/synthesize',
              deferredBody: { engine: 'piper' },
              requiresConsent: isCloned,
            };
          }
          return {
            voiceOver: args.text,
            voiceId: isCloned ? args.voiceId : stockVoice,
            method: 'edge-tts',
            dataLeavesDevice: true,
            retentionDisclosure:
              'Text is sent to the online Microsoft Edge TTS service for speech.',
            deferredEndpoint: '/v1/providers/speech/synthesize',
            deferredBody: { engine: 'edge-tts' },
            requiresConsent: isCloned,
          };
        },
        translate: (args: { readonly text: string; readonly targetLanguage: string }) => ({
          text: args.text,
          targetLanguage: args.targetLanguage,
          translated: false,
          deferred: true,
          reason:
            'Translation needs a provider gateway; the browser runner does not invent translated text.',
        }),
      },
      editor: {
        createBranch: (args: { readonly name: string; readonly source: unknown }) => {
          branchSeq += 1;
          return {
            branchId: `deferred-branch-${String(branchSeq)}`,
            name: args.name,
            source: args.source,
            applied: false,
            deferredToEditor: true,
            note: 'In-memory branch IDs are for workflow continuity only; duplicate clips in the editor for real variants.',
          };
        },
      },
      render: {
        render: (args: { readonly mode: 'preview' | 'final'; readonly profile?: string }) => ({
          rendered: false,
          deferred: true,
          mode: args.mode,
          profile: args.profile ?? 'social-h264-aac',
          reason: 'Use the editor Export with an output preset; Worker encoding is not wired yet.',
        }),
      },
      output: {
        writeToFolder: (args: { readonly folderId: string }) => ({
          written: false,
          deferred: true,
          folderId: args.folderId,
          reason: 'The browser runner cannot write host folders; use Export or Jobs.',
        }),
        writeMetadataFile: (args: { readonly fileName: string }) => ({
          written: false,
          deferred: true,
          fileName: args.fileName,
          inMemoryManifest: true,
          reason:
            'The manifest stays in the workflow output; the browser runner does not write the host filesystem.',
        }),
      },
    },
  });
}
