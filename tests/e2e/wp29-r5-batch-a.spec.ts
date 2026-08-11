import { expect, test } from '@playwright/test';
import {
  MEDIA_FIXTURE_DIR,
  authenticate,
  importMediaFixture,
  openDisposableWorkspace,
  openPanel,
  recordEvidence,
} from './wp29-r5-harness.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test.describe('WP-29 R5 batch A — file bridge', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('[R5 CASE-15] imports PNG and JPEG through the real file input', async ({
    page,
  }, testInfo) => {
    await openDisposableWorkspace(page, `R5-15-${testInfo.project.name}`);
    await openPanel(page, 'Assets');
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/v1/library/my-assets')),
      page.getByRole('button', { name: 'Refresh assets' }).click(),
    ]);
    const imageSource = page.getByRole('button', {
      name: 'Showing cloud bucket assets; switch to user assets',
    });
    if (await imageSource.isVisible()) await imageSource.click();
    await expect(
      page.getByRole('button', { name: 'Showing user assets; switch to cloud bucket assets' }),
    ).toBeVisible();
    const pngCards = page.locator('.asset-card', { hasText: 'image.png' });
    const jpegCards = page.locator('.asset-card', { hasText: 'image.jpg' });
    const pngBaseline = await pngCards.count();
    const jpegBaseline = await jpegCards.count();
    const imageCountBefore = Number(
      (await page.getByRole('tab', { name: /Images \d+/ }).textContent())?.match(/\d+/)?.[0] ?? 0,
    );
    await importMediaFixture(page, 'image.png');
    await importMediaFixture(page, 'image.jpg');

    await expect(pngCards).toHaveCount(pngBaseline + 1);
    await expect(jpegCards).toHaveCount(jpegBaseline + 1);
    await expect(page.getByRole('tab', { name: `Images ${imageCountBefore + 2}` })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await recordEvidence(testInfo, {
      caseId: 15,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'PNG and JPEG each import once with visible cards and the correct category count.',
      actual: 'Both fixture cards appeared and Images reported two assets.',
      fixture: 'image.png, image.jpg',
    });
  });

  test('[R5 CASE-16] imports, previews, and places a short MP4', async ({ page }, testInfo) => {
    await openDisposableWorkspace(page, `R5-16-${testInfo.project.name}`);
    await openPanel(page, 'Assets');
    const mediaName = `wp29-case16-${testInfo.project.name}-${Date.now()}.mp4`;
    const videoCards = page.locator('.asset-card', { hasText: mediaName });
    const videoCountBefore = Number(
      (await page.getByRole('tab', { name: /Video \d+/ }).textContent())?.match(/\d+/)?.[0] ?? 0,
    );

    await page.getByRole('button', { name: 'Import media' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Import media' });
    await drawer.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
      name: mediaName,
      mimeType: 'video/mp4',
      buffer: readFileSync(join(MEDIA_FIXTURE_DIR, 'video.mp4')),
    });
    await drawer.getByRole('button', { name: 'Confirm import' }).click();

    await expect(videoCards).toHaveCount(1);
    const videoTab = page.getByRole('tab', { name: /Video \d+/ });
    await expect(videoTab).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(async () => Number((await videoTab.textContent())?.match(/\d+/)?.[0] ?? 0))
      .toBeGreaterThan(videoCountBefore);
    const card = videoCards.first();
    await card.getByRole('button', { name: `Preview ${mediaName}` }).click();
    const preview = page.getByRole('region', { name: `Preview: ${mediaName}` });
    await expect(preview).toBeVisible();
    await expect(preview.locator('video[controls]')).toHaveAttribute('src', /^blob:/);

    await card.getByRole('button', { name: `Add ${mediaName} to timeline` }).click();
    const placedClip = page.locator('.timeline-clip[data-clip-id]').first();
    await expect(placedClip).toBeVisible();
    await placedClip.click();
    await expect(placedClip).toHaveAttribute('aria-pressed', 'true');

    await recordEvidence(testInfo, {
      caseId: 16,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected:
        'A short MP4 imports exactly once, opens a verified browser preview, and can be placed and selected for editing.',
      actual:
        'The real file input added one Video card, Preview opened a controlled Blob-backed video, and Add to timeline created one selectable clip.',
      fixture: `video.mp4 bytes uploaded as ${mediaName}`,
    });
  });

  test('[R5 CASE-17] imports WAV and MP3 with audio categorization', async ({ page }, testInfo) => {
    await openDisposableWorkspace(page, `R5-17-${testInfo.project.name}`);
    await openPanel(page, 'Assets');
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/v1/library/my-assets')),
      page.getByRole('button', { name: 'Refresh assets' }).click(),
    ]);
    const audioSource = page.getByRole('button', {
      name: 'Showing cloud bucket assets; switch to user assets',
    });
    if (await audioSource.isVisible()) await audioSource.click();
    await expect(
      page.getByRole('button', { name: 'Showing user assets; switch to cloud bucket assets' }),
    ).toBeVisible();
    await page.getByRole('tab', { name: /Audio \d+/ }).click();
    const wavCards = page.locator('.asset-card', { hasText: 'audio.wav' });
    const mp3Cards = page.locator('.asset-card', { hasText: 'audio.mp3' });
    const wavBaseline = await wavCards.count();
    const mp3Baseline = await mp3Cards.count();
    const audioCountBefore = Number(
      (await page.getByRole('tab', { name: /Audio \d+/ }).textContent())?.match(/\d+/)?.[0] ?? 0,
    );
    await importMediaFixture(page, 'audio.wav');
    await importMediaFixture(page, 'audio.mp3');

    await expect(wavCards).toHaveCount(wavBaseline + 1);
    await expect(mp3Cards).toHaveCount(mp3Baseline + 1);
    await expect(page.getByRole('tab', { name: `Audio ${audioCountBefore + 2}` })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await recordEvidence(testInfo, {
      caseId: 17,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'WAV and MP3 import once and remain discoverable in Audio.',
      actual: 'Both audio fixture cards appeared and Audio reported two assets.',
      fixture: 'audio.wav, audio.mp3',
    });
  });

  test('[R5 CASE-18] rejects invalid, corrupt, and empty imports without partial cards', async ({
    page,
  }, testInfo) => {
    await openDisposableWorkspace(page, `R5-18-${testInfo.project.name}`);
    await openPanel(page, 'Assets');
    await page.getByRole('button', { name: 'Import media' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Import media' });

    for (const fileName of ['invalid.txt', 'corrupt.mp4', 'empty.bin']) {
      await drawer
        .locator('input[type="file"][aria-label="Media file"]')
        .setInputFiles(join(MEDIA_FIXTURE_DIR, fileName));
      await drawer.getByRole('button', { name: 'Confirm import' }).click();
      await expect(page.locator('.joy-panel-note')).toContainText(/Failed to register media:/, {
        timeout: 10_000,
      });
      await expect(page.locator('.asset-card', { hasText: fileName })).toHaveCount(0);
    }
    await recordEvidence(testInfo, {
      caseId: 18,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'Unsupported, corrupt, and empty fixtures receive feedback and create no asset.',
      actual: 'Each fixture produced the failure status and no asset card.',
      fixture: 'invalid.txt, corrupt.mp4, empty.bin',
    });
  });

  test('[R5 CASE-25] drags an imported asset card onto a real timeline track', async ({
    page,
  }, testInfo) => {
    await openDisposableWorkspace(page, `R5-25-${testInfo.project.name}`);
    await importMediaFixture(page, 'image.png');
    const card = page.locator('.asset-card', { hasText: 'image.png' }).first();
    const lane = page.locator('.timeline-lane[data-track-id]').first();
    await expect(page.locator('.timeline-clip[data-clip-id]')).toHaveCount(0);
    await card.dragTo(lane, { targetPosition: { x: 80, y: 20 } });
    const placedClip = page.locator('.timeline-clip[data-clip-id]').first();
    await expect(placedClip).toHaveCount(1);
    await expect(placedClip).toHaveClass(/timeline-clip--video/);
    await expect(placedClip).toHaveAttribute('data-clip-id', /^clip-media-/);
    await recordEvidence(testInfo, {
      caseId: 25,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'A real drag from Assets creates one typed timeline clip at the target track.',
      actual: 'The imported image card created exactly one video-typed media clip.',
      fixture: 'image.png',
    });
  });

  test('[R5 CASE-93] attaches and removes a Markdown fixture in Joy Code', async ({
    page,
  }, testInfo) => {
    await openDisposableWorkspace(page, `R5-93-${testInfo.project.name}`);
    await openPanel(page, 'Joy Code');
    await page
      .locator('.joy-code-panel input[type="file"]')
      .setInputFiles(join(MEDIA_FIXTURE_DIR, 'joycode-attachment.md'));
    const attachments = page.getByRole('list', { name: 'Attached media' });
    await expect(attachments).toContainText('joycode-attachment.md');
    await attachments.getByRole('button', { name: 'Detach joycode-attachment.md' }).click();
    await expect(attachments).toHaveCount(0);
    await recordEvidence(testInfo, {
      caseId: 93,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'Markdown attachment previews, can be removed, and does not submit a prompt.',
      actual: 'The named attachment appeared and Detach removed the attachment list.',
      fixture: 'joycode-attachment.md',
    });
  });
});
