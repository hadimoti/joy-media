import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authenticate, openPanel } from '../e2e/wp29-r5-harness.js';

// Packaged regression: the Program Monitor's "Fullscreen preview" control enters and leaves element
// fullscreen (renderer API), and the host window follows. Runs on the hidden desktop.

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;
const fixtureDirectory = resolve('packages/test-fixtures/media');

async function launchPackagedEditor(profile: string): Promise<ElectronApplication> {
  if (!existsSync(join(unpackedPackage, 'package.json')))
    throw new Error('Missing unpacked desktop package. Run package:unpacked before this test.');
  for (const name of ['downloads', 'temp', 'appdata', 'localappdata'])
    if (!existsSync(join(profile, name))) mkdirSync(join(profile, name));
  return electron.launch({
    executablePath: electronExecutable,
    cwd: unpackedPackage,
    args: ['.', '--joy-media-test-mode', `--user-data-dir=${profile}`],
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

async function openEditorWithClip(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await authenticate(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByPlaceholder('Project name').fill(`FullscreenPreview${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
  await openPanel(page, 'Assets');
  const name = 'fullscreen-preview.mp4';
  const dialog = page.getByRole('dialog', { name: 'Import media' });
  await page.getByRole('button', { name: 'Import media' }).first().click();
  await dialog.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
    name,
    mimeType: 'video/mp4',
    buffer: readFileSync(join(fixtureDirectory, 'video.mp4')),
  });
  await expect(dialog.getByText(name, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm import' }).click();
  await page
    .locator('.asset-card', { hasText: name })
    .first()
    .getByRole('button', { name: `Add ${name} to timeline` })
    .click();
  await expect(page.locator(`.timeline-clip[aria-label^="${name},"]`)).toHaveCount(1);
  return page;
}

async function mainFullScreen(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((win) => win.isFullScreen()),
  );
}

test.describe('desktop.fullscreen-preview', () => {
  test('the Program Monitor fullscreen control enters and leaves element fullscreen, and the host window follows', async () => {
    test.setTimeout(240_000);
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-fullscreen-preview-'));
    let app: ElectronApplication | undefined;
    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorWithClip(app);
      const programTab = page.locator('.dv-tab[role="tab"][aria-label="Program Monitor"]').first();
      if (!(await programTab.isVisible().catch(() => false))) {
        await page
          .getByRole('navigation', { name: 'Application menu' })
          .getByRole('button', { name: 'View', exact: true })
          .click();
        await page.getByRole('menuitem', { name: 'Program Monitor', exact: true }).click();
      }
      await programTab.click();

      // The fullscreen control is in the preview-scale drawer.
      await page.locator('button[aria-controls="monitor-zoom-drawer"]').first().click();
      const control = page.getByRole('button', { name: 'Fullscreen preview' });
      await expect(control).toBeVisible();

      await control.click();
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement !== null), { timeout: 10_000 })
        .toBe(true);
      await expect.poll(() => mainFullScreen(app!), { timeout: 10_000 }).toBe(true);

      // The drawer closes itself after the control is used, so reopen it to leave fullscreen.
      await page.locator('button[aria-controls="monitor-zoom-drawer"]').first().click();
      await page.getByRole('button', { name: 'Fullscreen preview' }).click();
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement !== null), { timeout: 10_000 })
        .toBe(false);
      await expect.poll(() => mainFullScreen(app!), { timeout: 10_000 }).toBe(false);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  });
});
