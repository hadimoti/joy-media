import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

async function launchPackagedEditor(
  userDataDirectory: string,
  deviceScaleFactor?: number,
): Promise<ElectronApplication> {
  const appWorkingDirectory = process.env.JOY_MEDIA_TEST_WORKING_DIRECTORY ?? unpackedPackage;
  if (!installedExecutable && !existsSync(resolve(unpackedPackage, 'package.json'))) {
    throw new Error('Missing unpacked desktop package. Run package:unpacked before this test.');
  }
  return electron.launch({
    executablePath: installedExecutable ?? electronExecutable,
    cwd: appWorkingDirectory,
    args: [
      ...(installedExecutable ? [] : ['.']),
      ...(deviceScaleFactor === undefined
        ? []
        : [`--force-device-scale-factor=${deviceScaleFactor}`]),
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
  if (!installedExecutable) {
    expect(
      existsSync(
        resolve(
          unpackedPackage,
          'node_modules',
          '@joy-media',
          'project-persistence',
          'dist',
          'editor-storage.js',
        ),
      ),
    ).toBe(true);
  }
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

async function capturePackagedMonitorFrame(page: Page): Promise<string> {
  const canvas = page.locator('.monitor-canvas canvas').first();
  await expect(canvas).toBeVisible();
  return createHash('sha256')
    .update(await canvas.screenshot({ animations: 'disabled' }))
    .digest('hex');
}

async function seekPackagedPlayhead(page: Page, timeUs: number): Promise<void> {
  const stepUs = 100_000;
  const steps = Math.round(timeUs / stepUs);
  const playhead = page.getByRole('slider', { name: 'Playhead' });
  await playhead.focus();
  await playhead.press('Home');
  for (let step = 0; step < steps; step += 1) await playhead.press('ArrowRight');
  await expect(playhead).toHaveAttribute('aria-valuenow', String(steps * stepUs));
}

async function dragPackagedClipBy(page: Page, clip: Locator, deltaX: number): Promise<void> {
  const bounds = await clip.boundingBox();
  expect(bounds).not.toBeNull();
  const startX = bounds!.x + Math.min(24, bounds!.width / 2);
  const centerY = bounds!.y + bounds!.height / 2;
  await page.mouse.move(startX, centerY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, centerY, { steps: 8 });
  await page.mouse.up();
}

function normalizedPcm16Rms(samples: Buffer): number {
  const sampleCount = Math.floor(samples.byteLength / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = samples.readInt16LE(index * 2) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

function pcm16ToneAmplitude(samples: Buffer, channel: 0 | 1, frequencyHz: number): number {
  const sampleRate = 48_000;
  const channelCount = 2;
  const frameCount = Math.min(sampleRate / 4, Math.floor(samples.byteLength / (channelCount * 2)));
  if (frameCount === 0) return 0;
  let real = 0;
  let imaginary = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = samples.readInt16LE((frame * channelCount + channel) * 2) / 32768;
    const phase = (2 * Math.PI * frequencyHz * frame) / sampleRate;
    real += sample * Math.cos(phase);
    imaginary -= sample * Math.sin(phase);
  }
  return (2 * Math.hypot(real, imaginary)) / frameCount;
}

function decodeMonitorPngToSquareRgb(image: Buffer): Buffer {
  return execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-vf',
      'scale=64:64:force_original_aspect_ratio=decrease,pad=64:64:(ow-iw)/2:(oh-ih)/2:color=black,format=rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { input: image, encoding: 'buffer', maxBuffer: 1_000_000 },
  );
}

function decodeExportFrameToSquareRgb(path: string, timeSeconds: number): Buffer {
  return execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      timeSeconds.toFixed(3),
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      'scale=64:64:force_original_aspect_ratio=decrease,pad=64:64:(ow-iw)/2:(oh-ih)/2:color=black,format=rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 1_000_000 },
  );
}

function normalizedRgbMeanAbsoluteDifference(left: Buffer, right: Buffer): number {
  expect(left.byteLength).toBe(64 * 64 * 3);
  expect(right.byteLength).toBe(left.byteLength);
  let absoluteDifference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    absoluteDifference += Math.abs(left[index]! - right[index]!);
  return absoluteDifference / (left.byteLength * 255);
}

const exportPresetAcceptanceCases = [
  { label: 'Social H.264', width: 1080, height: 1920 },
  { label: 'Reels 1080×1920', width: 1080, height: 1920 },
  { label: 'Shorts 1080×1920', width: 1080, height: 1920 },
  { label: 'YouTube 1920×1080', width: 1920, height: 1080 },
  { label: 'High bitrate', width: 1080, height: 1920 },
] as const;

async function createPackagedVideoProject(
  page: Page,
  projectTitle: string,
  mediaName: string,
): Promise<Locator> {
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
  const clip = page.locator(`.timeline-clip[aria-label^="${mediaName},"]`).first();
  await expect(clip).toBeVisible();
  return clip;
}

async function selectPackagedExportPreset(page: Page, label: string): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Export preset' });
  await trigger.click();
  const option = page.getByRole('region', { name: 'Export preset' }).getByRole('button', {
    name: label,
    exact: true,
  });
  await expect(option).toBeVisible();
  await option.click();
  await expect(trigger).toContainText(label);
}

async function openPackagedProcesses(page: Page): Promise<Locator> {
  const trigger = page.getByRole('button', { name: 'Recent processes' });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  const history = page.getByRole('region', { name: 'Recent processes' });
  await expect(history).toBeVisible();
  return history;
}

async function downloadPackagedExport(
  app: ElectronApplication,
  page: Page,
  downloadDirectory: string,
  download: Locator = page.getByRole('link', { name: /^Download .* again$/ }).first(),
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

function waitForPackagedDownload(app: ElectronApplication, filename: string): Promise<void> {
  return app.evaluate(
    ({ session }, expectedFilename) =>
      new Promise<void>((resolve, reject) => {
        const downloads = session.defaultSession;
        const timeout = setTimeout(() => {
          downloads.removeListener('will-download', onWillDownload);
          reject(new Error(`Timed out waiting for packaged download ${expectedFilename}.`));
        }, 30_000);
        const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
          if (item.getFilename() !== expectedFilename) return;
          item.once('done', (_doneEvent, state) => {
            clearTimeout(timeout);
            downloads.removeListener('will-download', onWillDownload);
            if (state !== 'completed') {
              reject(new Error(`Packaged download ${expectedFilename} ended in state ${state}.`));
              return;
            }
            resolve();
          });
        };
        downloads.on('will-download', onWillDownload);
      }),
    filename,
  );
}

function probePackagedExport(path: string): {
  readonly video: {
    readonly codec_name?: string;
    readonly width?: number;
    readonly height?: number;
  };
  readonly audio: { readonly codec_name?: string; readonly channels?: number };
  readonly duration: number;
} {
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], {
      encoding: 'utf8',
    }),
  ) as {
    readonly streams?: readonly {
      readonly codec_type?: string;
      readonly codec_name?: string;
      readonly width?: number;
      readonly height?: number;
      readonly channels?: number;
    }[];
    readonly format?: { readonly duration?: string };
  };
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  if (video === undefined || audio === undefined)
    throw new Error('packaged preset export must contain both video and audio streams');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-f',
    'null',
    '-',
  ]);
  return { video, audio, duration: Number(probe.format?.duration) };
}

test('packaged editor imports, plays, saves, restarts, and exports a playable project', async () => {
  const testInfo = test.info();
  test.setTimeout(360_000);
  const profile = mkdtempSync(join(tmpdir(), 'joy-media-desktop-acceptance-'));
  const downloadDirectory = join(profile, 'downloads');
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projectTitle = `Desktop acceptance ${suffix}`;
  const mediaName = `desktop-readiness-${suffix}.mp4`;
  const audioName = `desktop-readiness-stereo-${suffix}.wav`;
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
    await expectAccessiblePackagedEditor(page, 'packaged View menu open');
    await page.keyboard.press('Escape');
    await expect(viewMenu).toBeHidden();
    await expect(viewMenuButton).toBeFocused();

    for (const panel of [
      'Timeline',
      'Captions',
      'Text',
      'Audio',
      'Effects',
      'Motion',
      'Color',
      'Inspector',
      'Joy Code',
      'Workflows',
      'Plugins',
    ]) {
      await openPanel(page, panel);
      await expectAccessiblePackagedEditor(page, `packaged ${panel} panel`);
      if (panel === 'Workflows') {
        await page.getByRole('tab', { name: 'System', exact: true }).click();
        await expectAccessiblePackagedEditor(page, 'packaged system workflows panel');
      }
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

    await page.getByLabel('Monitor preview renderer').selectOption('local');
    await expect(page.locator('.monitor-preview-status')).toHaveText('Local');
    await seekPackagedPlayhead(page, 0);
    const monitorStart = await capturePackagedMonitorFrame(page);
    await seekPackagedPlayhead(page, 500_000);
    await expect
      .poll(() => capturePackagedMonitorFrame(page), {
        message: 'The packaged Monitor must repaint after seeking to 0.5 seconds.',
        timeout: 10_000,
      })
      .not.toBe(monitorStart);
    const monitorMiddle = await capturePackagedMonitorFrame(page);
    await seekPackagedPlayhead(page, 1_500_000);
    await expect
      .poll(() => capturePackagedMonitorFrame(page), {
        message: 'The packaged Monitor must repaint after seeking to 1.5 seconds.',
        timeout: 10_000,
      })
      .not.toBe(monitorMiddle);

    await seekPackagedPlayhead(page, 0);
    const playhead = page.getByRole('slider', { name: 'Playhead' });
    await page.locator('.monitor-transport').getByRole('button', { name: 'Play' }).click();
    await expect
      .poll(async () => Number(await playhead.getAttribute('aria-valuenow')), {
        message: 'The packaged Monitor transport must advance the playhead during playback.',
        timeout: 10_000,
      })
      .toBeGreaterThan(100_000);
    await page.locator('.monitor-transport').getByRole('button', { name: 'Pause' }).click();
    await seekPackagedPlayhead(page, 0);

    const originalClipLabel = await clip.getAttribute('aria-label');
    expect(originalClipLabel).toBeTruthy();
    await dragPackagedClipBy(page, clip, 6);
    await expect
      .poll(() => clip.getAttribute('aria-label'), { timeout: 10_000 })
      .not.toBe(originalClipLabel);
    const movedClipLabel = await clip.getAttribute('aria-label');
    const movedStartSeconds = Number(movedClipLabel?.match(/, ([\d.]+)s–/)?.[1]);
    expect(movedStartSeconds).toBeGreaterThan(0);
    const keyframeTimeUs = Math.ceil((movedStartSeconds * 1_000_000 + 100_000) / 100_000) * 100_000;
    await seekPackagedPlayhead(page, keyframeTimeUs);
    await expect(clip).toHaveAttribute('aria-current', 'true');
    const splitTool = page.getByRole('button', { name: 'Split tool' });
    await splitTool.click();
    await expect(splitTool).toHaveAttribute('aria-pressed', 'true');
    const clipBounds = await clip.boundingBox();
    expect(clipBounds).not.toBeNull();
    await page.mouse.click(
      clipBounds!.x + clipBounds!.width / 2,
      clipBounds!.y + clipBounds!.height / 2,
    );
    const videoClipsAfterSplit = page.locator(`.timeline-clip[aria-label^="${mediaName},"]`);
    await expect(videoClipsAfterSplit).toHaveCount(2);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(videoClipsAfterSplit).toHaveCount(1);
    await splitTool.click();
    await expect(splitTool).toHaveAttribute('aria-pressed', 'false');

    await openPanel(page, 'Text');
    const addCleanTitle = page.getByRole('button', { name: 'Add Clean Title' });
    await addCleanTitle.focus();
    await addCleanTitle.press('Enter');
    const authoredTitle = 'نسخهٔ آزمایشی | JOY Media — 2026';
    const titleEditor = page.getByRole('textbox', { name: 'Text content' });
    await titleEditor.focus();
    await titleEditor.press('Control+A');
    await titleEditor.pressSequentially(authoredTitle);
    await titleEditor.press('Tab');
    const textDirection = page.getByLabel('Direction', { exact: true });
    await textDirection.focus();
    await textDirection.press('End');
    await expect(titleEditor).toHaveValue(authoredTitle);
    await expect(textDirection).toHaveValue('rtl');
    await expect(page.getByRole('heading', { level: 3, name: 'Content' })).toBeVisible();
    for (const label of ['Size', 'Weight', 'Stroke width', 'Shadow blur', 'Opacity'])
      await expect(page.getByRole('slider', { name: label, exact: true })).toBeVisible();
    await expectAccessiblePackagedEditor(page, 'packaged Persian mixed-bidi title editor');
    const titleClipId = await page
      .locator('.timeline-clip[aria-current="true"]')
      .getAttribute('data-clip-id');
    expect(titleClipId).toBeTruthy();

    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(page.locator('.monitor-canvas canvas')).toBeVisible();
      await expectAccessiblePackagedEditor(
        page,
        `packaged editor at ${viewport.width}x${viewport.height}`,
      );
      await testInfo.attach(`packaged-editor-${viewport.width}x${viewport.height}.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    }

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
    const videoClips = page.locator(`.timeline-clip[aria-label^="${mediaName},"]`);
    await expect(videoClips).toHaveCount(2);

    // --- Effect and keyframe edit ---
    await videoClips.first().click();
    await openPanel(page, 'Effects');
    const addEffect = page.locator('.effect-add-btn:not([disabled])').first();
    await expect(addEffect).toBeEnabled();
    await addEffect.click();
    await openPanel(page, 'Inspector');
    const positionX = page.getByLabel('Position X', { exact: true });
    await positionX.fill('420');
    await expect(positionX).toHaveValue('420');
    await page.getByRole('button', { name: 'Add Position X keyframe' }).click();
    await expect(page.getByRole('button', { name: /Remove Position X keyframe/ })).toBeVisible();
    await page
      .getByRole('tablist', { name: 'Inspector sections' })
      .getByRole('tab', { name: 'Effects', exact: true })
      .click();
    await expect(page.locator('.inspector-effect-item[data-effect-instance-id]')).toHaveCount(1);

    // --- Transition across the adjacent duplicated clips ---
    const trackId = await videoClips
      .first()
      .evaluate((element) => element.closest('.timeline-lane')?.getAttribute('data-track-id'));
    expect(trackId).toBeTruthy();
    await openPanel(page, 'Transitions');
    await expectAccessiblePackagedEditor(page, 'packaged Transitions panel');
    const transitionFavorite = page.getByRole('button', { name: 'Add to favorites' }).first();
    await transitionFavorite.focus();
    await expect(transitionFavorite).toHaveCSS('opacity', '1');
    const transitionCard = page
      .getByRole('group', { name: 'Transition type' })
      .locator('.transition-card[data-transition-type]')
      .first();
    const transitionType = await transitionCard.getAttribute('data-transition-type');
    expect(transitionType).toBeTruthy();
    const lane = page.locator(`.timeline-lane[data-track-id="${trackId}"]`);
    const laneBounds = await lane.boundingBox();
    const firstClipBounds = await videoClips.first().boundingBox();
    expect(laneBounds).toBeTruthy();
    expect(firstClipBounds).toBeTruthy();
    await transitionCard.dragTo(lane, {
      targetPosition: {
        x: firstClipBounds!.x + firstClipBounds!.width - laneBounds!.x,
        y: laneBounds!.height / 2,
      },
    });
    await expect(page.locator('.timeline-transition-junction')).toHaveCount(1);
    await expectAccessiblePackagedEditor(page, 'packaged selected transition inspector');

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
      buffer: readFileSync(join(fixtureDirectory, 'readiness-stereo-tones.wav')),
    });
    await expect(audioImportDialog.getByText(audioName, { exact: true })).toBeVisible();
    await audioImportDialog.getByRole('button', { name: 'Confirm import' }).click();
    const audioCard = page.locator('.asset-card', { hasText: audioName }).first();
    await expect(audioCard).toBeVisible();
    await audioCard.getByRole('button', { name: `Add ${audioName} to timeline` }).click();
    const audioClip = page.locator(`.timeline-clip[aria-label^="${audioName},"]`);
    await expect(audioClip).toHaveCount(1);
    const audioClipLabel = await audioClip.getAttribute('aria-label');
    const audioClipStartSeconds = Number(audioClipLabel?.match(/, ([\d.]+)s–/)?.[1]);
    expect(Number.isFinite(audioClipStartSeconds)).toBe(true);

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
    await page.getByRole('tab', { name: 'Style', exact: true }).click();
    await expectAccessiblePackagedEditor(page, 'packaged Persian caption style panel');
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click();

    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), timelineLogKey),
    ).toBeNull();
    await app.close();
    const desktopDatabase = new DatabaseSync(join(profile, 'joy-media.sqlite3'));
    try {
      const persistedTimeline = desktopDatabase
        .prepare('SELECT value FROM editor_storage WHERE key = ?')
        .get(timelineLogKey) as { readonly value: string } | undefined;
      expect(persistedTimeline?.value).toContain(mediaName);
    } finally {
      desktopDatabase.close();
    }
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
    const restoredTitleClip = page.locator(`.timeline-clip[data-clip-id="${titleClipId}"]`);
    await expect(restoredTitleClip).toHaveCount(1);
    await restoredTitleClip.press('Enter');
    await openPanel(page, 'Text');
    await page.getByRole('tab', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Text content' })).toHaveValue(authoredTitle);
    await expect(page.getByLabel('Direction', { exact: true })).toHaveValue('rtl');
    // Assert audio clip survived
    const restoredAudioClip = page.locator(`.timeline-clip[aria-label^="${audioName},"]`);
    await expect(restoredAudioClip).toHaveCount(1);
    await expect(page.locator('.timeline-transition-junction')).toHaveCount(1);
    const restoredFirstVideo = restoredVideoClips.first();
    await seekPackagedPlayhead(page, keyframeTimeUs);
    await restoredFirstVideo.press('Enter');
    await expect(restoredFirstVideo).toHaveAttribute('aria-current', 'true');
    await openPanel(page, 'Inspector');
    await expect(page.getByRole('button', { name: /Remove Position X keyframe/ })).toBeVisible();
    await page
      .getByRole('tablist', { name: 'Inspector sections' })
      .getByRole('tab', { name: 'Effects', exact: true })
      .click();
    await expect(page.locator('.inspector-effect-item[data-effect-instance-id]')).toHaveCount(1);
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
    const exported = await downloadPackagedExport(app, page, downloadDirectory, redownload);
    expect(exported.filename).toBe(exportFilename);
    const exportedPath = exported.path;
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', exportedPath!],
        { encoding: 'utf8' },
      ),
    ) as {
      readonly streams?: readonly {
        readonly codec_type?: string;
        readonly codec_name?: string;
        readonly channels?: number;
      }[];
      readonly format?: { readonly duration?: string };
    };
    expect(probe.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codec_type: 'video', codec_name: 'h264' }),
        expect.objectContaining({ codec_type: 'audio', codec_name: 'aac' }),
      ]),
    );
    expect(Number(probe.format?.duration)).toBeGreaterThan(0);
    const audioOnsetSampleSeconds = audioClipStartSeconds + 0.1;
    const decodedAudio = execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        audioOnsetSampleSeconds.toFixed(3),
        '-i',
        exportedPath,
        '-map',
        '0:a:0',
        '-t',
        '0.25',
        '-ac',
        '2',
        '-ar',
        '48000',
        '-f',
        's16le',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 1_000_000 },
    );
    const audioOnsetRms = normalizedPcm16Rms(decodedAudio);
    expect(
      audioOnsetRms,
      `the decoded export must contain audible audio just after the audio clip starts at ${audioClipStartSeconds}s`,
    ).toBeGreaterThan(0.02);
    const left440Amplitude = pcm16ToneAmplitude(decodedAudio, 0, 440);
    const right880Amplitude = pcm16ToneAmplitude(decodedAudio, 1, 880);
    expect(
      left440Amplitude,
      'the fixture audio clip must mix its 440 Hz left channel',
    ).toBeGreaterThan(0.1);
    expect(
      right880Amplitude,
      'the fixture audio clip must mix its distinct 880 Hz right channel',
    ).toBeGreaterThan(0.1);
    result = {
      projectTitle,
      mediaName,
      exportBytes: readFileSync(exportedPath).byteLength,
      savedPath: exportFilename,
      exportFilename,
      ffprobe: probe,
      audioClipStartSeconds,
      audioOnsetSampleSeconds,
      audioOnsetRms,
      left440Amplitude,
      right880Amplitude,
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

test('packaged Social H.264 export remains retryable after cancellation', async () => {
  test.setTimeout(360_000);
  const profile = mkdtempSync(join(tmpdir(), 'joy-media-social-retry-'));
  const downloadDirectory = join(profile, 'downloads');
  const mediaName = 'social-retry-fixture.mp4';
  let app: ElectronApplication | undefined;

  try {
    app = await launchPackagedEditor(profile);
    const page = await openEditorPage(app);
    const clip = await createPackagedVideoProject(page, 'Social H.264 retry', mediaName);
    await selectPackagedExportPreset(page, 'Social H.264');
    let history = await openPackagedProcesses(page);
    const completed = history.locator('.process-row.process-completed');
    const completedBefore = await completed.count();

    await page.getByRole('button', { name: 'Export MP4' }).click();
    await expect(page.getByRole('button', { name: 'Cancel export' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel export' }).click();
    await expect(
      page.getByText('Export cancelled. You can retry from Recent processes.'),
    ).toBeVisible();

    history = await openPackagedProcesses(page);
    const interrupted = history.locator('.process-row.process-interrupted-retryable');
    await expect(interrupted).toHaveCount(1);
    const retryName = await interrupted.locator('.process-name').textContent();
    expect(retryName).toMatch(/\.mp4$/i);
    const retryRow = history.locator('.process-row', { hasText: retryName! });
    await interrupted.getByRole('button', { name: `Retry ${retryName}` }).click();
    await expect(retryRow).toHaveClass(/process-running/, { timeout: 30_000 });

    await expect(completed).toHaveCount(completedBefore + 1, { timeout: 120_000 });
    await expect(completed).toContainText('Completed — final MP4 verified');
    await expect(clip).toBeVisible();
    const exported = await downloadPackagedExport(app, page, downloadDirectory);
    const probe = probePackagedExport(exported.path);
    expect(probe.video).toMatchObject({ codec_name: 'h264', width: 1080, height: 1920 });
    expect(probe.audio.codec_name).toBe('aac');
    expect(probe.duration).toBeGreaterThan(0);
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('packaged exports encode every supported preset at its declared dimensions', async () => {
  test.setTimeout(360_000);
  const testInfo = test.info();
  const profile = mkdtempSync(join(tmpdir(), 'joy-media-preset-matrix-'));
  const downloadDirectory = join(profile, 'downloads');
  const mediaName = 'preset-matrix-fixture.mp4';
  let app: ElectronApplication | undefined;
  const outputs: Array<{
    readonly preset: string;
    readonly filename: string;
    readonly bytes: number;
    readonly width?: number;
    readonly height?: number;
    readonly duration: number;
  }> = [];

  try {
    app = await launchPackagedEditor(profile);
    const page = await openEditorPage(app);
    await createPackagedVideoProject(page, 'Packaged preset matrix', mediaName);

    for (const preset of exportPresetAcceptanceCases) {
      await selectPackagedExportPreset(page, preset.label);
      const history = await openPackagedProcesses(page);
      const completed = history.locator('.process-row.process-completed');
      const completedBefore = await completed.count();
      await page.getByRole('button', { name: 'Export MP4' }).click();
      await expect
        .poll(() => completed.count(), {
          message: `${preset.label} must produce a completed export`,
          timeout: 240_000,
        })
        .toBe(completedBefore + 1);
      await expect(history).toContainText('Completed — final MP4 verified');

      const exported = await downloadPackagedExport(app, page, downloadDirectory);
      const probe = probePackagedExport(exported.path);
      expect(probe.video, `${preset.label} video output`).toMatchObject({
        codec_name: 'h264',
        width: preset.width,
        height: preset.height,
      });
      expect(probe.audio.codec_name, `${preset.label} audio codec`).toBe('aac');
      expect(probe.duration, `${preset.label} duration`).toBeGreaterThan(0);
      outputs.push({
        preset: preset.label,
        filename: exported.filename,
        bytes: readFileSync(exported.path).byteLength,
        width: probe.video.width,
        height: probe.video.height,
        duration: probe.duration,
      });
    }

    await testInfo.attach('packaged-export-preset-matrix.json', {
      body: Buffer.from(`${JSON.stringify(outputs, null, 2)}\n`),
      contentType: 'application/json',
    });
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('packaged editor remains accessible at 150% display scaling', async () => {
  const testInfo = test.info();
  const profile = mkdtempSync(join(tmpdir(), 'joy-media-desktop-dpi-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchPackagedEditor(profile, 1.5);
    const page = await openEditorPage(app);
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(1.5);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByPlaceholder('Project name').fill('Packaged DPI acceptance');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Packaged DPI acceptance');
    await expectAccessiblePackagedEditor(page, 'packaged editor at 150% display scaling');
    await testInfo.attach('packaged-editor-150-percent-display-scale.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('packaged Monitor samples agree with decoded export frames', async () => {
  const testInfo = test.info();
  test.setTimeout(360_000);
  const profile = mkdtempSync(join(tmpdir(), 'joy-media-desktop-parity-'));
  const downloadDirectory = join(profile, 'downloads');
  const mediaName = 'monitor-parity-video.mp4';
  let app: ElectronApplication | undefined;
  const sampleTimes = [500_000, 1_500_000] as const;

  try {
    app = await launchPackagedEditor(profile);
    const page = await openEditorPage(app);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByPlaceholder('Project name').fill('Packaged preview parity');
    await page.getByRole('button', { name: 'Create project' }).click();
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
    const videoClip = page.locator(`.timeline-clip[aria-label^="${mediaName},"]`).first();
    await expect(videoClip).toBeVisible();
    await videoClip.click();
    await page.getByLabel('Monitor preview renderer').selectOption('local');
    await expect(page.locator('.monitor-preview-status')).toHaveText('Local');
    await seekPackagedPlayhead(page, 500_000);
    const frameBeforeScene = await capturePackagedMonitorFrame(page);
    await openPanel(page, 'Motion');
    const motionPanel = page.locator('.motion-panel');
    await motionPanel.getByRole('tab', { name: 'Scenes' }).click();
    const sceneRemovals = motionPanel.locator('button[aria-label^="Remove HTML scene "]');
    const sceneCountBefore = await sceneRemovals.count();
    const addScene = motionPanel.getByRole('button', { name: /^Add .+ to selected clip$/ }).first();
    const addedSceneLabel = (await addScene.getAttribute('aria-label'))?.replace(
      /^Add (.+) to selected clip$/,
      '$1',
    );
    expect(addedSceneLabel).toBeTruthy();
    await addScene.click();
    await expect(sceneRemovals).toHaveCount(sceneCountBefore + 1);
    await expect
      .poll(() => capturePackagedMonitorFrame(page), {
        message: 'Adding an HTML scene to the packaged project must change Monitor pixels.',
        // One HTML scene capture can use the renderer's full 15-second budget.
        timeout: 30_000,
      })
      .not.toBe(frameBeforeScene);
    await seekPackagedPlayhead(page, 0);
    let previousFrame = await capturePackagedMonitorFrame(page);
    const monitorSamples: Buffer[] = [];
    for (const sampleTime of sampleTimes) {
      await seekPackagedPlayhead(page, sampleTime);
      await expect
        .poll(() => capturePackagedMonitorFrame(page), {
          message: `The packaged Monitor must repaint at ${sampleTime / 1_000_000}s.`,
          timeout: 10_000,
        })
        .not.toBe(previousFrame);
      previousFrame = await capturePackagedMonitorFrame(page);
      monitorSamples.push(
        await page.locator('.monitor-canvas canvas').first().screenshot({ animations: 'disabled' }),
      );
    }

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
    const exported = await downloadPackagedExport(app, page, downloadDirectory, redownload);
    expect(exported.filename).toBe(exportFilename);
    const exportedPath = exported.path;

    const differences = sampleTimes.map((sampleTime, index) =>
      normalizedRgbMeanAbsoluteDifference(
        decodeMonitorPngToSquareRgb(monitorSamples[index]!),
        decodeExportFrameToSquareRgb(exportedPath, sampleTime / 1_000_000),
      ),
    );
    for (const [index, difference] of differences.entries())
      expect(
        difference,
        `preview/export normalized pixel difference at ${sampleTimes[index]! / 1_000_000}s`,
      ).toBeLessThan(0.2);

    await testInfo.attach('monitor-preview-samples-vs-export.json', {
      body: Buffer.from(
        JSON.stringify({ sampleTimes, normalizedMeanAbsoluteDifferences: differences }, null, 2),
      ),
      contentType: 'application/json',
    });
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
