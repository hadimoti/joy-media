import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  authenticate,
  MEDIA_FIXTURE_DIR,
  openDisposableWorkspace,
  openPanel,
} from './wp29-r5-harness.js';

// Browser-only export (no desktop host), so audio presence comes from the MP4 metadata reader.
// A silent video must export without an audio decode; a video with sound must keep it.

async function importAndAddFixture(page: Page, fixture: string, displayName: string): Promise<void> {
  await openPanel(page, 'Assets');
  await page.getByRole('button', { name: 'Import media' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Import media' });
  await drawer.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
    name: displayName,
    mimeType: 'video/mp4',
    buffer: readFileSync(join(MEDIA_FIXTURE_DIR, fixture)),
  });
  await expect(drawer.getByText(displayName, { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Confirm import' }).click();
  const card = page.locator('.asset-card', { hasText: displayName }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole('button', { name: `Add ${displayName} to timeline` }).click();
  await expect(page.locator(`.timeline-clip[aria-label^="${displayName},"]`)).toHaveCount(1);
}

/** Exports, waits for a verified MP4, downloads it, and returns the local path. */
async function exportAndDownload(page: Page, directory: string): Promise<string> {
  await page.getByRole('button', { name: 'Export MP4' }).click();
  const trigger = page.getByRole('button', { name: 'Recent processes' });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  const processes = page.getByRole('region', { name: 'Recent processes' });
  await expect(processes).toContainText('Completed — final MP4 verified', { timeout: 150_000 });
  const redownload = page.getByRole('link', { name: /Download .* again/ }).first();
  await expect(redownload).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), redownload.click()]);
  const path = join(directory, download.suggestedFilename());
  await download.saveAs(path);
  return path;
}

function probe(path: string): { readonly duration: number; readonly audioStreams: number } {
  const duration = Number(
    JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', path], {
        encoding: 'utf8',
      }),
    ).format?.duration ?? 0,
  );
  const audio = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path],
    { encoding: 'utf8' },
  );
  return {
    duration,
    audioStreams: audio.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
  };
}

test.describe('silent-video export in the browser editor', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('a silent video exports to a playable MP4', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2, 7)}`;
    const directory = mkdtempSync(join(tmpdir(), 'joy-silent-web-'));
    try {
      await openDisposableWorkspace(page, `Silent-${testInfo.project.name}-${suffix}`);
      await importAndAddFixture(page, 'readiness-silent.mp4', `silent-${suffix}.mp4`);
      const output = await exportAndDownload(page, directory);
      expect(probe(output).duration).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a video with sound exports with its audio stream', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2, 7)}`;
    const directory = mkdtempSync(join(tmpdir(), 'joy-sound-web-'));
    try {
      await openDisposableWorkspace(page, `Sound-${testInfo.project.name}-${suffix}`);
      await importAndAddFixture(page, 'video.mp4', `sound-${suffix}.mp4`);
      const output = await exportAndDownload(page, directory);
      const result = probe(output);
      expect(result.duration).toBeGreaterThan(0);
      expect(result.audioStreams).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a mixed timeline of silent and sound videos exports, keeping the sound', async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2, 7)}`;
    const directory = mkdtempSync(join(tmpdir(), 'joy-mixed-web-'));
    try {
      await openDisposableWorkspace(page, `Mixed-${testInfo.project.name}-${suffix}`);
      await importAndAddFixture(page, 'readiness-silent.mp4', `silent-${suffix}.mp4`);
      await importAndAddFixture(page, 'video.mp4', `sound-${suffix}.mp4`);
      const output = await exportAndDownload(page, directory);
      const result = probe(output);
      expect(result.duration).toBeGreaterThan(0);
      expect(result.audioStreams).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
