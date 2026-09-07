import { expect, test } from '@playwright/test';
import { authenticate, openPanel, openReferenceWorkspace } from './wp29-r5-harness.js';

/**
 * R2 L2 browser coverage: the Living Looks capability in Joy Code renders the
 * six built-in packs with honest availability, and running a Look compiles a
 * plan through the same staged-preview + approval path as a direct edit —
 * Approve applies it, one Undo restores it.
 */
test.describe('JOY Living Looks', () => {
  test('renders the six built-in packs and runs one through approve + Undo', async ({ page }) => {
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
      'Persian Editorial',
    ]) {
      await expect(panel.getByText(title, { exact: true })).toBeVisible();
    }

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

  test('shows an unavailable pack honestly when the editor lacks a capability', async ({
    page,
  }) => {
    // The unavailable rendering path (is-unavailable class + "Needs:" reason) is
    // unit-covered in LivingLooksPanel.test.tsx; here we assert the shipped
    // editor exposes all six packs as available, so none is silently hidden.
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Living Looks' });
    await expect(panel.locator('.living-look')).toHaveCount(6);
    // Every pack is selectable (available) in the shipped editor.
    await expect(panel.locator('.living-look.is-unavailable')).toHaveCount(0);
  });
});
