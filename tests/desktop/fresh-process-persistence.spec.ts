import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authenticate, openPanel } from '../e2e/wp29-r5-harness.js';

// The matrix's project.persistence.fresh-process case: save a project in one packaged process, end
// that process, reopen the saved project from a fresh profile in a new process, and render it. The
// persisted store is checked after the first process ends. The render is the packaged export, which
// runs the real export pipeline, and its MP4 is probed with ffprobe.

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const fixtureDirectory = resolve('packages/test-fixtures/media');
const timelineLogKey = 'joy-media.timeline-project-log.v1';
const catalogKey = 'joy-media.project-catalog.v1';
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;
const installedExecutable = process.env.JOY_MEDIA_TEST_EXECUTABLE;

// Launch and helper code shared with fresh-profile.spec.ts and editor-acceptance.spec.ts. Importing
// those specs would register their acceptance tests as well.
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

async function downloadPackagedExport(
  app: ElectronApplication,
  page: Page,
  downloadDirectory: string,
  download: Locator,
): Promise<{ readonly filename: string; readonly path: string }> {
  await expect(download).toBeVisible();
  const filename = await download.getAttribute('download');
  expect(filename).toMatch(/\.mp4$/i);
  const path = join(downloadDirectory, filename!);
  const downloadFinished = waitForPackagedDownload(app, filename!);
  await download.click();
  await downloadFinished;
  await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(true);
  return { filename: filename!, path };
}

async function createPackagedVideoProject(
  page: Page,
  projectTitle: string,
  mediaName: string,
): Promise<void> {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByPlaceholder('Project name').fill(projectTitle);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
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

test('a packaged project saved in one process reopens from a fresh profile in a new process and renders', async () => {
  test.setTimeout(900_000);
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  const projectTitle = `FreshProcess-${suffix}`;
  const hostTitle = `FreshProcessHost-${suffix}`;
  const mediaName = `fresh-process-${suffix}.mp4`;
  const packageFilename = `${projectTitle}.joyproject.json`;
  const sourceProfile = mkdtempSync(join(tmpdir(), 'joy-media-process-source-'));
  const freshProfile = mkdtempSync(join(tmpdir(), 'joy-media-process-fresh-'));
  const packagePath = join(sourceProfile, 'downloads', packageFilename);
  let app: ElectronApplication | undefined;

  try {
    // Save: the editor writes each edit to the desktop store, and the editable package carries the
    // project and its embedded media out of the first process.
    app = await launchPackagedEditor(sourceProfile);
    const page = await openEditorPage(app);
    await createPackagedVideoProject(page, projectTitle, mediaName);

    const downloadFinished = waitForPackagedDownload(app, packageFilename);
    const exportedNotice = page
      .getByRole('alert')
      .filter({ hasText: 'Editable project package downloaded with all media.' });
    await page.getByRole('button', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Export Editable Project…', exact: true }).click();
    await Promise.all([downloadFinished, expect(exportedNotice).toBeVisible()]);
    await expect.poll(() => existsSync(packagePath)).toBe(true);

    const packaged = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      readonly format?: string;
      readonly source?: { readonly title?: string };
      readonly media?: readonly {
        readonly status?: string;
        readonly asset?: { readonly id?: string; readonly displayName?: string };
      }[];
      readonly documents?: { readonly timeline?: unknown };
    };
    const embedded = packaged.media?.find(
      (entry) => entry.status === 'embedded' && entry.asset?.displayName === mediaName,
    );
    expect(packaged.format).toBe('joy-media-project');
    expect(packaged.source?.title).toBe(projectTitle);
    expect(embedded?.asset?.id).toEqual(expect.any(String));
    expect(JSON.stringify(packaged.documents?.timeline)).toContain(embedded?.asset?.id);

    // Process termination, then the persisted store. Both the timeline and the project catalog must
    // hold this project after the first process has ended.
    await app.close();
    app = undefined;
    const sourceDatabase = new DatabaseSync(join(sourceProfile, 'joy-media.sqlite3'));
    try {
      const persistedTimeline = sourceDatabase
        .prepare('SELECT value FROM editor_storage WHERE key = ?')
        .get(timelineLogKey) as { readonly value: string } | undefined;
      const persistedCatalog = sourceDatabase
        .prepare('SELECT value FROM editor_storage WHERE key = ?')
        .get(catalogKey) as { readonly value: string } | undefined;
      expect(persistedTimeline?.value, 'the saved timeline holds the clip').toContain(mediaName);
      expect(persistedCatalog?.value, 'the saved catalog holds the project').toContain(
        projectTitle,
      );
    } finally {
      sourceDatabase.close();
    }

    // Reopen from a fresh profile in a new process. The package import is the only input, so the
    // fresh profile's own store has to hold the project after the import.
    app = await launchPackagedEditor(freshProfile);
    const freshPage = await openEditorPage(app);
    await freshPage.getByRole('button', { name: 'New project' }).click();
    await freshPage.getByPlaceholder('Project name').fill(hostTitle);
    await freshPage.getByRole('button', { name: 'Create project' }).click();
    await expect(freshPage.getByRole('button', { name: 'File', exact: true })).toBeVisible();
    await freshPage.getByRole('button', { name: 'File', exact: true }).click();
    const fileChooser = freshPage.waitForEvent('filechooser');
    await freshPage
      .getByRole('menuitem', { name: 'Import Editable Project…', exact: true })
      .click();
    await (await fileChooser).setFiles(packagePath);

    await expect(freshPage.getByRole('heading', { name: projectTitle, level: 1 })).toBeVisible();
    await expect(freshPage.locator(`.timeline-clip[aria-label^="${mediaName},"]`)).toHaveCount(1);

    // Render the reopened project in this process with the packaged export. The wait stops at the
    // first failed status, so a render that cannot start reports its reason, not a timeout.
    await freshPage.getByRole('button', { name: 'Export MP4' }).click();
    const recentProcesses = freshPage.getByRole('button', { name: 'Recent processes' });
    if ((await recentProcesses.getAttribute('aria-expanded')) !== 'true')
      await recentProcesses.click();
    const processHistory = freshPage.getByRole('region', { name: 'Recent processes' });
    await expect(processHistory).toContainText(/Completed — final MP4 verified|Failed —/u, {
      timeout: 240_000,
    });
    await expect(
      processHistory,
      'the reopened project must render to a verified MP4',
    ).toContainText('Completed — final MP4 verified');
    const redownload = freshPage.getByRole('link', { name: /Download .* again/ }).first();
    const exported = await downloadPackagedExport(
      app,
      freshPage,
      join(freshProfile, 'downloads'),
      redownload,
    );

    // ffprobe validation of the rendered MP4: a video stream with real dimensions and a positive
    // duration, from an MP4 container.
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', exported.path],
        { encoding: 'utf8' },
      ),
    ) as {
      readonly streams?: readonly {
        readonly codec_type?: string;
        readonly width?: number;
        readonly height?: number;
      }[];
      readonly format?: { readonly format_name?: string; readonly duration?: string };
    };
    const video = probe.streams?.find((stream) => stream.codec_type === 'video');
    expect(video?.width, 'the rendered MP4 has a video width').toBeGreaterThan(0);
    expect(video?.height, 'the rendered MP4 has a video height').toBeGreaterThan(0);
    expect(probe.format?.format_name, 'the rendered file is an MP4 container').toMatch(/mp4/u);
    expect(
      Number(probe.format?.duration),
      'the rendered MP4 has a positive duration',
    ).toBeGreaterThan(0);

    // Close the reopened process, then check that the fresh profile's own store holds the project.
    await app.close();
    app = undefined;
    const freshDatabase = new DatabaseSync(join(freshProfile, 'joy-media.sqlite3'));
    try {
      const importedTimeline = freshDatabase
        .prepare('SELECT value FROM editor_storage WHERE key = ?')
        .get(timelineLogKey) as { readonly value: string } | undefined;
      expect(importedTimeline?.value, 'the fresh profile stores the imported clip').toContain(
        mediaName,
      );
    } finally {
      freshDatabase.close();
    }
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(sourceProfile, { recursive: true, force: true });
    rmSync(freshProfile, { recursive: true, force: true });
  }
});
