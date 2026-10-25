import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeAudioPresence } from './media-presence.js';

describe('probeAudioPresence', () => {
  let dir: string;
  let silentVideo: string;
  let videoWithAudio: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'joy-media-presence-'));
    silentVideo = join(dir, 'silent.mp4');
    videoWithAudio = join(dir, 'with-audio.mp4');
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=160x120:rate=10',
      '-pix_fmt',
      'yuv420p',
      silentVideo,
    ]);
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=160x120:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-pix_fmt',
      'yuv420p',
      '-shortest',
      videoWithAudio,
    ]);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a video with no audio stream as confirmed absent, from real ffprobe output', async () => {
    expect(await probeAudioPresence(silentVideo)).toEqual({ status: 'absent' });
  });

  it('reports a video with an audio stream as present, from real ffprobe output', async () => {
    expect(await probeAudioPresence(videoWithAudio)).toEqual({ status: 'present', streams: 1 });
  });

  it('reports unknown, never absent, when ffprobe is not installed', async () => {
    const result = await probeAudioPresence('ignored.mp4', async () => {
      throw Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' });
    });
    expect(result).toEqual({ status: 'unknown', reason: 'ffprobe is not installed' });
  });

  it('reports unknown when ffprobe cannot read the file', async () => {
    const result = await probeAudioPresence(join(dir, 'missing.mp4'));
    expect(result.status).toBe('unknown');
  });
});
