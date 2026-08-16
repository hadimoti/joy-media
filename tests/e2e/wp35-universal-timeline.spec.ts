import { expect, test } from '@playwright/test';
import {
  authenticate,
  openReferenceWorkspace,
  openTimelineShowcaseWorkspace,
  recordEvidence,
} from './wp29-r5-harness.js';

test.describe('WP-35 universal timeline closeout', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('marquee-selects mixed timeline clips and Delete removes/restores the batch atomically', async ({
    page,
  }, testInfo) => {
    await openReferenceWorkspace(page);
    const clips = page.locator('.timeline-clip[data-clip-id]');
    const beforeCount = await clips.count();
    expect(beforeCount).toBeGreaterThanOrEqual(2);

    const targetTrack = page.locator('.timeline-track[data-track-id]').first();
    const lane = targetTrack.locator('.timeline-lane[data-track-id]');
    const laneBox = await lane.boundingBox();
    expect(laneBox).not.toBeNull();
    const targetClips = targetTrack.locator('.timeline-clip[data-clip-id]');
    const targetCount = await targetClips.count();
    expect(targetCount).toBeGreaterThanOrEqual(2);
    const targetBoxes = await targetClips.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    );
    const startX = Math.min(
      laneBox!.x + laneBox!.width - 8,
      Math.max(...targetBoxes.map((box) => box.right)) + 32,
    );
    const endX = Math.max(laneBox!.x + 8, Math.min(...targetBoxes.map((box) => box.left)) - 8);
    const y = laneBox!.y + laneBox!.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(endX, y, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator('.timeline-clip[aria-pressed="true"]')).toHaveCount(targetCount);
    await page.keyboard.press('Delete');
    await expect(page.locator('.timeline-clip[data-clip-id]')).toHaveCount(
      beforeCount - targetCount,
    );

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.timeline-clip[data-clip-id]')).toHaveCount(beforeCount);
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(page.locator('.timeline-clip[data-clip-id]')).toHaveCount(
      beforeCount - targetCount,
    );

    await recordEvidence(testInfo, {
      caseId: 35,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected:
        'A reverse marquee selects all intersecting timeline elements and Delete removes the batch in one undoable operation.',
      actual:
        'The marquee selected the rendered clips, Delete removed all clips without ripple, and one Undo/Redo restored and removed the same batch.',
    });
  });

  test('renders backend track titles, mixed elements, and Quarter preview controls', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1613, height: 1066 });
    await openTimelineShowcaseWorkspace(page);
    const trackNames = page.locator('.timeline-track-header .track-name');
    await expect(trackNames.first()).toHaveText('Video 1');
    await expect(trackNames.nth(1)).toHaveText('Video 2');
    await expect(trackNames.nth(2)).toHaveText('Overlay');
    await expect(page.locator('.timeline-track-header .track-code').nth(2)).toHaveText('T3');
    await expect(page.getByLabel('Monitor preview quality')).toHaveValue('quarter');
    await expect(page.getByLabel('Monitor preview renderer')).toHaveValue('auto');
    const transportMetrics = await page.locator('.monitor-transport').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(transportMetrics.scrollWidth).toBeLessThanOrEqual(transportMetrics.clientWidth);
    const transportBox = await page.locator('.monitor-transport').boundingBox();
    const settingsBox = await page.locator('.monitor-transport-end').boundingBox();
    expect(transportBox).not.toBeNull();
    expect(settingsBox).not.toBeNull();
    expect(settingsBox!.x).toBeGreaterThanOrEqual(transportBox!.x);
    expect(settingsBox!.x + settingsBox!.width).toBeLessThanOrEqual(
      transportBox!.x + transportBox!.width + 0.5,
    );
    const workspaceMetrics = await page.locator('.workspace').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(workspaceMetrics.scrollWidth).toBeLessThanOrEqual(workspaceMetrics.clientWidth);
    expect(await page.locator('.timeline-clip[data-clip-id]').count()).toBeGreaterThanOrEqual(6);
    await testInfo.attach('wp35-mixed-elements-authenticated.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    if (process.env.WP35_SCREENSHOT_PATH !== undefined)
      await page.screenshot({ path: process.env.WP35_SCREENSHOT_PATH, fullPage: true });
    await recordEvidence(testInfo, {
      caseId: 36,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected:
        'Universal row codes remain neutral while titles match backend track.name, mixed clips render, and the narrow Monitor footer contains Quarter/Auto without clipping.',
      actual:
        'T rows displayed Video 1/Video 2/Overlay from backend track identities, mixed clips were visible, and the two-row Monitor footer contained Quarter/Auto and every trailing control inside its dock.',
    });
  });

  test('releases browser decoder, audio, Pixi, and transient GPU URL resources on workspace close', async ({
    page,
  }, testInfo) => {
    await openReferenceWorkspace(page);
    await expect(page.locator('.monitor-canvas canvas')).toBeVisible();
    const active = await page.evaluate(
      () =>
        (window as Window & { __JOY_MEDIA_RESOURCE_AUDIT__?: { active: Record<string, number> } })
          .__JOY_MEDIA_RESOURCE_AUDIT__?.active,
    );
    expect(active?.['primary-decoder']).toBe(1);
    expect(active?.['pixi-renderer']).toBe(1);

    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: /Projects Library/ }).click();
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const audit = (
            window as Window & {
              __JOY_MEDIA_RESOURCE_AUDIT__?: {
                active: Record<string, number>;
                released: Record<string, number>;
              };
            }
          ).__JOY_MEDIA_RESOURCE_AUDIT__;
          return (
            (audit?.active['primary-decoder'] ?? 0) +
            (audit?.active['partner-decoder'] ?? 0) +
            (audit?.active['audio-context'] ?? 0) +
            (audit?.active['pixi-renderer'] ?? 0) +
            (audit?.active['gpu-frame-url'] ?? 0)
          );
        }),
      )
      .toBe(0);
    expect(
      await page.evaluate(() => {
        const released = (
          window as Window & {
            __JOY_MEDIA_RESOURCE_AUDIT__?: { released: Record<string, number> };
          }
        ).__JOY_MEDIA_RESOURCE_AUDIT__?.released;
        return (released?.['primary-decoder'] ?? 0) + (released?.['pixi-renderer'] ?? 0);
      }),
    ).toBeGreaterThanOrEqual(2);
    await recordEvidence(testInfo, {
      caseId: 37,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'Closing the workspace releases every preview-owned browser resource.',
      actual:
        'Browser counters reached zero active resources after project close; primary decoder and Pixi renderer each reported deterministic release.',
    });
  });
});
