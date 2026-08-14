import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Download, type Page } from '@playwright/test';
import {
  MEDIA_FIXTURE_DIR,
  authenticate,
  openDisposableWorkspace,
  openPanel,
} from './wp29-r5-harness.js';

type JourneyCheckpoint = {
  readonly name: string;
  readonly status: 'passed' | 'failed';
  readonly detail?: string;
};

type JourneyTelemetry = {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly failedRequests: string[];
  readonly httpErrors: string[];
};

const EXPECTED_SANDBOX_STORAGE_ERROR =
  "Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.";
const EXPORT_DOWNLOAD_TIMEOUT_MS = 240_000;

async function downloadSha256(download: Download): Promise<{ bytes: number; sha256: string }> {
  const stream = await download.createReadStream();
  if (stream === null) throw new Error('The browser did not expose the export bytes');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function importFixture(page: Page, fileName: string, displayName: string): Promise<void> {
  await openPanel(page, 'Assets');
  await page.getByRole('button', { name: 'Import media' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Import media' });
  const mimeType = fileName.endsWith('.mp4')
    ? 'video/mp4'
    : fileName.endsWith('.wav')
      ? 'audio/wav'
      : 'image/png';
  await drawer.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
    name: displayName,
    mimeType,
    buffer: readFileSync(join(MEDIA_FIXTURE_DIR, fileName)),
  });
  await expect(drawer.getByText(displayName, { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.locator('.asset-card', { hasText: displayName }).first()).toBeVisible({
    timeout: 15_000,
  });
}

function assetCategory(fileName: string): RegExp {
  if (fileName.endsWith('.mp4')) return /^Video/;
  if (fileName.endsWith('.wav')) return /^Audio/;
  return /^Images/;
}

async function selectAssetCategory(page: Page, fileName: string): Promise<void> {
  await page
    .getByRole('tablist', { name: 'Assets sections' })
    .getByRole('tab', { name: assetCategory(fileName) })
    .click();
}

async function previewAsset(page: Page, displayName: string): Promise<void> {
  await selectAssetCategory(page, displayName);
  const card = page.locator('.asset-card', { hasText: displayName }).first();
  await card.getByRole('button', { name: `Preview ${displayName}` }).click();
  const preview = page.getByRole('region', { name: `Preview: ${displayName}` });
  await expect(preview).toBeVisible();
  await expect(preview.locator('img, video, audio')).toBeVisible();
  await preview.getByRole('button', { name: 'Close preview' }).click();
  await expect(preview).toBeHidden();
}

async function addAssetToTimeline(page: Page, displayName: string): Promise<void> {
  await selectAssetCategory(page, displayName);
  const card = page.locator('.asset-card', { hasText: displayName }).first();
  await card.getByRole('button', { name: `Add ${displayName} to timeline` }).click();
  await expect(page.locator(`.timeline-clip[aria-label^="${displayName},"]`)).toHaveCount(1);
}

async function readControlPlaneProjectId(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const activeRaw = localStorage.getItem('joy-media.active-project.v1');
    if (activeRaw === null) return undefined;
    let active: { readonly projectId?: unknown };
    try {
      active = JSON.parse(activeRaw) as { readonly projectId?: unknown };
    } catch {
      return undefined;
    }
    if (typeof active.projectId !== 'string') return undefined;
    const bindingsRaw = localStorage.getItem('joy-media.control-plane-project-bindings.v1');
    if (bindingsRaw === null) return undefined;
    try {
      const bindings = JSON.parse(bindingsRaw) as {
        readonly bindingsByOwner?: Readonly<
          Record<string, Readonly<Record<string, { readonly controlPlaneProjectId?: unknown }>>>
        >;
      };
      const ownerBindings = bindings.bindingsByOwner?.['e2e-owner@example.test'];
      const binding = ownerBindings?.[active.projectId];
      return typeof binding?.controlPlaneProjectId === 'string'
        ? binding.controlPlaneProjectId
        : undefined;
    } catch {
      return undefined;
    }
  });
}

async function cleanupExactDisposableProject(page: Page, projectId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const headers = { authorization: 'Bearer joy-media-e2e-token' };
    const assetsResponse = await fetch(`/api/v1/projects/${encodeURIComponent(id)}/assets`, {
      headers,
    });
    if (!assetsResponse.ok && assetsResponse.status !== 404)
      throw new Error(
        `cleanup asset listing failed (${assetsResponse.status}): ${await assetsResponse.text()}`,
      );
    if (assetsResponse.ok) {
      const payload = (await assetsResponse.json()) as {
        readonly data?: readonly { readonly id: string }[];
      };
      for (const asset of payload.data ?? []) {
        await fetch(
          `/api/v1/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(asset.id)}`,
          { method: 'DELETE', headers },
        );
      }
    }
    const projectResponse = await fetch(`/api/v1/projects/${encodeURIComponent(id)}`, { headers });
    if (projectResponse.status === 404) return;
    if (!projectResponse.ok)
      throw new Error(`cleanup project lookup failed (${projectResponse.status})`);
    const projectPayload = (await projectResponse.json()) as {
      readonly data?: { readonly revision?: number };
    };
    const baseRevision = projectPayload.data?.revision;
    if (typeof baseRevision !== 'number')
      throw new Error('cleanup project revision is unavailable');
    const trashResponse = await fetch(`/api/v1/projects/${encodeURIComponent(id)}/trash`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision }),
    });
    if (!trashResponse.ok) throw new Error(`cleanup trash failed (${trashResponse.status})`);
    const deleteResponse = await fetch(`/api/v1/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    });
    if (!deleteResponse.ok) throw new Error(`cleanup delete failed (${deleteResponse.status})`);
  }, projectId);
}

async function runCheckpoint(
  checkpoints: JourneyCheckpoint[],
  name: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
    checkpoints.push({ name, status: 'passed' });
  } catch (error) {
    checkpoints.push({
      name,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

test.describe('WP-32 real-project workflow acceptance', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('completes the disposable-project journey from import through verified export', async ({
    page,
  }, testInfo) => {
    test.setTimeout(360_000);
    const suffix = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const title = `WP32 journey ${suffix}`;
    const names = {
      video: `wp32-video-${suffix}.mp4`,
      image: `wp32-image-${suffix}.png`,
      audio: `wp32-audio-${suffix}.wav`,
    } as const;
    const checkpoints: JourneyCheckpoint[] = [];
    const telemetry: JourneyTelemetry = {
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
      httpErrors: [],
    };
    page.on('console', (message) => {
      if (message.type() === 'error') telemetry.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => telemetry.pageErrors.push(error.message));
    page.on('requestfailed', (request) => {
      if (request.url().startsWith('http'))
        telemetry.failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400)
        telemetry.httpErrors.push(
          `${response.status()} ${response.request().method()} ${response.url()}`,
        );
    });

    let projectId: string | undefined;
    let exportEvidence: Record<string, unknown> = {};
    try {
      await runCheckpoint(checkpoints, 'create disposable project', async () => {
        await openDisposableWorkspace(page, title);
        await expect
          .poll(() => readControlPlaneProjectId(page), {
            message: 'The signed-in project must receive its opaque control-plane binding.',
            timeout: 15_000,
          })
          .toBeTruthy();
        projectId = await readControlPlaneProjectId(page);
        expect(projectId).toBeTruthy();
      });

      await runCheckpoint(checkpoints, 'import video, image, and audio fixtures', async () => {
        await importFixture(page, 'video.mp4', names.video);
        await importFixture(page, 'image.png', names.image);
        await importFixture(page, 'audio.wav', names.audio);
        await page.getByRole('tab', { name: /^All/ }).click();
        for (const displayName of Object.values(names)) {
          await expect(page.locator('.asset-card', { hasText: displayName }).first()).toBeVisible();
        }
      });

      await runCheckpoint(checkpoints, 'preview each imported asset', async () => {
        await previewAsset(page, names.video);
        await previewAsset(page, names.image);
        await previewAsset(page, names.audio);
      });

      await runCheckpoint(checkpoints, 'place all media on the timeline', async () => {
        await addAssetToTimeline(page, names.video);
        await addAssetToTimeline(page, names.image);
        await addAssetToTimeline(page, names.audio);
        await expect(page.locator('.timeline-clip[data-clip-id]')).toHaveCount(3);
      });

      await runCheckpoint(checkpoints, 'author a timeline edit', async () => {
        const videoClip = page.locator(`.timeline-clip[aria-label^="${names.video},"]`);
        await videoClip.click();
        await expect(videoClip).toHaveAttribute('aria-pressed', 'true');
        const clipId = await videoClip.getAttribute('data-clip-id');
        expect(clipId).toBeTruthy();
        const trimEnd = page.getByRole('button', { name: `Trim end of ${clipId}` });
        await trimEnd.press('Shift+ArrowLeft');
        await trimEnd.press('Shift+ArrowLeft');
        for (let step = 0; step < 5; step += 1) await trimEnd.press('ArrowLeft');
        await expect(videoClip).toHaveAttribute('aria-label', /, 0\.5s$/);
        await page.getByRole('button', { name: 'Duplicate clip' }).click();
        await expect(page.locator('.timeline-clip[data-clip-id]')).toHaveCount(4);
      });

      await runCheckpoint(checkpoints, 'import and render captions', async () => {
        await openPanel(page, 'Captions');
        await page.getByRole('button', { name: 'Add caption track' }).click();
        await expect(page.getByRole('button', { name: 'Add caption' })).toBeVisible();
        await page
          .locator('.captions-panel input[type="file"]')
          .setInputFiles(join(MEDIA_FIXTURE_DIR, 'captions-en.srt'));
        await expect(page.locator('.caption-row')).toHaveCount(1);
        await expect(page.locator('.caption-source')).toHaveValue('JOY Media');
        await expect(page.locator('.captions-list')).toContainText('0.00');
      });

      await runCheckpoint(
        checkpoints,
        'apply browser audio processing and mix controls',
        async () => {
          await page.locator(`.timeline-clip[aria-label^="${names.audio},"]`).click();
          await openPanel(page, 'Audio');
          await page.getByRole('button', { name: 'Review Voice Polish changes' }).click();
          const browserRun = page.getByRole('button', { name: 'Apply changes' });
          await expect(browserRun).toBeEnabled();
          await browserRun.click();
          await expect(page.getByText(/Browser Voice Polish applied to \d+ clips?\./)).toBeVisible({
            timeout: 15_000,
          });
          await page.getByRole('tab', { name: 'Mix' }).click();
          const gain = page.getByRole('slider', { name: /^Gain voice-/ });
          await expect(gain).toBeEnabled();
          await gain.fill('1.25');
          await expect(gain).toHaveValue('1.25');
        },
      );

      let firstDownload: { bytes: number; sha256: string } | undefined;
      let exportPath: string | undefined;
      await runCheckpoint(checkpoints, 'export and verify MP4', async () => {
        const downloadPromise = page.waitForEvent('download', {
          timeout: EXPORT_DOWNLOAD_TIMEOUT_MS,
        });
        await page.getByRole('button', { name: 'Export MP4' }).click();
        const download = await downloadPromise;
        firstDownload = await downloadSha256(download);
        exportPath = (await download.path()) ?? undefined;
        expect(firstDownload.bytes).toBeGreaterThan(0);
        expect(firstDownload.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(exportPath).toBeDefined();
        const probe = JSON.parse(
          execFileSync(
            'ffprobe',
            ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', exportPath!],
            { encoding: 'utf8' },
          ),
        ) as {
          readonly streams?: readonly {
            readonly codec_type?: string;
            readonly codec_name?: string;
          }[];
          readonly format?: { readonly duration?: string };
        };
        expect(probe.streams).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ codec_type: 'video', codec_name: 'h264' }),
            expect.objectContaining({ codec_type: 'audio', codec_name: 'aac' }),
          ]),
        );
        expect(Number(probe.format?.duration)).toBeGreaterThan(0);
        exportEvidence = {
          bytes: firstDownload.bytes,
          sha256: firstDownload.sha256,
          filename: download.suggestedFilename(),
          ffprobe: probe,
        };
      });

      await runCheckpoint(checkpoints, 'refresh and re-download the verified export', async () => {
        await page.reload();
        await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
        await openPanel(page, 'Audio');
        await page.getByRole('tab', { name: 'Mix' }).click();
        await expect(page.getByRole('slider', { name: /^Gain voice-/ })).toHaveValue('1.25');
        const processes = page.getByRole('button', { name: 'Recent processes' });
        if ((await processes.getAttribute('aria-expanded')) !== 'true') await processes.click();
        await expect(page.getByRole('region', { name: 'Recent processes' })).toBeVisible();
        const redownload = page.getByRole('link', { name: /Download .* again/ }).first();
        await expect(redownload).toBeVisible();
        const downloadPromise = page.waitForEvent('download');
        await redownload.click();
        const second = await downloadSha256(await downloadPromise);
        expect(second).toEqual(firstDownload);
        exportEvidence = { ...exportEvidence, durableRedownloadMatched: true };
      });
    } finally {
      await testInfo.attach('wp32-journey-evidence.json', {
        body: Buffer.from(
          `${JSON.stringify(
            {
              title,
              projectId,
              checkpoints,
              telemetry,
              export: exportEvidence,
              fixtureDirectory: MEDIA_FIXTURE_DIR,
            },
            null,
            2,
          )}\n`,
        ),
        contentType: 'application/json',
      });
      if (projectId !== undefined) {
        await cleanupExactDisposableProject(page, projectId);
      }
    }

    // First-party scene previews intentionally run in opaque, storage-free
    // iframes. Chromium reports the denied localStorage capability as a
    // pageerror; it is expected security telemetry, not an editor failure.
    expect(
      telemetry.pageErrors.filter((error) => error !== EXPECTED_SANDBOX_STORAGE_ERROR),
    ).toEqual([]);
    expect(telemetry.consoleErrors, telemetry.httpErrors.join('\n')).toEqual([]);
    expect(telemetry.httpErrors).toEqual([]);
    expect(telemetry.failedRequests).toEqual([]);
  });
});
