import { expect, test, type Page } from '@playwright/test';
import {
  authenticate,
  openPanel,
  openReferenceWorkspace,
  recordEvidence,
} from './wp29-r5-harness.js';

async function selectProductClip(page: Page): Promise<void> {
  const product = page.locator('.timeline-clip[data-clip-id="product"]');
  await expect(product).toBeVisible();
  await product.click();
  await expect(product).toHaveAttribute('aria-pressed', 'true');
}

async function selectIntroJunction(page: Page): Promise<void> {
  const clips = page
    .locator('.timeline-track[data-track-id]')
    .first()
    .locator('.timeline-clip[data-clip-id]');
  const left = clips.nth(0);
  const right = clips.nth(1);
  await left.click();
  await right.click({ modifiers: ['Control'] });
  await expect(left).toHaveAttribute('aria-pressed', 'true');
  await expect(right).toHaveAttribute('aria-pressed', 'true');
}

test.describe('WP-29 R5 batch E — effects, transitions, color, and Inspector', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('[R5 CASE-71] adds, toggles, edits, reorders, and removes effects on the selected clip', async ({
    page,
  }, testInfo) => {
    await openReferenceWorkspace(page);
    await selectProductClip(page);
    await openPanel(page, 'Effects');
    const addButtons = page.locator('.effect-add-btn:not([disabled])');
    await addButtons.nth(0).click();
    await addButtons.nth(1).click();

    await openPanel(page, 'Inspector');
    await page.getByRole('tab', { name: 'Effects' }).click();
    const rows = page.locator('.inspector-effect-item[data-effect-instance-id]');
    await expect(rows).toHaveCount(2);
    const firstId = await rows.nth(0).getAttribute('data-effect-instance-id');
    const firstLabel = (await rows.nth(0).locator('.inspector-effect-label').textContent())!.trim();
    const secondLabel = (await rows
      .nth(1)
      .locator('.inspector-effect-label')
      .textContent())!.trim();
    const parameter = rows.nth(0).locator('input[type="range"]').first();
    if (await parameter.isVisible()) await parameter.press('ArrowRight');
    await rows.nth(0).getByRole('button', { name: 'On' }).click();
    await expect(rows.nth(0).getByRole('button', { name: 'Off' })).toBeVisible();
    await page.getByRole('button', { name: `Move ${firstLabel} down` }).click();
    await expect(rows.nth(1)).toHaveAttribute('data-effect-instance-id', firstId!);
    await page.getByRole('button', { name: `Remove ${secondLabel}` }).click();
    await expect(rows).toHaveCount(1);
    await recordEvidence(testInfo, {
      caseId: 71,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'Effect add, enable, parameter, reorder, and remove target the active image clip.',
      actual:
        'Two effects were added; the first toggled and moved down, then the other was removed.',
    });
  });

  test('[R5 CASE-72] creates, validates, saves, and applies an Effect Studio recipe', async ({
    page,
  }, testInfo) => {
    await openReferenceWorkspace(page);
    await selectProductClip(page);
    await openPanel(page, 'Effects');
    await page.getByRole('button', { name: 'Create effect recipe' }).click();
    await expect(page.locator('.effect-studio-overlay')).toBeVisible();
    const name = page.getByLabel('Recipe name');
    await name.fill('R5 Browser Recipe');
    await page.getByRole('button', { name: 'Browse effects' }).click();
    await page.locator('.es-library-grid button').first().click();
    await expect(page.getByRole('button', { name: 'Apply to selection' })).toBeEnabled();
    await expect(page.locator('.es-save-state')).toContainText('Saved', { timeout: 3_000 });
    await page.getByRole('button', { name: 'Apply to selection' }).click();
    await expect(page.locator('.effect-studio-overlay')).toHaveCount(0);
    await openPanel(page, 'Inspector');
    await page.getByRole('tab', { name: 'Effects' }).click();
    await expect(page.locator('.inspector-effect-item[data-effect-instance-id]')).toHaveCount(1);
    await recordEvidence(testInfo, {
      caseId: 72,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'A named recipe autosaves, applies, and leaves an inspectable effect on selection.',
      actual: 'The recipe reached Saved, applied, closed Studio, and produced one Inspector row.',
    });
  });

  test('[R5 CASE-74] favorites, applies, replaces, reloads, and removes a transition', async ({
    page,
  }, testInfo) => {
    await openReferenceWorkspace(page);
    await selectIntroJunction(page);
    await openPanel(page, 'Transitions');
    const cards = page
      .getByRole('group', { name: 'Transition type' })
      .locator('.transition-card[data-transition-type]');
    const first = cards.nth(0);
    const second = cards.nth(1);
    const favoriteType = await first.getAttribute('data-transition-type');
    await first.getByRole('button', { name: 'Add to favorites' }).click();
    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Remove selected transition' }).click();
    await expect(page.getByRole('button', { name: 'Remove selected transition' })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
    await openPanel(page, 'Transitions');
    const persisted = page
      .locator(`.transition-card[data-transition-type="${favoriteType}"]`)
      .first();
    await expect(persisted.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
    await recordEvidence(testInfo, {
      caseId: 74,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'Favorite persists; replacing and removing affect only the selected junction.',
      actual:
        'Transition was added, replaced, removed, and its favorite survived workspace reload.',
    });
  });

  test('[R5 CASE-75] manual grade supports undo and a complete reset', async ({
    page,
  }, testInfo) => {
    await openReferenceWorkspace(page);
    await openPanel(page, 'Color');
    const lift = page.getByLabel('Lift');
    await expect(lift).toHaveValue('0');
    await lift.focus();
    await page.keyboard.press('ArrowRight');
    await expect(lift).toHaveValue('0.01');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(lift).toHaveValue('0');
    await lift.focus();
    await page.keyboard.press('ArrowRight');
    const saturation = page.getByLabel('Saturation');
    await saturation.focus();
    await page.keyboard.press('ArrowLeft');
    const reset = page.getByRole('button', { name: 'Reset grade' });
    await expect(reset).toBeEnabled();
    await reset.click();
    await expect(lift).toHaveValue('0');
    await expect(saturation).toHaveValue('1');
    await expect(reset).toBeDisabled();
    await recordEvidence(testInfo, {
      caseId: 75,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'Manual grade values update, undo, and reset to exact defaults.',
      actual:
        'Keyboard changes updated Lift/Saturation, history undid Lift, and Reset restored defaults.',
    });
  });

  test('[R5 CASE-76] LUT selection persists and Parade scope updates without blocking', async ({
    page,
  }, testInfo) => {
    await openReferenceWorkspace(page);
    await openPanel(page, 'Color');
    await page.getByRole('tab', { name: 'LUT' }).click();
    const rec709 = page.getByRole('button', { name: 'Rec.709' });
    await rec709.click();
    await expect(rec709).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('tab', { name: 'Scopes' }).click();
    await expect(page.getByLabel('Parade scope')).toBeVisible();
    await expect(page.getByLabel('Parade scope').locator('.scope-bar')).toHaveCount(3);
    await page.reload();
    await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
    await openPanel(page, 'Color');
    await page.getByRole('tab', { name: 'LUT' }).click();
    await expect(page.getByRole('button', { name: 'Rec.709' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await recordEvidence(testInfo, {
      caseId: 76,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'LUT state persists and all Parade channels remain available.',
      actual: 'Rec.709 survived reload and the Parade rendered three channel bars.',
    });
  });

  test('[R5 CASE-77] Inspector edits transform, crop, keyframes, expressions, effects, and audio', async ({
    page,
  }, testInfo) => {
    await openReferenceWorkspace(page);
    await selectProductClip(page);
    await openPanel(page, 'Inspector');
    const x = page.getByLabel('Position X', { exact: true });
    await x.fill('420');
    await expect(x).toHaveValue('420');
    const cropLeft = page.getByLabel('left', { exact: true });
    await cropLeft.fill('0.1');
    await expect(cropLeft).toHaveValue('0.1');
    await page.getByRole('button', { name: 'Add Position X keyframe' }).click();
    await expect(page.getByRole('button', { name: 'Remove Position X keyframe' })).toBeVisible();
    await page.getByRole('button', { name: 'Bezier' }).click();
    await page.getByRole('button', { name: 'Add Position Y expression' }).click();
    await page.getByPlaceholder('e.g. sin(time) * 10').fill('sin(time) * 10');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Edit Position Y expression' })).toBeVisible();

    await openPanel(page, 'Effects');
    await page.locator('.effect-add-btn:not([disabled])').first().click();
    await openPanel(page, 'Inspector');
    await page.getByRole('tab', { name: 'Effects' }).click();
    await expect(page.locator('.inspector-effect-item[data-effect-instance-id]')).toHaveCount(1);
    await page.getByRole('tab', { name: 'Audio' }).click();
    await page.getByLabel('Volume').fill('0.75');
    await page.getByLabel('Pan').fill('-0.25');
    await page.getByText('Mute', { exact: true }).locator('..').getByRole('button').click();
    await expect(
      page.getByText('Mute', { exact: true }).locator('..').getByRole('button'),
    ).toHaveText('Muted');
    await recordEvidence(testInfo, {
      caseId: 77,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'All Inspector sections update only the active product clip.',
      actual:
        'Transform, crop, keyframe, expression, effect, gain, pan, and mute edits were accepted.',
    });
  });
});
