import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authenticate, openPanel } from '../e2e/wp29-r5-harness.js';

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const fixtureDirectory = resolve('packages/test-fixtures/media');
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;

async function launchPackagedEditor(userDataDirectory: string): Promise<ElectronApplication> {
  if (!existsSync(resolve(unpackedPackage, 'package.json'))) {
    throw new Error('Missing unpacked desktop package. Run package:unpacked before this test.');
  }
  return electron.launch({
    executablePath: electronExecutable,
    cwd: unpackedPackage,
    args: ['.', '--joy-media-test-mode', `--user-data-dir=${userDataDirectory}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JOY_MEDIA_TEST_API_BASE_URL: apiBaseUrl,
      JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY: join(userDataDirectory, 'downloads'),
    },
  });
}

async function openEditorPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  expect(page.url()).toMatch(/^joy-media-app:\/\/renderer\//);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__JOY_MEDIA_API_BASE__,
    ),
  ).toBe(apiBaseUrl);
  await authenticate(page);
  await page.reload();
  await expect
    .poll(async () => {
      const projectLibrary = await page
        .getByRole('heading', { name: 'Projects' })
        .isVisible()
        .catch(() => false);
      const editorWorkspace = await page
        .getByRole('button', { name: 'File', exact: true })
        .isVisible()
        .catch(() => false);
      return projectLibrary || editorWorkspace;
    })
    .toBe(true);
  return page;
}

test('packaged editor imports, plays, saves, restarts, and exports a playable project', async () => {
  const testInfo = test.info();
  test.setTimeout(360_000);
  const profile = mkdtempSync(join(tmpdir(), 'joy-media-desktop-acceptance-'));
  const downloadDirectory = join(profile, 'downloads');
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projectTitle = `Desktop acceptance ${suffix}`;
  const mediaName = `desktop-readiness-${suffix}.mp4`;
  const errors: string[] = [];
  let app: ElectronApplication | undefined;
  let result: Record<string, unknown> = {};

  try {
    app = await launchPackagedEditor(profile);
    let page = await openEditorPage(app);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) => {
      if (request.url().includes('joyst.ir'))
        errors.push(`unexpected production request: ${request.url()}`);
    });

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

    await assetCard.getByRole('button', { name: `Preview ${mediaName}` }).click();
    const preview = page.getByRole('region', { name: `Preview: ${mediaName}` });
    const previewVideo = preview.locator('video');
    await expect(previewVideo).toBeVisible();
    await previewVideo.evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      await video.play();
    });
    await expect
      .poll(() => previewVideo.evaluate((element) => (element as HTMLVideoElement).currentTime))
      .toBeGreaterThan(0.25);
    await previewVideo.evaluate((element) => (element as HTMLVideoElement).pause());
    await preview.getByRole('button', { name: 'Close preview' }).click();

    await assetCard.getByRole('button', { name: `Add ${mediaName} to timeline` }).click();
    const clip = page.locator(`.timeline-clip[aria-label^="${mediaName},"]`);
    await expect(clip).toHaveCount(1);
    await expect(clip).toBeVisible();

    await app.close();
    app = await launchPackagedEditor(profile);
    page = await openEditorPage(app);
    const projectLibrary = page.getByRole('heading', { name: 'Projects' });
    if (await projectLibrary.isVisible().catch(() => false)) {
      const savedProject = page.getByRole('button', { name: new RegExp(projectTitle) });
      await expect(savedProject).toBeVisible();
      await savedProject.click();
    }
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
    await expect(page.locator(`.timeline-clip[aria-label^="${mediaName},"]`)).toHaveCount(1);

    await page.getByRole('button', { name: 'Export MP4' }).click();
    const recentProcesses = page.getByRole('button', { name: 'Recent processes' });
    if ((await recentProcesses.getAttribute('aria-expanded')) !== 'true')
      await recentProcesses.click();
    const processHistory = page.getByRole('region', { name: 'Recent processes' });
    await expect(processHistory).toContainText('Completed — final MP4 verified', {
      timeout: 240_000,
    });
    const redownload = page.getByRole('link', { name: /Download .* again/ }).first();
    await expect(redownload).toBeVisible();
    const exportFilename = await redownload.getAttribute('download');
    expect(exportFilename).toMatch(/\.mp4$/i);
    const exportedPath = join(downloadDirectory, exportFilename!);
    await redownload.click();
    await expect
      .poll(() => existsSync(exportedPath), {
        message: 'The native Electron download must write into the isolated test profile.',
        timeout: 30_000,
      })
      .toBe(true);
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', exportedPath!],
        { encoding: 'utf8' },
      ),
    ) as {
      readonly streams?: readonly { readonly codec_type?: string; readonly codec_name?: string }[];
      readonly format?: { readonly duration?: string };
    };
    expect(probe.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codec_type: 'video', codec_name: 'h264' }),
        expect.objectContaining({ codec_type: 'audio', codec_name: 'aac' }),
      ]),
    );
    expect(Number(probe.format?.duration)).toBeGreaterThan(0);
    result = {
      projectTitle,
      mediaName,
      exportBytes: readFileSync(exportedPath).byteLength,
      savedPath: exportFilename,
      exportFilename,
      ffprobe: probe,
      productionRequests: errors.filter((error) => error.includes('joyst.ir')),
    };
    expect(errors).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    await testInfo.attach('packaged-editor-acceptance.json', {
      body: Buffer.from(
        `${JSON.stringify(
          {
            ...result,
            errors,
            isolatedDownloadFiles: existsSync(downloadDirectory)
              ? readdirSync(downloadDirectory)
              : [],
          },
          null,
          2,
        )}\n`,
      ),
      contentType: 'application/json',
    });
    rmSync(profile, { recursive: true, force: true });
  }
});
