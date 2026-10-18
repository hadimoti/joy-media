import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
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
const installedExecutable = process.env.JOY_MEDIA_TEST_EXECUTABLE;

async function launchPackagedEditor(userDataDirectory: string): Promise<ElectronApplication> {
  const appWorkingDirectory = process.env.JOY_MEDIA_TEST_WORKING_DIRECTORY ?? unpackedPackage;
  if (!installedExecutable && !existsSync(resolve(unpackedPackage, 'package.json'))) {
    throw new Error('Missing unpacked desktop package. Run package:unpacked before this test.');
  }
  return electron.launch({
    executablePath: installedExecutable ?? electronExecutable,
    cwd: appWorkingDirectory,
    args: [
      ...(installedExecutable ? [] : ['.']),
      '--joy-media-test-mode',
      `--user-data-dir=${userDataDirectory}`,
    ],
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

async function expectAccessiblePackagedEditor(page: Page, state: string): Promise<void> {
  const result = await new AxeBuilder({ page }).setLegacyMode().analyze();
  expect(result.violations, `${state}: ${JSON.stringify(result.violations, null, 2)}`).toEqual([]);
}

test('packaged editor imports, plays, saves, restarts, and exports a playable project', async () => {
  const testInfo = test.info();
  test.setTimeout(360_000);
  const profile = mkdtempSync(join(tmpdir(), 'joy-media-desktop-acceptance-'));
  const downloadDirectory = join(profile, 'downloads');
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projectTitle = `Desktop acceptance ${suffix}`;
  const mediaName = `desktop-readiness-${suffix}.mp4`;
  const audioName = `desktop-readiness-${suffix}.wav`;
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
    await expectAccessiblePackagedEditor(page, 'new packaged editor project');

    // Open a menu and close it using only keyboard input; focus returns to the
    // trigger so the journey proves the packaged shell's keyboard route.
    const viewMenuButton = page.getByRole('button', { name: 'View', exact: true });
    await viewMenuButton.focus();
    await page.keyboard.press('Enter');
    const viewMenu = page.getByRole('menu');
    await expect(viewMenu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viewMenu).toBeHidden();
    await expect(viewMenuButton).toBeFocused();

    for (const panel of [
      'Timeline',
      'Captions',
      'Audio',
      'Effects',
      'Motion',
      'Color',
      'Inspector',
      'Joy Code',
    ]) {
      await openPanel(page, panel);
      await expectAccessiblePackagedEditor(page, `packaged ${panel} panel`);
    }

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
    await expectAccessiblePackagedEditor(page, 'packaged asset library with imported video');

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

    // --- Keyboard trim, Undo/Redo, duplicate ---
    await clip.click();
    await expect(clip).toHaveAttribute('aria-current', 'true');
    const originalLabel = await clip.getAttribute('aria-label');
    expect(originalLabel).toBeTruthy();
    const clipId = await clip.getAttribute('data-clip-id');
    expect(clipId).toBeTruthy();
    const trimEnd = page.getByRole('button', { name: `Trim end of ${clipId}` });
    // One keyboard nudge is one history entry; multiple nudges are individually undoable.
    await trimEnd.press('ArrowLeft');
    const trimmedLabel = await clip.getAttribute('aria-label');
    expect(trimmedLabel).not.toBe(originalLabel);
    expect(trimmedLabel).toMatch(/, 2\.9s, /);

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(clip).toHaveAttribute('aria-label', originalLabel!);

    const redo = page.getByRole('button', { name: 'Redo', exact: true });
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect(clip).toHaveAttribute('aria-label', trimmedLabel!);

    await page.getByRole('button', { name: 'Duplicate clip' }).click();
    await expect(page.locator(`.timeline-clip[aria-label^="${mediaName},"]`)).toHaveCount(2);

    // --- Import audio, set gain to 1.25 ---
    await openPanel(page, 'Assets');
    await page
      .getByRole('tablist', { name: 'Assets sections' })
      .getByRole('tab', { name: /^Audio/ })
      .click();
    const audioImportDialog = page.getByRole('dialog', { name: 'Import media' });
    await page.getByRole('button', { name: 'Import media' }).first().click();
    await audioImportDialog.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
      name: audioName,
      mimeType: 'audio/wav',
      buffer: readFileSync(join(fixtureDirectory, 'audio.wav')),
    });
    await expect(audioImportDialog.getByText(audioName, { exact: true })).toBeVisible();
    await audioImportDialog.getByRole('button', { name: 'Confirm import' }).click();
    const audioCard = page.locator('.asset-card', { hasText: audioName }).first();
    await expect(audioCard).toBeVisible();
    await audioCard.getByRole('button', { name: `Add ${audioName} to timeline` }).click();
    const audioClip = page.locator(`.timeline-clip[aria-label^="${audioName},"]`);
    await expect(audioClip).toHaveCount(1);

    await audioClip.click();
    await openPanel(page, 'Audio');
    await page.getByRole('tab', { name: 'Mix' }).click();
    const gain = page.getByRole('slider', { name: /^Gain voice-/ });
    await expect(gain).toBeEnabled();
    await gain.fill('1.25');
    await expect(gain).toHaveValue('1.25');
    await expectAccessiblePackagedEditor(page, 'packaged audio mix panel');

    // --- Captions: add track, import Persian VTT ---
    await openPanel(page, 'Captions');
    await page.getByRole('button', { name: 'Add caption track' }).click();
    await expect(page.getByRole('button', { name: 'Add caption' })).toBeVisible();
    await page
      .locator('.captions-panel input[type="file"]')
      .setInputFiles(join(fixtureDirectory, 'captions-fa.vtt'));
    await expect(page.locator('.caption-row')).toHaveCount(1);
    const persianCaption = page.getByRole('textbox', { name: /^Caption text / });
    await expect(persianCaption).toHaveValue('این یک آزمون است');
    await expectAccessiblePackagedEditor(page, 'packaged Persian caption panel');

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
    // Assert duplicated video clips survived restart
    const restoredVideoClips = page.locator(`.timeline-clip[aria-label^="${mediaName},"]`);
    await expect(restoredVideoClips).toHaveCount(2);
    const restoredVideoLabels = await restoredVideoClips.evaluateAll((clips) =>
      clips.map((element) => element.getAttribute('aria-label') ?? ''),
    );
    for (const label of restoredVideoLabels) expect(label).toContain(', 2.9s, ');
    // Assert audio clip survived
    const restoredAudioClip = page.locator(`.timeline-clip[aria-label^="${audioName},"]`);
    await expect(restoredAudioClip).toHaveCount(1);
    // Assert audio gain survived
    await restoredAudioClip.click();
    await openPanel(page, 'Audio');
    await page.getByRole('tab', { name: 'Mix' }).click();
    await expect(page.getByRole('slider', { name: /^Gain voice-/ })).toHaveValue('1.25');
    // Assert Persian caption survived
    await openPanel(page, 'Captions');
    await expect(page.getByRole('textbox', { name: /^Caption text / })).toHaveValue(
      'این یک آزمون است',
    );
    await expectAccessiblePackagedEditor(page, 'reopened packaged project with Persian captions');

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
