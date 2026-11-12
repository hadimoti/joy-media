import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authenticate, openPanel } from '../e2e/wp29-r5-harness.js';

// Relink, mismatch warnings, Use Different File with Undo, and cancellation, run
// on the packaged app. Helpers mirror project-package-integrity.spec.ts; that
// spec is not imported so its unrelated tests do not register here too.

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const fixtureDirectory = resolve('packages/test-fixtures/media');
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;
const installedExecutable = process.env.JOY_MEDIA_TEST_EXECUTABLE;

interface PortableMediaEntry {
  readonly status?: string;
  readonly asset?: { readonly id?: string; readonly displayName?: string };
}

interface PortablePackage {
  readonly media?: readonly PortableMediaEntry[];
}

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

function waitForPackagedDownload(app: ElectronApplication, filename: string): Promise<void> {
  return app.evaluate(
    ({ session }, expectedFilename) =>
      new Promise<void>((resolveDownload, rejectDownload) => {
        const downloads = session.defaultSession;
        const timeout = setTimeout(() => {
          downloads.removeListener('will-download', onWillDownload);
          rejectDownload(new Error(`Timed out waiting for packaged download ${expectedFilename}.`));
        }, 30_000);
        const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
          if (item.getFilename() !== expectedFilename) return;
          item.once('done', (_doneEvent, state) => {
            clearTimeout(timeout);
            downloads.removeListener('will-download', onWillDownload);
            if (state === 'completed') resolveDownload();
            else
              rejectDownload(
                new Error(`Packaged download ${expectedFilename} ended in state ${state}.`),
              );
          });
        };
        downloads.on('will-download', onWillDownload);
      }),
    filename,
  );
}

async function createHostProject(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByPlaceholder('Project name').fill(title);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
}

async function createPackagedVideoProject(
  page: Page,
  projectTitle: string,
  mediaName: string,
): Promise<void> {
  await createHostProject(page, projectTitle);
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
  await expect(page.locator(`.timeline-clip[aria-label^="${mediaName},"]`).first()).toBeVisible();
}

async function exportEditableProject(
  app: ElectronApplication,
  page: Page,
  profile: string,
  projectTitle: string,
): Promise<string> {
  const packageFilename = `${projectTitle}.joyproject.json`;
  const packagePath = join(profile, 'downloads', packageFilename);
  const downloadFinished = waitForPackagedDownload(app, packageFilename);
  const exportedNotice = page
    .getByRole('alert')
    .filter({ hasText: 'Editable project package downloaded with all media.' });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export Editable Project…', exact: true }).click();
  await Promise.all([downloadFinished, expect(exportedNotice).toBeVisible()]);
  await expect.poll(() => existsSync(packagePath)).toBe(true);
  return packagePath;
}

async function importEditableProject(page: Page, packagePath: string): Promise<void> {
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const fileChooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Import Editable Project…', exact: true }).click();
  await (await fileChooser).setFiles(packagePath);
}

/**
 * Builds the missing-media state: a packaged project whose media bytes were
 * removed on export, imported into a fresh profile. Returns the open page.
 */
async function openProjectWithMissingMedia(
  suffix: string,
  mediaName: string,
  profiles: { readonly source: string; readonly fresh: string; readonly device: string },
): Promise<{ app: ElectronApplication; page: Page; projectTitle: string }> {
  const projectTitle = `MissingMedia${suffix}`;
  const hostTitle = `MissingMediaHost${suffix}`;
  const source = await launchPackagedEditor(profiles.source);
  try {
    const sourcePage = await openEditorPage(source);
    await createPackagedVideoProject(sourcePage, projectTitle, mediaName);
    const packagePath = await exportEditableProject(
      source,
      sourcePage,
      profiles.source,
      projectTitle,
    );
    const packaged = JSON.parse(readFileSync(packagePath, 'utf8')) as PortablePackage;
    if (!Array.isArray(packaged.media) || packaged.media.length === 0)
      throw new Error('Exported package has no media manifest to strip.');
    const stripped = {
      ...packaged,
      media: packaged.media.map((entry) => ({
        asset: entry.asset,
        status: 'missing',
        missingReason: 'unavailable',
      })),
    };
    const strippedPath = join(profiles.device, `${projectTitle}.joyproject.json`);
    writeFileSync(strippedPath, JSON.stringify(stripped));
    await source.close();

    const app = await launchPackagedEditor(profiles.fresh);
    const page = await openEditorPage(app);
    await createHostProject(page, hostTitle);
    await importEditableProject(page, strippedPath);
    await expect(page.getByRole('heading', { name: projectTitle, level: 1 })).toBeVisible();
    return { app, page, projectTitle };
  } catch (error) {
    await source.close().catch(() => undefined);
    throw error;
  }
}

/** After a restart the app may open the last project directly or show the library. */
async function reopenAfterRestart(app: ElectronApplication, projectTitle: string): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const projects = page.getByRole('heading', { name: 'Projects', exact: true });
  await expect(projects.or(page.getByRole('button', { name: 'File', exact: true }))).toBeVisible();
  if (await projects.isVisible()) {
    await page.getByRole('button', { name: new RegExp(projectTitle) }).click();
  }
  await expect(page.getByRole('heading', { name: projectTitle, level: 1 })).toBeVisible();
  return page;
}

async function openAssets(page: Page): Promise<void> {
  await openPanel(page, 'Assets');
}

async function clickMenuItem(page: Page, menu: 'Edit', label: string): Promise<void> {
  const bar = page.getByRole('navigation', { name: 'Application menu' });
  await bar.getByRole('button', { name: menu, exact: true }).click();
  const item = page.getByRole('menu').getByRole('menuitem', { name: label });
  await expect(item).toBeVisible();
  await expect(item).toBeEnabled();
  await item.click();
}

function flippedFirstByte(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes);
  copy[0] = copy[0]! ^ 0xff;
  return copy;
}

test.describe('desktop.missing-media relink', () => {
  test('exact relink restores the media, and the restored media persists across a restart', async () => {
    test.setTimeout(420_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const mediaName = `missing-${suffix}.mp4`;
    const profiles = {
      source: mkdtempSync(join(tmpdir(), 'joy-media-missing-source-')),
      fresh: mkdtempSync(join(tmpdir(), 'joy-media-missing-fresh-')),
      device: mkdtempSync(join(tmpdir(), 'joy-media-missing-device-')),
    };
    let app: ElectronApplication | undefined;
    try {
      const opened = await openProjectWithMissingMedia(suffix, mediaName, profiles);
      app = opened.app;
      const page = opened.page;
      await openAssets(page);
      const region = page.getByRole('region', { name: 'Missing media' });
      await expect(region).toBeVisible();
      await expect(page.locator('[data-missing-asset-id]', { hasText: mediaName })).toHaveCount(1);

      await page.getByLabel(`Relink ${mediaName}`).setInputFiles({
        name: mediaName,
        mimeType: 'video/mp4',
        buffer: readFileSync(join(fixtureDirectory, 'video.mp4')),
      });
      await expect(region.getByRole('status')).toContainText(`Relinked ${mediaName}.`);
      await expect(page.locator('[data-missing-asset-id]', { hasText: mediaName })).toHaveCount(0);

      await app.close();
      app = await launchPackagedEditor(profiles.fresh);
      const restarted = await reopenAfterRestart(app, opened.projectTitle);
      await openAssets(restarted);
      await expect(restarted.getByRole('region', { name: 'Missing media' })).toHaveCount(0);
      await expect(restarted.locator(`.timeline-clip[aria-label^="${mediaName},"]`)).toHaveCount(1);
    } finally {
      await app?.close().catch(() => undefined);
      for (const dir of Object.values(profiles)) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a file with the wrong hash or the wrong size is refused and the original stays missing', async () => {
    test.setTimeout(420_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const mediaName = `mismatch-${suffix}.mp4`;
    const profiles = {
      source: mkdtempSync(join(tmpdir(), 'joy-media-mismatch-source-')),
      fresh: mkdtempSync(join(tmpdir(), 'joy-media-mismatch-fresh-')),
      device: mkdtempSync(join(tmpdir(), 'joy-media-mismatch-device-')),
    };
    let app: ElectronApplication | undefined;
    try {
      const opened = await openProjectWithMissingMedia(suffix, mediaName, profiles);
      app = opened.app;
      const page = opened.page;
      await openAssets(page);
      const original = readFileSync(join(fixtureDirectory, 'video.mp4'));

      await page.getByLabel(`Relink ${mediaName}`).setInputFiles({
        name: mediaName,
        mimeType: 'video/mp4',
        buffer: flippedFirstByte(original),
      });
      await expect(
        page.getByRole('alert').filter({ hasText: 'does not match the original checksum' }),
      ).toBeVisible();
      await expect(
        page.getByRole('alert').filter({ hasText: 'The original is unchanged.' }),
      ).toBeVisible();
      await expect(page.locator('[data-missing-asset-id]', { hasText: mediaName })).toHaveCount(1);

      await page.getByLabel(`Relink ${mediaName}`).setInputFiles({
        name: mediaName,
        mimeType: 'video/mp4',
        buffer: original.subarray(0, original.length - 1),
      });
      await expect(page.getByRole('alert').filter({ hasText: 'different size' })).toBeVisible();
      await expect(page.locator('[data-missing-asset-id]', { hasText: mediaName })).toHaveCount(1);
    } finally {
      await app?.close().catch(() => undefined);
      for (const dir of Object.values(profiles)) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Use Different File creates a separate asset, and Undo restores the original reference', async () => {
    test.setTimeout(420_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const mediaName = `override-${suffix}.mp4`;
    const profiles = {
      source: mkdtempSync(join(tmpdir(), 'joy-media-override-source-')),
      fresh: mkdtempSync(join(tmpdir(), 'joy-media-override-fresh-')),
      device: mkdtempSync(join(tmpdir(), 'joy-media-override-device-')),
    };
    let app: ElectronApplication | undefined;
    try {
      const opened = await openProjectWithMissingMedia(suffix, mediaName, profiles);
      app = opened.app;
      const page = opened.page;
      await openAssets(page);
      const original = readFileSync(join(fixtureDirectory, 'video.mp4'));
      const replacement = flippedFirstByte(original);

      await page.getByLabel(`Relink ${mediaName}`).setInputFiles({
        name: mediaName,
        mimeType: 'video/mp4',
        buffer: replacement,
      });
      await expect(
        page.getByRole('alert').filter({ hasText: 'does not match the original checksum' }),
      ).toBeVisible();
      await page.getByLabel(`Use a different file for ${mediaName}`).setInputFiles({
        name: `other-${mediaName}`,
        mimeType: 'video/mp4',
        buffer: replacement,
      });
      await expect(
        page.getByRole('status').filter({ hasText: 'is now a separate asset' }),
      ).toBeVisible();
      await expect(page.locator('[data-missing-asset-id]', { hasText: mediaName })).toHaveCount(0);
      await expect(page.locator('.timeline-clip').first()).toBeVisible();

      await clickMenuItem(page, 'Edit', 'Undo');
      await expect(page.locator('[data-missing-asset-id]', { hasText: mediaName })).toHaveCount(1);
    } finally {
      await app?.close().catch(() => undefined);
      for (const dir of Object.values(profiles)) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cancelling the picker has no side effects', async () => {
    test.setTimeout(420_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const mediaName = `cancel-${suffix}.mp4`;
    const profiles = {
      source: mkdtempSync(join(tmpdir(), 'joy-media-cancel-source-')),
      fresh: mkdtempSync(join(tmpdir(), 'joy-media-cancel-fresh-')),
      device: mkdtempSync(join(tmpdir(), 'joy-media-cancel-device-')),
    };
    let app: ElectronApplication | undefined;
    try {
      const opened = await openProjectWithMissingMedia(suffix, mediaName, profiles);
      app = opened.app;
      const page = opened.page;
      await openAssets(page);

      await page.getByLabel(`Relink ${mediaName}`).setInputFiles([]);
      await expect(page.locator('[data-missing-asset-id]', { hasText: mediaName })).toHaveCount(1);
      await expect(page.getByRole('alert').filter({ hasText: 'does not match' })).toHaveCount(0);
      await expect(
        page.getByRole('region', { name: 'Missing media' }).getByRole('status'),
      ).toHaveCount(0);
    } finally {
      await app?.close().catch(() => undefined);
      for (const dir of Object.values(profiles)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
