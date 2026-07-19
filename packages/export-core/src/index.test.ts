import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ffmpegArgs, freezeManifest, renderFixture, verifyExport } from './index.js';
describe('deterministic export contract', () => {
  const manifest = {
    projectId: 'p',
    revision: 4,
    width: 64,
    height: 36,
    frameRate: 30,
    durationUs: 100_000,
    preset: 'social-h264-aac',
  } as const;
  it('freezes a manifest and uses argument arrays', () => {
    expect(freezeManifest(manifest)).toEqual(manifest);
    expect(ffmpegArgs(manifest, 'out.mp4')).toContain('libx264');
  });
  it('produces a verified H.264/AAC fixture through ffmpeg', () => {
    const output = join(mkdtempSync(join(tmpdir(), 'joy-media-export-')), 'fixture.mp4');
    renderFixture(manifest, output);
    expect(verifyExport(output)).toMatchObject({
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 64,
      height: 36,
    });
  });
});
