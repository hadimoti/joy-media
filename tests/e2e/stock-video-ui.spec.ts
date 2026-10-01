import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authenticate, openDisposableWorkspace, openPanel } from './wp29-r5-harness.js';
import {
  allowExpectedHttpResponse,
  assertBrowserAudit,
  setupBrowserAudit,
} from './helpers/browser-console-audit.js';

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
  test.beforeEach(({ page }) => {
    setupBrowserAudit(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await assertBrowserAudit(page, testInfo);
  });

  test('uses the shared rail, fixed cards, accessible preview, and project-scoped import', async ({
    page,
  }) => {
    const myAssetProjectIds: string[] = [];
    const myAssetResponsePromises: Promise<void>[] = [];
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (
        url.pathname === '/api/v1/library/my-assets' &&
        response.ok() &&
        response.request().method() === 'GET'
      ) {
        const promise = (async () => {
          const body: unknown = await response.json();
          if (
            typeof body === 'object' &&
            body !== null &&
            'data' in body &&
            Array.isArray((body as Record<string, unknown>).data)
          ) {
            for (const item of (body as { data: unknown[] }).data) {
              if (
                typeof item === 'object' &&
                item !== null &&
                'projectId' in item &&
                typeof (item as Record<string, unknown>).projectId === 'string' &&
                (item as { projectId: string }).projectId.trim().length > 0
              ) {
                myAssetProjectIds.push((item as { projectId: string }).projectId);
              }
            }
          }
        })();
        myAssetResponsePromises.push(promise);
      }
    });

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
    const { activeControlPlaneProjectIds } = await page.evaluate((activeEditorProjectId) => {
      const raw = window.localStorage.getItem('joy-media.control-plane-project-bindings.v1');
      if (raw === null) throw new Error('missing control-plane project bindings');
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('malformed control-plane project bindings');
      const bindingsByOwner = (value as { bindingsByOwner?: unknown }).bindingsByOwner;
      if (
        typeof bindingsByOwner !== 'object' ||
        bindingsByOwner === null ||
        Array.isArray(bindingsByOwner)
      )
        throw new Error('malformed control-plane owner bindings');
      const activeProjectIds: string[] = [];
      // The project selector/startup may issue project requests before the
      // disposable project becomes active, so this audit permits bindings for
      // this authenticated E2E owner only and excludes all other owners.
      const ownerBindings = bindingsByOwner['e2e-owner@example.test'];
      if (
        typeof ownerBindings !== 'object' ||
        ownerBindings === null ||
        Array.isArray(ownerBindings)
      )
        throw new Error('missing or malformed bindings for e2e-owner@example.test');
      for (const [editorProjectId, binding] of Object.entries(ownerBindings)) {
        if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) continue;
        const projectId = (binding as { controlPlaneProjectId?: unknown }).controlPlaneProjectId;
        if (typeof projectId !== 'string' || projectId.length === 0) continue;
        if (editorProjectId === activeEditorProjectId) activeProjectIds.push(projectId);
      }
      if (activeProjectIds.length === 0)
        throw new Error(`missing control-plane binding for active editor project`);
      return {
        activeControlPlaneProjectIds: [...new Set(activeProjectIds)],
      };
    }, activeProject);
    const projectRequestIds: string[] = [];
    const stockRequestErrors: string[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      const match = pathname.match(/^\/api\/v1\/projects\/([^/]+)\//);
      if (match === null) return;
      const projectId = decodeURIComponent(match[1]!);
      projectRequestIds.push(projectId);
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
    let importStatusPolls = 0;
    let stalePreviewId: string | undefined;
    let releaseCatalog: (() => void) | undefined;
    let releasePreview: (() => void) | undefined;
    let stalePreviewFulfilled: Promise<void> | undefined;
    let _holdImportStart: (() => void) | undefined;
    let importHoldPromise: Promise<void> | undefined;
    let resolveImportHold: (() => void) | undefined;
    const completedAsset = {
      id: 'imported-stock-1',
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
      if (projectId !== null && !activeControlPlaneProjectIds.includes(projectId))
        throw new Error(`unexpected my-assets project ${projectId}`);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data:
            projectId === null || !activeControlPlaneProjectIds.includes(projectId)
              ? []
              : [{ ...completedAsset, projectId }],
        }),
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
        const released = new Promise<void>((resolve) => {
          releasePreview = resolve;
        });
        const fulfillment = released.then(async () => {
          await route.fulfill({ status: 200, contentType: 'video/mp4', body: PREVIEW_BYTES });
        });
        stalePreviewFulfilled = fulfillment;
        await fulfillment;
        return;
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
      const projectId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[4]!);
      expect(activeControlPlaneProjectIds).toContain(projectId);
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
      if (importHoldPromise) {
        await importHoldPromise;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { importId: 'stock-import-1', state: 'claimed' } }),
      });
    });
    await page.route('**/api/v1/projects/*/stock-video-imports/stock-import-1', async (route) => {
      importStatusPolls += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data:
            importStatusPolls === 1
              ? { importId: 'stock-import-1', state: 'downloading' }
              : { importId: 'stock-import-1', state: 'completed', assetId: 'imported-stock-1' },
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
    await page.getByRole('button', { name: 'Search Assets' }).click();
    await page.getByPlaceholder('Search media…').fill('fixture');
    await expect(page.locator('.stock-video-card[data-orientation="portrait"]')).toHaveCount(2);

    const setContentWidth = async (contentWidth: number): Promise<void> => {
      await page.locator('.asset-library').evaluate((element, width) => {
        const panel = element as HTMLElement;
        const outerWidth = `${width + 20.8}px`;
        panel.style.boxSizing = 'border-box';
        panel.style.width = outerWidth;
        panel.style.minWidth = '0';
        panel.style.maxWidth = outerWidth;
        panel.style.overflow = 'hidden';
        const body = panel.querySelector<HTMLElement>('.joy-panel-body');
        if (body !== null) {
          body.style.boxSizing = 'border-box';
          body.style.width = '100%';
          body.style.minWidth = '0';
          body.style.maxWidth = 'none';
          body.style.overflow = 'hidden';
          body.style.scrollbarGutter = 'auto';
        }
        let ancestor: HTMLElement | null = panel.parentElement;
        for (let depth = 0; ancestor !== null && depth < 8; depth += 1) {
          ancestor.style.boxSizing = 'border-box';
          ancestor.style.minWidth = '0';
          ancestor.style.maxWidth = 'none';
          ancestor.style.overflow = 'hidden';
          ancestor = ancestor.parentElement;
        }
      }, contentWidth);
      await expect
        .poll(() => content.evaluate((element) => element.getBoundingClientRect().width))
        .toBeCloseTo(contentWidth, 1);
      await expect
        .poll(() => content.evaluate((element) => element.getBoundingClientRect().width))
        .toBeGreaterThan(contentWidth - 1);
      await expect
        .poll(() => content.evaluate((element) => element.getBoundingClientRect().width))
        .toBeLessThan(contentWidth + 1);
    };
    const mediaTabList = page.getByRole('tablist', { name: 'Assets sections' });
    const videoMediaTab = page.getByRole('tab', { name: /^Video, \d+ assets?$/ });
    const imageMediaTab = page.getByRole('tab', { name: /^Images, \d+ assets?$/ });
    await expect(mediaTabList.getByRole('tab')).toHaveCount(4);
    await expect(videoMediaTab).toHaveAttribute('aria-selected', 'true');
    await expect(videoMediaTab).toHaveAttribute('title', /^Video: \d+ assets?$/);
    await expect(videoMediaTab.locator('.joy-panel-tab-label')).toHaveCSS('display', 'none');
    await expect(videoMediaTab.locator('.joy-panel-tab-icon')).toBeVisible();
    await setContentWidth(300);
    await expect
      .poll(() =>
        page.locator('.asset-library').evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeGreaterThan(288);
    await expect(videoMediaTab.locator('.joy-panel-tab-count')).toBeVisible();
    await setContentWidth(260);
    await expect
      .poll(() =>
        page.locator('.asset-library').evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeLessThanOrEqual(288);
    await expect(videoMediaTab.locator('.joy-panel-tab-count')).toBeHidden();
    await expect(videoMediaTab).toBeVisible();
    await expect(imageMediaTab).toBeVisible();
    await expect(page.getByPlaceholder('Search media…')).toBeVisible();
    await imageMediaTab.click();
    await expect(imageMediaTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#stock-video-panel')).toBeHidden();
    await imageMediaTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(videoMediaTab).toHaveAttribute('aria-selected', 'true');
    await expect(videoMediaTab).toBeFocused();
    await expect(videoMediaTab).toHaveCSS('outline-style', 'solid');
    await expect(
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).resolves.toBe(true);
    await setContentWidth(300);
    await expect
      .poll(() => content.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(299);
    await expect
      .poll(() =>
        content
          .locator(':scope > .asset-library-sidebar')
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeCloseTo(53.6, 0);
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
      .toBeGreaterThanOrEqual(2);
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
      .toBeGreaterThanOrEqual(2);
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
    await expect(page.locator('.stock-video-state[role="status"]')).toContainText(
      'No native videos match',
    );
    catalogMode = 'normal';
    await page.getByRole('tab', { name: /Business & Work/ }).click();
    await expect(page.locator('.stock-video-card[data-orientation="portrait"]')).toHaveCount(2);

    allowExpectedHttpResponse(page, {
      status: 503,
      pathname: '/api/v1/library/stock-videos',
    });
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

    allowExpectedHttpResponse(page, {
      status: 503,
      pathname: /^\/api\/v1\/library\/stock-videos\/[^/]+\/poster$/,
    });
    stockMode = 'poster-failure';
    await page.getByRole('tab', { name: /Nature/ }).click();
    const failedPoster = page.locator(
      `.stock-video-card[data-stock-video-id="${stockFixtureId('nature', 'stock-portrait-2')}"] .stock-video-poster`,
    );
    await failedPoster.scrollIntoViewIfNeeded();
    await expect(failedPoster).toContainText('Poster unavailable');

    const opener = page.locator(
      `.stock-video-card[data-stock-video-id="${stockFixtureId('nature', 'stock-landscape-1')}"] .stock-video-poster`,
    );
    stalePreviewId = stockFixtureId('nature', 'stock-landscape-2');
    await page
      .locator(`.stock-video-card[data-stock-video-id="${stalePreviewId}"] .stock-video-poster`)
      .click();
    await expect.poll(() => releasePreview !== undefined).toBe(true);
    await page.getByRole('tab', { name: /^Images/ }).click();
    await expect(page.locator('#stock-video-panel')).toHaveCount(0);
    releasePreview?.();
    releasePreview = undefined;
    if (stalePreviewFulfilled === undefined) throw new Error('stale preview did not start');
    await stalePreviewFulfilled;
    stalePreviewId = undefined;
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.joy-panel-note')).not.toContainText(
      'Preview ready for Second landscape fixture.',
    );

    stockMode = 'normal';
    await page.evaluate(() => {
      document.documentElement.dir = 'ltr';
    });
    await page.getByRole('button', { name: /Cloud library/ }).click();
    await page.getByRole('tab', { name: /^Video/ }).click();
    await page.getByRole('tab', { name: /Nature/ }).click();
    await expect(page.locator('.stock-video-card')).toHaveCount(6);
    await opener.scrollIntoViewIfNeeded();
    await opener.click();
    await expect(page.getByRole('dialog')).toContainText('Landscape fixture');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByRole('button', { name: 'Close stock video preview' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await page.getByRole('tab', { name: /Business & Work/ }).click();
    allowExpectedHttpResponse(page, {
      status: 502,
      pathname: /^\/api\/v1\/projects\/[^/]+\/stock-video-import$/,
    });
    importMode = 'failure';
    const importButton = page
      .locator(`.stock-video-card[data-stock-video-id="${IMPORT_FIXTURE_ID}"]`)
      .getByRole('button', { name: /Import Landscape fixture to My media/ });
    await importButton.click();
    await expect(
      page.getByRole('button', { name: /Retry import Landscape fixture to My media/ }),
    ).toBeVisible();
    importMode = 'success';
    importHoldPromise = new Promise<void>((resolve) => {
      resolveImportHold = resolve;
    });
    await page
      .locator(`.stock-video-card[data-stock-video-id="${IMPORT_FIXTURE_ID}"]`)
      .getByRole('button', { name: /Retry import Landscape fixture to My media/ })
      .click();
    await expect(
      page.getByRole('button', { name: /Importing Landscape fixture to My media/ }),
    ).toBeVisible();
    resolveImportHold?.();
    importHoldPromise = undefined;
    await expect(page.getByText('Imported stock fixture.mp4 imported to My media.')).toBeVisible({
      timeout: 15_000,
    });
    await Promise.all(myAssetResponsePromises);
    const projectRequestErrors = projectRequestIds
      .filter((id) => !activeControlPlaneProjectIds.includes(id) && !myAssetProjectIds.includes(id))
      .map(() => '/api/v1/projects/:projectId');
    expect(projectRequestErrors).toEqual([]);
    expect(stockRequestErrors).toEqual([]);
  });
});
