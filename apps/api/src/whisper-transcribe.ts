import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ControlPlaneError } from './control-plane.js';

export interface WhisperWord {
  readonly text: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly confidence?: number;
  readonly speakerId?: string;
}

export interface WhisperTranscript {
  readonly language: string;
  readonly modelId: string;
  readonly words: readonly WhisperWord[];
  readonly speakers: readonly { readonly id: string; readonly name: string }[];
}

const SCRIPT = fileURLToPath(new URL('../scripts/whisper_transcribe.py', import.meta.url));

function resolvePython(): string {
  return process.env.JOY_MEDIA_PYTHON ?? 'python3';
}

function ffmpegExtractWav(inputPath: string, outputPath: string): void {
  const result = spawnSync(
    process.env.JOY_MEDIA_FFMPEG ?? 'ffmpeg',
    ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-f', 'wav', outputPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new ControlPlaneError(
      'PROVIDER_FAILED',
      `ffmpeg extract failed: ${result.stderr?.slice(0, 400) ?? 'unknown'}`,
    );
  }
}

function parseTranscript(stdout: string): WhisperTranscript {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throw new ControlPlaneError('PROVIDER_FAILED', 'whisper returned non-JSON output');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ControlPlaneError('PROVIDER_FAILED', 'whisper returned invalid payload');
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.language !== 'string' || typeof body.modelId !== 'string') {
    throw new ControlPlaneError('PROVIDER_FAILED', 'whisper payload missing language/modelId');
  }
  if (!Array.isArray(body.words)) {
    throw new ControlPlaneError('PROVIDER_FAILED', 'whisper payload missing words');
  }
  const words: WhisperWord[] = body.words.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ControlPlaneError('PROVIDER_FAILED', `whisper word ${index} invalid`);
    }
    const word = item as Record<string, unknown>;
    if (typeof word.text !== 'string' || typeof word.startUs !== 'number' || typeof word.endUs !== 'number') {
      throw new ControlPlaneError('PROVIDER_FAILED', `whisper word ${index} shape invalid`);
    }
    return {
      text: word.text,
      startUs: word.startUs,
      endUs: word.endUs,
      ...(typeof word.confidence === 'number' ? { confidence: word.confidence } : {}),
      ...(typeof word.speakerId === 'string' ? { speakerId: word.speakerId } : {}),
    };
  });
  const speakers = Array.isArray(body.speakers)
    ? body.speakers.flatMap((item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
        const speaker = item as Record<string, unknown>;
        if (typeof speaker.id !== 'string' || typeof speaker.name !== 'string') return [];
        return [{ id: speaker.id, name: speaker.name }];
      })
    : [{ id: 'speaker-1', name: 'Speaker 1' }];
  return {
    language: body.language,
    modelId: body.modelId,
    words,
    speakers,
  };
}

/**
 * Run faster-whisper against audio/video bytes. Converts to 16 kHz mono WAV first.
 */
export function runWhisperTranscription(
  mediaBytes: Uint8Array,
  language: string,
  options: { readonly mediaExtension?: string; readonly timeoutMs?: number } = {},
): WhisperTranscript {
  if (!existsSync(SCRIPT)) {
    throw new ControlPlaneError('PROVIDER_UNAVAILABLE', 'whisper helper script is missing');
  }
  const dir = mkdtempSync(join(tmpdir(), 'joy-whisper-'));
  const ext = options.mediaExtension ?? 'bin';
  const inputPath = join(dir, `input.${ext}`);
  const wavPath = join(dir, 'audio.wav');
  try {
    writeFileSync(inputPath, mediaBytes);
    ffmpegExtractWav(inputPath, wavPath);
    const timeoutMs = options.timeoutMs ?? Number(process.env.JOY_MEDIA_WHISPER_TIMEOUT_MS ?? 180_000);
    const result = spawnSync(
      resolvePython(),
      [SCRIPT, '--audio', wavPath, '--language', language],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        env: { ...process.env },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || 'whisper failed').slice(0, 600);
      throw new ControlPlaneError('PROVIDER_FAILED', detail);
    }
    return parseTranscript(result.stdout ?? '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function resolveReferenceMediaPath(assetId: string): string | undefined {
  const root =
    process.env.JOY_MEDIA_REFERENCE_MEDIA_DIR ??
    '/opt/joy-media/web/media/reference';
  const safe = assetId.replace(/[^a-zA-Z0-9._-]/g, '');
  if (safe.length === 0 || safe !== assetId) return undefined;
  const path = join(root, `${safe}.mp4`);
  return existsSync(path) ? path : undefined;
}

export function runWhisperOnReferenceAsset(
  assetId: string,
  language: string,
): WhisperTranscript {
  const path = resolveReferenceMediaPath(assetId);
  if (path === undefined) {
    throw new ControlPlaneError('REQUEST_INVALID', `unknown reference asset ${assetId}`);
  }
  return runWhisperTranscription(readFileSync(path), language, { mediaExtension: 'mp4' });
}
