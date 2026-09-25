import { expect, test, type Page } from '@playwright/test';
import {
  authenticate,
  importMediaFixture,
  openDisposableWorkspace,
  openPanel,
  recordEvidence,
} from './wp29-r5-harness.js';

async function pairThumbnailWorker(page: Page, assetId: string) {
  const workerId = `worker-r5-100-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
  const workerToken = await page.evaluate(
    async ({ workerId: id, pairingCode: code }) => {
      const response = await fetch('/api/v1/worker-pair/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: id, pairingCode: code }),
      });
      const body = (await response.json()) as { data: { sessionToken: string } };
      return body.data.sessionToken;
    },
    { workerId, pairingCode },
  );
  const hello = await page.evaluate(
    async ({ workerId: id, workerToken: token, assetId: sourceAssetId }) => {
      const response = await fetch(`/api/v1/workers/${encodeURIComponent(id)}/hello`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ capabilities: ['asset.thumbnail'], assetIds: [sourceAssetId] }),
      });
      return response.status;
    },
    { workerId, workerToken, assetId },
  );
  expect(hello).toBe(200);
  await page.getByRole('button', { name: 'Refresh jobs' }).click();
  return workerId;
}

test.describe('WP-29 R5 batch G — bulk assets and reload recovery', () => {
  test.beforeEach(async ({ page }) => authenticate(page));

  test('[R5 CASE-24] AI and bulk-delete actions target only selected media', async ({
    page,
  }, testInfo) => {
    await openDisposableWorkspace(page, `R5-24-${testInfo.project.name}`);
    const imageName = `wp29-case24-${testInfo.project.name}-${Date.now()}.png`;
    const untouchedImageName = `wp29-case24-untouched-${testInfo.project.name}-${Date.now()}.png`;
    await importMediaFixture(page, 'image.png', imageName);
    await importMediaFixture(page, 'image.png', untouchedImageName);
    const card = page.locator('.asset-card', { hasText: imageName }).first();
    const assetId = await card.getAttribute('data-asset-id');
    expect(assetId).toBeTruthy();
    const targetCard = page.locator(`.asset-card[data-asset-id="${assetId}"]`);
    await targetCard.getByRole('checkbox', { name: `Select ${imageName}` }).check();
    const toolbar = page.getByRole('toolbar', { name: 'Bulk asset actions' });
    await expect(toolbar).toContainText('1');
    await toolbar.getByRole('button', { name: 'Edit selected with AI' }).click();
    await expect(page.locator('.joy-code-panel')).toBeVisible();
    const attachedMedia = page.getByRole('list', { name: 'Attached media' });
    await expect(attachedMedia).toContainText(imageName);
    await expect(attachedMedia).not.toContainText(untouchedImageName);

    await openPanel(page, 'Assets');
    await targetCard.getByRole('checkbox', { name: `Select ${imageName}` }).check();
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .getByRole('toolbar', { name: 'Bulk asset actions' })
      .getByRole('button', { name: 'Delete selected assets' })
      .click();
    await expect(page.locator(`.asset-card[data-asset-id="${assetId}"]`)).toHaveCount(0);
    await expect(page.locator('.asset-card', { hasText: untouchedImageName })).toHaveCount(1);
    await expect(page.locator('.asset-library .joy-panel-note')).toContainText(
      'Deleted 1 of 1 selected media items',
    );
    await recordEvidence(testInfo, {
      caseId: 24,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'AI attachment and confirmed bulk delete target only the selected asset.',
      actual:
        'AI attached the selected image without the unselected image, and confirmed delete removed only the selected asset.',
      fixture: 'two image.png imports',
    });
  });

  test('[R5 CASE-100] reload reattaches to one queued operation without duplication', async ({
    page,
  }, testInfo) => {
    const title = `R5-100-${testInfo.project.name}-${Date.now()}`;
    await openDisposableWorkspace(page, title);
    const imageName = `wp29-case100-${testInfo.project.name}-${Date.now()}.png`;
    await importMediaFixture(page, 'image.png', imageName);
    await page
      .locator('.asset-card', { hasText: imageName })
      .first()
      .dragTo(page.locator('.timeline-lane[data-track-id]').first(), {
        targetPosition: { x: 80, y: 20 },
      });
    await page.locator('.timeline-clip[data-clip-id]').first().click();
    const assetId = await page
      .locator('.asset-card', { hasText: imageName })
      .first()
      .getAttribute('data-asset-id');
    expect(assetId).toBeTruthy();
    await pairThumbnailWorker(page, assetId!);
    await openPanel(page, 'Jobs');
    const initialize = page.getByRole('button', { name: 'Initialize project' });
    if (await initialize.isVisible()) {
      await initialize.click();
      await expect(page.locator('.jobs-panel .joy-panel-note')).toContainText('Project is ready');
    }
    const queue = page.getByRole('button', { name: 'Queue thumbnail derivative' });
    await expect(queue).toBeEnabled();
    await queue.click();
    await page.getByRole('tab', { name: 'Queue' }).click();
    const initialJobs = page.locator('.jobs-list > li[data-job-id]');
    await expect(initialJobs).toHaveCount(1);
    const jobId = await initialJobs.first().getAttribute('data-job-id');
    await expect(initialJobs.first()).toHaveAttribute('data-job-state', 'queued');

    await page.reload();
    const libraryHeading = page.getByRole('heading', { name: 'Projects' });
    if (await libraryHeading.isVisible()) {
      await page
        .getByRole('button', { name: new RegExp(title) })
        .first()
        .click();
    }
    await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
    await openPanel(page, 'Jobs');
    await page.getByRole('tab', { name: 'Queue' }).click();
    const recovered = page.locator(`.jobs-list > li[data-job-id="${jobId}"]`);
    await expect(recovered).toHaveCount(1);
    await expect(recovered).toHaveAttribute('data-job-state', 'queued');
    await expect(page.locator('.jobs-list > li[data-job-id]')).toHaveCount(1);

    page.once('dialog', (dialog) => dialog.accept());
    await recovered.getByRole('button', { name: `Cancel job ${jobId}` }).click();
    await expect(recovered).toHaveAttribute('data-job-state', 'canceled');
    await recordEvidence(testInfo, {
      caseId: 100,
      functional: 'PASS-FIXTURE',
      uiA11y: 'PASS',
      expected:
        'Reload reconnects to the same queued operation without duplicate jobs or lost project state.',
      actual: `Job ${jobId} remained unique and queued after reload, then canceled cleanly for test cleanup.`,
      fixture: 'Disposable in-memory control-plane job',
    });
  });
});
