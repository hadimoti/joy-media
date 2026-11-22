import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SpeechConsentRequest, SpeechSynthesisTiming } from '@joy-media/job-protocol';
import {
  parseSpeechSynthesisTiming,
  parseSpeechSynthesizeV1,
  parseSpeechTranscript,
  parseSpeechTranscribeV1,
} from '@joy-media/job-protocol';
import { killProcessTree } from './local-masking.js';

export const SPEECH_WAV_MAX_BYTES = 32 * 1024 * 1024;
export const SPEECH_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;

export interface SpeechRunner {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export interface SpeechModelRunner {
  readonly runner: SpeechRunner;
  readonly modelPath: string;
  readonly scriptPath: string;
  readonly ffmpegPath?: string;
}

export interface SpeechAvailability {
  readonly transcribe?: SpeechModelRunner;
  readonly synthesis: Readonly<
    Partial<Record<'kokoro-82m' | 'chatterbox-en' | 'chatterbox-fa', SpeechModelRunner>>
  >;
}

export interface SpeechWorkerDerivative {
  readonly kind: 'speech.transcribe' | 'speech.synthesize';
  readonly assetId?: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly localRef: string;
  readonly descriptor: {
    readonly mimeType: 'application/json' | 'audio/wav';
    readonly durationUs?: number;
  };
  readonly speech?: SpeechSynthesisTiming;
}

export interface SpeechRunnerOptions {
  readonly jobId: string;
  readonly jobType: 'speech.transcribe' | 'speech.synthesize';
  readonly payload: unknown;
  readonly availability: SpeechAvailability;
  readonly derivativeDirectory: string;
  readonly cancelled: () => boolean;
  readonly progress: (progress: number) => Promise<void>;
  readonly assetId?: string;
  readonly sourcePath?: string;
  readonly consent?: SpeechConsentRequest;
  readonly downloadJobAsset?: (
    jobId: string,
    leaseToken: string | undefined,
    destinationPath: string,
  ) => Promise<void>;
  readonly leaseToken?: string;
}

export class SpeechWorkerError extends Error {
  constructor(
    readonly code: 'SETUP_REQUIRED' | 'SOURCE_UNAVAILABLE' | 'CONSENT_DENIED' | 'CANCELED',
    message: string,
  ) {
    super(message);
    this.name = 'SpeechWorkerError';
  }
}

const dependencyProbeCache = new Map<string, boolean>();
const speechRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'speech');

/** Build capability state only from local paths; the cached probe checks imports without loading weights. */
export function speechAvailabilityFromEnvironment(env: NodeJS.ProcessEnv): SpeechAvailability {
  const sttPython = env.JOY_MEDIA_SPEECH_STT_PYTHON?.trim() ?? '';
  const ttsPython = env.JOY_MEDIA_SPEECH_TTS_PYTHON?.trim() ?? '';
  const runnerDir = env.JOY_MEDIA_SPEECH_RUNNER_DIR?.trim();
  const scriptDir = runnerDir || env.JOY_MEDIA_SPEECH_SCRIPT_DIR?.trim() || speechRoot;
  const modelDir = env.JOY_MEDIA_SPEECH_MODEL_DIR?.trim();
  const ffmpegPath = env.JOY_MEDIA_SPEECH_FFMPEG?.trim();
  const transcribeModel =
    env.JOY_MEDIA_SPEECH_STT_MODEL_PATH?.trim() ||
    (modelDir ? resolve(modelDir, 'faster-whisper-large-v3-turbo') : '');
  const transcribeScript = resolve(scriptDir, 'transcribe.py');
  const transcribe =
    isLocalFile(sttPython) &&
    isLocalDirectory(transcribeModel) &&
    isLocalFile(transcribeScript) &&
    dependenciesAvailable(sttPython, ['faster_whisper', 'torch'])
      ? modelRunner(sttPython, transcribeScript, transcribeModel, ffmpegPath)
      : undefined;
  const synthesis: Partial<
    Record<'kokoro-82m' | 'chatterbox-en' | 'chatterbox-fa', SpeechModelRunner>
  > = {};
  const models = [
    [
      'kokoro-82m',
      'JOY_MEDIA_SPEECH_KOKORO_MODEL_PATH',
      'synthesize_kokoro.py',
      ['kokoro', 'torch', 'misaki', 'spacy', 'en_core_web_sm'],
    ],
    [
      'chatterbox-en',
      'JOY_MEDIA_SPEECH_CHATTERBOX_EN_MODEL_PATH',
      'synthesize_chatterbox.py',
      ['chatterbox', 'torch', 'torchaudio'],
    ],
    [
      'chatterbox-fa',
      'JOY_MEDIA_SPEECH_CHATTERBOX_FA_MODEL_PATH',
      'synthesize_chatterbox.py',
      ['chatterbox', 'torch', 'torchaudio'],
    ],
  ] as const;
  for (const [modelId, key, scriptName, modules] of models) {
    const modelPath = env[key]?.trim() || (modelDir ? resolve(modelDir, modelId) : '');
    if (!isLocalFile(ttsPython)) continue;
    const scriptPath =
      modelId.startsWith('chatterbox-') && env.JOY_MEDIA_SPEECH_CHATTERBOX_SCRIPT?.trim()
        ? env.JOY_MEDIA_SPEECH_CHATTERBOX_SCRIPT.trim()
        : resolve(scriptDir, scriptName);
    if (
      isLocalDirectory(modelPath) &&
      isLocalFile(scriptPath) &&
      dependenciesAvailable(ttsPython, modules)
    )
      synthesis[modelId] = modelRunner(ttsPython, scriptPath, modelPath, ffmpegPath);
  }
  return { ...(transcribe === undefined ? {} : { transcribe }), synthesis };
}

function modelRunner(
  python: string,
  scriptPath: string,
  modelPath: string,
  ffmpegPath?: string,
): SpeechModelRunner {
  return {
    runner: { command: python, prefixArgs: [scriptPath] },
    modelPath: resolve(modelPath),
    scriptPath: resolve(scriptPath),
    ...(isLocalFile(ffmpegPath ?? '') ? { ffmpegPath: resolve(ffmpegPath!) } : {}),
  };
}

function isLocalFile(path: string): boolean {
  return (
    path.length > 0 &&
    isAbsolute(path) &&
    existsSync(path) &&
    statSync(path).isFile() &&
    extname(path).toLowerCase() !== '.url'
  );
}

function isLocalDirectory(path: string): boolean {
  return path.length > 0 && isAbsolute(path) && existsSync(path) && statSync(path).isDirectory();
}

function dependenciesAvailable(python: string, modules: readonly string[]): boolean {
  const key = `${resolve(python)}\u0000${modules.join(',')}`;
  const cached = dependencyProbeCache.get(key);
  if (cached !== undefined) return cached;
  const source = `import importlib.util,sys;sys.exit(0 if all(importlib.util.find_spec(x) is not None for x in ${JSON.stringify(modules)}) else 1)`;
  const result = spawnSync(python, ['-c', source], {
    shell: false,
    stdio: 'ignore',
    timeout: 5_000,
  });
  const ready = result.status === 0;
  dependencyProbeCache.set(key, ready);
  return ready;
}

export async function runSpeechJob(options: SpeechRunnerOptions): Promise<SpeechWorkerDerivative> {
  const transcribe =
    options.jobType === 'speech.transcribe' ? parseSpeechTranscribeV1(options.payload) : undefined;
  const synthesize =
    options.jobType === 'speech.synthesize' ? parseSpeechSynthesizeV1(options.payload) : undefined;
  if (
    (options.jobType === 'speech.transcribe' && transcribe === undefined) ||
    (options.jobType === 'speech.synthesize' && synthesize === undefined)
  )
    throw new Error('speech job payload is invalid');

  const model =
    transcribe !== undefined
      ? options.availability.transcribe
      : options.availability.synthesis[synthesize!.modelId];
  if (model === undefined)
    throw new SpeechWorkerError('SETUP_REQUIRED', 'Local speech model setup is required');
  if (options.cancelled()) throw new SpeechWorkerError('CANCELED', 'Speech job canceled');
  const purpose = synthesize?.purpose ?? 'general';
  if (
    synthesize !== undefined &&
    (!options.consent?.acknowledged || options.consent.purpose !== purpose)
  )
    throw new SpeechWorkerError('CONSENT_DENIED', 'Speech synthesis consent is required');
  if (
    synthesize?.modelId === 'chatterbox-fa' &&
    (purpose !== 'personal-noncommercial' || options.consent?.purpose !== 'personal-noncommercial')
  )
    throw new SpeechWorkerError(
      'CONSENT_DENIED',
      'Chatterbox Fa is restricted to personal noncommercial use',
    );

  const privateDir = mkdtempSync(join(tmpdir(), `joy-speech-${safeId(options.jobId)}-`));
  const outputDir = join(privateDir, 'output');
  const requestPath = join(privateDir, 'request.json');
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  let retainedPath: string | undefined;
  let committed = false;
  try {
    const sourcePath =
      transcribe !== undefined
        ? await stageSource(options, privateDir)
        : synthesize!.modelId.startsWith('chatterbox-') && options.assetId !== undefined
          ? await stageSource(options, privateDir)
          : undefined;
    if (options.cancelled()) throw new SpeechWorkerError('CANCELED', 'Speech job canceled');
    const isStt = transcribe !== undefined;
    const speechModelId = isStt ? transcribe.modelId : synthesize!.modelId;
    const request = {
      protocol: 'joy.speech.v1',
      type: options.jobType,
      language: isStt ? transcribe.language : synthesize!.language,
      modelId: speechModelId,
      modelPath: model.modelPath,
      ...(sourcePath === undefined ? {} : isStt ? { sourcePath } : { referencePath: sourcePath }),
      ...(model.ffmpegPath === undefined ? {} : { ffmpegPath: model.ffmpegPath }),
      ...(isStt && transcribe.range !== undefined ? { range: transcribe.range } : {}),
      ...(synthesize === undefined ? {} : { text: synthesize.text }),
      ...(synthesize?.modelId === 'chatterbox-fa' ? { nonCommercial: true } : {}),
    };
    writeFileSync(requestPath, JSON.stringify(request), { encoding: 'utf8', mode: 0o600 });
    if (options.cancelled()) throw new SpeechWorkerError('CANCELED', 'Speech job canceled');
    await options.progress(5);
    const completed = await runRunner(
      model.runner,
      ['--request', requestPath, '--output-dir', outputDir],
      options.cancelled,
      options.progress,
    );
    if (!completed || options.cancelled())
      throw new SpeechWorkerError('CANCELED', 'Speech job canceled');

    let outputPath: string;
    let descriptor: SpeechWorkerDerivative['descriptor'];
    let speech: SpeechSynthesisTiming | undefined;
    if (transcribe !== undefined) {
      outputPath = join(outputDir, 'transcript.json');
      const raw = readBounded(outputPath, SPEECH_TRANSCRIPT_MAX_BYTES);
      const parsed = parseSpeechTranscript(JSON.parse(raw.toString('utf8')));
      if (
        parsed === undefined ||
        parsed.language !== transcribe.language ||
        parsed.provenance.modelId !== transcribe.modelId
      )
        throw new Error('speech runner returned an invalid transcript');
      descriptor = { mimeType: 'application/json' };
    } else {
      outputPath = join(outputDir, 'voice.wav');
      const wav = readBounded(outputPath, SPEECH_WAV_MAX_BYTES);
      const durationUs = validateWav(wav);
      const timingPath = join(outputDir, 'timings.json');
      let parsedTiming = parseSpeechSynthesisTiming(
        JSON.parse(readBounded(timingPath, SPEECH_TRANSCRIPT_MAX_BYTES).toString('utf8')),
      );
      if (parsedTiming === undefined || parsedTiming.durationUs !== durationUs)
        throw new Error('speech runner returned invalid timing metadata');
      if (
        parsedTiming.timingSource === 'unavailable' &&
        options.availability.transcribe !== undefined &&
        synthesize !== undefined
      ) {
        parsedTiming =
          (await alignSpeech(
            options,
            options.availability.transcribe,
            model.modelPath,
            outputPath,
            privateDir,
            durationUs,
            synthesize.language,
          )) ?? parsedTiming;
      }
      speech = parsedTiming;
      descriptor = { mimeType: 'audio/wav', durationUs };
    }

    if (options.cancelled()) throw new SpeechWorkerError('CANCELED', 'Speech job canceled');
    await options.progress(90);
    const { sha256, bytes } = await hashFile(
      outputPath,
      isStt ? SPEECH_TRANSCRIPT_MAX_BYTES : SPEECH_WAV_MAX_BYTES,
    );
    const ext = isStt ? 'json' : 'wav';
    const localRef = `speech-${safeId(options.jobId)}-${sha256.slice(0, 16)}`;
    mkdirSync(options.derivativeDirectory, { recursive: true });
    const finalPath = join(options.derivativeDirectory, `${localRef}.${ext}`);
    retainedPath = finalPath;
    copyFileSync(outputPath, finalPath);
    const verified = await hashFile(
      finalPath,
      isStt ? SPEECH_TRANSCRIPT_MAX_BYTES : SPEECH_WAV_MAX_BYTES,
    );
    if (verified.sha256 !== sha256 || verified.bytes !== bytes)
      throw new Error('speech derivative integrity check failed');
    if (options.cancelled()) {
      rmSync(finalPath, { force: true });
      throw new SpeechWorkerError('CANCELED', 'Speech job canceled');
    }
    await options.progress(100);
    if (options.cancelled()) throw new SpeechWorkerError('CANCELED', 'Speech job canceled');
    committed = true;
    return {
      kind: options.jobType,
      ...(options.assetId === undefined || sourcePath === undefined
        ? {}
        : { assetId: options.assetId }),
      sha256,
      bytes,
      localRef,
      descriptor,
      ...(speech === undefined ? {} : { speech }),
    };
  } finally {
    if (!committed && retainedPath !== undefined) rmSync(retainedPath, { force: true });
    rmSync(privateDir, { recursive: true, force: true });
  }
}

async function stageSource(options: SpeechRunnerOptions, privateDir: string): Promise<string> {
  const target = join(privateDir, 'source.wav');
  if (
    options.sourcePath !== undefined &&
    isAbsolute(options.sourcePath) &&
    existsSync(options.sourcePath)
  ) {
    copyFileSync(options.sourcePath, target);
    return target;
  }
  if (options.assetId === undefined || options.downloadJobAsset === undefined)
    throw new SpeechWorkerError('SOURCE_UNAVAILABLE', 'Speech source is unavailable');
  await options.downloadJobAsset(options.jobId, options.leaseToken, target);
  if (!existsSync(target) || statSync(target).size === 0)
    throw new SpeechWorkerError('SOURCE_UNAVAILABLE', 'Speech source is unavailable');
  return target;
}

async function alignSpeech(
  options: SpeechRunnerOptions,
  stt: SpeechModelRunner,
  fallbackModelPath: string,
  wavPath: string,
  privateDir: string,
  durationUs: number,
  language: 'fa-IR' | 'en-US',
): Promise<SpeechSynthesisTiming | undefined> {
  const outputDir = join(privateDir, 'alignment');
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const requestPath = join(privateDir, 'alignment.json');
  writeFileSync(
    requestPath,
    JSON.stringify({
      protocol: 'joy.speech.v1',
      type: 'speech.transcribe',
      language,
      modelId: 'faster-whisper-large-v3-turbo',
      modelPath: stt.modelPath || fallbackModelPath,
      sourcePath: wavPath,
      ...(stt.ffmpegPath === undefined ? {} : { ffmpegPath: stt.ffmpegPath }),
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  try {
    const completed = await runRunner(
      stt.runner,
      ['--request', requestPath, '--output-dir', outputDir],
      options.cancelled,
      options.progress,
    );
    if (!completed || options.cancelled())
      throw new SpeechWorkerError('CANCELED', 'Speech job canceled');
    const transcript = parseSpeechTranscript(
      JSON.parse(
        readBounded(join(outputDir, 'transcript.json'), SPEECH_TRANSCRIPT_MAX_BYTES).toString(
          'utf8',
        ),
      ),
    );
    if (
      transcript === undefined ||
      transcript.language !== language ||
      transcript.words.some((word) => word.endUs > durationUs)
    )
      return undefined;
    return parseSpeechSynthesisTiming({
      durationUs,
      timingSource: 'aligned',
      words: transcript.words,
    });
  } catch (error) {
    if (options.cancelled()) throw error;
    return undefined;
  }
}

async function runRunner(
  runner: SpeechRunner,
  args: readonly string[],
  cancelled: () => boolean,
  progress: (progress: number) => Promise<void>,
): Promise<boolean> {
  const child = spawn(runner.command, [...runner.prefixArgs, ...args], {
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrBytes = 0;
  let stdoutBuffer = '';
  let lastProgress = 0;
  const progressTasks: Promise<void>[] = [];
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer = (stdoutBuffer + chunk).slice(-8_192);
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines.slice(-20)) {
      if (line.length > 512) continue;
      try {
        const item: unknown = JSON.parse(line);
        if (
          isRecord(item) &&
          item.type === 'progress' &&
          typeof item.percent === 'number' &&
          Number.isFinite(item.percent)
        ) {
          const value = Math.max(5, Math.min(85, Math.round(item.percent * 0.8 + 5)));
          if (value > lastProgress && progressTasks.length < 100) {
            lastProgress = value;
            progressTasks.push(progress(value));
          }
        }
      } catch {
        /* Non-progress runner output is ignored and never logged. */
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes = Math.min(2_000, stderrBytes + chunk.length);
  });
  const completed = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  try {
    while (child.exitCode === null) {
      if (cancelled()) {
        killProcessTree(child);
        await completed.catch(() => undefined);
        return false;
      }
      await sleep(50);
    }
    const code = await completed;
    await Promise.all(progressTasks);
    if (code !== 0)
      throw new Error(
        `speech runner failed (${String(code)})${stderrBytes ? ' with stderr output' : ''}`,
      );
    return true;
  } catch (error) {
    if (cancelled()) {
      killProcessTree(child);
      await completed.catch(() => undefined);
      return false;
    }
    throw error;
  }
}

export function readSpeechDerivative(
  directory: string,
  receipt: SpeechWorkerDerivative,
): Uint8Array {
  if (!/^speech-[A-Za-z0-9._-]{1,90}-[a-f0-9]{16}$/u.test(receipt.localRef))
    throw new Error('speech derivative reference is invalid');
  const isStt = receipt.kind === 'speech.transcribe';
  const bytes = readBounded(
    join(directory, `${receipt.localRef}.${isStt ? 'json' : 'wav'}`),
    isStt ? SPEECH_TRANSCRIPT_MAX_BYTES : SPEECH_WAV_MAX_BYTES,
  );
  if (
    bytes.length !== receipt.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== receipt.sha256
  )
    throw new Error('retained speech derivative integrity check failed');
  return bytes;
}

function readBounded(path: string, maxBytes: number): Buffer {
  if (!existsSync(path)) throw new Error('speech runner did not produce the expected output');
  const size = statSync(path).size;
  if (size < 1 || size > maxBytes) throw new Error('speech runner output exceeds its byte limit');
  return readFileSync(path);
}

async function hashFile(
  path: string,
  maxBytes: number,
): Promise<{ sha256: string; bytes: number }> {
  const size = statSync(path).size;
  if (size < 1 || size > maxBytes) throw new Error('speech derivative exceeds its byte limit');
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

function validateWav(bytes: Buffer): number {
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.toString('ascii', 12, 16) !== 'fmt '
  )
    throw new Error('speech runner returned an invalid WAV');
  const format = bytes.readUInt16LE(20);
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const byteRate = bytes.readUInt32LE(28);
  const blockAlign = bytes.readUInt16LE(32);
  const bitsPerSample = bytes.readUInt16LE(34);
  const dataOffset = bytes.indexOf('data', 36, 'ascii');
  if (
    format !== 1 ||
    channels < 1 ||
    channels > 2 ||
    sampleRate < 8_000 ||
    sampleRate > 192_000 ||
    bitsPerSample !== 16 ||
    blockAlign !== channels * 2 ||
    byteRate !== sampleRate * blockAlign ||
    dataOffset < 36 ||
    dataOffset + 8 > bytes.length
  )
    throw new Error('speech runner returned an unsupported WAV format');
  const dataBytes = bytes.readUInt32LE(dataOffset + 4);
  if (dataBytes < 1 || dataOffset + 8 + dataBytes > bytes.length || dataBytes % blockAlign !== 0)
    throw new Error('speech runner returned a truncated WAV');
  const durationUs = Math.round(((dataBytes / blockAlign) * 1_000_000) / sampleRate);
  if (!Number.isSafeInteger(durationUs) || durationUs < 1)
    throw new Error('speech runner returned invalid WAV duration');
  return durationUs;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 72) || 'job';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
