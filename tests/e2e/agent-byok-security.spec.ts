import { expect, test } from '@playwright/test';
import { authenticate, openPanel, openReferenceWorkspace } from './wp29-r5-harness.js';
import {
  configureJoyAgent,
  installFakeOpenAIProvider,
  scanForSentinel,
} from './fixtures/fake-openai-provider.js';

const SENTINEL = 'JOY_E2E_BYOK_SENTINEL_DO_NOT_PERSIST';

test.describe('built-in JOY Agent BYOK security envelope', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
  });

  test('keeps the key in the Worker session and never in app-owned stores', async ({ page }) => {
    const provider = await installFakeOpenAIProvider(page);
    const dialog = await configureJoyAgent(page, SENTINEL);
    expect(provider.authorizationSeen).toBe(true);
    expect(
      provider.requestUrls.every((url) => url.startsWith('https://joy-agent-fixture.example/')),
    ).toBe(true);

    await dialog.getByRole('button', { name: 'Done' }).click();
    expect(await scanForSentinel(page, SENTINEL)).toEqual([]);

    // Clear is an explicit lifecycle boundary: the Worker and public status
    // disappear, while the editor remains usable for deterministic local edits.
    await page.locator('.app-menu-trigger').filter({ hasText: 'Joy Code' }).click();
    await page.getByRole('menuitem', { name: 'Joy Code Settings…', exact: true }).click();
    const reopened = page.getByRole('dialog', { name: 'JOY Agent Engine' });
    await reopened.getByRole('button', { name: 'Clear connection' }).click();
    await expect(reopened.getByText('Not connected')).toBeVisible();
    expect(await scanForSentinel(page, SENTINEL)).toEqual([]);
    await reopened.getByRole('button', { name: 'Done' }).click();

    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(await scanForSentinel(page, SENTINEL)).toEqual([]);
  });

  test('fails closed for authentication, redirect, network, and oversized responses', async ({
    page,
  }) => {
    test.setTimeout(45_000);
    for (const mode of ['auth', 'redirect', 'network', 'oversize'] as const) {
      const provider = await installFakeOpenAIProvider(page, { mode });
      const dialog = await configureJoyAgent(page, `${SENTINEL}-${mode}`, { allowFailure: true });
      await expect(
        dialog.getByText(/authentication failed|CORS or network error|response too large/),
      ).toBeVisible({
        timeout: 20_000,
      });
      expect(provider.authorizationSeen).toBe(true);
      expect(await scanForSentinel(page, `${SENTINEL}-${mode}`)).toEqual([]);
      await dialog.getByRole('button', { name: 'Done' }).click();
      // Route handlers are intentionally removed before the next scenario.
      await page.unroute('https://joy-agent-fixture.example/**');
      if (mode !== 'oversize') continue;
    }
  });

  test('reports a bounded provider timeout without retaining the key', async ({ page }) => {
    test.setTimeout(40_000);
    await page.unroute('https://joy-agent-fixture.example/**');
    const provider = await installFakeOpenAIProvider(page, { mode: 'slow', delayMs: 16_000 });
    const dialog = await configureJoyAgent(page, `${SENTINEL}-timeout`, { allowFailure: true });
    await expect(dialog.getByText('Connection timed out')).toBeVisible({ timeout: 20_000 });
    expect(provider.authorizationSeen).toBe(true);
    expect(await scanForSentinel(page, `${SENTINEL}-timeout`)).toEqual([]);
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  test('reports malformed provider output without creating a preview or edit', async ({ page }) => {
    const provider = await installFakeOpenAIProvider(page, { mode: 'malformed' });
    const dialog = await configureJoyAgent(page, `${SENTINEL}-malformed`);
    await dialog.getByRole('button', { name: 'Done' }).click();
    const composer = page.getByLabel('Message Joy Code');
    await composer.fill('Update the selected caption style');
    await composer.press('Enter');
    await expect(page.getByText('Provider returned invalid proposal JSON')).toBeVisible({
      timeout: 20_000,
    });
    expect(provider.requests).toBeGreaterThanOrEqual(2);
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
    expect(await scanForSentinel(page, 'JOY_E2E_BYOK_SENTINEL_DO_NOT_PERSIST')).toEqual([]);
  });
});
