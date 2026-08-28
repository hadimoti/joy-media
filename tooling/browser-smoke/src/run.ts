import { createHash } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect, test as playwrightTest, type Page, type Route } from '@playwright/test';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5173;
const DEFAULT_FIXTURE = 'packages/test-fixtures/media/timecode-tone.mp4';
const TEST_TOKEN = 'browser-smoke-token';
const TEST_ACCOUNT = 'browser-smoke@joy.media';
const ASSET_ID = 'real-media-loop';
const HAVE_CURRENT_DATA = 2;

type EditorServerProcess = ChildProcessByStdio<null, Readable, Readable>;

export const test = playwrightTest;

interface JourneyOptions {
  readonly page: Page;
  readonly baseUrl: string;
  readonly fixturePath: string;
}

export interface AuthenticatedEditorJourneyEvidence {
  readonly journeyId: 'authenticated-editor-1.0';
  readonly status: 'verified';
  /** This runner deliberately intercepts API calls and is never release evidence. */
  readonly execution: 'mocked';
  readonly verifiedAt: string;
  readonly assertions: Readonly<Record<string, unknown>>;
  readonly screenshots: readonly string[];
}

/** Viewports covered by the authenticated shell contract. Keep this matrix
 * small and representative so evidence remains useful in CI. */
export const AUTHENTICATED_SHELL_VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
] as const;

export interface ViewportShellEvidence {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly document: {
    readonly innerWidth: number;
    readonly scrollWidth: number;
    readonly scrollHeight: number;
  };
  readonly coreControls: readonly CoreControlEvidence[];
  readonly clippedControls: readonly CoreControlEvidence[];
  readonly keyboardShortcuts: 'opened-focused-and-escaped';
}

export interface CoreControlEvidence {
  readonly name: string;
  readonly index: number;
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

export interface ViewportDocumentMetrics {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
}

/** Document overflow excludes intentional scrolling inside panels/canvases. */
export function hasPageOverflow(metrics: ViewportDocumentMetrics): boolean {
  return metrics.scrollWidth > metrics.innerWidth || metrics.scrollHeight > metrics.innerHeight;
}

export function clippedCoreControls(
  controls: readonly CoreControlEvidence[],
  viewport: { readonly width: number; readonly height: number },
): readonly CoreControlEvidence[] {
  return controls.filter(
    ({ rect }) =>
      rect.left < -1 ||
      rect.top < -1 ||
      rect.right > viewport.width + 1 ||
      rect.bottom > viewport.height + 1,
  );
}

export const AUTHENTICATED_CORE_CONTROL_SPECS = [
  { name: 'Import media', selector: 'button[aria-label="Import media"]' },
  { name: 'Export action', selector: 'button.header-export-btn' },
  { name: 'Delivery action', selector: 'button.header-deliver-btn' },
  { name: 'Timeline seek', selector: 'button[aria-label="Seek forward 1s"]' },
  { name: 'Timeline clip', selector: '.timeline-clip' },
] as const;

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

export interface BrowserSmokeCliPlan {
  readonly baseUrl: string;
  readonly fixturePath: string;
  readonly server?:
    | {
        readonly command: string;
        readonly args: readonly string[];
        readonly port: number;
      }
    | undefined;
}

export function buildBrowserSmokeCliPlan(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BrowserSmokeCliPlan {
  const fixturePath = env.JOY_MEDIA_REAL_MEDIA_FIXTURE ?? DEFAULT_FIXTURE;
  const externalUrl = env.JOY_MEDIA_BROWSER_URL?.trim();
  if (externalUrl !== undefined && externalUrl.length > 0) {
    return { baseUrl: externalUrl, fixturePath };
  }

  const port = parsePort(env.JOY_MEDIA_BROWSER_PORT);
  return {
    baseUrl: `http://${DEFAULT_HOST}:${port}`,
    fixturePath,
    server: {
      command: pnpmExecutable(platform),
      args: [
        '--filter',
        '@joy-media/editor-web',
        'dev',
        '--host',
        DEFAULT_HOST,
        '--port',
        String(port),
        '--strictPort',
      ],
      port,
    },
  };
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
  page.on('response', (response) => {
    if (response.status() >= 400) {
      console.log(
        `[browser:http-${response.status()}] ${response.request().method()} ${response.url()}`,
      );
    }
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
  // The project title field is localized in the UI; use its semantic role so
  // the smoke journey remains valid across supported locales.
  await page.getByRole('textbox').fill('Browser smoke real-media loop');
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

async function runCli(): Promise<void> {
  const plan = buildBrowserSmokeCliPlan();
  if (plan.server !== undefined) {
    await ensurePortFree(plan.server.port);
  }
  const server = plan.server === undefined ? undefined : startEditorServer(plan.server);
  try {
    if (server !== undefined) {
      await waitForPort(server.port, server.process);
    }
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const evidence = await runAuthenticatedEditorJourney({
        page,
        baseUrl: plan.baseUrl,
        fixturePath: plan.fixturePath,
      });
      const outputDirectory = resolve(repoRoot(), 'test-output/browser/authenticated-editor-1.0');
      mkdirSync(outputDirectory, { recursive: true });
      const evidencePath = join(outputDirectory, 'journey-evidence.json');
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      writeFileSync(
        resolve(repoRoot(), 'test-output/browser/journeys.json'),
        `${JSON.stringify(
          [
            {
              id: evidence.journeyId,
              status: evidence.status,
              verifiedAt: evidence.verifiedAt,
              evidencePath: relative(repoRoot(), evidencePath),
            },
          ],
          null,
          2,
        )}\n`,
      );
      console.log(`[journey] evidence written to ${evidencePath}`);
    } finally {
      await browser.close();
    }
  } finally {
    if (server !== undefined) await stopEditorServer(server.process);
  }
}

/**
 * Release-grade authenticated editor journey. This is intentionally local and
 * deterministic: API calls are intercepted by the same bounded mock used by
 * the real-media smoke path, while the editor, browser media decoder, Motion
 * Studio persistence, and MP4 encoder all run for real.
 */
export async function runAuthenticatedEditorJourney({
  page,
  baseUrl,
  fixturePath,
}: JourneyOptions): Promise<AuthenticatedEditorJourneyEvidence> {
  const fixture = fixtureInfo(fixturePath);
  const assets = new Map<string, BrowserAsset>();
  const screenshots: string[] = [];
  const assertions: Record<string, unknown> = {};
  const evidenceDirectory = resolve(repoRoot(), 'test-output/browser/authenticated-editor-1.0');
  mkdirSync(evidenceDirectory, { recursive: true });

  page.on('console', (message) => {
    console.log(`[browser:${message.type()}] ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      console.log(
        `[browser:http-${response.status()}] ${response.request().method()} ${response.url()}`,
      );
    }
  });
  page.on('pageerror', (error) => {
    console.log(`[browser:pageerror] ${error.message}`);
  });

  await installApiMock(page, assets);
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const login = page.getByRole('dialog', { name: 'Joy Studio login' });
  await expect(login).toBeVisible();
  await login.getByRole('button', { name: 'Token' }).click();
  await login.getByRole('combobox').fill(TEST_TOKEN);
  await login.getByRole('button', { name: 'Login →' }).click();
  await expect(login).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
  assertions.login = 'token login UI completed and authenticated session was probed';
  await captureJourneyScreenshot(page, evidenceDirectory, screenshots, '01-authenticated');

  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('textbox').fill('Authenticated release journey');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.timeline-clip')).toHaveCount(0);

  await page.getByRole('button', { name: 'Import media' }).first().click();
  await page
    .locator('input[type="file"][aria-label="Media file"]')
    .setInputFiles(fixture.absolutePath);
  await page.getByLabel('Asset ID').fill(ASSET_ID);
  await page.getByRole('button', { name: 'Confirm import' }).click();
  const registered = await waitForAssetRegistration(assets, ASSET_ID);
  assertions.asset = {
    id: registered.id,
    bytes: registered.bytes,
    sha256: registered.sha256,
    durationUs: registered.descriptor.durationUs,
  };

  await page.getByRole('tab', { name: /Video 1/ }).click();
  const card = page.locator('li.asset-card').filter({ hasText: fixture.displayName }).first();
  await expect(card).toBeVisible();
  const targetLane = page.locator('.timeline-virtual-lane').first();
  await expect(targetLane).toBeVisible();
  await card.dragTo(targetLane, { targetPosition: { x: 8, y: 24 } });
  await expect(page.locator('.timeline-clip')).toHaveCount(1);
  const timelineAfterEdit = await timelineClipSummary(page);
  assertSingleClipNearStart(timelineAfterEdit);
  assertions.timelineEdit = timelineAfterEdit;
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.timeline-clip')).toHaveCount(1);
  await page.getByRole('button', { name: 'Seek forward 1s' }).click();
  await waitForPlaybackMediaReady(page);
  const frameProbe = await probeChangingFrames(page);
  assertFrameProbe(frameProbe);
  const audioProbe = await probeAudioReadiness(page);
  assertAudioProbe(audioProbe);
  assertions.mediaPlayback = { frameProbe, audioProbe };
  await captureJourneyScreenshot(page, evidenceDirectory, screenshots, '02-project-timeline');

  // Export the real source-backed clip before adding a Motion Scene overlay.
  // The browser encoder produces an actual H.264/AAC MP4 and records its
  // byte/frame evidence in the app's durable export history.
  const exportButton = page.locator('button.header-export-btn');
  console.log(`[journey] export controls ${JSON.stringify(await inspectDom(page))}`);
  await expect(exportButton).toBeVisible();
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await page.waitForFunction(
    () => {
      const raw = window.localStorage.getItem('joy-media.export-history.v1');
      if (raw === null) return false;
      try {
        const entries = JSON.parse(raw) as Array<{
          status?: string;
          totalBytes?: number;
          frameCount?: number;
          channel?: string;
        }>;
        const latest = entries[0];
        return (
          latest?.status === 'completed' &&
          latest.totalBytes !== undefined &&
          latest.totalBytes > 0 &&
          latest.frameCount !== undefined &&
          latest.frameCount > 0 &&
          latest.channel === 'quick-browser-export'
        );
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 120_000 },
  );
  const exportEvidence = await page.evaluate(() => {
    const raw = window.localStorage.getItem('joy-media.export-history.v1');
    if (raw === null) throw new Error('export history was not persisted');
    const entries = JSON.parse(raw) as readonly Record<string, unknown>[];
    const latest = entries[0];
    if (latest === undefined) throw new Error('export history is empty');
    return latest;
  });
  assertions.verifiedExport = exportEvidence;
  await captureJourneyScreenshot(page, evidenceDirectory, screenshots, '03-real-mp4-export');

  await page.locator('.timeline-clip').first().click();
  await page.locator('.panel-tab[aria-label="Motion"]').click();
  await expect(page.getByRole('complementary', { name: 'Motion sections' })).toBeVisible();
  await page.getByRole('button', { name: 'Create new motion' }).click();
  const studio = page.locator('.motion-studio-overlay');
  await expect(studio).toBeVisible();
  await studio.getByRole('button', { name: 'Add rectangle' }).click();
  await expect(studio.locator('.ms-layer-row')).toHaveCount(1);
  await studio.getByRole('button', { name: 'Undo' }).click();
  await expect(studio.locator('.ms-layer-row')).toHaveCount(0);
  await studio.getByRole('button', { name: 'Redo' }).click();
  await expect(studio.locator('.ms-layer-row')).toHaveCount(1);
  await studio.getByRole('button', { name: 'Preview motion' }).click();
  await page.waitForTimeout(180);
  await studio.getByRole('button', { name: 'Publish motion' }).click();
  const motionCatalog = await page.evaluate(() => {
    const raw = window.localStorage.getItem('joy-media.motion-scene-catalog.v1');
    if (raw === null) throw new Error('Motion Studio catalog was not saved');
    return JSON.parse(raw) as {
      readonly scenes?: Record<string, { readonly title?: string; readonly publishedAt?: string }>;
    };
  });
  const motionEntry = Object.values(motionCatalog.scenes ?? {})[0];
  if (motionEntry?.title === undefined || motionEntry.publishedAt === undefined) {
    throw new Error('Motion Studio publish did not create a published catalog entry');
  }
  assertions.motionStudio = {
    title: motionEntry.title,
    publishedAt: motionEntry.publishedAt,
    layerCount: await studio.locator('.ms-layer-row').count(),
    preview: 'played',
    undoRedo: 'passed',
  };
  await captureJourneyScreenshot(
    page,
    evidenceDirectory,
    screenshots,
    '04-motion-studio-published',
  );
  await studio.getByRole('button', { name: 'Back to editor' }).click();
  await expect(studio).toBeHidden();

  await page.locator('.panel-tab[aria-label="Motion"]').click();
  await page.getByRole('tab', { name: 'My Motions' }).click();
  const placeButton = page.getByRole('button', {
    name: `Place ${motionEntry.title} on the timeline`,
  });
  await expect(placeButton).toBeEnabled();
  await placeButton.click();
  const timelineAfterPlacement = await timelineClipSummary(page);
  if (!Array.isArray(timelineAfterPlacement) || timelineAfterPlacement.length < 2) {
    throw new Error('Published Motion Studio scene was not placed on the timeline');
  }
  assertions.motionPlacement = timelineAfterPlacement;
  await captureJourneyScreenshot(page, evidenceDirectory, screenshots, '05-motion-placed');

  const undoButtonBeforeReopen = page.getByRole('button', { name: 'Undo' });
  const redoButtonBeforeReopen = page.getByRole('button', { name: 'Redo' });
  await expect(undoButtonBeforeReopen).toBeEnabled();
  await undoButtonBeforeReopen.click();
  const timelineAfterTimelineUndo = await timelineClipSummary(page);
  await expect(redoButtonBeforeReopen).toBeEnabled();
  await redoButtonBeforeReopen.click();
  const timelineAfterTimelineRedo = await timelineClipSummary(page);
  if (
    !Array.isArray(timelineAfterTimelineUndo) ||
    !Array.isArray(timelineAfterTimelineRedo) ||
    timelineAfterTimelineUndo.length >= timelineAfterTimelineRedo.length
  ) {
    throw new Error('Timeline undo/redo did not change and restore the project');
  }
  assertions.undoRedo = {
    afterUndo: timelineAfterTimelineUndo,
    afterRedo: timelineAfterTimelineRedo,
  };

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('navigation', { name: 'Application menu' })).toBeVisible();
  const timelineAfterReopen = await timelineClipSummary(page);
  if (!Array.isArray(timelineAfterReopen) || timelineAfterReopen.length < 2) {
    throw new Error('Project or Motion Studio placement did not survive browser reopen');
  }
  assertions.reopen = timelineAfterReopen;
  assertions.undoRedoAfterReopen = 'reopened persisted timeline after the verified undo/redo cycle';
  await captureJourneyScreenshot(page, evidenceDirectory, screenshots, '06-reopen-undo-redo');

  assertions.shellViewports = await verifyAuthenticatedShellViewports(
    page,
    evidenceDirectory,
    screenshots,
  );

  return {
    journeyId: 'authenticated-editor-1.0',
    status: 'verified',
    execution: 'mocked',
    verifiedAt: new Date().toISOString(),
    assertions,
    screenshots,
  };
}

/** Run deterministic shell layout checks at each supported desktop viewport. */
export async function verifyAuthenticatedShellViewports(
  page: Page,
  evidenceDirectory: string,
  screenshots: string[],
): Promise<readonly ViewportShellEvidence[]> {
  const evidence: ViewportShellEvidence[] = [];
  for (const viewport of AUTHENTICATED_SHELL_VIEWPORTS) {
    await page.setViewportSize(viewport);
    const shell = await page.evaluate((specs) => {
      const coreControls: CoreControlEvidence[] = [];
      for (const { name, selector } of specs) {
        const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
        if (elements.length === 0) throw new Error(`missing core shell control: ${name}`);
        elements.forEach((element, index) => {
          const rect = element.getBoundingClientRect();
          coreControls.push({
            name,
            index,
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          });
        });
      }
      const clippedControls = coreControls.filter(
        ({ rect }) =>
          rect.left < -1 ||
          rect.top < -1 ||
          rect.right > innerWidth + 1 ||
          rect.bottom > innerHeight + 1,
      );
      return {
        document: {
          innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
        },
        coreControls,
        clippedControls,
      };
    }, AUTHENTICATED_CORE_CONTROL_SPECS);
    expect(
      hasPageOverflow({
        ...shell.document,
        innerHeight: viewport.height,
      }),
    ).toBe(false);
    expect(clippedCoreControls(shell.coreControls, viewport)).toEqual([]);

    const shortcutButton = page.getByRole('button', { name: 'Keyboard shortcuts' });
    await expect(shortcutButton).toBeVisible();
    await shortcutButton.click();
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close shortcuts' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    const item: ViewportShellEvidence = {
      viewport,
      document: shell.document,
      coreControls: shell.coreControls,
      clippedControls: shell.clippedControls,
      keyboardShortcuts: 'opened-focused-and-escaped',
    };
    evidence.push(item);
    await captureJourneyScreenshot(
      page,
      evidenceDirectory,
      screenshots,
      `07-shell-${viewport.width}x${viewport.height}`,
    );
  }
  return evidence;
}

async function captureJourneyScreenshot(
  page: Page,
  evidenceDirectory: string,
  screenshots: string[],
  name: string,
): Promise<void> {
  const path = join(evidenceDirectory, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  screenshots.push(relative(repoRoot(), path));
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

    if (method === 'GET' && path === '/v1/workers') {
      await json(route, []);
      return;
    }

    const projectJobsMatch = path.match(/^\/v1\/projects\/([^/]+)\/jobs$/);
    if (projectJobsMatch !== null && method === 'GET') {
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

function repoRoot(): string {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

function pnpmExecutable(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`JOY_MEDIA_BROWSER_PORT must be a valid TCP port, got "${raw}"`);
  }
  return port;
}

function startEditorServer(server: NonNullable<BrowserSmokeCliPlan['server']>): {
  readonly process: EditorServerProcess;
  readonly port: number;
} {
  console.log(`[smoke] starting editor server: ${server.command} ${server.args.join(' ')}`);
  const child = spawn(server.command, [...server.args], {
    cwd: repoRoot(),
    env: process.env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[server] ${chunk.toString()}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[server] ${chunk.toString()}`);
  });
  return { process: child, port: server.port };
}

async function waitForPort(
  port: number,
  child: EditorServerProcess,
  timeoutMs = 60_000,
): Promise<void> {
  const startTime = Date.now();
  const deadline = Date.now() + timeoutMs;
  let exit:
    | {
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }
    | undefined;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  while (Date.now() < deadline) {
    if (exit !== undefined) {
      throw new Error(
        `editor dev server exited before port ${port} was ready (${exit.code ?? exit.signal})`,
      );
    }
    if (Date.now() - startTime > 250 && (await canConnect(port))) {
      console.log(`[smoke] editor server ready on http://${DEFAULT_HOST}:${port}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for editor dev server on port ${port}`);
}

async function ensurePortFree(port: number): Promise<void> {
  if (!(await canConnect(port))) return;
  throw new Error(
    `port ${port} is already in use; set JOY_MEDIA_BROWSER_URL to reuse it or JOY_MEDIA_BROWSER_PORT to start an isolated server`,
  );
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveCanConnect) => {
    const socket = connect({ host: DEFAULT_HOST, port });
    socket.once('connect', () => {
      socket.end();
      resolveCanConnect(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolveCanConnect(false);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolveCanConnect(false);
    });
  });
}

async function stopEditorServer(child: EditorServerProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    await new Promise<void>((resolveTaskkill) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
      });
      killer.once('exit', () => resolveTaskkill());
      killer.once('error', () => resolveTaskkill());
    });
    await waitForChildExit(child, 5_000);
    return;
  }

  child.kill();
  const stopped = await waitForChildExit(child, 5_000);
  if (stopped || child.exitCode !== null) return;
  child.kill('SIGKILL');
}

function waitForChildExit(child: EditorServerProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveStopped) => {
    const timer = setTimeout(() => resolveStopped(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStopped(true);
    });
  });
}

async function json(route: Route, data: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runCli();
}
