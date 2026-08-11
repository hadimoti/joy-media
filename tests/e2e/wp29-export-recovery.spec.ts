import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Download } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  authenticate,
  MEDIA_FIXTURE_DIR,
  openDisposableWorkspace,
  openPanel,
} from './wp29-r5-harness.js';

async function downloadSha256(download: Download): Promise<{ bytes: number; sha256: string }> {
  const stream = await download.createReadStream();
  if (stream === null) throw new Error('Chrome did not expose the downloaded MP4 bytes');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function addFixtureVideo(page: Parameters<typeof authenticate>[0]): Promise<void> {
  const videoName = `export-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`;
  await openPanel(page, 'Assets');
  await page.getByRole('button', { name: 'Import media' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Import media' });
  await drawer.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
    name: videoName,
    mimeType: 'video/mp4',
    buffer: readFileSync(join(MEDIA_FIXTURE_DIR, 'video.mp4')),
  });
  await expect(drawer.getByText(videoName, { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.locator('.asset-card', { hasText: videoName }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page
    .locator('.asset-card', { hasText: videoName })
    .first()
    .getByRole('button', { name: `Add ${videoName} to timeline` })
    .click();
  const timelineClip = page.locator(`.timeline-clip[data-clip-id][aria-label^="${videoName},"]`);
  await expect(timelineClip).toHaveCount(1);
  const clipId = await timelineClip.getAttribute('data-clip-id');
  if (clipId === null) throw new Error('Fixture clip id is unavailable');
  await expect
    .poll(() =>
      page.evaluate((expectedClipId) => {
        const raw = window.localStorage.getItem('joy-media.visual-object-project-log.v1');
        if (raw === null) return false;
        const database = JSON.parse(raw) as {
          readonly projects?: Readonly<
            Record<
              string,
              {
                readonly snapshots?: readonly {
                  readonly revision?: number;
                  readonly payload?: {
                    readonly audio?: { readonly clips?: Record<string, unknown> };
                  };
                }[];
              }
            >
          >;
        };
        return Object.values(database.projects ?? {}).some((project) => {
          const latest = [...(project.snapshots ?? [])].sort(
            (left, right) => (right.revision ?? -1) - (left.revision ?? -1),
          )[0];
          return latest?.payload?.audio?.clips?.[expectedClipId] !== undefined;
        });
      }, clipId),
    )
    .toBe(true);
}

async function openProcesses(page: Parameters<typeof authenticate>[0]): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Recent processes' });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(page.getByRole('region', { name: 'Recent processes' })).toBeVisible();
}

test.describe('WP-29 export recovery acceptance', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('reload, same-operation retry, cancel, and durable re-download preserve one verified output', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await openDisposableWorkspace(
      page,
      `WP29-export-recovery-${testInfo.project.name}-${Date.now()}`,
    );
    await addFixtureVideo(page);

    // Reload during a real encode. Startup recovery must turn the durable
    // running intent into one retryable process instead of leaving a spinner.
    await page.getByRole('button', { name: 'Export MP4' }).click();
    await expect(page.getByRole('button', { name: 'Cancel export' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
    await openProcesses(page);
    const interrupted = page.locator('.process-row.process-interrupted-retryable');
    await expect(interrupted).toHaveCount(1);
    await expect(interrupted).toContainText('interrupted by page reload');
    const retryName = await interrupted.locator('.process-name').textContent();

    const revisionProbe = await page.evaluate(() => {
      const history = JSON.parse(
        window.localStorage.getItem('joy-media.export-history.v2') ?? '{"entries":[]}',
      ) as {
        readonly entries?: readonly {
          readonly fingerprint?: string;
          readonly projectId?: string;
        }[];
      };
      const entry = history.entries?.[0];
      const latestRevision = (key: string, projectId: string | undefined): number => {
        if (projectId === undefined) return -1;
        const database = JSON.parse(window.localStorage.getItem(key) ?? '{"projects":{}}') as {
          readonly projects?: Readonly<
            Record<
              string,
              {
                readonly snapshots?: readonly { readonly revision?: number }[];
                readonly transactions?: readonly { readonly revision?: number }[];
              }
            >
          >;
        };
        const project = database.projects?.[projectId];
        return Math.max(
          0,
          ...(project?.snapshots ?? []).map(({ revision }) => revision ?? -1),
          ...(project?.transactions ?? []).map(({ revision }) => revision ?? -1),
        );
      };
      const match = /:timeline=(\d+):document=(\d+):graph=(\d+):artifacts=(\d+):/.exec(
        entry?.fingerprint ?? '',
      );
      return {
        fingerprint: entry?.fingerprint,
        fingerprintTimeline: Number(match?.[1] ?? -1),
        fingerprintDocument: Number(match?.[2] ?? -1),
        latestTimeline: latestRevision('joy-media.timeline-project-log.v1', entry?.projectId),
        latestDocument: latestRevision('joy-media.visual-object-project-log.v1', entry?.projectId),
      };
    });
    expect(revisionProbe, JSON.stringify(revisionProbe)).toMatchObject({
      fingerprintTimeline: revisionProbe.latestTimeline,
      fingerprintDocument: revisionProbe.latestDocument,
    });

    // Retry reuses the same logical row and commits its verified OPFS result
    // before the best-effort browser download is emitted.
    const firstDownloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await interrupted.getByRole('button', { name: new RegExp(`^Retry ${retryName}$`) }).click();
    const firstDownload = await firstDownloadPromise;
    const first = await downloadSha256(firstDownload);
    expect(first.bytes).toBeGreaterThan(0);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    await openProcesses(page);
    await expect(page.locator('.process-row')).toHaveCount(1);
    await expect(page.locator('.process-row.process-completed')).toHaveCount(1);

    // A hard reload hydrates the completed Blob from OPFS only after its
    // persisted byte length and SHA-256 pass verification.
    await page.reload();
    await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
    await openProcesses(page);
    const redownload = page.getByRole('link', { name: `Download ${retryName} again` });
    await expect(redownload).toBeVisible();
    const redownloadPromise = page.waitForEvent('download');
    await redownload.click();
    const second = await downloadSha256(await redownloadPromise);
    expect(second).toEqual(first);

    // A terminal ledger write can fail after OPFS verification, the final
    // revision check, session metadata, and completed-history persistence. The
    // failed attempt must remove only its own partial while the prior verified
    // export remains downloadable.
    await page.evaluate(() => {
      const ledgerKey = 'joy-media.project-operation-ledger.v1';
      const raw = window.localStorage.getItem(ledgerKey);
      const priorIds = new Set<string>(
        raw === null
          ? []
          : (JSON.parse(raw) as { readonly id?: unknown }[])
              .map(({ id }) => id)
              .filter((id): id is string => typeof id === 'string'),
      );
      const originalSetItem = Storage.prototype.setItem;
      const testWindow = window as Window & { restoreWp29StorageSetItem?: () => void };
      Storage.prototype.setItem = function (key, value) {
        if (key === ledgerKey) {
          const records = JSON.parse(value) as {
            readonly id?: unknown;
            readonly type?: unknown;
            readonly status?: unknown;
          }[];
          if (
            records.some(
              (record) =>
                record.type === 'export' &&
                record.status === 'completed' &&
                typeof record.id === 'string' &&
                !priorIds.has(record.id),
            )
          )
            throw new DOMException('simulated terminal ledger quota failure', 'QuotaExceededError');
        }
        originalSetItem.call(this, key, value);
      };
      testWindow.restoreWp29StorageSetItem = () => {
        Storage.prototype.setItem = originalSetItem;
        delete testWindow.restoreWp29StorageSetItem;
      };
    });
    await page.getByRole('button', { name: 'Export MP4' }).click();
    await expect(
      page.getByText('Export failed: simulated terminal ledger quota failure'),
    ).toBeVisible({ timeout: 120_000 });
    await openProcesses(page);
    await expect(page.locator('.process-row.process-failed')).toHaveCount(1);
    const retainedDownload = page.getByRole('link', { name: `Download ${retryName} again` });
    await expect(retainedDownload).toBeVisible();
    const retainedDownloadPromise = page.waitForEvent('download');
    await retainedDownload.click();
    expect(await downloadSha256(await retainedDownloadPromise)).toEqual(first);
    await page.evaluate(() => {
      const testWindow = window as Window & { restoreWp29StorageSetItem?: () => void };
      testWindow.restoreWp29StorageSetItem?.();
    });

    // Cancellation is terminal and retryable, never a permanently running
    // row. Retrying that same row completes without duplicating its logical record.
    await page.getByRole('button', { name: 'Export MP4' }).click();
    await expect(page.getByRole('button', { name: 'Cancel export' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel export' }).click();
    await expect(
      page.getByText('Export cancelled. You can retry from Recent processes.'),
    ).toBeVisible();
    await openProcesses(page);
    const cancelled = page.locator('.process-row.process-interrupted-retryable');
    await expect(cancelled).toHaveCount(1);
    const cancelledName = await cancelled.locator('.process-name').textContent();
    const retryDownloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await cancelled.getByRole('button', { name: new RegExp(`^Retry ${cancelledName}$`) }).click();
    const retried = await downloadSha256(await retryDownloadPromise);
    expect(retried.bytes).toBeGreaterThan(0);
    await openProcesses(page);
    await expect(page.locator('.process-row')).toHaveCount(3);
    await expect(page.locator('.process-row.process-completed')).toHaveCount(2);
    await expect(page.locator('.process-row.process-failed')).toHaveCount(1);

    await testInfo.attach('export-recovery-verification.json', {
      body: Buffer.from(
        `${JSON.stringify(
          {
            retryFilename: retryName,
            bytes: first.bytes,
            sha256: first.sha256,
            durableRedownloadMatched: true,
            lateLedgerFailurePreservedPrior: true,
            cancelledRetryFilename: cancelledName,
            cancelledRetryBytes: retried.bytes,
          },
          null,
          2,
        )}\n`,
      ),
      contentType: 'application/json',
    });
  });
});
