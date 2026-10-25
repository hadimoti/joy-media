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

// L6 keyboard coverage on the packaged app. Every global shortcut action in SHORTCUT_ACTIONS is pressed
// here and checked against the editor state it changes: the timecode, the play button, the clip count and
// the open overlays. The step names carry the action id, which the coverage ledger cites.

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const fixtureDirectory = resolve('packages/test-fixtures/media');
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;
const installedExecutable = process.env.JOY_MEDIA_TEST_EXECUTABLE;

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

/**
 * Presses one key the way a user does after clicking the editor: a focused button or field owns Space and
 * the arrows, so the focus is released first. Clicking a timeline clip does not take that ownership.
 */
async function pressKey(page: Page, key: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(key);
}

/** The timeline timecode, in seconds, from the `m:ss.cc` text the editor shows. */
async function timecodeSeconds(page: Page): Promise<number> {
  const text = ((await page.locator('.timeline-timecode').textContent()) ?? '').trim();
  const match = /^(\d+):(\d{2}\.\d{2})$/u.exec(text);
  if (match === null) throw new Error(`Unexpected timeline timecode "${text}"`);
  return Number(match[1]) * 60 + Number(match[2]);
}

async function expectTimecode(page: Page, seconds: number): Promise<void> {
  await expect.poll(() => timecodeSeconds(page)).toBeCloseTo(seconds, 2);
}

test.describe('desktop.keyboard-shortcuts', () => {
  test('global shortcuts drive playback, the playhead, clips, history, the palette and the shortcut sheet', async () => {
    test.setTimeout(360_000);
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const mediaName = `keys-clip-${suffix}.mp4`;
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-keyboard-'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchPackagedEditor(profile);
      const page = await openEditorPage(app);
      await createProject(page, `Keyboard${suffix}`);
      const clips = page.locator(`.timeline-clip[aria-label^="${mediaName},"]`);
      await addClip(page, mediaName);
      await expect(clips).toHaveCount(1);
      await openPanel(page, 'Timeline');
      await expectTimecode(page, 0);

      let endSeconds = 0;
      await test.step('playhead.forward: ArrowRight moves the playhead one second', async () => {
        await pressKey(page, 'ArrowRight');
        await expectTimecode(page, 1);
      });
      await test.step('playhead.back: ArrowLeft moves it back one second', async () => {
        await pressKey(page, 'ArrowLeft');
        await expectTimecode(page, 0);
      });
      await test.step('playhead.forwardFine: Shift+ArrowRight moves it 0.1 s', async () => {
        await pressKey(page, 'Shift+ArrowRight');
        await expectTimecode(page, 0.1);
      });
      await test.step('playhead.backFine: Shift+ArrowLeft moves it back 0.1 s', async () => {
        await pressKey(page, 'Shift+ArrowLeft');
        await expectTimecode(page, 0);
      });
      await test.step('playhead.end: End moves the playhead to the end of the timeline', async () => {
        await pressKey(page, 'End');
        endSeconds = await timecodeSeconds(page);
        expect(endSeconds, 'the fixture clip must give the timeline a duration').toBeGreaterThan(2);
      });
      await test.step('playhead.start: Home returns the playhead to zero', async () => {
        await pressKey(page, 'Home');
        await expectTimecode(page, 0);
      });
      await test.step('playback.toggle: Space starts and stops playback', async () => {
        const playButton = page.locator('.timeline-panel button[aria-label="Play"]').first();
        await expect(playButton).toBeVisible();
        await pressKey(page, ' ');
        await expect(
          page.locator('.timeline-panel button[aria-label="Pause"]').first(),
        ).toBeVisible();
        await expect.poll(() => timecodeSeconds(page)).toBeGreaterThan(0);
        await pressKey(page, ' ');
        await expect(playButton).toBeVisible();
        const stopped = await timecodeSeconds(page);
        await page.waitForTimeout(700);
        expect(await timecodeSeconds(page), 'playback must stop at Space').toBeCloseTo(stopped, 2);
        await pressKey(page, 'Home');
        await expectTimecode(page, 0);
      });

      await test.step('clip.split: S splits the selected clip at the playhead', async () => {
        await selectFirstTimelineClip(page);
        await pressKey(page, 'ArrowRight');
        await expectTimecode(page, 1);
        await pressKey(page, 's');
        await expect(clips).toHaveCount(2);
        await pressKey(page, 'Home');
        await expectTimecode(page, 0);
      });
      await test.step('clip.delete: Delete removes the selected clip', async () => {
        await selectFirstTimelineClip(page);
        await pressKey(page, 'Delete');
        await expect(clips).toHaveCount(1);
      });
      await test.step('history.undo: Ctrl+Z restores the deleted clip', async () => {
        await pressKey(page, 'Control+z');
        await expect(clips).toHaveCount(2);
      });
      await test.step('history.redo: Ctrl+Y deletes it again', async () => {
        await pressKey(page, 'Control+y');
        await expect(clips).toHaveCount(1);
      });
      await test.step('clip.delete: Backspace also deletes the selected clip', async () => {
        await selectFirstTimelineClip(page);
        await pressKey(page, 'Backspace');
        await expect(clips).toHaveCount(0);
        await pressKey(page, 'Control+z');
        await expect(clips).toHaveCount(1);
      });
      await test.step('clip.duplicate: Ctrl+D duplicates the selected clip', async () => {
        await selectFirstTimelineClip(page);
        await pressKey(page, 'Control+d');
        await expect(clips).toHaveCount(2);
        await pressKey(page, 'Control+z');
        await expect(clips).toHaveCount(1);
        await selectFirstTimelineClip(page);
        await pressKey(page, 'Control+d');
        await expect(clips).toHaveCount(2);
      });

      await test.step('palette.toggle: Ctrl+K opens the command palette', async () => {
        await pressKey(page, 'Control+k');
        const palette = page.locator('section.palette');
        await expect(palette).toBeVisible();
        await expect(palette.getByPlaceholder('Search commands')).toBeFocused();
      });
      await test.step('palette.close: Escape closes the palette while its search field has focus', async () => {
        await page.keyboard.press('Escape');
        await expect(page.locator('section.palette')).toBeHidden();
      });

      await test.step('shortcuts.toggle: ? opens the keyboard shortcut sheet and ? closes it', async () => {
        const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
        await pressKey(page, '?');
        await expect(sheet).toBeVisible();
        await pressKey(page, '?');
        await expect(sheet).toBeHidden();
      });
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
