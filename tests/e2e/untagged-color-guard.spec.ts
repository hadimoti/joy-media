import { expect, test, type Page, type Route } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * C-078: Guard test for the production source-observation decoder's untagged color behavior.
 *
 * JOY does not choose a separate BT.601/BT.709 fallback matrix. Its source-observation path uses
 * Mediabunny/WebCodecs, where Chromium makes that decision. This test imports that production path
 * in the browser and measures the decoded pixels.
 *
 * Grounded in c2-untagged-decode-evidence-2026-11-06.md:
 * - Source color: RGB (200, 50, 50).
 * - Untagged SD (640x480):
 *   - Encoded with BT.601: Chromium decodes as ~(199, 49, 50) (matches source: decoder assumed BT.601)
 *   - Encoded with BT.709: Chromium decodes as ~(184, 31, 49) (off source: decoder assumed BT.601)
 * - Untagged HD (1280x720):
 *   - Encoded with BT.601: Chromium decodes as ~(213, 64, 50) (off source: decoder assumed BT.709)
 *   - Encoded with BT.709: Chromium decodes as ~(198, 47, 49) (matches source: decoder assumed BT.709)
 */

test.describe('untagged video color space decode guard (C-078)', () => {
  let tempDir: string;
  let sd601Path: string;
  let sd709Path: string;
  let hd601Path: string;
  let hd709Path: string;

  function runFfmpeg(args: string[], fixtureName: string, outputPath: string): void {
    const result = spawnSync('ffmpeg', ['-loglevel', 'error', ...args], { encoding: 'utf8' });
    if (result.error !== undefined) {
      throw new Error(
        `Could not create ${fixtureName}: ffmpeg could not start (${result.error.message}). ` +
          'Install ffmpeg and make sure it is available on PATH.',
      );
    }
    if (result.status !== 0) {
      const status =
        result.status === null
          ? `signal ${result.signal ?? 'unknown'}`
          : `exit code ${result.status}`;
      const details = result.stderr.trim() || result.stdout.trim();
      throw new Error(
        `Could not create ${fixtureName}: ffmpeg exited with ${status}.` +
          (details.length === 0 ? '' : ` ${details}`),
      );
    }
    if (!existsSync(outputPath)) {
      throw new Error(
        `Could not create ${fixtureName}: ffmpeg reported success but no file appeared.`,
      );
    }
  }

  test.beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'joy-untagged-guard-'));
    sd601Path = join(tempDir, 'sd-bt601.mp4');
    sd709Path = join(tempDir, 'sd-bt709.mp4');
    hd601Path = join(tempDir, 'hd-bt601.mp4');
    hd709Path = join(tempDir, 'hd-bt709.mp4');

    // 640x480 SD encoded with BT.601 matrix, untagged VUI
    runFfmpeg(
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0xC83232:s=640x480:d=0.5',
        '-vf',
        'scale=out_color_matrix=bt601',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-bsf:v',
        'h264_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2',
        sd601Path,
      ],
      'untagged SD BT.601 fixture',
      sd601Path,
    );

    // 640x480 SD encoded with BT.709 matrix, untagged VUI
    runFfmpeg(
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0xC83232:s=640x480:d=0.5',
        '-vf',
        'scale=out_color_matrix=bt709',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-bsf:v',
        'h264_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2',
        sd709Path,
      ],
      'untagged SD BT.709 fixture',
      sd709Path,
    );

    // 1280x720 HD encoded with BT.601 matrix, untagged VUI
    runFfmpeg(
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0xC83232:s=1280x720:d=0.5',
        '-vf',
        'scale=out_color_matrix=bt601',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-bsf:v',
        'h264_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2',
        hd601Path,
      ],
      'untagged HD BT.601 fixture',
      hd601Path,
    );

    // 1280x720 HD encoded with BT.709 matrix, untagged VUI
    runFfmpeg(
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0xC83232:s=1280x720:d=0.5',
        '-vf',
        'scale=out_color_matrix=bt709',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-bsf:v',
        'h264_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2',
        hd709Path,
      ],
      'untagged HD BT.709 fixture',
      hd709Path,
    );
  });

  test.afterAll(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function decodeCenterPixel(
    page: Page,
    filePath: string,
    routePath: string,
  ): Promise<{ r: number; g: number; b: number }> {
    const bytes = readFileSync(filePath);
    await page.route(`**${routePath}`, async (route: Route) => {
      await route.fulfill({
        contentType: 'video/mp4',
        body: bytes,
      });
    });

    return page.evaluate(async (url: string) => {
      const decoderModulePath = '/src/media-observation/source-decoder.ts';
      const schedulerModulePath = '/src/media-observation/resource-scheduler.ts';
      const { createBrowserSourceObservationDecoder } = await import(decoderModulePath);
      const { ObservationResourceScheduler } = await import(schedulerModulePath);
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`Could not fetch the untagged color fixture (${response.status}).`);
      const source = await response.blob();
      const digestBytes = await crypto.subtle.digest('SHA-256', await source.arrayBuffer());
      const assetDigest = Array.from(new Uint8Array(digestBytes), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const decoder = createBrowserSourceObservationDecoder({
        assetDigest,
        streamId: 'untagged-color-guard',
        source,
        scheduler: new ObservationResourceScheduler({
          maxWorkingSetBytes: 32 * 1024 * 1024,
          maxInFlight: 1,
        }),
        epoch: 0,
      });
      const iterator = decoder.frames({ startUs: 0, endUs: 500_000 }, new AbortController().signal);
      const frameIterator = iterator[Symbol.asyncIterator]();
      let frame: Awaited<ReturnType<typeof frameIterator.next>>['value'];
      try {
        const next = await frameIterator.next();
        frame = next.value;
        if (next.done || frame === undefined)
          throw new Error('The production decoder returned no frame.');
        const thumbnail = await frame.createThumbnail({
          maxWidth: 2_048,
          maxHeight: 2_048,
          maxBytes: 8 * 1024 * 1024,
          mimeType: 'image/png',
        });
        const bitmap = await createImageBitmap(thumbnail.blob);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d', { colorSpace: 'srgb' });
          if (!context) throw new Error('Cannot get 2d sRGB canvas context.');
          context.drawImage(bitmap, 0, 0);
          const pixel = context.getImageData(
            Math.floor(bitmap.width / 2),
            Math.floor(bitmap.height / 2),
            1,
            1,
          ).data;
          return { r: pixel[0]!, g: pixel[1]!, b: pixel[2]! };
        } finally {
          bitmap.close();
        }
      } finally {
        frame?.close();
        await frameIterator.return?.();
        decoder.close();
      }
    }, routePath);
  }

  test('untagged SD (640x480) decodes as BT.601 in the browser decoder', async ({ page }) => {
    await page.goto('/');

    const pixel601 = await decodeCenterPixel(page, sd601Path, '/__fixtures__/sd-bt601.mp4');
    const pixel709 = await decodeCenterPixel(page, sd709Path, '/__fixtures__/sd-bt709.mp4');

    // BT.601 encoded source matches source RGB(200, 50, 50) within 2 units
    expect(Math.abs(pixel601.r - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(pixel601.g - 50)).toBeLessThanOrEqual(2);
    expect(Math.abs(pixel601.b - 50)).toBeLessThanOrEqual(2);

    // BT.709 encoded source is off-source (~184, 31, 49) because decoder applied BT.601
    expect(pixel709.r).toBeLessThanOrEqual(188);
    expect(pixel709.g).toBeLessThanOrEqual(35);
  });

  test('untagged HD (1280x720) decodes as BT.709 in the browser decoder', async ({ page }) => {
    await page.goto('/');

    const pixel709 = await decodeCenterPixel(page, hd709Path, '/__fixtures__/hd-bt709.mp4');
    const pixel601 = await decodeCenterPixel(page, hd601Path, '/__fixtures__/hd-bt601.mp4');

    // BT.709 encoded source matches source RGB(200, 50, 50) within 3 units
    expect(Math.abs(pixel709.r - 200)).toBeLessThanOrEqual(3);
    expect(Math.abs(pixel709.g - 50)).toBeLessThanOrEqual(3);
    expect(Math.abs(pixel709.b - 50)).toBeLessThanOrEqual(3);

    // BT.601 encoded source is off-source (~213, 64, 50) because decoder applied BT.709
    expect(pixel601.r).toBeGreaterThanOrEqual(210);
    expect(pixel601.g).toBeGreaterThanOrEqual(60);
  });
});
