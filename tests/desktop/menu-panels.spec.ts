import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authenticate, openPanel } from '../e2e/wp29-r5-harness.js';

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;
const installedExecutable = process.env.JOY_MEDIA_TEST_EXECUTABLE;

const fileMenuItems = [
  'Account & Workstation…',
  'Settings…',
  'Projects Library…',
  'Import Editable Project…',
  'Export Editable Project…',
  'Export',
  'Sign Out',
] as const;

const editMenuItems = [
  'Undo',
  'Redo',
  'Cut / Delete Clip',
  'Duplicate Clip',
  'Command Palette…',
  'Asset Library Folder…',
] as const;

// Product labels for the workspace panels named in desktop.timeline-and-panels,
// plus the Filters and Adjust tabs that exist on the Enhance hub.
const workspacePanels = [
  'Media',
  'Timeline',
  'Flow',
  'Captions',
  'Text',
  'Inspector',
  '3D Scene',
  'Motion',
  'Camera',
  'Audio',
  'Effects',
  'Transitions',
  'Color',
  'Filters',
  'Adjust',
  'History',
  'Diagnostics',
  'Jobs',
  'Joy Code',
  'Workflows',
  'Plugins',
  'Templates',
] as const;

async function launchPackagedEditor(profile: string): Promise<ElectronApplication> {
  if (!installedExecutable && !existsSync(join(unpackedPackage, 'package.json'))) {
    throw new Error('Missing unpacked desktop package. Run package:unpacked before this test.');
  }
  for (const name of ['downloads', 'temp', 'appdata', 'localappdata']) {
    mkdirSync(join(profile, name));
  }
  return electron.launch({
    executablePath: installedExecutable ?? electronExecutable,
    cwd: process.env.JOY_MEDIA_TEST_WORKING_DIRECTORY ?? unpackedPackage,
    args: [
      ...(installedExecutable ? [] : ['.']),
      '--joy-media-test-mode',
      `--user-data-dir=${profile}`,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JOY_MEDIA_TEST_API_BASE_URL: apiBaseUrl,
      JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY: join(profile, 'downloads'),
      APPDATA: join(profile, 'appdata'),
      LOCALAPPDATA: join(profile, 'localappdata'),
      TEMP: join(profile, 'temp'),
      TMP: join(profile, 'temp'),
    },
  });
}

async function openEditorPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  expect(page.url()).toMatch(/^joy-media-app:\/\/renderer\//u);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__JOY_MEDIA_API_BASE__,
    ),
  ).toBe(apiBaseUrl);
  await authenticate(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  return page;
}

async function expectAccessible(page: Page, state: string): Promise<void> {
  const result = await new AxeBuilder({ page }).setLegacyMode().analyze();
  expect(result.violations, `${state}: ${JSON.stringify(result.violations, null, 2)}`).toEqual([]);
}

function menuItem(menu: Locator, label: string): Locator {
  return menu.getByRole('menuitem', { name: label, exact: label === 'Export' });
}

function appMenuBar(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Application menu' });
}

async function openMenu(page: Page, name: 'File' | 'Edit' | 'Window'): Promise<Locator> {
  const trigger = appMenuBar(page).getByRole('button', { name, exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return menu;
}

async function expectMenuReachable(
  page: Page,
  menu: Locator,
  labels: readonly string[],
): Promise<void> {
  const enabled: Locator[] = [];
  for (const label of labels) {
    const item = menuItem(menu, label);
    await expect(item, label).toBeVisible();
    if (await item.isEnabled()) enabled.push(item);
  }
  expect(enabled.length).toBeGreaterThan(0);
  await expect(enabled[0]!).toBeFocused();
  for (const item of enabled.slice(1)) {
    await page.keyboard.press('ArrowDown');
    await expect(item).toBeFocused();
  }
}

async function openDockTab(page: Page, label: string, content: Locator): Promise<void> {
  let tab = page.locator(`.dv-tab[role="tab"][aria-label="${label}"]`).first();
  if (!(await tab.isVisible())) {
    await appMenuBar(page).getByRole('button', { name: 'View', exact: true }).click();
    const item = page.getByRole('menuitem', { name: label, exact: true });
    await expect(item).toBeVisible();
    await item.click();
    tab = page.locator(`.dv-tab[role="tab"][aria-label="${label}"]`).first();
  }
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(content).toBeVisible();
}

// Window > Focus items, in the order the menu lists them. Each is checked by the dock tab it activates.
const WINDOW_FOCUS_ITEMS = [
  { menu: 'Focus Program Monitor', tab: 'Program Monitor' },
  { menu: 'Focus Timeline', tab: 'Timeline' },
  { menu: 'Focus Inspector', tab: 'Inspector' },
  { menu: 'Focus Create', tab: 'Create' },
] as const;

test('window menu focuses each workspace panel and makes its tab the active one', async () => {
  test.setTimeout(360_000);
  const profile = mkdtempSync(join(tmpdir(), 'joy-media-menu-focus-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchPackagedEditor(profile);
    const page = await openEditorPage(app);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByPlaceholder('Project name').fill(`Menu focus ${Date.now()}`);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();

    // Dockview keeps one active tab per group, and panels can sit in several groups. So the check is that
    // the focused group (`.dv-active-group`) shows the requested panel as its active tab.
    for (const item of WINDOW_FOCUS_ITEMS) {
      const menu = await openMenu(page, 'Window');
      await menuItem(menu, item.menu).click();
      await expect(
        page.locator(`.dv-active-group .dv-tab.dv-active-tab[aria-label="${item.tab}"]`),
        `${item.menu} must focus the group that shows the ${item.tab} tab`,
      ).toBeVisible();
    }
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('packaged File and Edit menus and workspace panels are reachable', async () => {
  test.setTimeout(360_000);
  const profile = mkdtempSync(join(tmpdir(), 'joy-media-menu-panels-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchPackagedEditor(profile);
    const page = await openEditorPage(app);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByPlaceholder('Project name').fill(`Menu panels ${Date.now()}`);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();

    const fileMenu = await openMenu(page, 'File');
    await expectMenuReachable(page, fileMenu, fileMenuItems);
    await expectAccessible(page, 'packaged File menu open');
    await page.keyboard.press('Escape');
    await expect(fileMenu).toBeHidden();
    await expect(appMenuBar(page).getByRole('button', { name: 'File', exact: true })).toBeFocused();

    const editMenu = await openMenu(page, 'Edit');
    await expectMenuReachable(page, editMenu, editMenuItems);
    await expectAccessible(page, 'packaged Edit menu open');
    await page.keyboard.press('Escape');
    await expect(editMenu).toBeHidden();
    await expect(appMenuBar(page).getByRole('button', { name: 'Edit', exact: true })).toBeFocused();

    // Program Monitor's root is `.monitor-panel` and has no article name.
    // Flow's dock tab is "Flow"; its shell is the Dual Lens panel.
    await openDockTab(page, 'Program Monitor', page.locator('.monitor-panel'));
    for (const label of workspacePanels) {
      if (label === 'Flow') {
        await openDockTab(page, 'Flow', page.locator('.dual-lens-panel'));
      } else {
        await openPanel(page, label);
      }
    }
    await expectAccessible(page, 'packaged workspace panels');
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
