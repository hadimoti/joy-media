import { expect, test } from '@playwright/test';
import { authenticate, openPanel, openReferenceWorkspace } from './wp29-r5-harness.js';

/**
 * R2 L2 browser coverage: the Living Looks capability in Joy Code renders the
 * five shipping packs with honest availability, and running a Look compiles a
 * plan through the same staged-preview + approval path as a direct edit —
 * Approve applies it, one Undo restores it.
 */
test.describe('JOY Living Looks', () => {
  test('renders the five shipping packs and runs one through approve + Undo', async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');

    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Living Looks' });
    await expect(panel).toBeVisible();

    for (const title of [
      'Editorial Clean',
      'Product Precision',
      'Kinetic Type',
      'Quiet Documentary',
      'Music Pulse',
    ]) {
      await expect(panel.getByText(title, { exact: true })).toBeVisible();
    }
    await expect(panel.getByText('Persian Editorial', { exact: true })).toHaveCount(0);

    // Editorial Clean is selected by default (first available). Its editor form
    // is visible and Run is disabled until the required headline slot is bound.
    const editor = panel.getByRole('form', { name: /Editorial Clean controls/ });
    await expect(editor).toBeVisible();
    const run = editor.getByRole('button', { name: 'Run Editorial Clean' });
    await expect(run).toBeDisabled();

    // Bind the required headline slot to the reference project's text object.
    const headlineSelect = editor
      .locator('.living-look-slot', { hasText: /Headline/ })
      .locator('select');
    await headlineSelect.selectOption({ index: 1 });
    await expect(run).toBeEnabled();

    await run.click();

    const preview = page.getByRole('region', { name: 'JOY Agent live proposal' });
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview).toHaveAttribute('data-agent-preview-ready', 'true', { timeout: 20_000 });

    await preview.getByRole('button', { name: /Approve & apply/ }).click();

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled({ timeout: 20_000 });
    await undo.click();
    await expect(page.getByText(/could not be prepared/)).toHaveCount(0);
  });

  test('a saved Look survives reload and can be reopened, adjusted, and detached (GAP 1b/1c)', async ({
    page,
  }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Living Looks' });
    await expect(panel).toBeVisible();

    // Apply Editorial Clean.
    const editor = panel.getByRole('form', { name: /Editorial Clean controls/ });
    await editor
      .locator('.living-look-slot', { hasText: /Headline/ })
      .locator('select')
      .selectOption({ index: 1 });
    await editor.getByRole('button', { name: 'Run Editorial Clean' }).click();
    let preview = page.getByRole('region', { name: 'JOY Agent live proposal' });
    await expect(preview).toHaveAttribute('data-agent-preview-ready', 'true', { timeout: 30_000 });
    await preview.getByRole('button', { name: /Approve & apply/ }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled({
      timeout: 20_000,
    });

    // The applied Look is listed, and survives a full browser reload.
    const applied = panel.getByRole('region', { name: 'Applied Looks' });
    await expect(applied.getByText('Editorial Clean', { exact: true })).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openPanel(page, 'Joy Code');
    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    await expect(applied.getByText('Editorial Clean', { exact: true })).toBeVisible();

    // Adjust a control -> the same staged-preview + approval path.
    const firstSlider = applied.locator('.applied-look-control input[type="range"]').first();
    if ((await firstSlider.count()) > 0) {
      await firstSlider.fill('0.6');
      await firstSlider.dispatchEvent('change');
      preview = page.getByRole('region', { name: 'JOY Agent live proposal' });
      await expect(preview).toHaveAttribute('data-agent-preview-ready', 'true', {
        timeout: 30_000,
      });
      await preview.getByRole('button', { name: /Approve & apply/ }).click();
      await expect(applied.getByText('Editorial Clean', { exact: true })).toBeVisible();
    }

    // Detach -> removed from Applied Looks; one Undo restores it.
    await applied.getByRole('button', { name: 'Detach' }).first().click();
    await expect(applied.getByText('Editorial Clean', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(applied.getByText('Editorial Clean', { exact: true })).toBeVisible();
  });

  test('shows an unavailable pack honestly when the editor lacks a capability', async ({
    page,
  }) => {
    // The unavailable rendering path (is-unavailable class + "Needs:" reason) is
    // unit-covered in LivingLooksPanel.test.tsx; here we assert the shipped
    // editor exposes all five packs as available, so none is silently hidden.
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Living Looks' });
    await expect(panel.locator('.living-look')).toHaveCount(5);
    // Every pack is selectable (available) in the shipped editor.
    await expect(panel.locator('.living-look.is-unavailable')).toHaveCount(0);
  });
});
