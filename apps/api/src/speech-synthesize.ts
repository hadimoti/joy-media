import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { ControlPlaneError } from './control-plane.js';

export interface SpeechSynthesisRequest {
  readonly text: string;
  readonly language?: string;
  readonly voiceId?: string;
  readonly speed?: number;
}

export interface SpeechSynthesisResult {
  readonly assetId: string;
  readonly mimeType: string;
  readonly bytesBase64: string;
  readonly voiceId: string;
  readonly engine: 'edge-tts';
  readonly modelId: string;
  readonly dataLeavesDevice: true;
  readonly retentionDisclosure: string;
  readonly durationUs: number;
}

export function resolveEdgeVoice(language: string | undefined, voiceId: string | undefined): string {
  if (voiceId !== undefined && voiceId.length > 0 && !voiceId.startsWith('stock:')) {
    return voiceId;
  }
  const lang = (language ?? 'en').toLowerCase();
  if (lang.startsWith('fa')) return 'fa-IR-DilaraNeural';
  if (lang.startsWith('en')) return 'en-US-EmmaMultilingualNeural';
  return 'en-US-EmmaMultilingualNeural';
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
    const wordCount = request.text.trim().split(/\s+/).filter(Boolean).length;
    const durationUs = Math.max(1, wordCount) * 400_000;
    const assetId = `tts-${createHash('sha256').update(request.text).digest('hex').slice(0, 12)}-${randomUUID().slice(0, 8)}`;
    return {
      assetId,
      mimeType: 'audio/mpeg',
      bytesBase64: bytes.toString('base64'),
      voiceId: voice,
      engine: 'edge-tts',
      modelId: 'edge-tts',
      dataLeavesDevice: true,
      retentionDisclosure: 'Text is sent to Microsoft Edge online TTS for synthesis',
      durationUs,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
