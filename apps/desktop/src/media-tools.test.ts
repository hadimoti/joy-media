import { describe, expect, it } from 'vitest';
import { discoverMediaTools } from './media-tools.js';

describe('explicit media tool discovery', () => {
  it('fails closed when either required tool is unavailable', () => {
    expect(discoverMediaTools({}, 'win32', () => false)).toMatchObject({ ready: false });
  });
  it('accepts two explicitly configured executable paths', () => {
    expect(
      discoverMediaTools(
        { ffmpegPath: 'ffmpeg.exe', ffprobePath: 'ffprobe.exe' },
        'win32',
        () => true,
        () => true,
      ),
    ).toMatchObject({ ready: true, ffmpegPath: 'ffmpeg.exe', ffprobePath: 'ffprobe.exe' });
  });
});
