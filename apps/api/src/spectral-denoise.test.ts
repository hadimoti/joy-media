import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, ftruncateSync, openSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DENOISE_DURATION_SECONDS,
  MAX_DENOISE_MEDIA_BYTES,
  MAX_DENOISE_OUTPUT_BYTES,
  runSpectralDenoise,
} from './spectral-denoise.js';

describe('spectral denoise safety boundary', () => {
  it('runs ffmpeg asynchronously and removes its private temporary directory', async () => {
    let temporaryDirectory: string | undefined;
    const launch = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      temporaryDirectory = dirname(args[2]!);
      return spawn(command, args, options);
    }) as typeof spawn;

    const result = await runSpectralDenoise(
      {
        assetId: 'audio-source',
        mediaBase64: silentWav().toString('base64'),
        sampleRate: 16_000,
        strength: 0.5,
      },
      { spawn: launch },
    );

    const output = Buffer.from(result.bytesBase64, 'base64');
    expect(result).toMatchObject({
      assetId: expect.stringMatching(/^audio-source-denoised-[a-f0-9]{8}$/),
      mimeType: 'audio/wav',
      method: 'ffmpeg-afftdn',
      strength: 0.5,
    });
    expect(output.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(output.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(temporaryDirectory).toBeDefined();
    await expect(access(temporaryDirectory!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kills a hung ffmpeg process at the configured timeout and still cleans up', async () => {
    let temporaryDirectory: string | undefined;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const kill = vi.fn((signal?: NodeJS.Signals | number) => {
      queueMicrotask(() => child.emit('close', null, typeof signal === 'string' ? signal : null));
      return true;
    });
    Object.assign(child, { kill });
    const launch = vi.fn((_command: string, args: string[]) => {
      temporaryDirectory = dirname(args[2]!);
      return child;
    }) as unknown as typeof spawn;

    await expect(
      runSpectralDenoise(
        { assetId: 'hung-audio', mediaBase64: silentWav().toString('base64') },
        { spawn: launch, timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED', message: 'ffmpeg afftdn timed out' });

    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(temporaryDirectory).toBeDefined();
    await expect(access(temporaryDirectory!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('caps decoded duration and rejects oversized output from stat before reading it', async () => {
    let capturedArgs: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const launch = vi.fn((_command: string, args: string[]) => {
      capturedArgs = args;
      const outputPath = args.at(-1)!;
      const descriptor = openSync(outputPath, 'w');
      ftruncateSync(descriptor, MAX_DENOISE_OUTPUT_BYTES + 1);
      closeSync(descriptor);
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    }) as unknown as typeof spawn;

    await expect(
      runSpectralDenoise(
        { assetId: 'large-output', mediaBase64: silentWav().toString('base64') },
        { spawn: launch },
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
      message: 'ffmpeg afftdn output exceeded the server size limit',
    });

    expect(capturedArgs).toContain('-t');
    expect(capturedArgs[capturedArgs.indexOf('-t') + 1]).toBe(String(MAX_DENOISE_DURATION_SECONDS));
    expect(capturedArgs).toContain('-fs');
    expect(capturedArgs[capturedArgs.indexOf('-fs') + 1]).toBe(String(MAX_DENOISE_OUTPUT_BYTES));
  });

  it('rejects malformed base64 and decoded media above the fixed byte ceiling', async () => {
    await expect(
      runSpectralDenoise({ assetId: 'bad-audio', mediaBase64: 'not-base64!' }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID', message: 'mediaBase64 is invalid' });

    const oversizedBase64 = 'A'.repeat((MAX_DENOISE_MEDIA_BYTES / 3 + 1) * 4);
    await expect(
      runSpectralDenoise({ assetId: 'large-audio', mediaBase64: oversizedBase64 }),
    ).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
      message: 'decoded media exceeds the size limit',
    });
  });

  it.each([
    [{ strength: -0.01 }, 'strength must be between 0 and 1'],
    [{ strength: 1.01 }, 'strength must be between 0 and 1'],
    [{ sampleRate: 7_999 }, 'sampleRate must be between 8000 and 192000'],
    [{ sampleRate: 192_001 }, 'sampleRate must be between 8000 and 192000'],
  ] as const)('rejects unsafe numeric input %o', async (values, message) => {
    await expect(
      runSpectralDenoise({
        assetId: 'audio-source',
        mediaBase64: silentWav().toString('base64'),
        ...values,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID', message });
  });
});

function silentWav(sampleRate = 16_000, durationMs = 100): Buffer {
  const sampleCount = Math.round((sampleRate * durationMs) / 1_000);
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}
