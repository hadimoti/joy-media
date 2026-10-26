import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/** A project media item: the name it is imported under, and the fixture whose bytes it carries. */
interface MediaSpec {
  readonly name: string;
  readonly fixture: string;
}

async function createPackagedVideoProject(
  page: Page,
  projectTitle: string,
  media: readonly MediaSpec[],
): Promise<void> {
  await createHostProject(page, projectTitle);
  await openPanel(page, 'Assets');
  for (const item of media) {
    const importDialog = page.getByRole('dialog', { name: 'Import media' });
    await page.getByRole('button', { name: 'Import media' }).first().click();
    await importDialog.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
      name: item.name,
      mimeType: 'video/mp4',
      buffer: readFileSync(resolve(fixtureDirectory, item.fixture)),
    });
    await expect(importDialog.getByText(item.name, { exact: true })).toBeVisible();
    await importDialog.getByRole('button', { name: 'Confirm import' }).click();
    const assetCard = page.locator('.asset-card', { hasText: item.name }).first();
    await expect(assetCard).toBeVisible();
    await assetCard.getByRole('button', { name: `Add ${item.name} to timeline` }).click();
    await expect(page.locator(`.timeline-clip[aria-label^="${item.name},"]`).first()).toBeVisible();
  }
}

/**
 * Renders the project with the editor's own MP4 export and returns the downloaded file's path.
 * The render must finish as verified, not merely start.
 */
async function exportRenderedMp4(
  app: ElectronApplication,
  page: Page,
  profile: string,
): Promise<string> {
  await page.getByRole('button', { name: 'Export MP4' }).click();
  const recentProcesses = page.getByRole('button', { name: 'Recent processes' });
  if ((await recentProcesses.getAttribute('aria-expanded')) !== 'true')
    await recentProcesses.click();
  await expect(page.getByRole('region', { name: 'Recent processes' })).toContainText(
    'Completed — final MP4 verified',
    { timeout: 240_000 },
  );
  const redownload = page.getByRole('link', { name: /Download .* again/ }).first();
  await expect(redownload).toBeVisible();
  const filename = await redownload.getAttribute('download');
  if (filename === null || !/\.mp4$/iu.test(filename))
    throw new Error('Export did not offer an MP4 download.');
  const downloadFinished = waitForPackagedDownload(app, filename);
  await redownload.click();
  await downloadFinished;
  return join(profile, 'downloads', filename);
}

/**
 * A second, different file with the same audio and video streams: a stream copy with a distinct
 * metadata tag. Batch and override matching is by content, so the copy must not be byte-identical.
 */
function distinctCopyOfFixture(directory: string, fixture: string, tag: string): string {
  const output = join(directory, `distinct-${tag}.mp4`);
  execFileSync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    join(fixtureDirectory, fixture),
    '-c',
    'copy',
    '-metadata',
    `comment=${tag}`,
    output,
  ]);
  return output;
}

/** Number of audio streams in a rendered file, read from its container headers. */
function audioStreamCount(path: string): number {
  const output = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      path,
    ],
    { encoding: 'utf8' },
  );
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function probeDurationSeconds(path: string): number {
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', path], {
      encoding: 'utf8',
    }),
  ) as { readonly format?: { readonly duration?: string } };
  return Number(probe.format?.duration ?? 0);
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
  media: readonly MediaSpec[],
  profiles: { readonly source: string; readonly fresh: string; readonly device: string },
): Promise<{ app: ElectronApplication; page: Page; projectTitle: string }> {
  const projectTitle = `MissingMedia${suffix}`;
  const hostTitle = `MissingMediaHost${suffix}`;
  const source = await launchPackagedEditor(profiles.source);
  try {
    const sourcePage = await openEditorPage(source);
    await createPackagedVideoProject(sourcePage, projectTitle, media);
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

/**
 * Removes a profile directory with the same retries as before. If removal still fails, the live Joy Media and Chromium
 * processes are logged first, so the holder of the file can be named. The error is rethrown unchanged.
 */
function removeProfile(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    console.error(`profile removal failed for ${dir}; live processes:\n${liveProcessSnapshot()}`);
    throw error;
  }
}

function liveProcessSnapshot(): string {
  try {
    return execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'joy|electron|crashpad|chrome|worker' } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.Name, $_.ExecutablePath }",
      ],
      { encoding: 'utf8' },
    );
  } catch (error) {
    return `(process snapshot unavailable: ${error instanceof Error ? error.message : String(error)})`;
  }
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
      const opened = await openProjectWithMissingMedia(
        suffix,
        [{ name: mediaName, fixture: 'video.mp4' }],
        profiles,
      );
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
      for (const dir of Object.values(profiles)) removeProfile(dir);
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
      const opened = await openProjectWithMissingMedia(
        suffix,
        [{ name: mediaName, fixture: 'video.mp4' }],
        profiles,
      );
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
      for (const dir of Object.values(profiles)) removeProfile(dir);
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
      const opened = await openProjectWithMissingMedia(
        suffix,
        [{ name: mediaName, fixture: 'video.mp4' }],
        profiles,
      );
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
      for (const dir of Object.values(profiles)) removeProfile(dir);
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
      const opened = await openProjectWithMissingMedia(
        suffix,
        [{ name: mediaName, fixture: 'video.mp4' }],
        profiles,
      );
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
      for (const dir of Object.values(profiles)) removeProfile(dir);
    }
  });

  test('batch relink matches each missing file by content, reports the unmatched file, and the project then exports', async () => {
    test.setTimeout(600_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const work = mkdtempSync(join(tmpdir(), 'joy-media-batch-work-'));
    const distinct = distinctCopyOfFixture(work, 'video.mp4', suffix);
    const media: MediaSpec[] = [
      { name: `batch-a-${suffix}.mp4`, fixture: 'video.mp4' },
      { name: `batch-b-${suffix}.mp4`, fixture: distinct },
    ];
    const profiles = {
      source: mkdtempSync(join(tmpdir(), 'joy-media-batch-source-')),
      fresh: mkdtempSync(join(tmpdir(), 'joy-media-batch-fresh-')),
      device: mkdtempSync(join(tmpdir(), 'joy-media-batch-device-')),
    };
    let app: ElectronApplication | undefined;
    try {
      const opened = await openProjectWithMissingMedia(suffix, media, profiles);
      app = opened.app;
      const page = opened.page;
      await openAssets(page);
      await expect(page.locator('[data-missing-asset-id]')).toHaveCount(2);

      // Files are matched by content, not by name: the names here are deliberately different.
      await page.getByLabel('Match files to missing media').setInputFiles([
        {
          name: 'unrelated.jpg',
          mimeType: 'image/jpeg',
          buffer: readFileSync(join(fixtureDirectory, 'image.jpg')),
        },
        { name: `copy-b-${suffix}.mp4`, mimeType: 'video/mp4', buffer: readFileSync(distinct) },
        {
          name: `copy-a-${suffix}.mp4`,
          mimeType: 'video/mp4',
          buffer: readFileSync(join(fixtureDirectory, 'video.mp4')),
        },
      ]);
      const region = page.getByRole('region', { name: 'Missing media' });
      await expect(region.getByRole('status')).toContainText('Relinked 2 of 2 matched file(s).');
      await expect(region.getByRole('status')).toContainText(
        'No missing media matches: unrelated.jpg.',
      );
      await expect(page.locator('[data-missing-asset-id]')).toHaveCount(0);

      const rendered = await exportRenderedMp4(app, page, profiles.fresh);
      expect(probeDurationSeconds(rendered)).toBeGreaterThan(0);
    } finally {
      await app?.close().catch(() => undefined);
      for (const dir of [...Object.values(profiles), work]) removeProfile(dir);
    }
  });

  test('a Use Different File override survives a restart and the restarted project exports', async () => {
    test.setTimeout(600_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const mediaName = `kept-${suffix}.mp4`;
    const work = mkdtempSync(join(tmpdir(), 'joy-media-kept-work-'));
    const distinct = distinctCopyOfFixture(work, 'video.mp4', suffix);
    const profiles = {
      source: mkdtempSync(join(tmpdir(), 'joy-media-kept-source-')),
      fresh: mkdtempSync(join(tmpdir(), 'joy-media-kept-fresh-')),
      device: mkdtempSync(join(tmpdir(), 'joy-media-kept-device-')),
    };
    let app: ElectronApplication | undefined;
    try {
      const opened = await openProjectWithMissingMedia(
        suffix,
        [{ name: mediaName, fixture: 'video.mp4' }],
        profiles,
      );
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
      // A different, valid video is the override, so the separate asset can be rendered.
      await page.getByLabel(`Use a different file for ${mediaName}`).setInputFiles({
        name: `other-${mediaName}`,
        mimeType: 'video/mp4',
        buffer: readFileSync(distinct),
      });
      await expect(
        page.getByRole('status').filter({ hasText: 'is now a separate asset' }),
      ).toBeVisible();
      await expect(page.locator('[data-missing-asset-id]', { hasText: mediaName })).toHaveCount(0);

      await app.close();
      app = await launchPackagedEditor(profiles.fresh);
      const restarted = await reopenAfterRestart(app, opened.projectTitle);
      await openAssets(restarted);
      await expect(restarted.getByRole('region', { name: 'Missing media' })).toHaveCount(0);
      await expect(restarted.locator('.timeline-clip').first()).toBeVisible();

      const rendered = await exportRenderedMp4(app, restarted, profiles.fresh);
      expect(probeDurationSeconds(rendered)).toBeGreaterThan(0);
    } finally {
      await app?.close().catch(() => undefined);
      for (const dir of [...Object.values(profiles), work]) removeProfile(dir);
    }
  });
});

test.describe('desktop.silent-video-export', () => {
  test('a silent video exports as a playable MP4 instead of failing the audio mix', async () => {
    test.setTimeout(600_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-silent-export-'));
    let app: ElectronApplication | undefined;
    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createPackagedVideoProject(page, `Silent${suffix}`, [
        { name: `silent-${suffix}.mp4`, fixture: 'readiness-silent.mp4' },
      ]);
      const rendered = await exportRenderedMp4(app, page, profile);
      expect(probeDurationSeconds(rendered)).toBeGreaterThan(0);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  });

  test('a video with an audio track exports with its sound', async () => {
    test.setTimeout(600_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-sound-export-'));
    let app: ElectronApplication | undefined;
    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createPackagedVideoProject(page, `Sound${suffix}`, [
        { name: `sound-${suffix}.mp4`, fixture: 'video.mp4' },
      ]);
      const rendered = await exportRenderedMp4(app, page, profile);
      expect(probeDurationSeconds(rendered)).toBeGreaterThan(0);
      expect(audioStreamCount(rendered)).toBeGreaterThanOrEqual(1);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  });

  test('a mixed timeline of silent and audio videos exports, and keeps the sound of the audio video', async () => {
    test.setTimeout(600_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-mixed-export-'));
    let app: ElectronApplication | undefined;
    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createPackagedVideoProject(page, `Mixed${suffix}`, [
        { name: `silent-${suffix}.mp4`, fixture: 'readiness-silent.mp4' },
        { name: `sound-${suffix}.mp4`, fixture: 'video.mp4' },
      ]);
      const rendered = await exportRenderedMp4(app, page, profile);
      expect(probeDurationSeconds(rendered)).toBeGreaterThan(0);
      expect(audioStreamCount(rendered)).toBeGreaterThanOrEqual(1);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  });

  test('a silent video relinked to its original exports after the relink', async () => {
    test.setTimeout(600_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const mediaName = `relinked-silent-${suffix}.mp4`;
    const profiles = {
      source: mkdtempSync(join(tmpdir(), 'joy-media-silent-relink-source-')),
      fresh: mkdtempSync(join(tmpdir(), 'joy-media-silent-relink-fresh-')),
      device: mkdtempSync(join(tmpdir(), 'joy-media-silent-relink-device-')),
    };
    let app: ElectronApplication | undefined;
    try {
      const opened = await openProjectWithMissingMedia(
        suffix,
        [{ name: mediaName, fixture: 'readiness-silent.mp4' }],
        profiles,
      );
      app = opened.app;
      const page = opened.page;
      await openAssets(page);
      await page.getByLabel(`Relink ${mediaName}`).setInputFiles({
        name: mediaName,
        mimeType: 'video/mp4',
        buffer: readFileSync(join(fixtureDirectory, 'readiness-silent.mp4')),
      });
      await expect(
        page.getByRole('region', { name: 'Missing media' }).getByRole('status'),
      ).toContainText(`Relinked ${mediaName}.`);
      const rendered = await exportRenderedMp4(app, page, profiles.fresh);
      expect(probeDurationSeconds(rendered)).toBeGreaterThan(0);
    } finally {
      await app?.close().catch(() => undefined);
      for (const dir of Object.values(profiles)) removeProfile(dir);
    }
  });
});

test.describe('desktop.editor-thumbnail-bridge', () => {
  test('a desktop thumbnail is rendered by the local Worker from the imported original, and a repeat request reuses the verified copy', async () => {
    test.setTimeout(600_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const mediaName = `thumb-${suffix}.mp4`;
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-thumb-bridge-'));
    const originalBytes = readFileSync(join(fixtureDirectory, 'video.mp4'));
    const originalHash = createHash('sha256').update(originalBytes).digest('hex');
    let app: ElectronApplication | undefined;
    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createPackagedVideoProject(page, `Thumb${suffix}`, [
        { name: mediaName, fixture: 'video.mp4' },
      ]);

      const card = page.locator('.asset-card', { hasText: mediaName }).first();
      await card.getByRole('button', { name: `Make desktop thumbnail for ${mediaName}` }).click();
      const thumbnail = card.getByRole('img', { name: `Desktop thumbnail of ${mediaName}` });
      await expect(thumbnail).toBeVisible({ timeout: 300_000 });
      await expect
        .poll(() => thumbnail.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);

      // The original was staged under its hash, so the desktop can name it again without a re-upload.
      expect(existsSync(join(profile, 'media', 'staged', `${originalHash}.bin`))).toBe(true);
      const repeat = await page.evaluate(
        async ({ sha256, bytes }) => {
          const joy = (
            window as unknown as {
              joyDesktop: { invoke(channel: string, payload?: unknown): Promise<unknown> };
            }
          ).joyDesktop;
          return joy.invoke('desktop.media-stage.begin', {
            sha256,
            bytes,
            displayName: 'repeat.mp4',
          });
        },
        { sha256: originalHash, bytes: originalBytes.byteLength },
      );
      expect(repeat).toMatchObject({ status: 'cached' });
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  });
});
