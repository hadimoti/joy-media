import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authenticate, openDisposableWorkspace, openPanel } from './wp29-r5-harness.js';

const STOCK_CATEGORIES = [
  'business-work',
  'technology',
  'people-lifestyle',
  'nature',
  'travel-places',
  'city-transport',
  'food-drink',
  'abstract-backgrounds',
] as const;

const FIXTURE_MEDIA_DIR = join(process.cwd(), 'packages/test-fixtures/media');
const POSTER_BYTES = readFileSync(join(FIXTURE_MEDIA_DIR, 'image.png'));
const PREVIEW_BYTES = readFileSync(join(FIXTURE_MEDIA_DIR, 'video.mp4'));

function stockFixtureId(category: (typeof STOCK_CATEGORIES)[number], suffix: string): string {
  return `${category}-${suffix}`;
}

const IMPORT_FIXTURE_SUFFIX = 'stock-landscape-1';
const IMPORT_FIXTURE_ID = stockFixtureId('business-work', IMPORT_FIXTURE_SUFFIX);

function stockItems(category: (typeof STOCK_CATEGORIES)[number]) {
  return [
    [IMPORT_FIXTURE_SUFFIX, 'Landscape fixture', 'landscape'],
    ['stock-portrait-1', 'Portrait fixture', 'portrait'],
    ['stock-landscape-2', 'Second landscape fixture', 'landscape'],
    ['stock-portrait-2', 'Second portrait fixture', 'portrait'],
    ['stock-landscape-3', 'Third landscape fixture', 'landscape'],
    ['stock-landscape-4', 'Fourth landscape fixture', 'landscape'],
  ].map(([id, title, orientation]) => ({
    id: stockFixtureId(category, id),
    category,
    title,
    provider: 'pexels',
    creator: 'JOY fixture creator',
    sourcePageUrl: `https://example.test/source/${stockFixtureId(category, id)}`,
    durationUs: 3_000_000,
    width: orientation === 'portrait' ? 360 : 640,
    height: orientation === 'portrait' ? 640 : 360,
    orientation,
  }));
}

test.describe('native stock video library', () => {
  test('uses the shared rail, fixed cards, accessible preview, and project-scoped import', async ({
    page,
  }) => {
    await authenticate(page);
    await openDisposableWorkspace(page, `Stock UI ${Date.now()}`);

    const activeProject = await page.evaluate(() => {
      const raw = window.localStorage.getItem('joy-media.active-project.v1');
      if (raw === null) throw new Error('missing active project binding');
      const value: unknown = JSON.parse(raw);
      if (
        typeof value !== 'object' ||
        value === null ||
        (value as { version?: unknown }).version !== 1 ||
        typeof (value as { projectId?: unknown }).projectId !== 'string' ||
        (value as { projectId: string }).projectId.length === 0
      )
        throw new Error('malformed active project binding');
      return (value as { projectId: string }).projectId;
    });
    const projectRequestErrors: string[] = [];
    const stockRequestErrors: string[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      const match = pathname.match(/^\/api\/v1\/projects\/([^/]+)\//);
      if (match === null) return;
      if (decodeURIComponent(match[1]!) !== activeProject)
        projectRequestErrors.push(`unexpected project ${decodeURIComponent(match[1]!)}`);
    });
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.includes('/api/v1/library/stock-videos')) return;
      if (
        !/^\/api\/v1\/library\/stock-videos(?:\?.*|\/[^/]+\/(?:poster|preview))$/.test(
          pathname + new URL(request.url()).search,
        )
      )
        stockRequestErrors.push(pathname);
    });

    let catalogMode: 'normal' | 'loading' | 'zero' | 'error' = 'normal';
    let stockMode: 'normal' | 'poster-failure' = 'normal';
    let importMode: 'success' | 'failure' = 'success';
    let stalePreviewId: string | undefined;
    let releaseCatalog: (() => void) | undefined;
    let releasePreview: (() => void) | undefined;
    const completedAsset = {
      id: 'imported-stock-1',
      projectId: activeProject,
      kind: 'video',
      displayName: 'Imported stock fixture.mp4',
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      bytes: 1024,
      descriptor: { mimeType: 'video/mp4', durationUs: 3_000_000, width: 640, height: 360 },
      createdAt: 1_700_000_000_000,
      cloudBacked: true,
    };

    await page.route('**/api/v1/library/my-assets**', async (route) => {
      const url = new URL(route.request().url());
      expect(url.pathname).toBe('/api/v1/library/my-assets');
      const projectId = url.searchParams.get('projectId');
      if (projectId !== null && projectId !== activeProject)
        throw new Error(`unexpected my-assets project ${projectId}`);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: projectId === activeProject ? [completedAsset] : [] }),
      });
    });
    await page.route('**/api/v1/library/cloud-assets', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
    });
    await page.route('**/api/v1/library/stock-videos/*/poster', async (route) => {
      const id = route.request().url().split('/').at(-2);
      if (id === stockFixtureId('nature', 'stock-portrait-2') && stockMode === 'poster-failure') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'image/png', body: POSTER_BYTES });
    });
    await page.route('**/api/v1/library/stock-videos/*/preview', async (route) => {
      const id = route.request().url().split('/').at(-2);
      if (id === stalePreviewId) {
        await new Promise<void>((resolve) => {
          releasePreview = resolve;
        });
      }
      await route.fulfill({ status: 200, contentType: 'video/mp4', body: PREVIEW_BYTES });
    });
    await page.route('**/api/v1/library/stock-videos?*', async (route) => {
      const url = new URL(route.request().url());
      const category = url.searchParams.get('category');
      if (!STOCK_CATEGORIES.includes(category as (typeof STOCK_CATEGORIES)[number]))
        throw new Error(`unexpected stock category ${category}`);
      const query = url.searchParams.get('q');
      if (query !== null && query !== 'fixture') throw new Error(`unexpected stock query ${query}`);
      const counts = Object.fromEntries(STOCK_CATEGORIES.map((id) => [id, 6]));
      if (catalogMode === 'loading') {
        await new Promise<void>((resolve) => {
          releaseCatalog = resolve;
        });
      }
      if (catalogMode === 'error') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'fixture catalog unavailable' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            items:
              catalogMode === 'zero'
                ? []
                : stockItems(category as (typeof STOCK_CATEGORIES)[number]),
            counts,
          },
        }),
      });
    });
    await page.route('**/api/v1/projects/*/stock-video-import', async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({
        catalogId: IMPORT_FIXTURE_ID,
      });
      if (importMode === 'failure') {
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'fixture import failed' }),
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { importId: 'stock-import-1', state: 'claimed' } }),
      });
    });
    await page.route('**/api/v1/projects/*/stock-video-imports/stock-import-1', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { importId: 'stock-import-1', state: 'completed', assetId: 'imported-stock-1' },
        }),
      });
    });

    await openPanel(page, 'Assets');
    await page.getByRole('button', { name: /Cloud library/ }).click();
    await page.getByRole('tab', { name: /^Video/ }).click();
    const content = page.locator('.asset-library-content');
    await expect(content).toHaveAttribute('data-asset-library-source', 'stock');
    await expect(
      page.getByRole('tablist', { name: 'Native JOY stock video categories' }),
    ).toBeVisible();
    await expect(page.getByRole('tab', { name: /Business & Work/ })).toHaveAttribute(
      'aria-controls',
      'stock-video-panel',
    );
    await expect(page.locator('#stock-video-panel')).toHaveAttribute(
      'aria-labelledby',
      'stock-video-category-business-work',
    );
    await expect(page.locator('.stock-video-poster')).toHaveCount(6);
    await page.getByPlaceholder('Search media…').fill('fixture');
    await expect(page.locator('.stock-video-card[data-orientation="portrait"]')).toHaveCount(2);

    const setContentWidth = async (contentWidth: number): Promise<void> => {
      await page.locator('.asset-library').evaluate((element, width) => {
        const panel = element as HTMLElement;
        panel.style.boxSizing = 'border-box';
        panel.style.width = `${width + 20.8}px`;
        panel.style.minWidth = '0';
        panel.style.overflow = 'hidden';
        const parent = panel.parentElement;
        if (parent instanceof HTMLElement) {
          parent.style.minWidth = '0';
          parent.style.overflow = 'hidden';
        }
      }, contentWidth);
      await expect
        .poll(() => content.evaluate((element) => element.getBoundingClientRect().width))
        .toBeCloseTo(contentWidth, 0);
    };
    await setContentWidth(300);
    await expect
      .poll(() => content.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(299);
    await expect(content.locator(':scope > .asset-library-sidebar')).toHaveJSProperty(
      'clientWidth',
      54,
    );
    await page.getByRole('button', { name: 'Large previews' }).click();
    await expect(page.locator('.stock-video-grid--large')).toHaveCount(1);
    await expect
      .poll(() =>
        page
          .locator('.stock-video-grid--large')
          .evaluate(
            (element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
          ),
      )
      .toBe(1);
    await page.getByRole('button', { name: 'Compact grid' }).click();
    await expect(page.locator('.stock-video-grid--medium .stock-video-card')).toHaveCount(6);
    await expect
      .poll(() =>
        page
          .locator('.stock-video-grid--medium')
          .evaluate(
            (element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
          ),
      )
      .toBe(1);
    const compact300Geometry = await page
      .locator('.stock-video-grid--medium .stock-video-card')
      .evaluateAll((cards) =>
        cards.map((card) => {
          const cardBox = card.getBoundingClientRect();
          const posterBox = card
            .querySelector<HTMLElement>('.stock-video-poster')!
            .getBoundingClientRect();
          const actionsBox = card
            .querySelector<HTMLElement>('.stock-video-card-actions')!
            .getBoundingClientRect();
          return {
            cardBox,
            posterBox,
            actionsBox,
            actionOffset: cardBox.bottom - actionsBox.bottom,
          };
        }),
      );
    expect(
      Math.max(...compact300Geometry.map(({ cardBox }) => cardBox.height)) -
        Math.min(...compact300Geometry.map(({ cardBox }) => cardBox.height)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...compact300Geometry.map(({ posterBox }) => posterBox.height)) -
        Math.min(...compact300Geometry.map(({ posterBox }) => posterBox.height)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...compact300Geometry.map(({ actionOffset }) => actionOffset)) -
        Math.min(...compact300Geometry.map(({ actionOffset }) => actionOffset)),
    ).toBeLessThanOrEqual(1);
    expect(
      compact300Geometry.every(
        ({ posterBox }) => Math.abs(posterBox.width / posterBox.height - 16 / 9) < 0.03,
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'List view' }).click();
    const listGeometry = await page
      .locator('.stock-video-grid--list .stock-video-card')
      .first()
      .evaluate((card) => {
        const poster = card.querySelector<HTMLElement>('.stock-video-poster')!;
        const copy = card.querySelector<HTMLElement>('.stock-video-card-copy')!;
        const actions = card.querySelector<HTMLElement>('.stock-video-card-actions')!;
        const controls = [...actions.children].map((child) => {
          const box = (child as HTMLElement).getBoundingClientRect();
          return { width: box.width, height: box.height };
        });
        return {
          card: card.getBoundingClientRect().width,
          poster: poster.getBoundingClientRect(),
          copy: copy.getBoundingClientRect().width,
          actions: actions.getBoundingClientRect().width,
          controls,
          gap: getComputedStyle(actions).gap,
        };
      });
    expect(listGeometry.card).toBeGreaterThan(224);
    expect(listGeometry.poster.width).toBeCloseTo(52, 0);
    expect(listGeometry.poster.height).toBeCloseTo(48, 0);
    expect(listGeometry.copy).toBeGreaterThanOrEqual(96);
    expect(listGeometry.actions).toBeGreaterThanOrEqual(60);
    expect(listGeometry.controls.every(({ width, height }) => width === 28 && height === 28)).toBe(
      true,
    );
    expect(listGeometry.gap).toBe('4px');
    const overflow = await page.evaluate(() => {
      const roots = [
        document.documentElement,
        document.querySelector('.asset-library'),
        document.querySelector('.asset-library-content'),
      ];
      return roots.map((root) => (root === null ? false : root.scrollWidth <= root.clientWidth));
    });
    expect(overflow).toEqual([true, true, true]);

    await setContentWidth(560);
    await page.getByRole('button', { name: 'Compact grid' }).click();
    await expect(page.locator('.stock-video-grid--medium .stock-video-card')).toHaveCount(6);
    await expect
      .poll(() =>
        page
          .locator('.stock-video-grid--medium')
          .evaluate(
            (element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
          ),
      )
      .toBe(2);
    const cardGeometry = await page
      .locator('.stock-video-grid--medium .stock-video-card')
      .evaluateAll((cards) =>
        cards.map((card) => ({
          card: card.getBoundingClientRect(),
          poster: card.querySelector<HTMLElement>('.stock-video-poster')!.getBoundingClientRect(),
        })),
      );
    expect(
      Math.max(...cardGeometry.map(({ card }) => card.height)) -
        Math.min(...cardGeometry.map(({ card }) => card.height)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...cardGeometry.map(({ poster }) => poster.height)) -
        Math.min(...cardGeometry.map(({ poster }) => poster.height)),
    ).toBeLessThanOrEqual(1);
    expect(
      cardGeometry.every(({ poster }) => Math.abs(poster.width / poster.height - 16 / 9) < 0.03),
    ).toBe(true);
    await setContentWidth(280);
    await expect(content).toHaveAttribute('data-stock-rail-orientation', 'horizontal');
    await expect(
      page.getByRole('tablist', { name: 'Native JOY stock video categories' }),
    ).toHaveAttribute('aria-orientation', 'horizontal');
    await page.getByRole('tab', { name: /Business & Work/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /Technology/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await setContentWidth(300);
    await expect(content).toHaveAttribute('data-stock-rail-orientation', 'vertical');
    await expect(
      page.getByRole('tablist', { name: 'Native JOY stock video categories' }),
    ).toHaveAttribute('aria-orientation', 'vertical');

    catalogMode = 'loading';
    await page.getByRole('tab', { name: /Nature/ }).click();
    await expect(page.locator('.stock-video-loading-label')).toBeVisible();
    await expect.poll(() => releaseCatalog !== undefined).toBe(true);
    catalogMode = 'normal';
    releaseCatalog?.();
    await expect(page.locator('.stock-video-card[data-orientation="portrait"]')).toHaveCount(2);

    catalogMode = 'zero';
    await page.getByRole('tab', { name: /Food & Drink/ }).click();
    await expect(page.getByRole('status')).toContainText('No native videos match');
    catalogMode = 'normal';
    await page.getByRole('tab', { name: /Business & Work/ }).click();
    await expect(page.locator('.stock-video-card[data-orientation="portrait"]')).toHaveCount(2);

    catalogMode = 'error';
    await page.getByRole('tab', { name: /Nature/ }).click();
    await expect(page.getByRole('alert')).toContainText('fixture catalog unavailable');
    catalogMode = 'normal';
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('.stock-video-card[data-orientation="portrait"]')).toHaveCount(2);

    await expect(page.locator('.stock-video-card[data-orientation="portrait"]')).toHaveCount(2);
    await expect(
      page
        .locator('.stock-video-card[data-orientation="landscape"]')
        .first()
        .locator('.stock-video-card-actions'),
    ).toBeVisible();

    await page.getByRole('tab', { name: /Business & Work/ }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('tab', { name: /Technology/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: /Business & Work/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const rtlMarker = await page.getByRole('tab', { name: /Business & Work/ }).evaluate((tab) => {
      document.documentElement.dir = 'rtl';
      return getComputedStyle(tab, '::before').insetInlineStart;
    });
    expect(rtlMarker).not.toBe('');

    stockMode = 'poster-failure';
    await page.getByRole('tab', { name: /Nature/ }).click();
    await expect(
      page.locator(
        `.stock-video-card[data-stock-video-id="${stockFixtureId('nature', 'stock-portrait-2')}"] .stock-video-poster`,
      ),
    ).toContainText('Poster unavailable');

    const opener = page.locator(
      `.stock-video-card[data-stock-video-id="${stockFixtureId('nature', 'stock-landscape-1')}"] .stock-video-poster`,
    );
    stalePreviewId = stockFixtureId('nature', 'stock-landscape-2');
    await page
      .locator(`.stock-video-card[data-stock-video-id="${stalePreviewId}"] .stock-video-poster`)
      .click();
    await expect.poll(() => releasePreview !== undefined).toBe(true);
    await opener.click();
    await expect(page.getByRole('dialog')).toContainText('Landscape fixture');
    releasePreview?.();
    stalePreviewId = undefined;
    await page.waitForTimeout(50);
    await expect(page.getByRole('dialog')).toContainText('Landscape fixture');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByRole('button', { name: 'Close stock video preview' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await page.getByRole('tab', { name: /Business & Work/ }).click();
    importMode = 'failure';
    const importButton = page
      .locator(`.stock-video-card[data-stock-video-id="${IMPORT_FIXTURE_ID}"]`)
      .getByRole('button', { name: /Import Landscape fixture to My media/ });
    await importButton.click();
    await expect(
      page.getByRole('button', { name: /Retry import Landscape fixture to My media/ }),
    ).toBeVisible();
    importMode = 'success';
    await page
      .locator(`.stock-video-card[data-stock-video-id="${IMPORT_FIXTURE_ID}"]`)
      .getByRole('button', { name: /Retry import Landscape fixture to My media/ })
      .click();
    await expect(
      page.getByRole('button', { name: /Importing Landscape fixture to My media/ }),
    ).toBeVisible();
    await expect(page.getByText('Imported stock fixture.mp4 imported to My media.')).toBeVisible({
      timeout: 15_000,
    });
    expect(projectRequestErrors).toEqual([]);
    expect(stockRequestErrors).toEqual([]);
  });
});
