import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  E2E_TOKEN,
  MEDIA_FIXTURE_DIR,
  authenticate,
  openDisposableWorkspace,
  openPanel,
} from './wp29-r5-harness.js';

async function importFixture(page: Page, fileName: string, displayName: string): Promise<void> {
  await openPanel(page, 'Assets');
  await page.getByRole('button', { name: 'Import media' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Import media' });
  await drawer.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
    name: displayName,
    mimeType: fileName.endsWith('.gif') ? 'image/gif' : 'image/webp',
    buffer: readFileSync(join(MEDIA_FIXTURE_DIR, fileName)),
  });
  await expect(drawer.getByText(displayName, { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.locator('.asset-card', { hasText: displayName })).toBeVisible({
    timeout: 15_000,
  });
}

async function cleanupDisposableProject(page: Page): Promise<void> {
  const projectId = await page.evaluate(() => localStorage.getItem('joy-media.active-project.v1'));
  if (projectId === null) return;
  await page.evaluate(async (id) => {
    const headers = { authorization: 'Bearer joy-media-e2e-token' };
    const assetsResponse = await fetch(`/api/v1/projects/${encodeURIComponent(id)}/assets`, {
      headers,
    });
    if (assetsResponse.ok) {
      const assets = (await assetsResponse.json()) as {
        data?: readonly { id: string; displayName: string }[];
      };
      for (const asset of assets.data ?? []) {
        if (asset.displayName.startsWith('wp30-')) {
          await fetch(
            `/api/v1/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(asset.id)}`,
            { method: 'DELETE', headers },
          );
        }
      }
    }
    await fetch(`/api/v1/projects/${encodeURIComponent(id)}/trash`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 0 }),
    });
    await fetch(`/api/v1/projects/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
  }, projectId);
}

test.describe('WP-30 cross-browser animated assets', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('imports GIF/WebP, advertises animation, and rehydrates from a second profile', async ({
    page,
    browser,
  }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const gifName = `wp30-animated-${suffix}.gif`;
    const webpName = `wp30-animated-${suffix}.webp`;
    try {
      await openDisposableWorkspace(page, `WP-30 animated ${suffix}`);
      await importFixture(page, 'animated.gif', gifName);
      await importFixture(page, 'animated.webp', webpName);

      for (const name of [gifName, webpName]) {
        const card = page.locator('.asset-card', { hasText: name });
        await expect(card.locator('.asset-card-meta')).toContainText('Animated');
        const image = card.locator('img');
        await expect(image).toHaveAttribute('src', /^(blob:|https?:)/);
        await expect
          .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
          .toBeGreaterThan(0);
      }

      const secondContext = await browser.newContext({
        viewport: test.info().project.use.viewport,
      });
      try {
        await secondContext.addInitScript((token) => {
          window.localStorage.setItem('joy-media-session-token', token);
        }, E2E_TOKEN);
        const secondPage = await secondContext.newPage();
        await secondPage.goto('/');
        const catalog = await secondPage.evaluate(async () => {
          const response = await fetch('/api/v1/library/my-assets', {
            headers: { authorization: 'Bearer joy-media-e2e-token' },
          });
          return { status: response.status, data: await response.json() };
        });
        expect(catalog.status).toBe(200);
        const assets = catalog.data.data as readonly {
          id: string;
          projectId: string;
          displayName: string;
          bytes: number;
          sha256: string;
          descriptor: { animation?: { frameCount: number; cycleDurationUs: number } };
        }[];
        for (const [name, fixture] of [
          [gifName, 'animated.gif'],
          [webpName, 'animated.webp'],
        ] as const) {
          const asset = assets.find((candidate) => candidate.displayName === name);
          expect(asset, name).toBeDefined();
          expect(asset!.descriptor.animation).toMatchObject({
            frameCount: 4,
            cycleDurationUs: 1_000_000,
          });
          const content = await secondPage.evaluate(
            async ({ projectId, assetId }) => {
              const response = await fetch(
                `/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/original`,
                { headers: { authorization: 'Bearer joy-media-e2e-token' } },
              );
              return {
                status: response.status,
                bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
              };
            },
            { projectId: asset!.projectId, assetId: asset!.id },
          );
          const fixtureBytes = readFileSync(join(MEDIA_FIXTURE_DIR, fixture));
          expect(content.status, name).toBe(200);
          expect(content.bytes.length, name).toBe(fixtureBytes.byteLength);
          expect(createHash('sha256').update(Buffer.from(content.bytes)).digest('hex'), name).toBe(
            asset!.sha256,
          );
        }
        await secondPage.close();
      } finally {
        await secondContext.close();
      }
    } finally {
      await cleanupDisposableProject(page);
    }
  });

  test('proves Chromium decodes distinct animated WebP frames', async ({ page }) => {
    await page.goto('/');
    const bytes = Array.from(readFileSync(join(MEDIA_FIXTURE_DIR, 'animated.webp')));
    const result = await page.evaluate(async (payload) => {
      const Decoder = (
        globalThis as typeof globalThis & {
          ImageDecoder?: new (options: { data: ArrayBuffer; type: string }) => {
            completed: Promise<void>;
            tracks: { ready?: Promise<void>; selectedTrack?: { frameCount: number } };
            decode(options: { frameIndex: number }): Promise<{ image: VideoFrame }>;
            close(): void;
          };
        }
      ).ImageDecoder;
      if (Decoder === undefined) return { available: false, frameCount: 0, hashes: [] as string[] };
      const decoder = new Decoder({ data: Uint8Array.from(payload).buffer, type: 'image/webp' });
      await decoder.completed;
      if (decoder.tracks.ready !== undefined) await decoder.tracks.ready;
      const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
      const hashes: string[] = [];
      for (let index = 0; index < frameCount; index += 1) {
        const decoded = await decoder.decode({ frameIndex: index });
        const width = decoded.image.displayWidth;
        const height = decoded.image.displayHeight;
        const pixels = new Uint8Array(width * height * 4);
        await decoded.image.copyTo(pixels, { format: 'RGBA' });
        let hash = 2166136261;
        for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619);
        hashes.push(String(hash >>> 0));
        decoded.image.close();
      }
      decoder.close();
      return { available: true, frameCount, hashes };
    }, bytes);
    expect(result.available).toBe(true);
    expect(result.frameCount).toBe(4);
    expect(new Set(result.hashes).size).toBeGreaterThan(1);
  });
});
