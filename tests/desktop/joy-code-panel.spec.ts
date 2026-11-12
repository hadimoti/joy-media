import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authenticate } from '../e2e/wp29-r5-harness.js';

// Joy Code panel open and close, on the packaged app. Helpers mirror
// menu-actions.spec.ts; that spec is not imported because it carries an
// unrelated test that is still open.

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;
const installedExecutable = process.env.JOY_MEDIA_TEST_EXECUTABLE;

const JOY_CODE_TAB = '.panel-tab[title="Joy Code"]';

async function launchPackagedEditor(profile: string): Promise<ElectronApplication> {
  if (!installedExecutable && !existsSync(join(unpackedPackage, 'package.json'))) {
    throw new Error('Missing unpacked desktop package. Run package:unpacked before this test.');
  }
  for (const name of ['downloads', 'temp', 'appdata', 'localappdata']) {
    if (!existsSync(join(profile, name))) mkdirSync(join(profile, name));
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
  await authenticate(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  return page;
}

async function createHostProject(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByPlaceholder('Project name').fill(title);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
}

async function clickJoyCodeMenuItem(page: Page, label: string): Promise<void> {
  const bar = page.getByRole('navigation', { name: 'Application menu' });
  await bar.getByRole('button', { name: 'Joy Code', exact: true }).click();
  const item = page.getByRole('menu').getByRole('menuitem', { name: label });
  await expect(item).toBeVisible();
  await item.click();
}

test.describe('desktop.joy-code-panel', () => {
  test('the Joy Code tab closes from its own control and reopens from the menu', async () => {
    test.setTimeout(240_000);
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-joycode-close-'));
    let app: ElectronApplication | undefined;
    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createHostProject(page, `JoyCodeClose${Date.now()}`);

      await clickJoyCodeMenuItem(page, 'Open Joy Code');
      const tab = page.locator(JOY_CODE_TAB);
      await expect(tab).toHaveCount(1);

      await tab.hover();
      await page.getByRole('button', { name: 'Close Joy Code panel' }).click();
      await expect(page.locator(JOY_CODE_TAB)).toHaveCount(0);

      await clickJoyCodeMenuItem(page, 'Open Joy Code');
      await expect(page.locator(JOY_CODE_TAB)).toHaveCount(1);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
