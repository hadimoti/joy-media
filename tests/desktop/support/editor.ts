import { expect, type Page } from '@playwright/test';

const APPLICATION_MENU = 'nav[aria-label="Application menu"]';

/** Opens the first local project from the Projects library and waits for the editor's menu bar. */
export async function openFirstProject(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByText('Local editor project', { exact: true }).first().click();
  await expect(page.locator(APPLICATION_MENU)).toBeVisible({ timeout: 30_000 });
}

/** The labels of one top-level menu, opened by its trigger. The menu is closed again before returning. */
export async function menuItemLabels(page: Page, menu: string): Promise<string[]> {
  await page.locator(APPLICATION_MENU).getByRole('button', { name: menu, exact: true }).click();
  const labels = await page.getByRole('menuitem').allInnerTexts();
  await page.keyboard.press('Escape');
  return labels.map((label) => label.trim());
}

/** Opens Joy Code → Joy Code Settings… and returns the settings dialog. */
export async function openJoyCodeSettings(page: Page) {
  await page
    .locator(APPLICATION_MENU)
    .getByRole('button', { name: 'Joy Code', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Joy Code Settings…' }).click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  return dialog;
}
