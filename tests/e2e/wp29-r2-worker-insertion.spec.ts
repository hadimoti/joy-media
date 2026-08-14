import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  authenticate,
  MEDIA_FIXTURE_DIR,
  openDisposableWorkspace,
  openPanel,
  recordEvidence,
} from './wp29-r5-harness.js';

interface PairedWorker {
  readonly workerId: string;
  readonly workerToken: string;
}

async function pairProtocolWorker(page: Page, sourceAssetId: string): Promise<PairedWorker> {
  const workerId = `worker-r2-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pairingCode = `pair-${Math.random().toString(36).slice(2, 10)}`;
  const offered = await page.evaluate(
    async ({ id, code }) => {
      const response = await fetch('/api/v1/worker-pair/offers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: id, pairingCode: code }),
      });
      return response.status;
    },
    { id: workerId, code: pairingCode },
  );
  expect(offered).toBe(201);

  await openPanel(page, 'Jobs');
  await page.getByRole('tab', { name: 'Pair' }).click();
  await page.getByRole('textbox', { name: 'Worker ID', exact: true }).fill(workerId);
  await page.getByRole('textbox', { name: 'One-time pairing code', exact: true }).fill(pairingCode);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('.jobs-panel .joy-panel-note')).toContainText('Pairing approved');

  const workerToken = await page.evaluate(
    async ({ id, code, assetId }) => {
      const claimResponse = await fetch('/api/v1/worker-pair/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: id, pairingCode: code }),
      });
      if (claimResponse.status !== 201)
        throw new Error(`Worker claim failed: ${claimResponse.status}`);
      const claim = (await claimResponse.json()) as { data: { sessionToken: string } };
      const response = await fetch(`/api/v1/workers/${encodeURIComponent(id)}/hello`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${claim.data.sessionToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ capabilities: ['audio.ml-denoise'], assetIds: [assetId] }),
      });
      if (response.status !== 200) throw new Error(`Worker hello failed: ${response.status}`);
      return claim.data.sessionToken;
    },
    { id: workerId, code: pairingCode, assetId: sourceAssetId },
  );

  await page.getByRole('button', { name: 'Refresh jobs' }).click();
  await page.getByRole('tab', { name: 'Workers' }).click();
  const worker = page
    .getByRole('button', { name: `Revoke Worker ${workerId}` })
    .locator('xpath=ancestor::li[1]');
  await expect(worker).toHaveClass(/worker-connected/);
  await expect(worker).toContainText('audio.ml-denoise');
  return { workerId, workerToken };
}

async function returnProtocolFixtureResult(
  page: Page,
  input: {
    readonly workerId: string;
    readonly workerToken: string;
    readonly jobId: string;
    readonly sourceAssetId: string;
    readonly wavBase64: string;
    readonly sha256: string;
    readonly bytes: number;
  },
): Promise<void> {
  const result = await page.evaluate(async (payload) => {
    const workerHeaders = {
      authorization: `Bearer ${payload.workerToken}`,
      'content-type': 'application/json',
    };
    let leasedExpectedJob = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      const lease = await fetch(`/api/v1/workers/${encodeURIComponent(payload.workerId)}/leases`, {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({ durationMs: 30_000 }),
      });
      const leaseBody = (await lease.json()) as { data?: { id?: string } | null };
      if (lease.status !== 200 || leaseBody.data?.id === undefined)
        return { phase: 'lease', status: lease.status, body: leaseBody };
      if (leaseBody.data.id === payload.jobId) {
        leasedExpectedJob = true;
        break;
      }
      // A long-lived deterministic server may retain queued jobs from an
      // earlier disposable test project that used the same content-addressed
      // source asset. Terminally fail only that test-owned stale lease, then
      // continue until this project's globally scoped job is reached.
      const stale = await fetch(
        `/api/v1/workers/${encodeURIComponent(payload.workerId)}/jobs/${encodeURIComponent(leaseBody.data.id)}/fail`,
        {
          method: 'POST',
          headers: workerHeaders,
          body: JSON.stringify({ error: 'superseded disposable E2E job' }),
        },
      );
      if (stale.status !== 200)
        return { phase: 'stale-cleanup', status: stale.status, body: await stale.json() };
    }
    if (!leasedExpectedJob)
      return { phase: 'lease', status: 409, body: { error: 'expected job was not leased' } };

    const binary = atob(payload.wavBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const upload = await fetch(
      `/api/v1/workers/${encodeURIComponent(payload.workerId)}/jobs/${encodeURIComponent(payload.jobId)}/derivative`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${payload.workerToken}`,
          'content-type': 'audio/wav',
          'x-joy-asset-id': payload.sourceAssetId,
          'x-joy-sha256': payload.sha256,
          'x-joy-bytes': String(payload.bytes),
        },
        body: bytes,
      },
    );
    if (upload.status !== 201)
      return { phase: 'upload', status: upload.status, body: await upload.json() };

    const complete = await fetch(
      `/api/v1/workers/${encodeURIComponent(payload.workerId)}/jobs/${encodeURIComponent(payload.jobId)}/complete`,
      {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({
          result: {
            kind: 'audio.ml-denoise',
            assetId: payload.sourceAssetId,
            sha256: payload.sha256,
            bytes: payload.bytes,
            localRef: `gpu-${payload.jobId}`,
            descriptor: { mimeType: 'audio/wav' },
          },
        }),
      },
    );
    return { phase: 'complete', status: complete.status, body: await complete.json() };
  }, input);

  expect(result, JSON.stringify(result)).toMatchObject({
    phase: 'complete',
    status: 200,
    body: { data: { id: input.jobId, state: 'completed' } },
  });
}

test.describe('WP-29 R2 — Worker result insertion browser closeout', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('pairs in UI and applies one verified protocol-fixture result with reversible history', async ({
    page,
  }, testInfo) => {
    const title = `R2-worker-insertion-${testInfo.project.name}-${Date.now()}`;
    await openDisposableWorkspace(page, title);
    const wav = readFileSync(join(MEDIA_FIXTURE_DIR, 'audio.wav'));
    const audioName = `r2-${testInfo.project.name}-${Date.now()}.wav`;
    await openPanel(page, 'Assets');
    await page.getByRole('button', { name: 'Import media' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Import media' });
    await drawer.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
      name: audioName,
      mimeType: 'audio/wav',
      buffer: wav,
    });
    await expect(drawer.getByText(audioName, { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: 'Confirm import' }).click();
    const assetCard = page.locator('.asset-card', { hasText: audioName }).first();
    await expect(assetCard).toBeVisible({ timeout: 15_000 });
    const sourceAssetId = await assetCard.getAttribute('data-asset-id');
    expect(sourceAssetId).toBeTruthy();
    await assetCard.dragTo(page.locator('.timeline-lane[data-track-id]').first(), {
      targetPosition: { x: 70, y: 20 },
    });
    const clip = page.locator('.timeline-clip[data-clip-id]').first();
    await clip.click();
    await expect(clip).toHaveAttribute('aria-pressed', 'true');

    const worker = await pairProtocolWorker(page, sourceAssetId!);
    const run = page.getByRole('button', { name: 'Run audio denoise' });
    await expect(run).toBeEnabled();
    await run.click();
    await expect(page.locator('.jobs-panel .joy-panel-note')).toContainText(
      'Audio denoise job queued',
    );

    await page.getByRole('tab', { name: 'Queue' }).click();
    const job = page
      .locator('.jobs-list > li[data-job-id]', { hasText: 'audio.ml-denoise' })
      .first();
    await expect(job).toHaveAttribute('data-job-state', 'queued');
    const jobId = await job.getAttribute('data-job-id');
    expect(jobId).toBeTruthy();
    await returnProtocolFixtureResult(page, {
      ...worker,
      jobId: jobId!,
      sourceAssetId: sourceAssetId!,
      wavBase64: wav.toString('base64'),
      sha256: createHash('sha256').update(wav).digest('hex'),
      bytes: wav.byteLength,
    });

    await page.getByRole('button', { name: 'Refresh jobs' }).click();
    await expect(job).toHaveAttribute('data-job-state', 'completed');
    await job.getByRole('button', { name: 'Review result' }).click();
    const review = page.getByRole('dialog', { name: 'Review processed audio' });
    await expect(review).toBeVisible();
    await expect(review).toContainText(`Verified ${wav.byteLength} bytes`);
    await review.getByRole('button', { name: 'Replace selected clip audio' }).click();
    await expect(page.locator('.jobs-panel .joy-panel-note')).toContainText(
      'Processed audio applied to the selected clip',
    );
    await expect(job.getByRole('button', { name: 'Applied' })).toBeDisabled();

    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await expect(job.getByRole('button', { name: 'Review result' })).toBeEnabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).first().click();
    await expect(job.getByRole('button', { name: 'Applied' })).toBeDisabled();

    await page.reload();
    if (await page.getByRole('heading', { name: 'Projects' }).isVisible()) {
      await page
        .getByRole('button', { name: new RegExp(title) })
        .first()
        .click();
    }
    await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
    await openPanel(page, 'Jobs');
    await page.getByRole('tab', { name: 'Queue' }).click();
    const reloadedJob = page.locator(`.jobs-list > li[data-job-id="${jobId!}"]`);
    await expect(reloadedJob).toHaveCount(1);
    await expect(reloadedJob.getByRole('button', { name: 'Applied' })).toBeDisabled();

    await openPanel(page, 'Timeline');
    await page.locator('.timeline-clip[data-clip-id]').first().click();
    await openPanel(page, 'Jobs');
    await page.getByRole('button', { name: 'Run audio denoise' }).click();
    await expect(page.locator('.jobs-panel .joy-panel-note')).toContainText(
      'already been applied to the project',
    );
    await page.getByRole('tab', { name: 'Queue' }).click();
    await expect(page.locator(`.jobs-list > li[data-job-id="${jobId!}"]`)).toHaveCount(1);

    await page.getByRole('tab', { name: 'Workers' }).click();
    const revoke = page.getByRole('button', { name: `Revoke Worker ${worker.workerId}` });
    page.once('dialog', (dialog) => dialog.accept());
    await revoke.click();
    await expect(revoke).toHaveCount(0);
    const revokedLeaseStatus = await page.evaluate(
      async ({ id, token }) =>
        (
          await fetch(`/api/v1/workers/${encodeURIComponent(id)}/leases`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body: '{}',
          })
        ).status,
      { id: worker.workerId, token: worker.workerToken },
    );
    expect(revokedLeaseStatus).toBe(401);

    await recordEvidence(testInfo, {
      caseId: 66,
      functional: 'PASS-FIXTURE',
      uiA11y: 'PASS',
      expected:
        'UI pairing and a Worker-returned verified audio result support review, replace, one-click Undo, Redo, reload recovery, duplicate prevention, and revoke.',
      actual:
        'One deterministic protocol Worker leased the real queued job, uploaded valid WAV bytes through the production derivative endpoint, completed it, and every browser lifecycle assertion passed.',
      fixture:
        'Protocol fixture returns packages/test-fixtures/media/audio.wav; complements the separately committed real licensed Worker runtime proof.',
    });
  });
});
