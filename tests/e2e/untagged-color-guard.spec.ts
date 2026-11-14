import { expect, test, type Page, type Route } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * C-078: Guard test that untagged SD decodes as BT.601 and HD as BT.709 in the browser runtime.
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

  test.beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'joy-untagged-guard-'));
    sd601Path = join(tempDir, 'sd-bt601.mp4');
    sd709Path = join(tempDir, 'sd-bt709.mp4');
    hd601Path = join(tempDir, 'hd-bt601.mp4');
    hd709Path = join(tempDir, 'hd-bt709.mp4');

    // 640x480 SD encoded with BT.601 matrix, untagged VUI
    spawnSync('ffmpeg', [
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
    ]);

    // 640x480 SD encoded with BT.709 matrix, untagged VUI
    spawnSync('ffmpeg', [
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
    ]);

    // 1280x720 HD encoded with BT.601 matrix, untagged VUI
    spawnSync('ffmpeg', [
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
    ]);

    // 1280x720 HD encoded with BT.709 matrix, untagged VUI
    spawnSync('ffmpeg', [
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
    ]);
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
      const video = document.createElement('video');
      video.src = url;
      video.muted = true;
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('Video element failed to load fixture'));
        video.load();
      });
      video.currentTime = 0.1;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
      });
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
      if (!ctx) throw new Error('Cannot get 2d sRGB canvas context');
      ctx.drawImage(video, 0, 0);
      const cx = Math.floor(video.videoWidth / 2);
      const cy = Math.floor(video.videoHeight / 2);
      const pixel = ctx.getImageData(cx, cy, 1, 1).data;
      return { r: pixel[0]!, g: pixel[1]!, b: pixel[2]! };
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
