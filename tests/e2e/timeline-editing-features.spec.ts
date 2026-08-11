import { expect, test } from '@playwright/test';
import {
  authenticate,
  openPanel,
  openReferenceWorkspace,
  selectFirstTimelineClip,
} from './wp29-r5-harness.js';

test.describe('Timeline editing features — aspect ratio, merge, and speed', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('changes an authored monitor aspect ratio and Undo restores the persisted canvas', async ({
    page,
  }) => {
    await openReferenceWorkspace(page);
    const selector = page.getByRole('button', { name: /Canvas aspect ratio/ });
    await expect(selector).toBeVisible();
    await selector.click();
    await page.getByRole('menuitemradio', { name: '1:1' }).click();
    const monitorMeta = page.locator('article.monitor-panel span.monitor-meta[dir="ltr"]');
    await expect(monitorMeta).toContainText('1080 × 1080');

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(monitorMeta).toContainText('1080 × 1920');
    await expect(selector).toHaveAccessibleName('Canvas aspect ratio (9:16)');

    await selector.click();
    await page.getByRole('menuitemradio', { name: '1:1' }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Canvas aspect ratio (1:1)' })).toBeVisible();
    await expect(page.locator('article.monitor-panel span.monitor-meta[dir="ltr"]')).toContainText(
      '1080 × 1080',
    );
  });

  test('merges contiguous clips from the context menu, drills in, and returns with Back', async ({
    page,
  }) => {
    await openReferenceWorkspace(page);
    const clips = page.locator('.timeline-track[data-track-id]').first().locator('.timeline-clip');
    const first = clips.nth(0);
    const second = clips.nth(1);
    await first.click();
    await second.click({ modifiers: ['Control'] });
    await first.click({ button: 'right' });
    const merge = page.getByRole('menuitem', { name: /Merge 2 selected clips/ });
    await expect(merge).toBeVisible();
    await merge.click();

    const compound = page.locator('.timeline-clip[data-clip-id^="compound-"]');
    await expect(compound).toHaveCount(1);
    await expect(compound).toHaveClass(/timeline-clip--comp/);
    // Dockview remounts the selected clip between physical clicks. Two
    // immediate clicks reproduce a real double-click while re-resolving the
    // clip after that remount (Playwright's atomic dblclick cannot).
    await compound.click();
    await compound.click();
    const back = page.getByRole('button', { name: 'Back to parent timeline' });
    await expect(back).toBeVisible();
    await back.click();
    await expect(back).toHaveCount(0);
  });

  test('changes speed manually, reverses, and applies an undoable source-continuous ramp', async ({
    page,
  }) => {
    await openReferenceWorkspace(page);
    await selectFirstTimelineClip(page);
    await openPanel(page, 'Inspector');
    await page.getByRole('tab', { name: 'Speed' }).click();
    const rate = page.getByLabel('Rate');
    await expect(rate).toHaveValue('1');
    await rate.fill('1.25');
    await expect(rate).toHaveValue('1.25');

    await page.getByRole('button', { name: 'Set speed to reverse' }).click();
    const selected = page.locator('.timeline-clip[aria-pressed="true"]');
    await selected.click({ button: 'right' });
    const restoreForward = page.getByRole('menuitem', { name: 'Restore forward playback' });
    await expect(restoreForward).toBeVisible();

    // Restore forward, then apply a duration-preserving three-segment ramp.
    await restoreForward.click();
    await page.getByRole('button', { name: 'Ease In', exact: true }).click();
    await expect(page.locator('.timeline-clip[data-clip-id*="-ramp-ease-in-"]')).toHaveCount(3);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.timeline-clip[data-clip-id*="-ramp-ease-in-"]')).toHaveCount(0);
  });
});
