import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect, test as playwrightTest, type Page, type Route } from '@playwright/test';

const DEFAULT_BASE_URL = 'http://127.0.0.1:5173';
const DEFAULT_FIXTURE = 'packages/test-fixtures/media/timecode-tone.mp4';
const TEST_TOKEN = 'browser-smoke-token';
const TEST_ACCOUNT = 'browser-smoke@joy.media';
const ASSET_ID = 'real-media-loop';
const HAVE_CURRENT_DATA = 2;

export const test = playwrightTest;

interface JourneyOptions {
  readonly page: Page;
  readonly baseUrl: string;
  readonly fixturePath: string;
}

interface BrowserAsset {
  readonly id: string;
  readonly projectId: string;
  readonly kind: 'video' | 'audio' | 'image';
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: {
    readonly mimeType: string;
    readonly durationUs?: number;
    readonly width?: number;
    readonly height?: number;
  };
  readonly tags: readonly string[];
  readonly createdAt: number;
}

interface DomInspection {
  readonly buttonLabels: readonly string[];
  readonly panelLabels: readonly string[];
  readonly fileInputs: number;
}

interface FrameProbe {
  readonly firstHash: string;
  readonly secondHash: string;
  readonly firstMean: number;
  readonly secondMean: number;
  readonly changedPixels: number;
  readonly width: number;
  readonly height: number;
  readonly readyState: number;
  readonly duration: number;
  readonly currentSrcScheme: string;
}

interface AudioProbe {
  readonly readyState: number;
  readonly duration: number;
  readonly audioTracks: number;
  readonly captureStreamAudioTracks: number;
  readonly webkitAudioDecodedByteCount?: number;
}

export async function runRealMediaLoopJourney({
  page,
  baseUrl,
  fixturePath,
}: JourneyOptions): Promise<void> {
  const fixture = fixtureInfo(fixturePath);
  const assets = new Map<string, BrowserAsset>();

  page.on('console', (message) => {
    console.log(`[browser:${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    console.log(`[browser:pageerror] ${error.message}`);
  });

  await installApiMock(page, assets);
  await page.addInitScript((token) => {
    window.localStorage.setItem('joy-media-session-token', token);
  }, TEST_TOKEN);

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const initialDom = await inspectDom(page);
  console.log(`[smoke] initial DOM ${JSON.stringify(initialDom)}`);

  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByPlaceholder('Project name').fill('Browser smoke real-media loop');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('navigation', { name: 'Application menu' })).toBeVisible();

  await expect(page.locator('.timeline-clip')).toHaveCount(0);
  await page.getByRole('button', { name: 'Import media' }).first().click();
  await page
    .locator('input[type="file"][aria-label="Media file"]')
    .setInputFiles(fixture.absolutePath);
  await page.getByLabel('Asset ID').fill(ASSET_ID);
  await page.getByRole('button', { name: 'Confirm import' }).click();
  const registered = await waitForAssetRegistration(assets, ASSET_ID);
  console.log(`[smoke] registered asset ${JSON.stringify(registered)}`);

  await page.getByRole('tab', { name: /Video 1/ }).click();
  const card = page.locator('li.asset-card').filter({ hasText: fixture.displayName }).first();
  await expect(card).toBeVisible();
  const targetLane = page.locator('.timeline-virtual-lane').first();
  await expect(targetLane).toBeVisible();
  await card.dragTo(targetLane, { targetPosition: { x: 8, y: 24 } });
  await expect(page.locator('.timeline-clip')).toHaveCount(1);
  const timelineAfterImport = await timelineClipSummary(page);
  assertSingleClipNearStart(timelineAfterImport);
  console.log(`[smoke] timeline after import ${JSON.stringify(timelineAfterImport)}`);

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.timeline-clip')).toHaveCount(1);
  const timelineAfterReload = await timelineClipSummary(page);
  assertSingleClipNearStart(timelineAfterReload);
  console.log(`[smoke] timeline after reload ${JSON.stringify(timelineAfterReload)}`);

  await page.getByRole('button', { name: 'Seek forward 1s' }).click();
  await waitForPlaybackMediaReady(page);

  const frameProbe = await probeChangingFrames(page);
  assertFrameProbe(frameProbe);
  console.log(`[smoke] frame probe ${JSON.stringify(frameProbe)}`);

  const audioProbe = await probeAudioReadiness(page);
  assertAudioProbe(audioProbe);
  console.log(`[smoke] audio probe ${JSON.stringify(audioProbe)}`);

  await page.locator('.panel-tab[aria-label="Assets"]').click();
  await page.getByRole('tab', { name: /Video 1/ }).click();
  await expect(page.getByRole('button', { name: `Preview ${fixture.displayName}` })).toBeVisible();
  await page.waitForLoadState('networkidle');
  console.log('[smoke] reopened Assets with imported media visible');
}

async function installApiMock(page: Page, assets: Map<string, BrowserAsset>): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method();

    if (method === 'GET' && path === '/v1/auth/session') {
      await json(route, {
        contact: TEST_ACCOUNT,
        method: 'gmail',
        displayName: 'Browser Smoke',
        avatarAvailable: false,
      });
      return;
    }

    if (method === 'POST' && path === '/v1/projects') {
      await json(route, {});
      return;
    }

    if (method === 'GET' && path === '/v1/library/my-assets') {
      await json(route, [...assets.values()]);
      return;
    }

    if (method === 'GET' && path === '/v1/library/cloud-assets') {
      await json(route, []);
      return;
    }

    const projectAssetsMatch = path.match(/^\/v1\/projects\/([^/]+)\/assets$/);
    if (projectAssetsMatch !== null && method === 'GET') {
      const projectId = decodeURIComponent(projectAssetsMatch[1]!);
      await json(
        route,
        [...assets.values()].filter((asset) => asset.projectId === projectId),
      );
      return;
    }

    if (projectAssetsMatch !== null && method === 'POST') {
      const projectId = decodeURIComponent(projectAssetsMatch[1]!);
      const body = (await request.postDataJSON()) as {
        readonly id: string;
        readonly kind: BrowserAsset['kind'];
        readonly displayName: string;
        readonly sha256: string;
        readonly bytes: number;
        readonly descriptor: BrowserAsset['descriptor'];
      };
      const asset: BrowserAsset = {
        id: body.id,
        projectId,
        kind: body.kind,
        displayName: body.displayName,
        sha256: body.sha256,
        bytes: body.bytes,
        descriptor: body.descriptor,
        tags: ['category-video', 'browser-smoke'],
        createdAt: Date.now(),
      };
      assets.set(asset.id, asset);
      await json(route, asset);
      return;
    }

    const derivativesMatch = path.match(/^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/derivatives$/);
    if (derivativesMatch !== null && method === 'GET') {
      await json(route, []);
      return;
    }

    const retagMatch = path.match(/^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/retag$/);
    if (retagMatch !== null && method === 'POST') {
      const assetId = decodeURIComponent(retagMatch[2]!);
      const asset = assets.get(assetId);
      await json(route, asset ?? {});
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: `unhandled smoke route ${method} ${path}` } }),
    });
  });
}

async function inspectDom(page: Page): Promise<DomInspection> {
  await page.waitForLoadState('networkidle');
  return page.evaluate(() => ({
    buttonLabels: Array.from(document.querySelectorAll('button'))
      .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')
      .filter(Boolean)
      .slice(0, 18),
    panelLabels: Array.from(document.querySelectorAll('[aria-label]'))
      .map((element) => element.getAttribute('aria-label') ?? '')
      .filter(Boolean)
      .slice(0, 24),
    fileInputs: document.querySelectorAll('input[type="file"]').length,
  }));
}

async function waitForAssetRegistration(
  assets: ReadonlyMap<string, BrowserAsset>,
  id: string,
): Promise<BrowserAsset> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const asset = assets.get(id);
    if (asset !== undefined) return asset;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`asset ${id} was not registered`);
}

async function timelineClipSummary(page: Page): Promise<unknown> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.timeline-clip')).map((clip) => ({
      label: clip.textContent?.replace(/\s+/g, ' ').trim(),
      title: clip.getAttribute('title'),
    })),
  );
}

function assertSingleClipNearStart(summary: unknown): void {
  expect(Array.isArray(summary)).toBeTruthy();
  expect((summary as unknown[]).length).toBe(1);
  const title = (summary as { readonly title?: unknown }[])[0]?.title;
  expect(typeof title).toBe('string');
  const match = String(title).match(/· ([\d.]+)s/);
  expect(match).not.toBeNull();
  expect(Number(match?.[1] ?? Number.NaN)).toBeLessThan(1);
}

async function waitForPlaybackMediaReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('video.playback-media');
    return (
      video !== null &&
      video.currentSrc.startsWith('blob:') &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    );
  });
}

async function probeChangingFrames(page: Page): Promise<FrameProbe> {
  return page.evaluate(`(async () => {
    const video = document.querySelector('video.playback-media');
    if (video === null) throw new Error('playback media element is missing');
    const waitFor = (type) =>
      new Promise((resolve, reject) => {
        const onOk = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error('video emitted error while waiting for ' + type));
        };
        const cleanup = () => {
          video.removeEventListener(type, onOk);
          video.removeEventListener('error', onError);
        };
        video.addEventListener(type, onOk, { once: true });
        video.addEventListener('error', onError, { once: true });
      });
    const capture = async (seconds) => {
      video.pause();
      if (Math.abs(video.currentTime - seconds) > 0.01) {
        video.currentTime = seconds;
        await waitFor('seeked');
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await waitFor('loadeddata');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('2d canvas unavailable');
      context.drawImage(video, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    const first = await capture(0.4);
    const second = await capture(1.8);
    const stats = (image) => {
      let sum = 0;
      let hash = 2166136261;
      for (let index = 0; index < image.data.length; index += 4) {
        const value = image.data[index] + image.data[index + 1] + image.data[index + 2];
        sum += value;
        hash ^= value & 0xff;
        hash = Math.imul(hash, 16777619);
      }
      return {
        mean: sum / (image.width * image.height * 3),
        hash: (hash >>> 0).toString(16).padStart(8, '0'),
      };
    };
    let changedPixels = 0;
    for (let index = 0; index < first.data.length; index += 4) {
      const delta =
        Math.abs(first.data[index] - second.data[index]) +
        Math.abs(first.data[index + 1] - second.data[index + 1]) +
        Math.abs(first.data[index + 2] - second.data[index + 2]);
      if (delta > 20) changedPixels += 1;
    }
    const firstStats = stats(first);
    const secondStats = stats(second);
    return {
      firstHash: firstStats.hash,
      secondHash: secondStats.hash,
      firstMean: firstStats.mean,
      secondMean: secondStats.mean,
      changedPixels,
      width: video.videoWidth,
      height: video.videoHeight,
      readyState: video.readyState,
      duration: video.duration,
      currentSrcScheme: video.currentSrc.split(':', 1)[0] ?? '',
    };
  })()`) as Promise<FrameProbe>;
}

function assertFrameProbe(probe: FrameProbe): void {
  expect(probe.currentSrcScheme).toBe('blob');
  expect(probe.width).toBeGreaterThan(0);
  expect(probe.height).toBeGreaterThan(0);
  expect(probe.readyState).toBeGreaterThanOrEqual(HAVE_CURRENT_DATA);
  expect(probe.firstMean).toBeGreaterThan(2);
  expect(probe.secondMean).toBeGreaterThan(2);
  expect(probe.firstHash).not.toBe(probe.secondHash);
  expect(probe.changedPixels).toBeGreaterThan(500);
}

async function probeAudioReadiness(page: Page): Promise<AudioProbe> {
  return page.evaluate(`(() => {
    const video = document.querySelector('video.playback-media');
    if (video === null) throw new Error('playback media element is missing');
    const stream =
      typeof video.captureStream === 'function'
        ? video.captureStream()
        : undefined;
    const audioTracks =
      'audioTracks' in video && video.audioTracks !== undefined
        ? video.audioTracks.length
        : 0;
    const webkitAudioDecodedByteCount =
      'webkitAudioDecodedByteCount' in video
        ? Number(video.webkitAudioDecodedByteCount)
        : undefined;
    return {
      readyState: video.readyState,
      duration: video.duration,
      audioTracks,
      captureStreamAudioTracks: stream?.getAudioTracks().length ?? 0,
      ...(webkitAudioDecodedByteCount === undefined ? {} : { webkitAudioDecodedByteCount }),
    };
  })()`) as Promise<AudioProbe>;
}

function assertAudioProbe(probe: AudioProbe): void {
  expect(probe.readyState).toBeGreaterThanOrEqual(HAVE_CURRENT_DATA);
  expect(probe.duration).toBeGreaterThan(1);
  expect(
    probe.audioTracks > 0 ||
      probe.captureStreamAudioTracks > 0 ||
      (probe.webkitAudioDecodedByteCount ?? 0) > 0,
  ).toBeTruthy();
}

function fixtureInfo(inputPath: string): {
  readonly absolutePath: string;
  readonly displayName: string;
  readonly bytes: number;
  readonly sha256: string;
} {
  const absolutePath = resolveFixturePath(inputPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`fixture does not exist: ${absolutePath}`);
  }
  const bytes = statSync(absolutePath).size;
  const sha256 = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  return {
    absolutePath,
    displayName: absolutePath.split(/[\\/]/).at(-1) ?? 'media.mp4',
    bytes,
    sha256,
  };
}

function resolveFixturePath(inputPath: string): string {
  const cwdPath = resolve(inputPath);
  if (existsSync(cwdPath)) return cwdPath;
  const repoPath = resolve(fileURLToPath(new URL('../../..', import.meta.url)), inputPath);
  if (existsSync(repoPath)) return repoPath;
  return cwdPath;
}

async function json(route: Route, data: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const baseUrl = process.env.JOY_MEDIA_BROWSER_URL ?? DEFAULT_BASE_URL;
  const fixturePath = process.env.JOY_MEDIA_REAL_MEDIA_FIXTURE ?? DEFAULT_FIXTURE;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await runRealMediaLoopJourney({ page, baseUrl, fixturePath });
  } finally {
    await browser.close();
  }
}
