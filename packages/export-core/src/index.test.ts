import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFERENCE_PROJECT } from '@joy-media/test-fixtures';
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
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-export-'));
    const output = join(directory, 'fixture.mp4');
    renderFixture(manifest, output);
    expect(existsSync(output)).toBe(true);
    expect(readdirSync(directory).some((name) => name.includes('.partial.'))).toBe(false);
    expect(verifyExport(output)).toMatchObject({
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 64,
      height: 36,
    });
  });
  it('exports both golden social formats from a frozen revision', () => {
    for (const format of REFERENCE_PROJECT.formats) {
      const output = join(
        mkdtempSync(join(tmpdir(), 'joy-media-reference-')),
        `${format.width}x${format.height}.mp4`,
      );
      renderFixture(
        {
          ...manifest,
          projectId: REFERENCE_PROJECT.id,
          revision: REFERENCE_PROJECT.revision,
          width: format.width,
          height: format.height,
        },
        output,
      );
      expect(verifyExport(output)).toMatchObject(format);
    }
  });
});
