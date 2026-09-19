import { expect, test } from '@playwright/test';
import { authenticate, openDisposableWorkspace, openPanel } from './wp29-r5-harness.js';

test.describe('WP-32 responsive workflow checkpoints', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('keeps project controls, workspace navigation, and keyboard menus reachable', async ({
    page,
  }, testInfo) => {
    const title = `WP32 responsive ${testInfo.project.name}-${Date.now()}`;
    await openDisposableWorkspace(page, title);

    const noHorizontalOverflow = async (where: string) => {
      const d = await page.evaluate(() => ({
        bodyWidth: document.body.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        bodyHeight: document.body.scrollHeight,
      }));
      expect(d.bodyHeight, `${where}: body has height`).toBeGreaterThan(0);
      expect(d.bodyWidth, `${where}: no horizontal overflow`).toBeLessThanOrEqual(d.viewportWidth);
    };
    await noHorizontalOverflow('default layout');

    await expect(page.getByRole('button', { name: 'Export MP4' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recent processes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Workspace preset' })).toBeVisible();

    // Every panel: reachable AND opening it introduces no overflow at this
    // viewport (previously overflow was measured once, in the default layout).
    // Includes the R2 surfaces the real-service journey walks — Joy Code,
    // Enhance, 3D Scene, Creative Brief — which had no per-viewport coverage.
    for (const label of [
      'Assets',
      'Timeline',
      'Captions',
      'Audio',
      'Inspector',
      'Color',
      'Enhance',
      'Workflows',
      'Joy Code',
      '3D Scene',
    ]) {
      let navigation = page.locator('.panel-tab[aria-label="Timeline"]').first();
      if (label === 'Timeline') {
        await navigation.click();
        await expect(page.locator('.timeline-panel')).toBeVisible();
      } else {
        navigation = await openPanel(page, label);
      }
      await expect(navigation).toBeVisible();
      if (label === 'Workflows') {
        await expect(page.getByText('No saved workflows', { exact: true })).toBeVisible();
      }
      await noHorizontalOverflow(`after opening ${label}`);
    }

    // Creative Brief is a composer capability inside the Joy Code panel, not a
    // dock tab — reveal it the way the app does, then re-check overflow.
    await openPanel(page, 'Joy Code');
    await page.getByRole('button', { name: 'Creative Brief', exact: true }).click();
    await expect(page.locator('.creative-brief-panel')).toBeVisible();
    await noHorizontalOverflow('after opening Creative Brief');

    const fileMenu = page.getByRole('button', { name: 'File' });
    await fileMenu.focus();
    await fileMenu.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const firstMenuitem = menu.getByRole('menuitem').first();
    await expect(firstMenuitem).toBeVisible();
    await expect(firstMenuitem).toBeFocused();
    // Walk the File menu with the keyboard to the plain "Export" action. The
    // menu order is Account & Workstation… / Projects Library… / Import Editable
    // Project… / Export Editable Project… / Export, so "Export" needs an
    // exact-name match after four ArrowDown presses.
    await page.keyboard.press('ArrowDown');
    await expect(
      page.getByRole('menuitem', { name: 'Projects Library…', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(
      page.getByRole('menuitem', { name: 'Import Editable Project…', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(
      page.getByRole('menuitem', { name: 'Export Editable Project…', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Export', exact: true })).toBeFocused();
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
