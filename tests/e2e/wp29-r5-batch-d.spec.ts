import { expect, test, type Page } from '@playwright/test';
import {
  authenticate,
  blockCase,
  E2E_TOKEN,
  importMediaFixture,
  installDeterministicCloudDenoiseProvider,
  openDisposableWorkspace,
  openPanel,
  openReferenceWorkspace,
  recordEvidence,
  selectFirstTimelineClip,
} from './wp29-r5-harness.js';

interface CloudApplicationState {
  readonly outputAssetCount: number;
  readonly sourceAssetId?: string;
  readonly snapshotCount: number;
  readonly latestRevision: number;
  readonly operationCount: number;
  readonly operationStatus?: string;
  readonly operationAttempt?: number;
  readonly resultRef?: string;
}

async function readCloudApplicationState(
  page: Page,
  outputAssetId: string,
): Promise<CloudApplicationState> {
  return page.evaluate((fixtureAssetId) => {
    const visualRaw = window.localStorage.getItem('joy-media.visual-object-project-log.v1');
    if (visualRaw === null) throw new Error('visual project persistence is missing');
    const visual = JSON.parse(visualRaw) as {
      readonly projects: Record<
        string,
        {
          readonly snapshots: readonly {
            readonly revision: number;
            readonly payload: {
              readonly assets: Record<string, { readonly id: string }>;
              readonly audio?: {
                readonly clips: Record<string, { readonly sourceAssetId?: string }>;
              };
            };
          }[];
        }
      >;
    };
    const snapshots = visual.projects['local-editor-project']?.snapshots ?? [];
    const latest = [...snapshots].sort((left, right) => right.revision - left.revision)[0];
    if (latest === undefined) throw new Error('visual project snapshot is missing');
    const ledgerRaw = window.localStorage.getItem('joy-media.project-operation-ledger.v1');
    const ledger = (ledgerRaw === null ? [] : JSON.parse(ledgerRaw)) as {
      readonly projectId: string;
      readonly type: string;
      readonly status: string;
      readonly attempt: number;
      readonly resultRef?: string;
    }[];
    const cloudOperations = ledger.filter(
      (record) => record.projectId === 'local-editor-project' && record.type === 'cloud-audio',
    );
    const operation = cloudOperations[0];
    return {
      outputAssetCount: Object.values(latest.payload.assets).filter(
        (asset) => asset.id === fixtureAssetId,
      ).length,
      sourceAssetId: latest.payload.audio?.clips.intro?.sourceAssetId,
      snapshotCount: snapshots.length,
      latestRevision: latest.revision,
      operationCount: cloudOperations.length,
      operationStatus: operation?.status,
      operationAttempt: operation?.attempt,
      resultRef: operation?.resultRef,
    };
  }, outputAssetId);
}

async function offerAndPairWorker(
  page: Page,
  capabilities: readonly string[],
): Promise<{ workerId: string; workerToken: string }> {
  const workerId = `worker-r5-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pairingCode = `pair-${Math.random().toString(36).slice(2, 10)}`;
  const offered = await page.evaluate(
    async ({ workerId: id, pairingCode: code }) => {
      const response = await fetch('/api/v1/worker-pair/offers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: id, pairingCode: code }),
      });
      return response.status;
    },
    { workerId, pairingCode },
  );
  expect(offered).toBe(201);

  await openPanel(page, 'Jobs');
  await page.getByRole('tab', { name: 'Pair' }).click();
  await page.getByRole('textbox', { name: 'Worker ID', exact: true }).fill(workerId);
  await page.getByRole('textbox', { name: 'One-time pairing code', exact: true }).fill(pairingCode);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('.jobs-panel .joy-panel-note')).toContainText('Pairing approved');

  const claim = await page.evaluate(
    async ({ workerId: id, pairingCode: code }) => {
      const response = await fetch('/api/v1/worker-pair/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: id, pairingCode: code }),
      });
      return (await response.json()) as { data: { sessionToken: string } };
    },
    { workerId, pairingCode },
  );
  const workerToken = claim.data.sessionToken;
  const hello = await page.evaluate(
    async ({ workerId: id, workerToken: token, capabilities: caps }) => {
      const response = await fetch(`/api/v1/workers/${encodeURIComponent(id)}/hello`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ capabilities: caps, assetIds: [] }),
      });
      return response.status;
    },
    { workerId, workerToken, capabilities },
  );
  expect(hello).toBe(200);
  await page.getByRole('button', { name: 'Refresh jobs' }).click();
  await page.getByRole('tab', { name: 'Workers' }).click();
  const revoke = page.getByRole('button', { name: `Revoke Worker ${workerId}` });
  await expect(revoke).toBeVisible();
  await expect(revoke.locator('xpath=ancestor::li[1]')).toHaveClass(/worker-connected/);
  return { workerId, workerToken };
}

test.describe('WP-29 R5 batch D — Worker and audio execution routes', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('[R5 CASE-63] pairs and inspects a capability-specific connected Worker', async ({
    page,
  }, testInfo) => {
    await openDisposableWorkspace(page, `R5-63-${testInfo.project.name}`);
    const { workerId } = await offerAndPairWorker(page, ['asset.thumbnail', 'audio.ml-denoise']);
    const worker = page
      .getByRole('button', { name: `Revoke Worker ${workerId}` })
      .locator('xpath=ancestor::li[1]');
    await expect(worker).toContainText('connected');
    await expect(worker).toContainText('audio.ml-denoise');
    await recordEvidence(testInfo, {
      caseId: 63,
      functional: 'PASS-FIXTURE',
      uiA11y: 'PASS',
      expected: 'Pairing exposes readiness, capability, and connected state for the exact Worker.',
      actual:
        'The real pairing offer/approval/claim/hello protocol produced one connected Worker row.',
      fixture: 'Disposable in-memory Worker protocol client',
    });
  });

  test('[R5 CASE-66] queues Local Worker audio, then records external processing as blocked', async ({
    page,
  }, testInfo) => {
    const title = `R5-66-${testInfo.project.name}`;
    await openDisposableWorkspace(page, title);
    await importMediaFixture(page, 'audio.wav');
    await page
      .locator('.asset-card', { hasText: 'audio.wav' })
      .first()
      .dragTo(page.locator('.timeline-lane[data-track-id]').first(), {
        targetPosition: { x: 70, y: 20 },
      });
    await page.locator('.timeline-clip[data-clip-id]').first().click();
    await offerAndPairWorker(page, ['audio.ml-denoise']);
    await page.reload();
    if (await page.getByRole('heading', { name: 'Projects' }).isVisible()) {
      await page
        .getByRole('button', { name: new RegExp(title) })
        .first()
        .click();
    }
    await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
    await openPanel(page, 'Audio');
    await expect(page.locator('.audio-runtime-cell', { hasText: 'Local Worker' })).toContainText(
      'Connected',
    );
    const localRun = page.locator('[data-audio-route="local-worker"]');
    await expect(localRun).toBeEnabled();
    await localRun.click();
    await expect(page.locator('.jobs-panel')).toBeVisible();
    await page.getByRole('tab', { name: 'Queue' }).click();
    await expect(page.locator('.jobs-list')).toContainText('audio.ml-denoise');
    await blockCase(testInfo, {
      caseId: 66,
      functional: 'BLOCKED-INTEGRATION',
      uiA11y: 'PASS',
      expected: 'A real local Worker processes the WAV and returns reviewable media for insertion.',
      actual:
        'Routing and queue insertion passed, but the deterministic browser stack has no external DSP Worker process to lease and return bytes.',
      blocker:
        'Requires an independently running Worker with audio.ml-denoise and its model runtime.',
      fixture: 'audio.wav plus paired protocol client; no fabricated result bytes',
    });
  });

  test('[R5 CASE-67] requires consent and applies one deterministic Cloud result', async ({
    page,
  }, testInfo) => {
    const outputAssetId = `cloud-denoise-${testInfo.project.name}`;
    const probe = await installDeterministicCloudDenoiseProvider(page, outputAssetId);
    await openReferenceWorkspace(page);
    await selectFirstTimelineClip(page);
    await openPanel(page, 'Audio');
    const browserRun = page.locator('[data-audio-route="browser-dsp"]');
    await expect(browserRun).toBeEnabled();
    await browserRun.click();
    await expect(page.getByText('Browser Voice Polish applied to the project.')).toBeVisible();
    const cloudRun = page.locator('[data-audio-route="vps-orchestrated"]');
    await expect(cloudRun).toBeEnabled();
    await expect(cloudRun).toHaveAttribute(
      'title',
      'Confirm Cloud Brain run with joy.playwright-cloud',
    );

    await cloudRun.click();
    const consent = page.getByRole('dialog', { name: 'Run with Cloud Brain?' });
    await expect(consent).toContainText('joy.playwright-cloud');
    await expect(consent).toContainText('may use paid credits');
    await expect(consent.getByRole('button', { name: 'Run Cloud Brain' })).toBeFocused();
    await consent.getByRole('button', { name: 'Cancel' }).click();
    await expect(consent).toBeHidden();
    expect(probe.requests).toBe(0);
    await expect
      .poll(() => readCloudApplicationState(page, outputAssetId))
      .toMatchObject({
        outputAssetCount: 0,
        operationCount: 0,
      });

    await cloudRun.click();
    await consent.getByRole('button', { name: 'Run Cloud Brain' }).click();
    await expect(cloudRun).toBeDisabled();
    await expect(cloudRun).toHaveText('Running…');
    await expect(page.getByText('Cloud Brain audio applied to the selected clip.')).toBeVisible({
      timeout: 15_000,
    });
    expect(probe).toMatchObject({
      requests: 1,
      authorization: `Bearer ${E2E_TOKEN}`,
      operationId: 'cloud-audio-asset-intro-podcast-quality',
      assetId: 'asset-intro',
      strength: 0.8,
    });
    expect(probe.providerChecks).toBeGreaterThan(0);
    expect(probe.projectId).toBeTruthy();
    expect(probe.mediaBytes).toBeGreaterThan(0);
    const applied = await readCloudApplicationState(page, outputAssetId);
    expect(applied).toMatchObject({
      outputAssetCount: 1,
      sourceAssetId: outputAssetId,
      operationCount: 1,
      operationStatus: 'applied',
      operationAttempt: 1,
      resultRef: outputAssetId,
    });

    await page.reload();
    if (await page.getByRole('heading', { name: 'Projects' }).isVisible()) {
      await page
        .getByRole('button', { name: /Local editor project/ })
        .first()
        .click();
    }
    await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
    await openPanel(page, 'Audio');
    const reloadedCloudRun = page.locator('[data-audio-route="vps-orchestrated"]');
    await expect(reloadedCloudRun).toBeEnabled();
    await reloadedCloudRun.click();
    const reloadedConsent = page.getByRole('dialog', { name: 'Run with Cloud Brain?' });
    await reloadedConsent.getByRole('button', { name: 'Run Cloud Brain' }).click();
    await expect(page.getByText('This Cloud Brain result is already applied.')).toBeVisible();
    expect(probe.requests).toBe(1);
    const reopened = await readCloudApplicationState(page, outputAssetId);
    expect(reopened).toEqual(applied);

    await recordEvidence(testInfo, {
      caseId: 67,
      functional: 'PASS-FIXTURE',
      uiA11y: 'PASS-FIXTURE',
      expected:
        'A configured Cloud path requires explicit remote/cost consent, cancel sends nothing, confirmation applies one output, and reload cannot duplicate it.',
      actual:
        'Browser DSP passed; cancel made zero requests; confirmation sent one authenticated request, applied one audio asset, and a post-reload confirmation reused the applied ledger record without another request or snapshot.',
      fixture:
        'Playwright-local configured provider status and packages/test-fixtures/media/audio.wav response; no credential, egress, or paid call',
    });
  });

  test('[R5 CASE-89] cancels, retries, and revokes only the confirmed records', async ({
    page,
  }, testInfo) => {
    await openDisposableWorkspace(page, `R5-89-${testInfo.project.name}`);
    const { workerId } = await offerAndPairWorker(page, ['asset.thumbnail']);
    const initialize = page.getByRole('button', { name: 'Initialize project' });
    if (await initialize.isVisible()) {
      await initialize.click();
      await expect(page.locator('.jobs-panel .joy-panel-note')).toContainText(/Project is ready/);
    }
    const queue = page.getByRole('button', { name: 'Queue thumbnail derivative' });
    await expect(queue).toBeEnabled();
    await queue.click();
    await page.getByRole('tab', { name: 'Queue' }).click();
    const job = page.locator('.jobs-list > li').first();
    await expect(job).toHaveAttribute('data-job-state', 'queued');
    const cancel = job.getByRole('button', { name: /Cancel job/ });
    page.once('dialog', (dialog) => dialog.accept());
    await cancel.click();
    await expect(job).toHaveAttribute('data-job-state', 'canceled');
    await job.getByRole('button', { name: /Retry job/ }).click();
    await expect(job).toHaveAttribute('data-job-state', 'queued');

    await page.getByRole('tab', { name: 'Workers' }).click();
    const revoke = page.getByRole('button', { name: `Revoke Worker ${workerId}` });
    page.once('dialog', (dialog) => dialog.accept());
    await revoke.click();
    await expect(page.getByRole('button', { name: `Revoke Worker ${workerId}` })).toHaveCount(0);
    await recordEvidence(testInfo, {
      caseId: 89,
      functional: 'PASS-FIXTURE',
      uiA11y: 'PASS',
      expected: 'Confirmed cancel/retry/revoke actions mutate only their labeled job or Worker.',
      actual:
        'The queued job canceled and retried; the exact Worker was revoked after confirmation.',
      fixture: 'Disposable in-memory Worker and thumbnail job',
    });
  });
});
