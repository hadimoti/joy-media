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
import { authenticate, openPanel, selectFirstTimelineClip } from '../e2e/wp29-r5-harness.js';

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const fixtureDirectory = resolve('packages/test-fixtures/media');
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;
const installedExecutable = process.env.JOY_MEDIA_TEST_EXECUTABLE;

// Launch helper copied from menu-panels.spec.ts. Importing that spec would
// register its unrelated acceptance test as well.
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

async function createProject(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByPlaceholder('Project name').fill(title);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
}

async function clickMenuItem(
  page: Page,
  menu: 'Edit' | 'View' | 'Joy Code',
  label: string,
): Promise<void> {
  const bar = page.getByRole('navigation', { name: 'Application menu' });
  await bar.getByRole('button', { name: menu, exact: true }).click();
  const item = page.getByRole('menu').getByRole('menuitem', { name: label });
  await expect(item).toBeVisible();
  await expect(item).toBeEnabled();
  await item.click();
}

async function addClip(page: Page, mediaName: string): Promise<void> {
  await openPanel(page, 'Assets');
  const importDialog = page.getByRole('dialog', { name: 'Import media' });
  await page.getByRole('button', { name: 'Import media' }).first().click();
  await importDialog.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
    name: mediaName,
    mimeType: 'video/mp4',
    buffer: readFileSync(join(fixtureDirectory, 'video.mp4')),
  });
  await expect(importDialog.getByText(mediaName, { exact: true })).toBeVisible();
  await importDialog.getByRole('button', { name: 'Confirm import' }).click();
  const assetCard = page.locator('.asset-card', { hasText: mediaName }).first();
  await expect(assetCard).toBeVisible();
  await assetCard.getByRole('button', { name: `Add ${mediaName} to timeline` }).click();
}

test.describe('desktop.menu-actions', () => {
  test('edit undo, redo, delete, duplicate, command palette, and Joy Code open change the editor', async () => {
    test.setTimeout(360_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const mediaName = `menu-clip-${suffix}.mp4`;
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-menu-actions-'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createProject(page, `MenuActions${suffix}`);
      const clips = page.locator(`.timeline-clip[aria-label^="${mediaName},"]`);
      await addClip(page, mediaName);
      await expect(clips).toHaveCount(1);

      await clickMenuItem(page, 'Edit', 'Undo');
      await expect(clips).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();

      await clickMenuItem(page, 'Edit', 'Redo');
      await expect(clips).toHaveCount(1);

      await selectFirstTimelineClip(page);
      await clickMenuItem(page, 'Edit', 'Duplicate Clip');
      await expect(clips).toHaveCount(2);

      await selectFirstTimelineClip(page);
      await clickMenuItem(page, 'Edit', 'Cut / Delete Clip');
      await expect(clips).toHaveCount(1);

      await clickMenuItem(page, 'Edit', 'Command Palette…');
      const palette = page.locator('section.palette');
      await expect(palette).toBeVisible();
      await expect(palette).toHaveAttribute('aria-label', 'Command palette');
      await expect(palette.getByPlaceholder('Search commands')).toBeFocused();
      await expect(palette.getByRole('button', { name: 'Undo' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();

      await page.locator('.dv-tab[role="tab"][aria-label="Timeline"]').first().click();
      await expect(page.locator('.dv-active-group .timeline-panel')).toBeVisible();
      await expect(page.locator('.dv-active-group .joy-code-panel')).toHaveCount(0);
      await clickMenuItem(page, 'Joy Code', 'Open Joy Code');
      await expect(page.locator('.dv-active-group .joy-code-panel')).toBeVisible();
      const joyTab = page.locator('.dv-tab[role="tab"][aria-label="Joy Code"]').first();
      await expect(joyTab.getByRole('button', { name: /close/i })).toHaveCount(0);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('view menu toggles the host window full screen on and off', async () => {
    test.setTimeout(360_000);
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-menu-fullscreen-'));
    let app: ElectronApplication | undefined;
    // The host window owns full screen, so the test reads the window state from
    // the main process rather than the renderer's document.fullscreenElement.
    const windowFullScreen = (electronApp: ElectronApplication) =>
      electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((win) => win.isFullScreen()),
      );

    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createProject(page, `MenuFullscreen${Date.now()}`);
      await expect.poll(() => windowFullScreen(app!)).toBe(false);

      await clickMenuItem(page, 'View', 'Toggle Full Screen');
      await expect.poll(() => windowFullScreen(app!)).toBe(true);

      await clickMenuItem(page, 'View', 'Toggle Full Screen');
      await expect.poll(() => windowFullScreen(app!)).toBe(false);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
