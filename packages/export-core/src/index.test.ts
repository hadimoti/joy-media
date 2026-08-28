import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFERENCE_PROJECT } from '@joy-media/test-fixtures';
import { deliveryPromiseForManifest as browserDeliveryPromiseForManifest } from './browser.js';
import {
  deliveryPromiseForManifest,
  ffmpegArgs,
  freezeManifest,
  renderFixture,
  renderRgbaFrames,
  verifyExportDelivery,
  verifyExport,
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
  it('keeps the browser delivery projection in parity with the Node entry', () => {
    const nodePromise = deliveryPromiseForManifest(manifest);
    const browserPromise = browserDeliveryPromiseForManifest(manifest);
    expect(browserPromise).toEqual(nodePromise);
    expect(Object.isFrozen(browserPromise)).toBe(true);
    expect(Object.isFrozen(browserPromise.video)).toBe(true);
  });
  it.each([{ revision: -1 }, { width: 0 }, { height: 0 }, { frameRate: 0 }, { durationUs: 0 }])(
    'rejects invalid manifests in both entries (%s)',
    (invalid) => {
      const candidate = { ...manifest, ...invalid } as typeof manifest;
      expect(() => deliveryPromiseForManifest(candidate)).toThrow(RangeError);
      expect(() => browserDeliveryPromiseForManifest(candidate)).toThrow(RangeError);
    },
  );
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
    const report = verifyExportDelivery(output, deliveryPromiseForManifest(manifest), {
      outputRef: 'render-fixture-aaaaaaaaaaaaaaaa',
    });
    expect(report.findings.filter((finding) => finding.status === 'fail')).toEqual([
      expect.objectContaining({ code: 'audio-silence' }),
    ]);
    expect(JSON.stringify(report)).not.toContain(output);
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
});
