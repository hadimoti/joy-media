import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Request } from '@playwright/test';

// Runtime checks for the landing site preview (PLAN-v4 7e, runtime part; 7d; P6 acceptance).
const PAGES = ['/', '/download', '/providers', '/privacy', '/source'];

/** Paths the v1.0.x clients call (PLAN-v4 7d). Each must return 404 from 404.html. */
const CLIENT_API_PATHS = ['/api/v1/auth/session', '/api/health', '/api/v1/billing/invoices'];

/** Paths outside the API that must also return 404 from 404.html. */
const MISSING_PATHS = ['/no-such-page', '/download/missing'];

function isOffSite(request: Request, origin: string): boolean {
  return new URL(request.url()).origin !== origin;
}

test.describe('landing site preview', () => {
  test('/ returns 200 with the JOY Media title', async ({ page, baseURL }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/JOY Media/);
    expect(baseURL).toBeTruthy();
  });

  for (const path of PAGES) {
    test(`${path}: passes axe, makes only same-origin non-script requests and sets no cookies`, async ({
      page,
      context,
      baseURL,
    }) => {
      const origin = new URL(baseURL ?? 'http://127.0.0.1:8788').origin;
      const requests: Request[] = [];
      page.on('request', (request) => requests.push(request));

      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await page.waitForLoadState('networkidle');

      const offSite = requests.filter((request) => isOffSite(request, origin));
      expect(offSite.map((request) => request.url())).toEqual([]);

      const scripted = requests.filter((request) =>
        ['fetch', 'xhr', 'websocket', 'eventsource'].includes(request.resourceType()),
      );
      expect(scripted.map((request) => request.url())).toEqual([]);

      expect(await context.cookies()).toEqual([]);

      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(axe.violations.map((violation) => violation.id)).toEqual([]);
    });
  }

  test('the download page links each payload file to its tag-specific URL', async ({ page }) => {
    await page.goto('/download');
    const links = await page
      .locator('a[href*="/releases/download/"]')
      .evaluateAll((elements) => elements.map((element) => (element as HTMLAnchorElement).href));
    expect(links).toHaveLength(4);
    for (const link of links) {
      expect(link).toMatch(
        /^https:\/\/github\.com\/hadimoti\/joy-media\/releases\/download\/v\d+\.\d+\.\d+\/[^/]+$/,
      );
      expect(link).not.toContain('/latest/');
    }
  });

  test('the hash cells match the hash mode recorded in build.txt', async ({ page, request }) => {
    const build = await request.get('/build.txt');
    expect(build.status()).toBe(200);
    const buildText = await build.text();
    expect(buildText).toMatch(/^release_tag=v\d+\.\d+\.\d+$/m);

    await page.goto('/download');
    const cells = await page
      .locator('code[data-sha256-state]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-sha256-state')),
      );
    expect(cells).toHaveLength(4);
    const expected = buildText.includes('hash_source=placeholder') ? 'placeholder' : 'published';
    expect(cells.every((state) => state === expected)).toBe(true);
  });

  test('the page does not overflow horizontally at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    for (const path of PAGES) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});

test.describe('API paths used by v1.0.x clients return 404 from 404.html', () => {
  for (const path of CLIENT_API_PATHS) {
    test(`GET ${path}`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(404);
      expect(response.headers()['set-cookie']).toBeUndefined();
      expect(await response.text()).toContain('Page not found');
    });
  }
});

test.describe('other missing paths return 404 from 404.html', () => {
  for (const path of MISSING_PATHS) {
    test(`GET ${path}`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(404);
      expect(await response.text()).toContain('Page not found');
    });
  }
});
