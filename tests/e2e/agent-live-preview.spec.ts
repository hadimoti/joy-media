import { expect, test, type Page } from '@playwright/test';
import { authenticate, openPanel, openReferenceWorkspace } from './wp29-r5-harness.js';
import { configureJoyAgent, installFakeOpenAIProvider } from './fixtures/fake-openai-provider.js';

test.describe('built-in JOY Agent live visual preview', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
    await installFakeOpenAIProvider(page);
    const dialog = await configureJoyAgent(page, 'JOY_E2E_PREVIEW_KEY');
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  async function requestPreview(page: Page): Promise<void> {
    const composer = page.getByLabel('Message Joy Code');
    await composer.fill('Update the selected caption style');
    await composer.press('Enter');
    await expect
      .poll(() => page.locator('[data-agent-preview="true"]').count(), { timeout: 20_000 })
      .toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: /Approve & apply/ })).toBeVisible();
  }

  test('renders a revision-bound preview and Before toggle without changing canonical timeline', async ({
    page,
  }) => {
    const canonicalClipCount = await page.locator('.timeline-clip').count();
    await requestPreview(page);
    expect(await page.locator('.timeline-clip').count()).toBe(canonicalClipCount);

    const before = page.getByRole('checkbox', { name: 'Before' });
    await expect(before).toBeVisible();
    await before.check();
    await expect(page.getByText('Before · canonical')).toBeVisible();
    await before.uncheck();
    await expect(page.getByText('Staged · not applied').first()).toBeVisible();

    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
    expect(await page.locator('.timeline-clip').count()).toBe(canonicalClipCount);
  });

  test('approval applies atomically and one Undo restores the edit', async ({ page }) => {
    await requestPreview(page);
    await page.getByRole('button', { name: /Approve & apply/ }).click();
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
  });

  test('revision drift invalidates a staged preview before approval', async ({ page }) => {
    await requestPreview(page);
    const clip = page.locator('.timeline-clip[data-clip-id]').first();
    await clip.click();
    await expect(clip).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.app-menu-trigger').filter({ hasText: 'Edit' }).click();
    await page.getByRole('menuitem', { name: /Duplicate Clip/ }).click();
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
  });
});
