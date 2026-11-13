import { expect, test, type Page } from '@playwright/test';
import { installDesktopBridge } from './support/desktop-bridge.js';
import { menuItemLabels, openFirstProject } from './support/editor.js';

// The application menus of the local-only build (PLAN-v4 §4a "Login, accounts and sessions"):
// the File menu keeps its project and export entries, and no menu has an account or update entry.
const FILE_MENU = [
  'Projects Library…',
  'Import Editable Project…',
  'Export Editable Project…',
  'Export',
];
const EDIT_MENU = ['Undo', 'Redo', 'Delete', 'Command Palette…', 'Asset Library Folder…'];
// Speed… opens the Inspector's Speed tab. Detach audio is not listed: no such command exists yet.
const CLIP_MENU = ['Split at Playhead', 'Duplicate Clip', 'Delete', 'Speed…'];
const JOY_CODE_MENU = [
  'Open Joy Code',
  'Built-in JOY Agent Engine',
  'Execution Mode…',
  'Pause / Stop',
  'Joy Code Settings…',
];
const ACCOUNT_OR_UPDATE_LABELS = [/account/i, /sign in/i, /sign out/i, /update/i, /subscription/i];

/**
 * Reads the visible labels of one open menu. Reads `.app-menu-item-label`, so the
 * shortcut keys (kbd) are not part of the label.
 */
async function menuActionLabels(page: Page, menu: string): Promise<string[]> {
  await page
    .getByRole('navigation', { name: 'Application menu' })
    .getByRole('button', { name: menu, exact: true })
    .click();
  const labels = await page.locator('.app-menu-item-label').allInnerTexts();
  await page.keyboard.press('Escape');
  return labels.map((label) => label.trim());
}

test.beforeEach(async ({ page }) => {
  await installDesktopBridge(page);
  await openFirstProject(page);
});

test('the File menu keeps its project and export entries', async ({ page }) => {
  expect(await menuItemLabels(page, 'File')).toEqual(FILE_MENU);
});

test('the Edit menu has Delete as its own item, and no Cut', async ({ page }) => {
  expect(await menuActionLabels(page, 'Edit')).toEqual(EDIT_MENU);
});

test('the Clip menu lists the clip actions that exist as commands', async ({ page }) => {
  expect(await menuActionLabels(page, 'Clip')).toEqual(CLIP_MENU);
});

test('the command palette lists every menu action', async ({ page }) => {
  await page.getByRole('button', { name: 'Command palette', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  // Each palette button reads "<title><shortcut>", so a menu label must start a palette text.
  const paletteTexts = (await palette.getByRole('button').allInnerTexts()).map((text) =>
    text.trim(),
  );
  for (const label of [...FILE_MENU, ...EDIT_MENU, ...CLIP_MENU, ...JOY_CODE_MENU]) {
    expect(
      paletteTexts.some((text) => text.startsWith(label)),
      `the command palette must list "${label}"`,
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
});

test('the Joy Code menu lists the built-in engine and its settings, with no provider sign-in', async ({
  page,
}) => {
  expect(await menuItemLabels(page, 'Joy Code')).toEqual(JOY_CODE_MENU);
});

test('no application menu has an account, sign-in or update entry', async ({ page }) => {
  for (const menu of ['File', 'Edit', 'Clip', 'Joy Code', 'View', 'Window']) {
    const labels = await menuItemLabels(page, menu);
    for (const label of labels) {
      for (const pattern of ACCOUNT_OR_UPDATE_LABELS) {
        expect(label, `the ${menu} menu must not have "${label}"`).not.toMatch(pattern);
      }
    }
  }
});
