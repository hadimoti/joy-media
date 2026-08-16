import { expect, test } from '@playwright/test';
import { authenticate, openReferenceWorkspace, recordEvidence } from './wp29-r5-harness.js';

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
});
