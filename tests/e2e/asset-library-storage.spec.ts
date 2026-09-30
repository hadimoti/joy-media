import { expect, test } from '@playwright/test';
import { authenticate, openDisposableWorkspace, openPanel } from './wp29-r5-harness.js';
import { assertBrowserAudit, setupBrowserAudit } from './helpers/browser-console-audit.js';

test.beforeEach(({ page }) => {
  setupBrowserAudit(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await assertBrowserAudit(page, testInfo);
});

test('an upgraded install can reselect its previous library and restore its catalog', async ({
  page,
}) => {
  await authenticate(page);
  await openDisposableWorkspace(page, `Storage upgrade ${Date.now()}`);

  await page.evaluate(() => {
    type LibrarySettings = {
      directory: string;
      exists: boolean;
      hasCatalog: boolean;
      isDefault: boolean;
      counts: { total: number; audio: number; image: number };
    };
    const desktopWindow = window as Window & {
      __JOY_MEDIA_API_BASE__?: string;
      __JOY_ASSET_UPGRADE_FIXTURE__?: {
        readonly fileNames: readonly string[];
        selectedDirectory?: string;
      };
      joyDesktop?: {
        channels: readonly string[];
        invoke: (channel: string, args?: unknown) => Promise<unknown>;
      };
    };
    desktopWindow.__JOY_MEDIA_API_BASE__ = '/api';
    const missingDefault: LibrarySettings = {
      directory: 'fixture-assets/new-default',
      exists: false,
      hasCatalog: false,
      isDefault: true,
      counts: { total: 0, audio: 0, image: 0 },
    };
    const previousLibrary: LibrarySettings = {
      directory: 'fixture-assets/previous-library',
      exists: true,
      hasCatalog: true,
      isDefault: false,
      counts: { total: 2, audio: 1, image: 1 },
    };
    let currentSettings = missingDefault;
    desktopWindow.__JOY_ASSET_UPGRADE_FIXTURE__ = {
      fileNames: ['audio/ambience.wav', 'images/cover.png'],
    };
    desktopWindow.joyDesktop = {
      channels: [
        'desktop.asset-library.get-settings',
        'desktop.asset-library.select-directory',
        'desktop.asset-library.get-catalog',
      ],
      async invoke(channel) {
        if (channel === 'desktop.asset-library.get-settings') return currentSettings;
        if (channel === 'desktop.asset-library.select-directory') {
          currentSettings = previousLibrary;
          desktopWindow.__JOY_ASSET_UPGRADE_FIXTURE__!.selectedDirectory =
            previousLibrary.directory;
          return currentSettings;
        }
        if (channel === 'desktop.asset-library.get-catalog') {
          return {
            version: 1,
            counts: { total: 2, audio: 1, image: 1 },
            assets: [
              {
                id: 'fixture-audio',
                projectId: 'fixture-project',
                kind: 'audio',
                displayName: 'ambience.wav',
                sha256: 'a'.repeat(64),
                bytes: 4,
                descriptor: { mimeType: 'audio/wav' },
                createdAt: 1,
                cloudBacked: false,
                relativePath: 'audio/ambience.wav',
              },
              {
                id: 'fixture-image',
                projectId: 'fixture-project',
                kind: 'image',
                displayName: 'cover.png',
                sha256: 'b'.repeat(64),
                bytes: 4,
                descriptor: { mimeType: 'image/png' },
                createdAt: 2,
                cloudBacked: false,
                relativePath: 'images/cover.png',
              },
            ],
          };
        }
        return null;
      },
    };
  });

  await openPanel(page, 'Text');
  await openPanel(page, 'Assets');
  await page.getByRole('button', { name: 'Asset Library Folder Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Asset Library Storage' });
  await expect(dialog.locator('[role="note"]')).toContainText('previous Asset Library is missing');
  await expect(dialog.locator('.asset-library-storage-chip.is-incomplete')).toBeVisible();

  await dialog.getByRole('button', { name: 'Change Folder…' }).click();

  await expect(dialog.locator('.asset-library-storage-path-input')).toHaveValue(
    'fixture-assets/previous-library',
  );
  await expect(dialog.locator('[role="note"]')).toHaveCount(0);
  await expect(dialog.locator('.asset-library-storage-chip.is-ready')).toContainText(
    'Connected & Ready',
  );
  await expect(dialog.locator('.asset-library-storage-count-value')).toHaveText(['2', '1', '1']);
  await expect
    .poll(() => page.evaluate(() => window.__JOY_ASSET_UPGRADE_FIXTURE__?.selectedDirectory))
    .toBe('fixture-assets/previous-library');
  expect(await page.evaluate(() => window.__JOY_ASSET_UPGRADE_FIXTURE__?.fileNames)).toEqual([
    'audio/ambience.wav',
    'images/cover.png',
  ]);
});

test('returns keyboard focus to the folder action after picker cancellation', async ({ page }) => {
  await authenticate(page);
  await openDisposableWorkspace(page, `Storage picker focus ${Date.now()}`);

  await page.evaluate(() => {
    type LibrarySettings = {
      directory: string;
      exists: boolean;
      hasCatalog: boolean;
      isDefault: boolean;
      counts: { total: number; audio: number; image: number };
    };
    type FocusFixture = { resolveSelection?: () => void };
    const desktopWindow = window as Window & {
      __JOY_MEDIA_API_BASE__?: string;
      __ASSET_STORAGE_FOCUS_FIXTURE__?: FocusFixture;
      joyDesktop?: {
        channels: readonly string[];
        invoke: (channel: string, args?: unknown) => Promise<unknown>;
      };
    };
    const currentSettings: LibrarySettings = {
      directory: 'fixture-assets/asset-library',
      exists: true,
      hasCatalog: true,
      isDefault: true,
      counts: { total: 12, audio: 7, image: 5 },
    };
    const fixture: FocusFixture = {};
    desktopWindow.__JOY_MEDIA_API_BASE__ = '/api';
    desktopWindow.__ASSET_STORAGE_FOCUS_FIXTURE__ = fixture;
    desktopWindow.joyDesktop = {
      channels: ['desktop.asset-library.get-settings', 'desktop.asset-library.select-directory'],
      async invoke(channel) {
        if (channel === 'desktop.asset-library.get-settings') return currentSettings;
        if (channel === 'desktop.asset-library.select-directory') {
          return new Promise<LibrarySettings | null>((resolve) => {
            fixture.resolveSelection = () => resolve(null);
          });
        }
        return null;
      },
    };
  });

  await openPanel(page, 'Text');
  await openPanel(page, 'Assets');
  await page.getByRole('button', { name: 'Asset Library Folder Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Asset Library Storage' });
  const picker = dialog.getByRole('button', { name: 'Change Folder…' });
  await picker.focus();
  await expect(picker).toBeFocused();

  await picker.click();
  await expect(picker).toBeDisabled();
  await page.evaluate(() => {
    const fixture = (
      window as Window & {
        __ASSET_STORAGE_FOCUS_FIXTURE__?: { resolveSelection?: () => void };
      }
    ).__ASSET_STORAGE_FOCUS_FIXTURE__;
    fixture?.resolveSelection?.();
  });

  await expect(picker).toBeEnabled();
  await expect(picker).toBeFocused();
});

test('Asset Library Storage reflows path controls and inspection cards at narrow widths', async ({
  page,
}) => {
  await authenticate(page);
  await openDisposableWorkspace(page, `Storage layout ${Date.now()}`);

  await page.evaluate(() => {
    const desktopWindow = window as Window & {
      __JOY_MEDIA_API_BASE__?: string;
      joyDesktop?: {
        channels: readonly string[];
        invoke: (channel: string, args?: unknown) => Promise<unknown>;
      };
    };
    desktopWindow.__JOY_MEDIA_API_BASE__ = '/api';
    const connectedSettings = {
      directory: 'fixture-assets/asset-library',
      exists: true,
      hasCatalog: true,
      isDefault: true,
      counts: { total: 12, audio: 7, image: 5 },
    };
    desktopWindow.joyDesktop = {
      channels: [
        'desktop.asset-library.get-settings',
        'desktop.asset-library.set-directory',
        'desktop.asset-library.select-directory',
      ],
      async invoke(channel) {
        return channel === 'desktop.asset-library.get-settings' ? connectedSettings : null;
      },
    };
  });

  await openPanel(page, 'Text');
  await openPanel(page, 'Assets');
  await page.getByRole('button', { name: 'Asset Library Folder Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Asset Library Storage' });
  await expect(dialog).toBeVisible();

  await page.setViewportSize({ width: 560, height: 800 });
  const pathInput = dialog.locator('.asset-library-storage-path-input');
  const pickerButton = dialog.getByRole('button', { name: 'Change Folder…' });
  const inputBounds = await pathInput.boundingBox();
  const pickerBounds = await pickerButton.boundingBox();
  expect(inputBounds).not.toBeNull();
  expect(pickerBounds).not.toBeNull();
  expect(pickerBounds!.y).toBeGreaterThan(inputBounds!.y);
  expect(
    await dialog
      .locator('.asset-library-storage-actions')
      .evaluate((element) => getComputedStyle(element).flexWrap),
  ).toBe('wrap');
  expect(
    await dialog
      .locator('.asset-library-storage-count-grid')
      .evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
      ),
  ).toBe(2);

  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await dialog
      .locator('.asset-library-storage-count-grid')
      .evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
      ),
  ).toBe(1);
  const dialogMetrics = await dialog.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dialogMetrics.scrollWidth).toBeLessThanOrEqual(dialogMetrics.clientWidth);
});
