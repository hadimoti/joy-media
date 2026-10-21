import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectAudioPresence, inspectMp4AudioPresence } from './media-audio-presence.js';

describe('MP4 audio presence from container metadata', () => {
  let dir: string;
  let fixtures: Record<string, Blob>;

  function encode(name: string, args: readonly string[]): void {
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, join(dir, name)]);
  }

  function blobOf(name: string): Blob {
    return new Blob([readFileSync(join(dir, name))], { type: 'video/mp4' });
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'joy-audio-presence-'));
    const picture = ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10'];
    const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'];
    // ffmpeg writes `moov` after `mdat` by default; the faststart variant puts it first.
    encode('silent.mp4', [...picture, '-pix_fmt', 'yuv420p']);
    encode('with-audio.mp4', [...picture, ...tone, '-pix_fmt', 'yuv420p', '-shortest']);
    encode('silent-faststart.mp4', [...picture, '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
    encode('with-audio-faststart.mp4', [
      ...picture,
      ...tone,
      '-pix_fmt',
      'yuv420p',
      '-shortest',
      '-movflags',
      '+faststart',
    ]);
    fixtures = {
      silent: blobOf('silent.mp4'),
      withAudio: blobOf('with-audio.mp4'),
      silentFaststart: blobOf('silent-faststart.mp4'),
      withAudioFaststart: blobOf('with-audio-faststart.mp4'),
    };
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a silent MP4 as absent, with the moov box at the end of the file', async () => {
    expect(await inspectMp4AudioPresence(fixtures.silent!)).toEqual({ status: 'absent' });
  });

  it('reports an MP4 with an audio track as present, with the moov box at the end', async () => {
    expect(await inspectMp4AudioPresence(fixtures.withAudio!)).toEqual({
      status: 'present',
      streams: 1,
    });
  });

  it('agrees with the same files when the moov box is at the start (faststart)', async () => {
    expect(await inspectMp4AudioPresence(fixtures.silentFaststart!)).toEqual({ status: 'absent' });
    expect(await inspectMp4AudioPresence(fixtures.withAudioFaststart!)).toEqual({
      status: 'present',
      streams: 1,
    });
  });

  it('reports unknown, never absent, for a file that is not an MP4 container', async () => {
    const result = await inspectAudioPresence(new Blob(['plain text']), 'notes.mp4');
    expect(result.status).toBe('unknown');
  });

  it('reports unknown for a truncated file whose metadata cannot be read in full', async () => {
    const whole = readFileSync(join(dir, 'with-audio.mp4'));
    const truncated = new Blob([whole.subarray(0, 200)], { type: 'video/mp4' });
    const result = await inspectMp4AudioPresence(truncated);
    expect(result.status).toBe('unknown');
  });

  it('reports unknown for containers without a metadata reader, instead of guessing', async () => {
    writeFileSync(join(dir, 'clip.webm'), 'not really webm');
    const result = await inspectAudioPresence(new Blob(['x']), 'clip.webm');
    expect(result).toEqual({ status: 'unknown', reason: 'no metadata reader for this container' });
  });
});
