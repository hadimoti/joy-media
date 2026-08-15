import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFERENCE_PROJECT } from '@joy-media/test-fixtures';
import {
  ffmpegArgs,
  freezeManifest,
  remuxBrowserMp4,
  renderFixture,
  renderRgbaFrames,
  verifyExport,
  verifyExportAgainstManifest,
} from './index.js';
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
      durationUs: 100_000,
      frameRate: 30,
      videoStreamCount: 1,
      audioStreamCount: 1,
    });
    expect(verifyExportAgainstManifest(output, manifest)).toMatchObject({
      width: 64,
      height: 36,
    });
  });
  it('encodes evaluated RGBA pixels through the verified export path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-rgba-export-'));
    const output = join(directory, 'scene-reel.mp4');
    const red = new Uint8Array(manifest.width * manifest.height * 4);
    for (let offset = 0; offset < red.length; offset += 4) {
      red[offset] = 220;
      red[offset + 3] = 255;
    }
    renderRgbaFrames(manifest, [red, red], output);
    expect(verifyExport(output)).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
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
  it('remuxes browser MP4 to h264/aac with exactly one video and audio stream at 30 fps', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-remux-'));
    const fixturePath = join(directory, 'browser.mp4');
    const outputPath = join(directory, 'remuxed.mp4');
    renderFixture(manifest, fixturePath);
    const probe = remuxBrowserMp4(fixturePath, outputPath);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');
    expect(probe.videoStreamCount).toBe(1);
    expect(probe.audioStreamCount).toBe(1);
    expect(probe.frameRate).toBe(30);
    expect(readdirSync(directory).some((name) => name.includes('.partial.'))).toBe(false);
  });
  it('normalizes slow browser-capture timestamps to the authored frame count', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-remux-timeline-'));
    const fixturePath = join(directory, 'slow-browser.mp4');
    const outputPath = join(directory, 'normalized.mp4');
    renderFixture(
      {
        ...manifest,
        frameRate: 1,
        durationUs: 2_000_000,
      },
      fixturePath,
    );

    const probe = remuxBrowserMp4(fixturePath, outputPath, 30, 2);
    expect(probe.frameRate).toBe(30);
    expect(probe.durationUs).toBeGreaterThanOrEqual(60_000);
    expect(probe.durationUs).toBeLessThanOrEqual(100_000);
  });
});
