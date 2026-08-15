import { expect, test, type Download, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEDIA_FIXTURE_DIR,
  authenticate,
  openDisposableWorkspace,
  openPanel,
} from './wp29-r5-harness.js';

async function importAnimatedGif(page: Page, name: string): Promise<void> {
  await openPanel(page, 'Assets');
  await page.getByRole('button', { name: 'Import media' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Import media' });
  await drawer.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
    name,
    mimeType: 'image/gif',
    buffer: readFileSync(join(MEDIA_FIXTURE_DIR, 'animated.gif')),
  });
  await expect(drawer.getByText(name, { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Confirm import' }).click();
  const card = page.locator('.asset-card', { hasText: name });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole('button', { name: `Add ${name} to timeline` }).click();
  await expect(page.locator(`.timeline-clip[aria-label^="${name},"]`)).toHaveCount(1);
}

async function cleanup(page: Page): Promise<void> {
  const projectId = await page.evaluate(() => {
    const raw = localStorage.getItem('joy-media.active-project.v1');
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { projectId?: unknown };
      return typeof parsed.projectId === 'string' ? parsed.projectId : null;
    } catch {
      return raw;
    }
  });
  if (projectId === null) return;
  await page.evaluate(async (id) => {
    const headers = { authorization: 'Bearer joy-media-e2e-token' };
    const assets = await fetch(`/api/v1/projects/${encodeURIComponent(id)}/assets`, { headers });
    if (assets.ok) {
      const data = (await assets.json()) as {
        data?: readonly { id: string; displayName: string }[];
      };
      for (const asset of data.data ?? []) {
        if (asset.displayName.startsWith('wp30-')) {
          await fetch(
            `/api/v1/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(asset.id)}`,
            { method: 'DELETE', headers },
          );
        }
      }
    }
    await fetch(`/api/v1/projects/${encodeURIComponent(id)}/trash`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 0 }),
    });
    await fetch(`/api/v1/projects/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
  }, projectId);
}

test.describe('WP-30 animated timeline export', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('exports a placed animated GIF and retains a verified download', async ({ page }, info) => {
    test.setTimeout(180_000);
    const name = `wp30-export-${info.project.name}-${Date.now()}.gif`;
    try {
      await openDisposableWorkspace(page, `WP-30 export ${Date.now()}`);
      await importAnimatedGif(page, name);
      const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
      await page.getByRole('button', { name: 'Export MP4' }).click();
      const download: Download = await downloadPromise;
      const path = await download.path();
      expect(path).not.toBeNull();
      const bytes = readFileSync(path!).byteLength;
      expect(bytes).toBeGreaterThan(0);
      const probe = JSON.parse(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path!],
          { encoding: 'utf8' },
        ),
      ) as {
        streams?: readonly { codec_type?: string; codec_name?: string }[];
        format?: { duration?: string };
      };
      expect(probe.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ codec_type: 'video', codec_name: 'h264' }),
          expect.objectContaining({ codec_type: 'audio', codec_name: 'aac' }),
        ]),
      );
      const durationSeconds = Number(probe.format?.duration);
      expect(durationSeconds).toBeGreaterThanOrEqual(0.95);
      expect(durationSeconds).toBeLessThanOrEqual(1.05);
      const frameHashes = execFileSync(
        'ffmpeg',
        ['-v', 'error', '-i', path!, '-map', '0:v:0', '-an', '-f', 'framemd5', '-'],
        { encoding: 'utf8' },
      )
        .split(/\r?\n/)
        .filter((line) => /^\s*0,/.test(line))
        .map((line) => line.split(',').at(-1)?.trim())
        .filter((hash): hash is string => hash !== undefined);
      const uniqueFrameHashes = [...new Set(frameHashes)];
      expect(frameHashes).toHaveLength(30);
      expect(uniqueFrameHashes.length).toBeGreaterThan(1);
      await info.attach('animated-export.json', {
        body: Buffer.from(
          JSON.stringify({
            name,
            bytes,
            filename: download.suggestedFilename(),
            duration: durationSeconds,
            frameCount: frameHashes.length,
            uniqueFrameHashes,
          }),
        ),
        contentType: 'application/json',
      });
    } finally {
      await cleanup(page);
    }
  });
});
