import { expect, test } from '@playwright/test';
import { authenticate, openPanel, openReferenceWorkspace } from './wp29-r5-harness.js';
import { configureJoyAgent, installFakeOpenAIProvider } from './fixtures/fake-openai-provider.js';

test.describe('built-in JOY Agent live presence', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
    await installFakeOpenAIProvider(page, { delayMs: 350 });
    const dialog = await configureJoyAgent(page, 'JOY_E2E_PRESENCE_KEY');
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  test('shows the semantic target while keeping the composer focused by default', async ({
    page,
  }) => {
    const composer = page.getByLabel('Message Joy Code');
    await composer.fill('Update the selected caption style');
    await composer.press('Enter');

    const rail = page.locator('[data-agent-activity="true"]');
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute('data-agent-phase', 'awaiting-approval');
    await expect(rail).toContainText('Captions');
    expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
  });

  test('Follow activates the routed nested feature tab without stealing input focus', async ({
    page,
  }) => {
    const composer = page.getByLabel('Message Joy Code');
    await composer.fill('Update the selected caption style');
    await composer.press('Enter');
    const rail = page.locator('[data-agent-activity="true"]');
    await expect(rail).toBeVisible();
    await rail.getByRole('checkbox', { name: 'Follow' }).check();

    await expect(
      page.locator('[data-feature-tool="captions"][aria-selected="true"]'),
    ).toBeVisible();
    await expect(
      page.locator('.feature-hub-agent-marker[aria-label="Agent needs approval"]'),
    ).toBeVisible();
    expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
  });
});
