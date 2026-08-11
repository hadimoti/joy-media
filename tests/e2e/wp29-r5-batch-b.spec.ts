import { expect, test } from '@playwright/test';
import {
  authenticate,
  openReferenceWorkspace,
  recordEvidence,
  selectFirstTimelineClip,
} from './wp29-r5-harness.js';

test.describe('WP-29 R5 batch B — shell and timeline gestures', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('[R5 CASE-10] sign-out confirmation can be cancelled without losing the session', async ({
    page,
  }, testInfo) => {
    await openReferenceWorkspace(page);
    await page.getByRole('button', { name: 'Joy Studio account' }).click();
    await expect(page.getByRole('region', { name: 'Joy Studio account' })).toContainText('JOY E2E');
    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toContain('Sign out of JOY Studio?');
      await dialog.dismiss();
    });
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('.timeline-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Joy Studio account' })).toHaveAttribute(
      'title',
      /Signed in/,
    );
    expect(await page.evaluate(() => localStorage.getItem('joy-media-session-token'))).toBeTruthy();
    await recordEvidence(testInfo, {
      caseId: 10,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected:
        'Sign out asks for confirmation and cancellation keeps the authenticated workspace.',
      actual: 'The native confirmation was dismissed; the workspace and session remained intact.',
    });
  });

  test('[R5 CASE-32] pointer drag moves a clip onto a different track', async ({
    page,
  }, testInfo) => {
    await openReferenceWorkspace(page);
    await page.getByRole('button', { name: 'Add video track' }).click();
    const tracks = page.locator('.timeline-track[data-track-id]');
    await expect(tracks).toHaveCount(3);
    const clip = page.locator('.timeline-clip[data-clip-id]').first();
    const clipId = await clip.getAttribute('data-clip-id');
    const targetLane = tracks.nth(2).locator('.timeline-lane[data-track-id]');
    const sourceBox = await clip.boundingBox();
    const targetBox = await targetLane.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await page.mouse.move(
      sourceBox!.x + sourceBox!.width / 2,
      sourceBox!.y + sourceBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(targetBox!.x + 40, targetBox!.y + targetBox!.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(tracks.nth(2).locator(`.timeline-clip[data-clip-id="${clipId}"]`)).toHaveCount(1);
    await recordEvidence(testInfo, {
      caseId: 32,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'A pointer drag moves the selected clip to the lane under the release point.',
      actual: 'The same clip id moved from its source track into the newly added third track.',
    });
  });

  test('[R5 CASE-33] trim handles support precise keyboard editing', async ({ page }, testInfo) => {
    await openReferenceWorkspace(page);
    await selectFirstTimelineClip(page);
    const clip = page.locator('.timeline-clip[data-clip-id]').first();
    const before = await clip.getAttribute('aria-label');
    const clipId = await clip.getAttribute('data-clip-id');
    const endHandle = clip.locator('[data-trim-edge="end"]');
    await endHandle.focus();
    await expect(endHandle).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(clip).not.toHaveAttribute('aria-label', before!);
    await expect(endHandle).toHaveAttribute(
      'aria-keyshortcuts',
      'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight',
    );
    await recordEvidence(testInfo, {
      caseId: 33,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'The end trim changes duration and exposes documented keyboard controls.',
      actual: `ArrowLeft changed ${clipId}'s duration while focus remained on its semantic trim button.`,
    });
  });

  test('[R5 CASE-37] freeze-frame and rate actions are visible and undoable', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    await openReferenceWorkspace(page);
    const firstClip = page.locator('.timeline-clip[data-clip-id]').first();
    await firstClip.click();
    const playhead = page.getByRole('slider', { name: 'Playhead' });
    await playhead.focus();
    await page.keyboard.press('Home');
    // The ruler's documented shifted step is one second. Keep this as one
    // semantic gesture so trace snapshotting cannot consume the test budget.
    await page.keyboard.press('Shift+ArrowRight');
    await expect(playhead).toHaveAttribute('aria-valuenow', '1000000');

    const beforeCount = await page.locator('.timeline-clip[data-clip-id]').count();
    await firstClip.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Freeze frame at playhead' }).click();
    await expect(page.locator('.timeline-clip[data-clip-id]')).toHaveCount(beforeCount + 2);
    const undoButton = page.getByRole('button', { name: 'Undo' });
    await expect(undoButton).toBeEnabled();
    await undoButton.click();
    await expect(page.locator('.timeline-clip[data-clip-id]')).toHaveCount(beforeCount);

    // Use the final video clip so preserving its source range at 0.5x has
    // room to extend instead of intentionally colliding with a following clip.
    const rateClip = page.locator('.timeline-clip--video[data-clip-id]').last();
    await rateClip.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Set playback rate…' }).click();
    await expect(rateClip).toContainText('0.5×');
    await expect(undoButton).toBeEnabled();
    await undoButton.click();
    await expect(rateClip).not.toContainText('0.5×');
    await recordEvidence(testInfo, {
      caseId: 37,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'Freeze and playback-rate commands alter output state and undo cleanly.',
      actual: 'Freeze created the expected segments, 0.5× displayed, and each operation undid.',
    });
  });

  test('[R5 CASE-46] fullscreen preview enters and exits through visible controls', async ({
    page,
  }, testInfo) => {
    await openReferenceWorkspace(page);
    await page.getByRole('button', { name: /Preview scale/ }).click();
    const fullscreen = page.getByRole('button', { name: 'Fullscreen preview' });
    await expect(fullscreen).toBeVisible();
    await fullscreen.click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await page.keyboard.press('Escape');
    const escaped = await page.evaluate(() => document.fullscreenElement === null);
    if (!escaped) {
      await page.getByRole('button', { name: /Preview scale/ }).click();
      await page.getByRole('button', { name: 'Fullscreen preview' }).click();
    }
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await page.getByRole('button', { name: /Preview scale/ }).click();
    await expect(page.getByRole('button', { name: 'Fullscreen preview' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await recordEvidence(testInfo, {
      caseId: 46,
      functional: escaped ? 'PASS' : 'PASS-FIXTURE',
      uiA11y: escaped ? 'PASS' : 'PASS-FIXTURE',
      expected: 'The visible monitor control enters fullscreen and Escape returns safely.',
      actual: escaped
        ? 'FullscreenElement entered and cleared on Escape.'
        : 'Headless Chrome retained fullscreen after synthetic Escape; the same visible toggle exited and reset aria-pressed.',
      ...(escaped ? {} : { fixture: 'Headless Chromium fullscreen keyboard limitation' }),
    });
  });
});
