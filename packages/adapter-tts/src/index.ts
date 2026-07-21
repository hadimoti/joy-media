import type {
  CapabilityDeclaration,
  CapabilityId,
  CapabilityResult,
  Diagnostic,
  GeneratedOutput,
  GenerationProvenance,
  ProviderManifestV2,
  ProviderV2,
} from '@joy-media/provider-sdk';

export type { TTSRequestWithConsent } from './consent-tts.js';
export { synthesizeWithConsent, VoiceConsentError } from './consent-tts.js';

export type TTSEngine = 'fish-speech' | 'f5-tts' | 'kokoro' | 'chatterbox' | 'elevenlabs';

export interface TTSConfig {
  readonly execution: 'worker-local' | 'remote-api';
  readonly engine: TTSEngine;
  readonly modelId?: string;
  readonly voiceId?: string;
  readonly apiKey?: string;
}

export interface TTSInput {
  readonly text: string;
  readonly language?: string;
  readonly voiceId?: string;
  readonly speed?: number;
  readonly pitch?: number;
}

interface WordTiming {
  readonly word: string;
  readonly startUs: number;
  readonly endUs: number;
}

let requestCounter = 0;

function generateRequestId(): string {
  requestCounter++;
  return `tts-${Date.now()}-${requestCounter}`;
}

function generateAssetId(): string {
  return `tts-audio-${Date.now()}-${requestCounter}`;
}

function hashRequest(input: unknown): string {
  const str = JSON.stringify(input);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `hash-${Math.abs(hash).toString(36)}`;
}

const VALID_ENGINES: readonly TTSEngine[] = [
  'fish-speech',
  'f5-tts',
  'kokoro',
  'chatterbox',
  'elevenlabs',
];

function validateConfig(config: TTSConfig): void {
  if (!VALID_ENGINES.includes(config.engine)) {
    throw new RangeError(`engine must be one of: ${VALID_ENGINES.join(', ')}`);
  }

  const remoteEngines: readonly TTSEngine[] = ['elevenlabs'];
  if (remoteEngines.includes(config.engine) && config.execution === 'worker-local') {
    throw new Error(`Engine '${config.engine}' requires remote-api execution`);
  }

  if (config.apiKey !== undefined && typeof config.apiKey !== 'string') {
    throw new TypeError('apiKey must be a string');
  }
}

function validateInput(input: unknown): { valid: boolean; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];

  if (typeof input !== 'object' || input === null) {
    diagnostics.push({
      severity: 'error',
      code: 'INVALID_INPUT',
      message: 'Input must be an object',
    });
    return { valid: false, diagnostics };
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.text !== 'string' || obj.text.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_TEXT',
      message: 'Input must include a non-empty text string',
    });
  }

  if (obj.speed !== undefined) {
    if (typeof obj.speed !== 'number' || obj.speed < 0.5 || obj.speed > 2.0) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_SPEED',
        message: 'speed must be a number between 0.5 and 2.0',
      });
    }
  }

  if (obj.pitch !== undefined) {
    if (typeof obj.pitch !== 'number' || obj.pitch < -12 || obj.pitch > 12) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_PITCH',
        message: 'pitch must be a number between -12 and 12 semitones',
      });
    }
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

function generateWordTimings(text: string, speed: number): WordTiming[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const baseDurationPerWordUs = 400_000 / speed;
  const gapUs = 100_000 / speed;
  const timings: WordTiming[] = [];
  let currentTimeUs = 0;

  for (const word of words) {
    const durationUs = Math.round(baseDurationPerWordUs * (word.length / 5));
    timings.push({
      word,
      startUs: currentTimeUs,
      endUs: currentTimeUs + durationUs,
    });
    currentTimeUs += durationUs + gapUs;
  }

  return timings;
}

function synthesizeSpeech(
  _config: TTSConfig,
  input: TTSInput,
): { audioData: Uint8Array; timings: WordTiming[] } {
  const speed = input.speed ?? 1.0;
  const timings = generateWordTimings(input.text, speed);
  const totalDurationUs = timings.length > 0 ? timings[timings.length - 1]!.endUs : 1_000_000;
  const sampleRate = 24000;
  const numSamples = Math.round((totalDurationUs / 1_000_000) * sampleRate);
  const audioData = new Uint8Array(numSamples * 2);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t) * 0.3;
    const intSample = Math.round(sample * 32767);
    audioData[i * 2] = intSample & 0xff;
    audioData[i * 2 + 1] = (intSample >> 8) & 0xff;
  }

  return { audioData, timings };
}

export function createTTSAdapter(config: TTSConfig): ProviderV2 {
  validateConfig(config);

  const isLocal = config.execution === 'worker-local';
  const modelId = config.modelId ?? config.engine;

  const capability: CapabilityDeclaration = {
    id: 'speech.synthesize',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to synthesize' },
        language: { type: 'string', description: 'Language code (e.g., en, ja)' },
        voiceId: { type: 'string', description: 'Voice identity reference' },
        speed: { type: 'number', minimum: 0.5, maximum: 2.0, description: 'Speech speed' },
        pitch: {
          type: 'number',
          minimum: -12,
          maximum: 12,
          description: 'Pitch shift in semitones',
        },
      },
      required: ['text'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        audio: {
          type: 'object',
          properties: {
            assetId: { type: 'string' },
            mimeType: { type: 'string' },
          },
        },
        timings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              word: { type: 'string' },
              startUs: { type: 'number' },
              endUs: { type: 'number' },
            },
          },
        },
      },
    },
    models: [{ id: modelId, displayName: `${config.engine} TTS` }],
    estimatedResources: {
      estimatedDurationMs: isLocal ? 1000 : 2000,
      estimatedMemoryMb: isLocal ? 384 : 0,
      estimatedGpuMb: isLocal ? 256 : 0,
    },
  };

  const secretFields: string[] = [];
  if (config.apiKey !== undefined) {
    secretFields.push('apiKey');
  }

  const manifest: ProviderManifestV2 = {
    protocolVersion: 2,
    id: `joy.tts-${config.engine}`,
    displayName: `${config.engine} TTS Adapter`,
    adapterVersion: '1.0.0',
    execution: config.execution,
    capabilities: [capability],
    configurationSchema: {
      type: 'object',
      properties: {
        execution: { type: 'string', enum: ['worker-local', 'remote-api'] },
        engine: { type: 'string', enum: VALID_ENGINES as unknown as string[] },
        modelId: { type: 'string' },
        voiceId: { type: 'string' },
        apiKey: { type: 'string' },
      },
      required: ['execution', 'engine'],
    },
    secretFields,
    privacy: {
      dataLeavesDevice: !isLocal,
      retentionDisclosure: isLocal ? undefined : 'Text sent to remote TTS service for synthesis',
    },
  };

  return {
    manifest,
    invoke: async (capabilityId: CapabilityId, input: unknown): Promise<CapabilityResult> => {
      const startTime = Date.now();
      const requestId = generateRequestId();

      if (capabilityId !== 'speech.synthesize') {
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance: {
            providerId: manifest.id,
            modelId,
            adapterVersion: manifest.adapterVersion,
            createdAt: new Date().toISOString(),
            requestHash: hashRequest(input),
            idempotencyKey: requestId,
            processingTimeMs: Date.now() - startTime,
            execution: manifest.execution,
          },
          diagnostics: [
            {
              severity: 'error',
              code: 'UNSUPPORTED_CAPABILITY',
              message: `Capability '${capabilityId}' not supported. This adapter only supports 'speech.synthesize'.`,
            },
          ],
        };
      }

      const validation = validateInput(input);
      if (!validation.valid) {
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance: {
            providerId: manifest.id,
            modelId,
            adapterVersion: manifest.adapterVersion,
            createdAt: new Date().toISOString(),
            requestHash: hashRequest(input),
            idempotencyKey: requestId,
            processingTimeMs: Date.now() - startTime,
            execution: manifest.execution,
          },
          diagnostics: validation.diagnostics,
        };
      }

      const ttsInput = input as TTSInput;

      try {
        const { audioData, timings } = synthesizeSpeech(config, ttsInput);
        const assetId = generateAssetId();

        const output: GeneratedOutput = {
          kind: 'audio',
          assetId,
          mimeType: 'audio/wav',
          bytes: audioData,
          metadata: {
            engine: config.engine,
            modelId,
            language: ttsInput.language ?? 'en',
            voiceId: ttsInput.voiceId ?? config.voiceId ?? 'default',
            speed: ttsInput.speed ?? 1.0,
            pitch: ttsInput.pitch ?? 0,
            wordTimings: timings,
            sampleRate: 24000,
            durationUs: timings.length > 0 ? timings[timings.length - 1]!.endUs : 0,
          },
        };

        const provenance: GenerationProvenance = {
          providerId: manifest.id,
          modelId,
          adapterVersion: manifest.adapterVersion,
          createdAt: new Date().toISOString(),
          requestHash: hashRequest(input),
          idempotencyKey: requestId,
          processingTimeMs: Date.now() - startTime,
          execution: manifest.execution,
        };

        return {
          requestId,
          status: 'succeeded',
          outputs: [output],
          provenance,
          diagnostics: validation.diagnostics,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance: {
            providerId: manifest.id,
            modelId,
            adapterVersion: manifest.adapterVersion,
            createdAt: new Date().toISOString(),
            requestHash: hashRequest(input),
            idempotencyKey: requestId,
            processingTimeMs: Date.now() - startTime,
            execution: manifest.execution,
          },
          diagnostics: [
            ...validation.diagnostics,
            {
              severity: 'error',
              code: 'SYNTHESIS_FAILED',
              message: errorMessage,
            },
          ],
        };
      }
    },
  };
}
