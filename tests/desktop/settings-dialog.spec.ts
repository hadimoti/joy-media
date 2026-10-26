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
import { authenticate } from '../e2e/wp29-r5-harness.js';

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;
const installedExecutable = process.env.JOY_MEDIA_TEST_EXECUTABLE;

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
  return menu.getByRole('menuitem', { name: label });
}

function appMenuBar(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Application menu' });
}

async function openFileMenu(page: Page): Promise<Locator> {
  const trigger = appMenuBar(page).getByRole('button', { name: 'File', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

test('File > Settings opens the dialog and its manual update check reports a result', async () => {
  test.setTimeout(360_000);
  const profile = mkdtempSync(join(tmpdir(), 'joy-media-settings-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchPackagedEditor(profile);
    const page = await openEditorPage(app);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByPlaceholder('Project name').fill(`Settings ${Date.now()}`);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();

    const fileMenu = await openFileMenu(page);
    await menuItem(fileMenu, 'Settings…').click();

    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(dialog).toBeVisible();
    await expectAccessible(page, 'packaged Settings dialog open');

    // The Updates check runs only on this click. This build pins no release key, so the check is refused
    // before any request is made, and it reports the outcome in the status region. It never installs.
    const check = dialog.getByRole('button', { name: 'Check for Updates' });
    await check.click();
    await expect(check).toHaveText('Check for Updates');
    await expect(dialog.getByRole('status').locator('[data-update-status]')).toHaveAttribute(
      'data-update-status',
      /^(current|update|blocked)$/u,
    );

    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await expect(dialog).toBeHidden();
    await expect(appMenuBar(page).getByRole('button', { name: 'File', exact: true })).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
