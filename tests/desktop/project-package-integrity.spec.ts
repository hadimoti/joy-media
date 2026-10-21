import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { authenticate, openPanel } from '../e2e/wp29-r5-harness.js';

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const fixtureDirectory = resolve('packages/test-fixtures/media');
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;
const installedExecutable = process.env.JOY_MEDIA_TEST_EXECUTABLE;

interface PortableMediaEntry {
  readonly status?: string;
  readonly dataBase64?: string;
  readonly missingReason?: string;
  readonly asset?: { readonly id?: string; readonly displayName?: string };
}

interface PortablePackage {
  readonly format?: string;
  readonly source?: { readonly title?: string };
  readonly media?: readonly PortableMediaEntry[];
  readonly documents?: { readonly timeline?: unknown };
}

// Launch helper copied from fresh-profile.spec.ts. Importing that spec would
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

function isInside(parent: string, child: string): boolean {
  const fromParent = relative(resolve(parent), resolve(child));
  return fromParent === '' || (!fromParent.startsWith('..') && !isAbsolute(fromParent));
}

async function libraryProjectCount(page: Page): Promise<number> {
  const tab = page.getByRole('button', { name: /^Projects \(\d+\)$/ });
  await expect(tab).toBeVisible();
  const match = /\((\d+)\)/u.exec(await tab.innerText());
  if (match?.[1] === undefined) throw new Error('Project library did not show a project count.');
  return Number(match[1]);
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

async function catalogTitleCount(page: Page, title: string): Promise<number> {
  const titles = await page.evaluate(() => {
    const desktop = (
      window as unknown as {
        joyDesktop?: { projectStorage?: { getItem(key: string): string | null } };
      }
    ).joyDesktop;
    const raw = desktop?.projectStorage?.getItem('joy-media.project-catalog.v1');
    if (raw == null) return [] as string[];
    const parsed = JSON.parse(raw) as {
      projects?: Record<string, { title?: string; trashedAt?: string }>;
    };
    return Object.values(parsed.projects ?? {})
      .filter((entry) => entry.trashedAt === undefined && typeof entry.title === 'string')
      .map((entry) => entry.title ?? '');
  });
  return titles.filter((entry) => entry === title).length;
}

async function expectRestoredProject(
  page: Page,
  projectTitle: string,
  mediaName: string,
): Promise<void> {
  await expect(page.getByRole('heading', { name: projectTitle, level: 1 })).toBeVisible();
  await expect(page.locator(`.timeline-clip[aria-label^="${mediaName},"]`)).toHaveCount(1);
  await openPanel(page, 'Assets');
  await page.getByRole('button', { name: /^My media/ }).click();
  const assetSearch = page.getByPlaceholder('Search media…');
  if (!(await assetSearch.isVisible())) {
    await page.getByRole('button', { name: 'Search Assets' }).click();
  }
  await assetSearch.fill(mediaName);
  await expect(page.getByRole('button', { name: `Add ${mediaName} to timeline` })).toBeVisible();
}

function readPackage(packagePath: string): PortablePackage {
  return JSON.parse(readFileSync(packagePath, 'utf8')) as PortablePackage;
}

test.describe('desktop.file-project-package', () => {
  test('cross-device round trip restores the project, clip, and media in a new profile', async () => {
    test.setTimeout(360_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const projectTitle = `PkgCross${suffix}`;
    const hostTitle = `PkgCrossHost${suffix}`;
    const mediaName = `pkg-cross-${suffix}.mp4`;
    const sourceProfile = mkdtempSync(join(tmpdir(), 'joy-media-pkg-source-'));
    const freshProfile = mkdtempSync(join(tmpdir(), 'joy-media-pkg-fresh-'));
    const otherDeviceDir = mkdtempSync(join(tmpdir(), 'joy-media-other-device-'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchPackagedEditor(sourceProfile);
      const page = await openEditorPage(app);
      await createPackagedVideoProject(page, projectTitle, mediaName);
      const packagePath = await exportEditableProject(app, page, sourceProfile, projectTitle);
      const packaged = readPackage(packagePath);
      const embedded = packaged.media?.find(
        (entry) => entry.status === 'embedded' && entry.asset?.displayName === mediaName,
      );
      expect(packaged.format).toBe('joy-media-project');
      expect(packaged.source?.title).toBe(projectTitle);
      expect(embedded?.dataBase64).toEqual(expect.any(String));
      expect(embedded?.asset?.id).toEqual(expect.any(String));
      expect(JSON.stringify(packaged.documents?.timeline)).toContain(embedded?.asset?.id);

      const otherDevicePackage = join(otherDeviceDir, `${projectTitle}.joyproject.json`);
      copyFileSync(packagePath, otherDevicePackage);
      expect(isInside(sourceProfile, otherDevicePackage)).toBe(false);
      expect(isInside(freshProfile, otherDevicePackage)).toBe(false);

      await app.close();
      app = undefined;
      app = await launchPackagedEditor(freshProfile);
      const freshPage = await openEditorPage(app);
      await createHostProject(freshPage, hostTitle);
      await importEditableProject(freshPage, otherDevicePackage);
      await expectRestoredProject(freshPage, projectTitle, mediaName);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(sourceProfile, { recursive: true, force: true });
      rmSync(freshProfile, { recursive: true, force: true });
      rmSync(otherDeviceDir, { recursive: true, force: true });
    }
  });

  test('import reports one media file that needs relinking when the package has no media bytes', async () => {
    test.setTimeout(360_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const projectTitle = `PkgMissing${suffix}`;
    const hostTitle = `PkgMissingHost${suffix}`;
    const mediaName = `pkg-missing-${suffix}.mp4`;
    const sourceProfile = mkdtempSync(join(tmpdir(), 'joy-media-pkg-missing-source-'));
    const freshProfile = mkdtempSync(join(tmpdir(), 'joy-media-pkg-missing-fresh-'));
    const otherDeviceDir = mkdtempSync(join(tmpdir(), 'joy-media-missing-device-'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchPackagedEditor(sourceProfile);
      const page = await openEditorPage(app);
      await createPackagedVideoProject(page, projectTitle, mediaName);
      const packagePath = await exportEditableProject(app, page, sourceProfile, projectTitle);
      const packaged = readPackage(packagePath);
      if (!Array.isArray(packaged.media) || packaged.media.length === 0) {
        throw new Error('Exported package has no media manifest to strip.');
      }
      const stripped: PortablePackage = {
        ...packaged,
        media: packaged.media.map((entry) => ({
          asset: entry.asset,
          status: 'missing',
          missingReason: 'unavailable',
        })),
      };
      const strippedPath = join(otherDeviceDir, `${projectTitle}.joyproject.json`);
      writeFileSync(strippedPath, JSON.stringify(stripped));
      expect(JSON.stringify(readPackage(strippedPath).media)).not.toContain('dataBase64');

      await app.close();
      app = undefined;
      app = await launchPackagedEditor(freshProfile);
      const freshPage = await openEditorPage(app);
      await createHostProject(freshPage, hostTitle);
      await importEditableProject(freshPage, strippedPath);

      // The import keeps the project and does not open a relink dialog. The
      // durable place to see what needs relinking is the Missing media section,
      // not the import toast, which disappears after about four seconds.
      await openPanel(freshPage, 'Assets');
      await expect(freshPage.getByRole('region', { name: 'Missing media' })).toBeVisible();
      await expect(
        freshPage.locator('[data-missing-asset-id]', { hasText: mediaName }),
      ).toHaveCount(1);
      await expect(freshPage.getByRole('dialog')).toHaveCount(0);
      await expect(freshPage.getByRole('heading', { name: projectTitle, level: 1 })).toBeVisible();
      await expect(freshPage.locator(`.timeline-clip[aria-label^="${mediaName},"]`)).toHaveCount(1);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(sourceProfile, { recursive: true, force: true });
      rmSync(freshProfile, { recursive: true, force: true });
      rmSync(otherDeviceDir, { recursive: true, force: true });
    }
  });

  test('importing the same package twice creates a distinct project and does not overwrite', async () => {
    test.setTimeout(360_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const projectTitle = `PkgCollision${suffix}`;
    const hostTitle = `PkgCollisionHost${suffix}`;
    const mediaName = `pkg-collision-${suffix}.mp4`;
    const sourceProfile = mkdtempSync(join(tmpdir(), 'joy-media-pkg-collision-source-'));
    const destinationProfile = mkdtempSync(join(tmpdir(), 'joy-media-pkg-collision-dest-'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchPackagedEditor(sourceProfile);
      const sourcePage = await openEditorPage(app);
      await createPackagedVideoProject(sourcePage, projectTitle, mediaName);
      const packagePath = await exportEditableProject(app, sourcePage, sourceProfile, projectTitle);
      await app.close();
      app = undefined;

      app = await launchPackagedEditor(destinationProfile);
      const page = await openEditorPage(app);
      const startCount = await libraryProjectCount(page);
      await createHostProject(page, hostTitle);
      await importEditableProject(page, packagePath);
      await expect(page.getByRole('heading', { name: projectTitle, level: 1 })).toBeVisible();
      await expect.poll(() => catalogTitleCount(page, projectTitle)).toBe(1);
      await importEditableProject(page, packagePath);
      await expect.poll(() => catalogTitleCount(page, projectTitle)).toBe(2);
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page.getByRole('button', { name: 'File', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Projects Library…', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
      expect(await libraryProjectCount(page)).toBe(startCount + 3);
      await expect(page.locator('.project-library-card', { hasText: projectTitle })).toHaveCount(2);
      await expect(page.locator('.project-library-card', { hasText: hostTitle })).toHaveCount(1);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(sourceProfile, { recursive: true, force: true });
      rmSync(destinationProfile, { recursive: true, force: true });
    }
  });

  test('a truncated project package is rejected and the library stays unchanged', async () => {
    test.setTimeout(360_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const hostTitle = `PkgMalformedHost${suffix}`;
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-pkg-malformed-'));
    const badPackage = join(profile, 'truncated.joyproject.json');
    let app: ElectronApplication | undefined;

    try {
      writeFileSync(
        badPackage,
        '{"format":"joy-media-project","schemaVersion":1,"app":"JOY Studio"',
      );
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      const startCount = await libraryProjectCount(page);
      await createHostProject(page, hostTitle);
      await importEditableProject(page, badPackage);

      await expect(
        page.getByRole('alert').filter({ hasText: 'Project import failed:' }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: hostTitle, level: 1 })).toBeVisible();

      await page.getByRole('button', { name: 'File', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Projects Library…', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
      expect(await libraryProjectCount(page)).toBe(startCount + 1);
      await expect(page.locator('.project-library-card', { hasText: hostTitle })).toHaveCount(1);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
