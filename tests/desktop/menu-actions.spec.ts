import { expect, test } from '@playwright/test';
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
const JOY_CODE_MENU = [
  'Open Joy Code',
  'Built-in JOY Agent Engine',
  'Execution Mode…',
  'Pause / Stop',
  'Joy Code Settings…',
];
const ACCOUNT_OR_UPDATE_LABELS = [/account/i, /sign in/i, /sign out/i, /update/i, /subscription/i];

test.beforeEach(async ({ page }) => {
  await installDesktopBridge(page);
  await openFirstProject(page);
});

test('the File menu keeps its project and export entries', async ({ page }) => {
  expect(await menuItemLabels(page, 'File')).toEqual(FILE_MENU);
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
