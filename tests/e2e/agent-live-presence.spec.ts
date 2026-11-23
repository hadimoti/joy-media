import { expect, test } from '@playwright/test';
import { authenticate, openPanel, openReferenceWorkspace } from './wp29-r5-harness.js';
import { configureJoyAgent, installFakeOpenAIProvider } from './fixtures/fake-openai-provider.js';
import { installJoyProviderHost } from './support/provider-profile-handlers.js';

test.describe('built-in JOY Agent live presence', () => {
  test.beforeEach(async ({ page }) => {
    // The JOY Code connect path needs the desktop host: it saves a provider profile there and
    // the model call is brokered by it. The bridge is installed before the page navigates.
    await installJoyProviderHost(page);
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
    await installFakeOpenAIProvider(page, { runDelayMs: 800 });
    const dialog = await configureJoyAgent(page, 'JOY_E2E_PRESENCE_KEY');
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  test('shows the semantic target and opens the proposal from the approval entry', async ({
    page,
  }) => {
    const composer = page.getByLabel('Message Joy Code');
    const processingIcon = page.locator('.joy-code-processing-icon');
    const codeTab = page.locator('.panel-tab[aria-label="Joy Code"]');
    await expect(codeTab).toBeVisible();
    await expect(codeTab.locator('img, .panel-tab-icon, .panel-tab-svg')).toHaveCount(0);
    await expect(processingIcon).toHaveCount(0);
    await composer.fill('Update the selected caption style');
    await composer.press('Enter');
    await expect(processingIcon).toBeVisible();
    await expect(processingIcon).toHaveCSS('animation-name', 'joy-code-processing-spin');
    await expect
      .poll(() => processingIcon.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(128);

    await expect(page.getByRole('status').filter({ hasText: 'Approval required' })).toBeAttached();
    await expect(processingIcon).toHaveCount(0);
    await expect(composer).toBeFocused();

    await page.locator('.app-menu-trigger').filter({ hasText: 'Joy Code' }).click();
    const approval = page.getByRole('menuitem', { name: /Needs approval · .*captions/i });
    await expect(approval).toBeVisible();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Follow target' })).not.toBeChecked();
    await page.getByRole('menuitem', { name: 'Show target' }).click();
    await expect(
      page.locator('[data-feature-tool="captions"][aria-selected="true"]'),
    ).toBeVisible();

    const toolbar = page.getByRole('toolbar', { name: 'Composer capabilities' });
    await toolbar.getByRole('button', { name: 'Creative Brief', exact: true }).click();
    await expect(composer).toBeHidden();
    await page.locator('.app-menu-trigger').filter({ hasText: 'Joy Code' }).click();
    await approval.click();
    await expect(page.getByRole('button', { name: /Approve & apply/ })).toBeVisible();
  });

  test('Follow activates the routed nested feature tab without stealing input focus', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const composer = page.getByLabel('Message Joy Code');
    await composer.fill('Update the selected caption style');
    await composer.press('Enter');
    await expect(page.locator('.joy-code-processing-icon')).toHaveCSS('animation-name', 'none');
    await page.locator('.app-menu-trigger').filter({ hasText: 'Joy Code' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Follow target' }).click();
    await expect(composer).toBeFocused();

    await expect(
      page.locator('[data-feature-tool="captions"][aria-selected="true"]'),
    ).toBeVisible();
    await expect(
      page.locator('.feature-hub-agent-marker[aria-label="Agent needs approval"]'),
    ).toBeVisible();
    await expect(composer).toBeFocused();
  });
});
