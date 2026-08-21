import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { ControlPlaneError } from './control-plane.js';
import type { CapabilityRequest, ProviderV2 } from '@joy-media/provider-sdk';

export type SpeechEngineId = 'edge-tts' | 'piper';

export interface SpeechSynthesisRequest {
  readonly text: string;
  readonly language?: string;
  readonly voiceId?: string;
  readonly speed?: number;
  /** Default: JOY_MEDIA_TTS_ENGINE env, else edge-tts. */
  readonly engine?: SpeechEngineId;
  readonly idempotencyKey?: string;
}

export interface SpeechSynthesisResult {
  readonly assetId: string;
  readonly mimeType: string;
  readonly bytesBase64: string;
  readonly voiceId: string;
  readonly engine: SpeechEngineId;
  readonly modelId: string;
  readonly dataLeavesDevice: boolean;
  readonly retentionDisclosure: string;
  readonly durationUs: number;
}

export function resolveEdgeVoice(
  language: string | undefined,
  voiceId: string | undefined,
): string {
  if (voiceId !== undefined && voiceId.length > 0 && !voiceId.startsWith('stock:')) {
    return voiceId;
  }
  const lang = (language ?? 'en').toLowerCase();
  if (lang.startsWith('fa')) return 'fa-IR-DilaraNeural';
  if (lang.startsWith('en')) return 'en-US-EmmaMultilingualNeural';
  return 'en-US-EmmaMultilingualNeural';
}

function resolvePiperModel(language: string | undefined, voiceId: string | undefined): string {
  if (
    voiceId !== undefined &&
    voiceId.length > 0 &&
    voiceId.endsWith('.onnx') &&
    existsSync(voiceId)
  ) {
    return voiceId;
  }
  const voicesDir =
    process.env.JOY_MEDIA_PIPER_VOICES_DIR?.trim() || '/opt/joy-media/data/piper/voices';
  const lang = (language ?? 'en').toLowerCase();
  const preferred = lang.startsWith('fa')
    ? join(voicesDir, 'fa_IR-gyro-medium.onnx')
    : join(voicesDir, 'en_US-lessac-medium.onnx');
  if (existsSync(preferred)) return preferred;
  const fallback = join(voicesDir, 'en_US-lessac-medium.onnx');
  if (existsSync(fallback)) return fallback;
  throw new ControlPlaneError(
    'PROVIDER_UNAVAILABLE',
    `Piper voice model missing under ${voicesDir}`,
  );
}

function estimateDurationUs(text: string): number {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, wordCount) * 400_000;
}

function assetIdFor(text: string): string {
  return `tts-${createHash('sha256').update(text).digest('hex').slice(0, 12)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Run Microsoft Edge online TTS (text leaves the device — disclosed in the result).
 */
export function runEdgeSpeechSynthesis(request: SpeechSynthesisRequest): SpeechSynthesisResult {
  if (typeof request.text !== 'string' || request.text.trim().length === 0) {
    throw new ControlPlaneError('REQUEST_INVALID', 'text is required');
  }
  const command = process.env.JOY_MEDIA_EDGE_TTS ?? 'edge-tts';
  const voice = resolveEdgeVoice(request.language, request.voiceId);
  const speed = request.speed ?? 1.0;
  const ratePercent = Math.round((speed - 1) * 100);
  const rate = `${ratePercent >= 0 ? '+' : ''}${ratePercent}%`;
  const dir = mkdtempSync(join(tmpdir(), 'joy-edge-tts-'));
  const mediaPath = join(dir, 'speech.mp3');
  try {
    const result = spawnSync(
      command,
      ['-t', request.text, '-v', voice, '--rate', rate, '--write-media', mediaPath],
      {
        encoding: 'utf8',
        timeout: Number(process.env.JOY_MEDIA_TTS_TIMEOUT_MS ?? 60_000),
      },
    );
    if (result.status !== 0 || !existsSync(mediaPath)) {
      throw new ControlPlaneError(
        'PROVIDER_FAILED',
        `edge-tts failed: ${(result.stderr || result.stdout || 'no output').slice(0, 400)}`,
      );
    }
    const bytes = readFileSync(mediaPath);
    return {
      assetId: assetIdFor(request.text),
      mimeType: 'audio/mpeg',
      bytesBase64: bytes.toString('base64'),
      voiceId: voice,
      engine: 'edge-tts',
      modelId: 'edge-tts',
      dataLeavesDevice: true,
      retentionDisclosure: 'Text is sent to Microsoft Edge online TTS for synthesis',
      durationUs: estimateDurationUs(request.text),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Local Piper ONNX TTS — text stays on this host (no egress).
 */
export function runPiperSpeechSynthesis(request: SpeechSynthesisRequest): SpeechSynthesisResult {
  if (typeof request.text !== 'string' || request.text.trim().length === 0) {
    throw new ControlPlaneError('REQUEST_INVALID', 'text is required');
  }
  const command = process.env.JOY_MEDIA_PIPER?.trim() || '/opt/joy-media/data/piper/piper/piper';
  if (!existsSync(command)) {
    throw new ControlPlaneError(
      'PROVIDER_UNAVAILABLE',
      `Piper binary not found at ${command}; set JOY_MEDIA_PIPER`,
    );
  }
  const model = resolvePiperModel(request.language, request.voiceId);
  const dir = mkdtempSync(join(tmpdir(), 'joy-piper-tts-'));
  const mediaPath = join(dir, 'speech.wav');
  try {
    const lengthScale =
      request.speed !== undefined && request.speed > 0 ? 1 / request.speed : undefined;
    const args = ['--model', model, '--output_file', mediaPath];
    if (lengthScale !== undefined) {
      args.push('--length_scale', String(lengthScale));
    }
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      input: request.text,
      timeout: Number(process.env.JOY_MEDIA_TTS_TIMEOUT_MS ?? 60_000),
    });
    if (result.status !== 0 || !existsSync(mediaPath)) {
      throw new ControlPlaneError(
        'PROVIDER_FAILED',
        `piper failed: ${(result.stderr || result.stdout || 'no output').slice(0, 400)}`,
      );
    }
    const bytes = readFileSync(mediaPath);
    return {
      assetId: assetIdFor(request.text),
      mimeType: 'audio/wav',
      bytesBase64: bytes.toString('base64'),
      voiceId: model,
      engine: 'piper',
      modelId: 'piper-onnx',
      dataLeavesDevice: false,
      retentionDisclosure:
        'Text is synthesized locally with Piper ONNX; it does not leave this host',
      durationUs: estimateDurationUs(request.text),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function resolveSpeechEngine(requested: unknown): SpeechEngineId {
  if (requested === 'piper' || requested === 'edge-tts') return requested;
  const fromEnv = (process.env.JOY_MEDIA_TTS_ENGINE ?? 'edge-tts').trim().toLowerCase();
  if (fromEnv === 'piper') return 'piper';
  return 'edge-tts';
}

/** Dispatch TTS by engine (piper = local; edge-tts = remote egress). */
export function runSpeechSynthesis(request: SpeechSynthesisRequest): SpeechSynthesisResult {
  const engine = resolveSpeechEngine(request.engine);
  if (engine === 'piper') return runPiperSpeechSynthesis(request);
  return runEdgeSpeechSynthesis(request);
}

export function speechSynthesisProvider(engine: SpeechEngineId): ProviderV2 {
  return {
    manifest: {
      protocolVersion: 2,
      id: engine === 'edge-tts' ? 'edge-tts' : 'piper',
      displayName: engine === 'edge-tts' ? 'Microsoft Edge TTS' : 'Piper TTS',
      adapterVersion: '1.0.0',
      execution: engine === 'edge-tts' ? 'remote-api' : 'server',
      capabilities: [
        {
          id: 'speech.synthesize',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          models: [{ id: engine, displayName: engine === 'edge-tts' ? 'Edge TTS' : 'Piper ONNX' }],
          ...(engine === 'edge-tts'
            ? {
                pricing: { model: 'per-character' as const, rate: '0.00', currency: 'USD' },
                policyFlags: ['remote-processing', 'privacy-approval-required'],
              }
            : {}),
        },
      ],
      configurationSchema: { type: 'object' },
      secretFields: [],
      privacy: {
        dataLeavesDevice: engine === 'edge-tts',
        retentionDisclosure:
          engine === 'edge-tts'
            ? 'Text is sent to Microsoft Edge online TTS for synthesis'
            : 'Text is synthesized locally with Piper ONNX; it does not leave this host',
      },
    },
    invoke: async () => {
      throw new Error('speech synthesis provider descriptor is preflight-only');
    },
  };
}

export function speechSynthesisCapabilityRequest(
  request: SpeechSynthesisRequest & { readonly idempotencyKey: string },
): CapabilityRequest {
  return {
    requestVersion: 1,
    capability: 'speech.synthesize',
    input: {
      text: request.text,
      ...(request.language === undefined ? {} : { language: request.language }),
      ...(request.voiceId === undefined ? {} : { voiceId: request.voiceId }),
      ...(request.speed === undefined ? {} : { speed: request.speed }),
      engine: resolveSpeechEngine(request.engine),
    },
    constraints: {
      executionPreference: [
        resolveSpeechEngine(request.engine) === 'edge-tts' ? 'remote' : 'local',
      ],
    },
    idempotencyKey: request.idempotencyKey,
  };
}
