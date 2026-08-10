import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('WP-29 browser safety envelope', () => {
  test('login gate loads without fatal browser errors or horizontal overflow', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('requestfailed', (request) => {
      if (request.url().startsWith('http'))
        failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Joy Studio.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gmail' })).toBeVisible();
    const widths = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(widths.body).toBeLessThanOrEqual(widths.viewport);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests.filter((entry) => !entry.includes('/api/v1/auth/session'))).toEqual([]);
  });
});
