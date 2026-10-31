import { expect, test } from '@playwright/test';
import { authenticate, openDisposableWorkspace, openPanel } from './wp29-r5-harness.js';
import { assertBrowserAudit, setupBrowserAudit } from './helpers/browser-console-audit.js';

/**
 * PLAN-v4 §11a P1 removed stock video discovery and import from the app, so
 * the browser spec that used to drive the native stock video library is
 * retired. The evidence:
 *
 *   - PLAN-v4 §11a P1 "Remove login, premium, Kilo and the update check from
 *     the app" lists "stock video discovery and import" among its removals.
 *   - commit a37448a3 "feat(editor): run without sign-in, stock video, cloud
 *     catalog or remote services (P1, partial)" deleted
 *     apps/editor-web/src/StockVideoDiscovery.tsx (446 lines) and its unit
 *     test, and rewrote apps/editor-web/src/AssetLibraryPanel.tsx.
 *   - apps/editor-web/src/asset-library-panel-contract.test.ts:84-103
 *     ("removes sign-in, cloud listing, and stock discovery from the panel")
 *     asserts that the panel source contains none of StockVideoDiscovery,
 *     BrowserStockVideo, STOCK_VIDEO_CATEGORIES, stock-video-category-rail,
 *     setAssetSource or "Cloud library".
 *   - A grep of apps/editor-web/src for "stock" returns no product source
 *     outside that contract test and unrelated TTS "stock:" voice ids; a grep
 *     of apps, packages and tooling for "stock-video" returns only the same
 *     contract-test string.
 *
 * A browser probe confirmed the running product exposes no stock surface: the
 * asset library renders zero elements whose class contains "stock-video",
 * zero "Cloud library" buttons, and no "Native JOY stock video categories"
 * tablist. It instead renders the local desktop-app catalog notice.
 *
 * The retired test is therefore replaced by a guard that asserts the removed
 * surface stays removed, so the P1 decision is enforced rather than merely
 * unasserted. This is not a skip and it does not weaken any assertion.
 */
test.describe('native stock video library', () => {
  test.beforeEach(({ page }) => {
    setupBrowserAudit(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await assertBrowserAudit(page, testInfo);
  });

  test('keeps stock video discovery and the cloud catalog out of the asset library', async ({
    page,
  }) => {
    await authenticate(page);
    await openDisposableWorkspace(page, `Stock UI ${Date.now()}`);

    await openPanel(page, 'Assets');

    // No stock video grid, cards, posters or category rail.
    await expect(page.locator('[class*="stock-video"]')).toHaveCount(0);
    await expect(
      page.getByRole('tablist', { name: 'Native JOY stock video categories' }),
    ).toHaveCount(0);

    // No cloud catalog source: the panel offers only the local desktop app.
    await expect(page.getByRole('button', { name: /Cloud library/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Ready in cloud/ })).toHaveCount(0);
    const content = page.locator('.asset-library-content');
    await expect(content).toHaveCount(1);
    await expect(content).not.toHaveAttribute('data-asset-library-source', 'stock');
  });
});
