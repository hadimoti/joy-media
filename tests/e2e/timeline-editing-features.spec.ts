import { expect, test, type Page } from '@playwright/test';
import {
  authenticate,
  openPanel,
  openReferenceWorkspace,
  selectFirstTimelineClip,
} from './wp29-r5-harness.js';

/** Picks a canvas shape. A project with clips first asks how to reframe them; "Keep positions" moves nothing. */
async function pickCanvasShape(page: Page, shape: string): Promise<void> {
  await page
    .getByRole('group', { name: 'Canvas shape' })
    .getByRole('button', { name: shape, exact: true })
    .click();
  const reframe = page.getByRole('dialog', { name: 'Reframe clips for the new canvas?' });
  if (
    await reframe.waitFor({ state: 'visible', timeout: 3_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await reframe.getByRole('radio', { name: /Keep positions/ }).check();
    await reframe.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(reframe).toBeHidden();
  }
}

test.describe('Timeline editing features — aspect ratio, merge, and speed', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('changes an authored monitor aspect ratio and Undo restores the persisted canvas', async ({
    page,
  }) => {
    await openReferenceWorkspace(page);
    // The monitor's canvas-format trigger reads "Canvas format: <readout>"; its shapes are buttons in
    // the Format popover, grouped as "Canvas shape".
    const selector = page.getByRole('button', { name: /^Canvas format:/ });
    await expect(selector).toBeVisible();
    await selector.click();
    await pickCanvasShape(page, '1:1');
    await expect(selector).toHaveAccessibleName(/Canvas format:.*1:1/);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(selector).toHaveAccessibleName(/Canvas format:.*9:16/);

    await selector.click();
    await pickCanvasShape(page, '1:1');
    await page.reload();
    await expect(page.getByRole('button', { name: /^Canvas format:.*1:1/ })).toBeVisible();
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
