import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  configureJoyAgent,
  installFakeOpenAIProvider,
} from '../e2e/fixtures/fake-openai-provider.js';
import { authenticate, openPanel, selectFirstTimelineClip } from '../e2e/wp29-r5-harness.js';

// The same fixture proposal the browser lifecycle spec stages: a title and an opacity keyframe.
const STAGED_PROPOSAL = {
  summary: 'Create and animate a title',
  operations: [
    {
      id: 'title',
      dependsOn: [],
      kind: 'text.insertTemplate',
      templateId: 'clean-title',
      content: 'Menu stop fixture title',
      startUs: 0,
      durationUs: 1_000_000,
      placementPreset: 'center',
      outputRef: { kind: 'visual-object', ref: 'title-output' },
    },
    {
      id: 'animate',
      dependsOn: ['title'],
      kind: 'motion.setKeyframe',
      binding: {
        ownerKind: 'visual-object',
        ownerRef: { kind: 'visual-object', ref: 'title-output' },
        propertyId: 'opacity',
        timeDomain: 'composition',
      },
      key: { kind: 'scalar', timeUs: 500_000, value: 0.5, interpolation: 'linear' },
    },
  ],
} as const;

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

/**
 * Opens an application menu and clicks one item. An item's accessible name can carry its shortcut hint
 * (for example "Minimize Ctrl+M"), so the label matches with an optional hint after it. `exact` is for a
 * label that another item starts with, such as "Export" and "Export Editable Project…".
 */
async function clickAppMenuItem(
  page: Page,
  menu: string,
  label: string,
  options: { readonly exact?: boolean } = {},
): Promise<void> {
  const bar = page.getByRole('navigation', { name: 'Application menu' });
  await bar.getByRole('button', { name: menu, exact: true }).click();
  const item =
    options.exact === true
      ? page.getByRole('menu').getByRole('menuitem', { name: label, exact: true })
      : page
          .getByRole('menu')
          .getByRole('menuitem', { name: new RegExp(`^${escapeForRegExp(label)}(\\s|$)`, 'u') });
  await expect(item).toBeVisible();
  await expect(item).toBeEnabled();
  await item.click();
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
}

/** Resolves once Electron saves a download with this name in the packaged profile. */
function waitForPackagedDownload(app: ElectronApplication, filename: string): Promise<void> {
  return app.evaluate(
    ({ session }, expectedFilename) =>
      new Promise<void>((resolveDownload, rejectDownload) => {
        const downloads = session.defaultSession;
        const timeout = setTimeout(() => {
          downloads.removeListener('will-download', onWillDownload);
          rejectDownload(new Error(`Timed out waiting for packaged download ${expectedFilename}.`));
        }, 60_000);
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

const windowMinimized = (electronApp: ElectronApplication) =>
  electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((win) => win.isMinimized()),
  );

const windowMaximized = (electronApp: ElectronApplication) =>
  electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((win) => win.isMaximized()),
  );

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

  test('file export from the File menu renders an MP4 that ffprobe accepts', async () => {
    test.setTimeout(600_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const mediaName = `menu-export-${suffix}.mp4`;
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-menu-export-'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createProject(page, `MenuExport${suffix}`);
      await addClip(page, mediaName);
      await expect(page.locator(`.timeline-clip[aria-label^="${mediaName},"]`)).toHaveCount(1);

      await clickAppMenuItem(page, 'File', 'Export', { exact: true });
      const recentProcesses = page.getByRole('button', { name: 'Recent processes' });
      if ((await recentProcesses.getAttribute('aria-expanded')) !== 'true')
        await recentProcesses.click();
      const processHistory = page.getByRole('region', { name: 'Recent processes' });
      await expect(processHistory).toContainText(/Completed — final MP4 verified|Failed —/u, {
        timeout: 480_000,
      });
      await expect(processHistory, 'File > Export must render to a verified MP4').toContainText(
        'Completed — final MP4 verified',
      );

      const redownload = page.getByRole('link', { name: /Download .* again/ }).first();
      await expect(redownload).toBeVisible();
      const filename = await redownload.getAttribute('download');
      expect(filename).toMatch(/\.mp4$/iu);
      const downloadFinished = waitForPackagedDownload(app, filename!);
      await redownload.click();
      await downloadFinished;
      const path = join(profile, 'downloads', filename!);
      await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(true);

      const probe = JSON.parse(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
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
      expect(video?.width, 'the exported MP4 has a video width').toBeGreaterThan(0);
      expect(video?.height, 'the exported MP4 has a video height').toBeGreaterThan(0);
      expect(probe.format?.format_name, 'the exported file is an MP4 container').toMatch(/mp4/u);
      expect(Number(probe.format?.duration), 'the exported MP4 has a duration').toBeGreaterThan(0);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('clip split from the Clip menu cuts the selected clip at the playhead', async () => {
    test.setTimeout(360_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const mediaName = `menu-split-${suffix}.mp4`;
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-menu-split-'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createProject(page, `MenuSplit${suffix}`);
      const clips = page.locator(`.timeline-clip[aria-label^="${mediaName},"]`);
      await addClip(page, mediaName);
      await expect(clips).toHaveCount(1);
      await selectFirstTimelineClip(page);
      // The playhead must sit inside the clip. The keyboard moves it one second, which the timecode confirms.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('.timeline-timecode')).toHaveText('0:01.00');

      await clickAppMenuItem(page, 'Clip', 'Split at Playhead');
      await expect(clips).toHaveCount(2);
      await expect(page.locator(`.timeline-clip[aria-label*="0.0s–1.0s"]`)).toHaveCount(1);
      await expect(page.locator(`.timeline-clip[aria-label*="1.0s–"]`)).toHaveCount(1);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('Joy Code menu opens the execution policy and the model settings', async () => {
    test.setTimeout(360_000);
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-menu-agent-'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createProject(page, `MenuAgent${Date.now()}`);
      const settings = page.getByRole('dialog', { name: 'Joy Code Settings' });
      const modelsOnly = settings.getByRole('button', { name: 'Browse models & API connections' });

      await clickMenuItem(page, 'Joy Code', 'Execution Mode…');
      await expect(settings).toBeVisible();
      await expect(
        settings.getByText('Execution Policy & Run Budgets', { exact: true }),
      ).toBeVisible();
      await expect(
        modelsOnly,
        'Execution Mode must open the execution tab, not the models tab',
      ).toHaveCount(0);
      await settings.getByRole('button', { name: 'Close settings' }).click();
      await expect(settings).toBeHidden();

      await clickMenuItem(page, 'Joy Code', 'Joy Code Settings…');
      await expect(settings).toBeVisible();
      await expect(modelsOnly).toBeVisible();
      await expect(
        settings.getByText('Execution Policy & Run Budgets', { exact: true }),
      ).toHaveCount(0);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('Joy Code menu stops a staged run and clears its proposal', async () => {
    test.setTimeout(480_000);
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-menu-stop-'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createProject(page, `MenuStop${Date.now()}`);
      await clickMenuItem(page, 'Joy Code', 'Open Joy Code');
      await expect(page.locator('.joy-code-panel')).toBeVisible();

      // The fixture provider answers the next request with the staged proposal, so the run waits for approval.
      await installFakeOpenAIProvider(page, { proposal: STAGED_PROPOSAL });
      const dialog = await configureJoyAgent(page, 'JOY_MENU_STOP_FIXTURE_KEY');
      await dialog.getByRole('button', { name: 'Done' }).click();

      const composer = page.getByLabel('Message Joy Code');
      await composer.fill('Create a title and animate its opacity.');
      await composer.press('Enter');
      const proposal = page.getByRole('region', { name: 'JOY Agent live proposal' });
      await expect(proposal).toBeVisible({ timeout: 60_000 });
      await expect(proposal).toHaveAttribute('data-agent-preview-ready', 'true', {
        timeout: 60_000,
      });

      await clickAppMenuItem(page, 'Joy Code', 'Pause / Stop');
      await expect(proposal, 'Pause / Stop must withdraw the staged proposal').toHaveCount(0);
      await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Joy Code composer' })).toHaveAttribute(
        'data-agent-phase',
        'cancelled',
      );
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('window menu minimizes the host window, then zooms it on and off', async () => {
    test.setTimeout(360_000);
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-menu-window-'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createProject(page, `MenuWindow${Date.now()}`);

      await clickAppMenuItem(page, 'Window', 'Minimize');
      await expect.poll(() => windowMinimized(app!)).toBe(true);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((win) => win.restore()),
      );
      await expect.poll(() => windowMinimized(app!)).toBe(false);

      await clickAppMenuItem(page, 'Window', 'Zoom / Maximize');
      await expect.poll(() => windowMaximized(app!)).toBe(true);
      await clickAppMenuItem(page, 'Window', 'Zoom / Maximize');
      await expect.poll(() => windowMaximized(app!)).toBe(false);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('window menu close closes the host window and ends the app', async () => {
    test.setTimeout(360_000);
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-menu-close-'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createProject(page, `MenuClose${Date.now()}`);
      const windowCount = () =>
        app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      await expect.poll(windowCount).toBeGreaterThan(0);

      await clickAppMenuItem(page, 'Window', 'Close Window');
      await expect.poll(windowCount, { timeout: 30_000 }).toBe(0);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
