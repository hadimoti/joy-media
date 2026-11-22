import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ChildProcess from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  readSpeechDerivative,
  runSpeechJob,
  speechAvailabilityFromEnvironment,
  type SpeechAvailability,
  type SpeechModelRunner,
} from './local-speech.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawnSync: (command: string, args: readonly string[], options: unknown) =>
      args[0] === '-c'
        ? { status: 0 }
        : actual.spawnSync(command, args, options as Parameters<typeof actual.spawnSync>[2]),
  };
});

const noCancel = () => false;
const noProgress = async () => undefined;

function fixtureRunner(script: string) {
  return { command: process.execPath, prefixArgs: ['-e', script, '--'] };
}

function wavBytes(durationMs = 100) {
  const sampleRate = 24_000;
  const frames = (sampleRate * durationMs) / 1000;
  const dataBytes = frames * 2;
  const header = Buffer.alloc(44 + dataBytes);
  header.write('RIFF', 0);
  header.writeUInt32LE(header.length - 8, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function modelRunner(
  runner: SpeechModelRunner['runner'],
  modelPath: string,
  scriptPath = 'fixture.py',
): SpeechModelRunner {
  return { runner, modelPath, scriptPath };
}

function availability(value: SpeechAvailability): SpeechAvailability {
  return value;
}

describe('local speech worker runner', () => {
  it('treats absent speech configuration as unavailable', () => {
    expect(speechAvailabilityFromEnvironment({})).toEqual({ synthesis: {} });
  });

  it.each([
    { name: 'only STT configured', stt: true, tts: false },
    { name: 'only TTS configured', stt: false, tts: true },
    { name: 'both configured', stt: true, tts: true },
    { name: 'neither configured', stt: false, tts: false },
  ])('reports independent availability and capabilities when $name', ({ stt, tts }) => {
    const root = mkdtempSync(join(tmpdir(), 'joy-speech-availability-'));
    const runnerDir = join(root, 'runners');
    const modelDir = join(root, 'models');
    mkdirSync(runnerDir);
    for (const name of ['transcribe.py', 'synthesize_kokoro.py', 'synthesize_chatterbox.py'])
      writeFileSync(join(runnerDir, name), 'fixture');
    for (const name of [
      'faster-whisper-large-v3-turbo',
      'kokoro-82m',
      'chatterbox-en',
      'chatterbox-fa',
    ])
      mkdirSync(join(modelDir, name), { recursive: true });
    for (const name of ['conds.pt', 's3gen.safetensors', 't3_cfg.safetensors', 'tokenizer.json', 've.safetensors'])
      writeFileSync(join(modelDir, 'chatterbox-en', name), 'fixture');
    for (const name of ['t3_fa_expressive.safetensors', 'persian_tts_engine.py', 'grapheme_mtl_merged_expanded_v1.json'])
      writeFileSync(join(modelDir, 'chatterbox-fa', name), 'fixture');
    mkdirSync(join(modelDir, 'chatterbox-en-base'));
    writeFileSync(join(modelDir, 'chatterbox-en-base', 've.safetensors'), 'fixture');
    writeFileSync(join(modelDir, 'chatterbox-en-base', 's3gen.safetensors'), 'fixture');
    const sttPython = join(root, 'stt-python.exe');
    const ttsPython = join(root, 'tts-python.exe');
    writeFileSync(sttPython, 'fixture STT executable');
    writeFileSync(ttsPython, 'fixture TTS executable');
    try {
      const result = speechAvailabilityFromEnvironment({
        JOY_MEDIA_SPEECH_STT_PYTHON: stt ? sttPython : undefined,
        JOY_MEDIA_SPEECH_TTS_PYTHON: tts ? ttsPython : undefined,
        JOY_MEDIA_SPEECH_RUNNER_DIR: runnerDir,
        JOY_MEDIA_SPEECH_MODEL_DIR: modelDir,
      });
      expect(result.transcribe?.runner.command).toBe(stt ? sttPython : undefined);
      expect(result.synthesis).toEqual(
        tts
          ? {
              'kokoro-82m': expect.objectContaining({ runner: { command: ttsPython, prefixArgs: [join(runnerDir, 'synthesize_kokoro.py')] } }),
              'chatterbox-en': expect.objectContaining({ runner: { command: ttsPython, prefixArgs: [join(runnerDir, 'synthesize_chatterbox.py')] } }),
              'chatterbox-fa': expect.objectContaining({ runner: { command: ttsPython, prefixArgs: [join(runnerDir, 'synthesize_chatterbox.py')] } }),
            }
          : {},
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks the real Chatterbox files and gives Persian a setup reason when its base is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-speech-chatterbox-layout-'));
    const runnerDir = join(root, 'runners');
    const models = join(root, 'models');
    const python = join(root, 'python.exe');
    mkdirSync(runnerDir);
    mkdirSync(join(models, 'chatterbox-en'), { recursive: true });
    const isolatedFa = join(root, 'isolated', 'persian-only');
    mkdirSync(isolatedFa, { recursive: true });
    writeFileSync(join(runnerDir, 'synthesize_chatterbox.py'), 'fixture');
    writeFileSync(python, 'fixture');
    for (const name of ['conds.pt', 's3gen.safetensors', 't3_cfg.safetensors', 'tokenizer.json', 've.safetensors'])
      writeFileSync(join(models, 'chatterbox-en', name), 'fixture');
    for (const name of ['t3_fa_expressive.safetensors', 'persian_tts_engine.py', 'grapheme_mtl_merged_expanded_v1.json'])
      writeFileSync(join(isolatedFa, name), 'fixture');
    try {
      const result = speechAvailabilityFromEnvironment({
        JOY_MEDIA_SPEECH_TTS_PYTHON: python,
        JOY_MEDIA_SPEECH_RUNNER_DIR: runnerDir,
        JOY_MEDIA_SPEECH_MODEL_DIR: models,
        JOY_MEDIA_SPEECH_CHATTERBOX_FA_MODEL_PATH: isolatedFa,
      });
      expect(result.synthesis['chatterbox-en']?.modelPath).toBe(join(models, 'chatterbox-en'));
      expect(result.synthesis['chatterbox-fa']).toBeUndefined();
      expect(result.setupRequired?.['chatterbox-fa']).toBe('CHATTERBOX_FA_BASE_FILES_MISSING');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not use the retired single-interpreter variable as a fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-speech-legacy-env-'));
    const runnerDir = join(root, 'runners');
    const modelDir = join(root, 'models');
    const legacyPython = join(root, 'legacy-python.exe');
    mkdirSync(runnerDir);
    for (const name of ['transcribe.py', 'synthesize_kokoro.py', 'synthesize_chatterbox.py'])
      writeFileSync(join(runnerDir, name), 'fixture');
    for (const name of [
      'faster-whisper-large-v3-turbo',
      'kokoro-82m',
      'chatterbox-en',
      'chatterbox-fa',
    ])
      mkdirSync(join(modelDir, name), { recursive: true });
    writeFileSync(legacyPython, 'fixture legacy executable');
    try {
      expect(
        speechAvailabilityFromEnvironment({
          JOY_MEDIA_SPEECH_PYTHON: legacyPython,
          JOY_MEDIA_SPEECH_RUNNER_DIR: runnerDir,
          JOY_MEDIA_SPEECH_MODEL_DIR: modelDir,
        }),
      ).toEqual({ synthesis: {} });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs transcription and synthesis with their separately configured executables', async () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-speech-executable-routing-'));
    const derivatives = join(root, 'derivatives');
    const sttPython = join(root, 'stt-python.exe');
    const ttsPython = join(root, 'tts-python.exe');
    const sttArgv0 = join(root, 'stt-argv0.txt');
    const ttsArgv0 = join(root, 'tts-argv0.txt');
    copyFileSync(process.execPath, sttPython);
    copyFileSync(process.execPath, ttsPython);
    const sttScript = [
      "const fs=require('node:fs');const a=process.argv;",
      `fs.writeFileSync(${JSON.stringify(sttArgv0)},process.argv[0]);`,
      "const r=JSON.parse(fs.readFileSync(a[a.indexOf('--request')+1],'utf8'));const o=a[a.indexOf('--output-dir')+1];",
      "fs.writeFileSync(o+'/transcript.json',JSON.stringify({language:r.language,words:[{text:'Hello',startUs:0,endUs:50000}],speakers:[],provenance:{providerId:'local',modelId:r.modelId,createdAt:new Date().toISOString()}}));",
    ].join('');
    const ttsScript = [
      "const fs=require('node:fs');const a=process.argv;",
      `fs.writeFileSync(${JSON.stringify(ttsArgv0)},process.argv[0]);`,
      "const o=a[a.indexOf('--output-dir')+1];",
      `fs.writeFileSync(o+'/voice.wav',Buffer.from(${JSON.stringify(wavBytes().toString('base64'))},'base64'));`,
      "fs.writeFileSync(o+'/timings.json',JSON.stringify({durationUs:100000,timingSource:'native',words:[]}));",
    ].join('');
    const config = availability({
      transcribe: modelRunner({ command: sttPython, prefixArgs: ['-e', sttScript, '--'] }, root),
      synthesis: {
        'kokoro-82m': modelRunner(
          { command: ttsPython, prefixArgs: ['-e', ttsScript, '--'] },
          root,
        ),
      },
    });
    const source = join(root, 'source.wav');
    writeFileSync(source, wavBytes());
    try {
      await runSpeechJob({
        jobId: 'routed-stt',
        jobType: 'speech.transcribe',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'faster-whisper-large-v3-turbo' },
        sourcePath: source,
        availability: config,
        derivativeDirectory: derivatives,
        cancelled: noCancel,
        progress: noProgress,
      });
      await runSpeechJob({
        jobId: 'routed-tts',
        jobType: 'speech.synthesize',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' },
        availability: config,
        derivativeDirectory: derivatives,
        consent: { acknowledged: true, purpose: 'general' },
        cancelled: noCancel,
        progress: noProgress,
      });
      expect(readFileSync(sttArgv0, 'utf8')).toBe(sttPython);
      expect(readFileSync(ttsArgv0, 'utf8')).toBe(ttsPython);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a staged transcription request, validates its JSON, and retains a checked derivative', async () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-speech-stt-'));
    const derivatives = join(root, 'derivatives');
    const runner = fixtureRunner(
      [
        "const fs=require('node:fs');",
        "const a=process.argv;const r=JSON.parse(fs.readFileSync(a[a.indexOf('--request')+1],'utf8'));const o=a[a.indexOf('--output-dir')+1];",
        "if(r.protocol!=='joy.speech.v1'||!r.sourcePath||!o)process.exit(3);",
        "fs.writeFileSync(o+'/transcript.json',JSON.stringify({language:r.language,words:[{text:'Hello',startUs:0,endUs:50000}],speakers:[],provenance:{providerId:'local',modelId:r.modelId,createdAt:new Date().toISOString()}}));",
      ].join(''),
    );
    const staged = join(root, 'staged.wav');
    writeFileSync(staged, wavBytes());
    const config = availability({
      transcribe: modelRunner(runner, join(root, 'whisper')),
      synthesis: {},
    });
    try {
      const result = await runSpeechJob({
        jobId: 'stt-job',
        jobType: 'speech.transcribe',
        assetId: 'audio-1',
        payload: {
          schemaVersion: 1,
          language: 'en-US',
          modelId: 'faster-whisper-large-v3-turbo',
        },
        availability: config,
        derivativeDirectory: derivatives,
        downloadJobAsset: async (_id, _lease, path) => writeFileSync(path, readFileSync(staged)),
        consent: { acknowledged: true, purpose: 'general' },
        cancelled: noCancel,
        progress: noProgress,
      });
      expect(result.kind).toBe('speech.transcribe');
      expect(result.descriptor).toEqual({ mimeType: 'application/json' });
      expect(readSpeechDerivative(derivatives, result).byteLength).toBe(result.bytes);
      expect(readdirSync(derivatives)).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(staged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('synthesizes built-in voice without staging or reading a source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-speech-tts-'));
    const derivatives = join(root, 'derivatives');
    const runner = fixtureRunner(
      [
        "const fs=require('node:fs');const a=process.argv;const r=JSON.parse(fs.readFileSync(a[a.indexOf('--request')+1],'utf8'));const o=a[a.indexOf('--output-dir')+1];",
        "if(r.sourcePath||r.referencePath||r.type!=='speech.synthesize')process.exit(4);",
        "fs.writeFileSync(o+'/voice.wav',Buffer.from(process.env.FIXTURE_WAV,'base64'));",
        "fs.writeFileSync(o+'/timings.json',JSON.stringify({durationUs:100000,timingSource:'native',words:[{text:'Hello',startUs:0,endUs:50000}]}));",
      ].join(''),
    );
    const previous = process.env.FIXTURE_WAV;
    process.env.FIXTURE_WAV = wavBytes().toString('base64');
    const config = availability({
      synthesis: {
        'kokoro-82m': modelRunner(runner, join(root, 'kokoro')),
      },
    });
    try {
      const result = await runSpeechJob({
        jobId: 'tts-job',
        jobType: 'speech.synthesize',
        payload: {
          schemaVersion: 1,
          language: 'en-US',
          modelId: 'kokoro-82m',
          text: 'Hello',
        },
        availability: config,
        derivativeDirectory: derivatives,
        consent: { acknowledged: true, purpose: 'general' },
        cancelled: noCancel,
        progress: noProgress,
      });
      expect(result.kind).toBe('speech.synthesize');
      expect(result.speech).toEqual({
        durationUs: 100000,
        timingSource: 'native',
        words: [{ text: 'Hello', startUs: 0, endUs: 50000 }],
      });
      expect(readSpeechDerivative(derivatives, result).byteLength).toBe(result.bytes);
    } finally {
      if (previous === undefined) delete process.env.FIXTURE_WAV;
      else process.env.FIXTURE_WAV = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stages a Chatterbox reference and sets nonCommercial only for validated personal purpose', async () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-speech-reference-'));
    const derivatives = join(root, 'derivatives');
    const runner = fixtureRunner(
      [
        "const fs=require('node:fs');const a=process.argv;const r=JSON.parse(fs.readFileSync(a[a.indexOf('--request')+1],'utf8'));const o=a[a.indexOf('--output-dir')+1];",
        'if(!r.referencePath||r.nonCommercial!==true)process.exit(5);',
        "fs.writeFileSync(o+'/voice.wav',Buffer.from(process.env.FIXTURE_WAV,'base64'));",
        "fs.writeFileSync(o+'/timings.json',JSON.stringify({durationUs:100000,timingSource:'unavailable',words:[]}));",
      ].join(''),
    );
    const staged = join(root, 'reference.wav');
    writeFileSync(staged, wavBytes());
    const previous = process.env.FIXTURE_WAV;
    process.env.FIXTURE_WAV = wavBytes().toString('base64');
    const config = availability({
      synthesis: {
        'chatterbox-fa': modelRunner(runner, join(root, 'chatterbox'), 'synthesize_chatterbox.py'),
      },
    });
    try {
      const result = await runSpeechJob({
        jobId: 'tts-ref',
        jobType: 'speech.synthesize',
        assetId: 'voice-ref',
        payload: {
          schemaVersion: 1,
          language: 'fa-IR',
          modelId: 'chatterbox-fa',
          text: 'سلام',
          purpose: 'personal-noncommercial',
        },
        consent: { acknowledged: true, purpose: 'personal-noncommercial' },
        availability: config,
        derivativeDirectory: derivatives,
        downloadJobAsset: async (_id, _lease, path) => writeFileSync(path, readFileSync(staged)),
        cancelled: noCancel,
        progress: noProgress,
      });
      expect(result.kind).toBe('speech.synthesize');
      expect(result.speech?.timingSource).toBe('unavailable');
      expect(result.speech?.words).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.FIXTURE_WAV;
      else process.env.FIXTURE_WAV = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed outputs and removes cold-failure files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-speech-invalid-'));
    writeFileSync(join(root, 'source.wav'), wavBytes());
    const runner = fixtureRunner(
      "const fs=require('node:fs');const a=process.argv;const o=a[a.indexOf('--output-dir')+1];fs.writeFileSync(o+'/transcript.json','{}');",
    );
    const config = availability({ transcribe: modelRunner(runner, root), synthesis: {} });
    try {
      await expect(
        runSpeechJob({
          jobId: 'bad-json',
          jobType: 'speech.transcribe',
          payload: {
            schemaVersion: 1,
            language: 'en-US',
            modelId: 'faster-whisper-large-v3-turbo',
          },
          sourcePath: join(root, 'source.wav'),
          availability: config,
          derivativeDirectory: join(root, 'derivatives'),
          cancelled: noCancel,
          progress: noProgress,
        }),
      ).rejects.toThrow('speech runner returned an invalid transcript');
      expect(existsSync(join(root, 'derivatives'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns unavailable alignment when no local STT model is ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-speech-align-'));
    const runner = fixtureRunner(
      [
        "const fs=require('node:fs');const a=process.argv;const o=a[a.indexOf('--output-dir')+1];",
        "fs.writeFileSync(o+'/voice.wav',Buffer.from(process.env.FIXTURE_WAV,'base64'));",
        "fs.writeFileSync(o+'/timings.json',JSON.stringify({durationUs:100000,timingSource:'unavailable',words:[]}));",
      ].join(''),
    );
    const previous = process.env.FIXTURE_WAV;
    process.env.FIXTURE_WAV = wavBytes().toString('base64');
    try {
      const result = await runSpeechJob({
        jobId: 'unaligned',
        jobType: 'speech.synthesize',
        payload: {
          schemaVersion: 1,
          language: 'en-US',
          modelId: 'kokoro-82m',
          text: 'Hello',
        },
        availability: availability({
          synthesis: {
            'kokoro-82m': modelRunner(runner, root),
          },
        }),
        derivativeDirectory: join(root, 'derivatives'),
        consent: { acknowledged: true, purpose: 'general' },
        cancelled: noCancel,
        progress: noProgress,
      });
      expect(result.speech).toEqual({ durationUs: 100000, timingSource: 'unavailable', words: [] });
    } finally {
      if (previous === undefined) delete process.env.FIXTURE_WAV;
      else process.env.FIXTURE_WAV = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cancels a runner process tree and removes job-private files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-speech-cancel-'));
    const derivatives = join(root, 'derivatives');
    const pidFile = join(root, 'child.pid');
    const source = join(root, 'source.wav');
    writeFileSync(source, wavBytes());
    const script = [
      "const fs=require('node:fs');const {spawn}=require('node:child_process');",
      "const a=process.argv;const r=JSON.parse(fs.readFileSync(a[a.indexOf('--request')+1],'utf8'));",
      `const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
      "c.on('exit',()=>process.exit(0));setInterval(()=>{},1000);",
    ].join('');
    const runner = fixtureRunner(script);
    const config = availability({ transcribe: modelRunner(runner, root), synthesis: {} });
    let childPid: number | undefined;
    try {
      await expect(
        runSpeechJob({
          jobId: 'cancel-tree',
          jobType: 'speech.transcribe',
          payload: {
            schemaVersion: 1,
            language: 'en-US',
            modelId: 'faster-whisper-large-v3-turbo',
          },
          sourcePath: source,
          availability: config,
          derivativeDirectory: derivatives,
          cancelled: () => {
            if (!existsSync(pidFile)) return false;
            childPid = Number(readFileSync(pidFile, 'utf8'));
            return Number.isInteger(childPid) && childPid > 0;
          },
          progress: noProgress,
        }),
      ).rejects.toMatchObject({ code: 'CANCELED' });
      expect(childPid).toBeGreaterThan(0);
      expect(existsSync(derivatives)).toBe(false);
      await new Promise((done) => setTimeout(done, 100));
      expect(() => process.kill(childPid ?? 0, 0)).toThrow();
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid);
        } catch {
          /* already exited */
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
