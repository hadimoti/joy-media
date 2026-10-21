import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authenticate, openPanel } from '../e2e/wp29-r5-harness.js';

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const fixtureDirectory = resolve('packages/test-fixtures/media');
const timelineLogKey = 'joy-media.timeline-project-log.v1';
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;
const installedExecutable = process.env.JOY_MEDIA_TEST_EXECUTABLE;

// Launch helper copied from export-semantics.spec.ts. Importing that spec would
// register its unrelated acceptance tests as well.
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

test('packaged File menu exports a project and imports it into a fresh profile', async () => {
  test.setTimeout(360_000);
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  const projectTitle = `FreshProfile-${suffix}`;
  const hostTitle = `FreshHost-${suffix}`;
  const mediaName = `fresh-profile-${suffix}.mp4`;
  const packageFilename = `${projectTitle}.joyproject.json`;
  const sourceProfile = mkdtempSync(join(tmpdir(), 'joy-media-fresh-source-'));
  const freshProfile = mkdtempSync(join(tmpdir(), 'joy-media-fresh-profile-'));
  const packagePath = join(sourceProfile, 'downloads', packageFilename);
  let app: ElectronApplication | undefined;

  try {
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

    await app.close();
    app = undefined;
    const desktopDatabase = new DatabaseSync(join(sourceProfile, 'joy-media.sqlite3'));
    try {
      const persistedTimeline = desktopDatabase
        .prepare('SELECT value FROM editor_storage WHERE key = ?')
        .get(timelineLogKey) as { readonly value: string } | undefined;
      expect(persistedTimeline?.value).toContain(mediaName);
    } finally {
      desktopDatabase.close();
    }

    // The File menu and its project-package file input mount only inside an
    // open editor. A fresh profile opens a disposable host project so Import
    // Editable Project… can run; the imported package then becomes active.
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

    // Opening the imported project remounts the workspace, so the short import
    // toast is not a stable signal. The restored title, clip, and My media
    // entry are the durable result.
    await expect(freshPage.getByRole('heading', { name: projectTitle, level: 1 })).toBeVisible();
    await expect(freshPage.locator(`.timeline-clip[aria-label^="${mediaName},"]`)).toHaveCount(1);
    await openPanel(freshPage, 'Assets');
    await freshPage.getByRole('button', { name: /^My media/ }).click();
    const assetSearch = freshPage.getByPlaceholder('Search media…');
    if (!(await assetSearch.isVisible())) {
      await freshPage.getByRole('button', { name: 'Search Assets' }).click();
    }
    await assetSearch.fill(mediaName);
    await expect(
      freshPage.getByRole('button', { name: `Add ${mediaName} to timeline` }),
    ).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(sourceProfile, { recursive: true, force: true });
    rmSync(freshProfile, { recursive: true, force: true });
  }
});
