import { expect, test } from '@playwright/test';
import { authenticate, openDisposableWorkspace, openPanel } from './wp29-r5-harness.js';

test.describe('WP-32 responsive workflow checkpoints', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('keeps project controls, workspace navigation, and keyboard menus reachable', async ({
    page,
  }, testInfo) => {
    const title = `WP32 responsive ${testInfo.project.name}-${Date.now()}`;
    await openDisposableWorkspace(page, title);

    const dimensions = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      bodyHeight: document.body.scrollHeight,
      viewportHeight: document.documentElement.clientHeight,
    }));
    expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(dimensions.bodyHeight).toBeGreaterThan(0);

    await expect(page.getByRole('button', { name: 'Export MP4' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recent processes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Workspace preset' })).toBeVisible();

    for (const label of [
      'Assets',
      'Timeline',
      'Captions',
      'Audio',
      'Inspector',
      'Color',
      'Workflows',
    ]) {
      if (label === 'Timeline') {
        await page.locator('.panel-tab[aria-label="Timeline"]').first().click();
        await expect(page.locator('.timeline-panel')).toBeVisible();
      } else {
        await openPanel(page, label);
      }
      await expect(page.locator(`.panel-tab[aria-label="${label}"]`).first()).toBeVisible();
      if (label === 'Workflows') {
        await expect(page.getByText('No saved workflows', { exact: true })).toBeVisible();
      }
    }

    const fileMenu = page.getByRole('button', { name: 'File' });
    await fileMenu.focus();
    await fileMenu.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Projects Library…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Projects Library…' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Export' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await page.getByRole('button', { name: 'Recent processes' }).click();
    await expect(page.getByRole('region', { name: 'Recent processes' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: 'Recent processes' })).toBeHidden();

    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Projects Library…' }).click();
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
    await expect(page.getByPlaceholder('Search projects')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Sort projects' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Grid view' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'List view' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Trash/ })).toBeVisible();
  });
});
