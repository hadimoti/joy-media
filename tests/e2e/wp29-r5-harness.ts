import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const E2E_TOKEN = 'joy-media-e2e-token';
export const MEDIA_FIXTURE_DIR = join(process.cwd(), 'packages/test-fixtures/media');

export type R5Verdict =
  'PASS' | 'PASS-FIXTURE' | 'FAIL' | 'FLAKY' | 'BLOCKED-CONSENT' | 'BLOCKED-INTEGRATION';

export interface R5Evidence {
  readonly caseId: number;
  readonly functional: R5Verdict;
  readonly uiA11y: R5Verdict;
  readonly actual: string;
  readonly expected: string;
  readonly blocker?: string;
  readonly fixture?: string;
}

export interface DeterministicCloudDenoiseProbe {
  providerChecks: number;
  requests: number;
  authorization?: string;
  projectId?: string;
  operationId?: string;
  assetId?: string;
  strength?: number;
  mediaBytes?: number;
}

/**
 * Test-only remote-provider seam. It makes provider discovery truthful for the
 * case while keeping all bytes local and deterministic: no paid endpoint or
 * credential is contacted. The request still crosses the browser client and
 * therefore proves auth, consent ordering, serialization, and deduplication.
 */
export async function installDeterministicCloudDenoiseProvider(
  page: Page,
  outputAssetId: string,
  responseDelayMs = 250,
): Promise<DeterministicCloudDenoiseProbe> {
  const output = await readFile(join(MEDIA_FIXTURE_DIR, 'audio.wav'));
  const probe: DeterministicCloudDenoiseProbe = { providerChecks: 0, requests: 0 };

  await page.route('**/api/v1/providers/reasoning', async (route) => {
    probe.providerChecks += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          providers: [
            {
              providerId: 'joy.playwright-cloud',
              state: 'configured',
              models: [
                {
                  id: 'audio-denoise-fixture-v1',
                  displayName: 'Deterministic Cloud Denoise',
                  version: 'fixture-v1',
                },
              ],
              adapterVersion: 'fixture-v1',
            },
          ],
        },
      }),
    });
  });

  await page.route('**/api/v1/providers/audio/denoise', async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as {
      readonly projectId?: string;
      readonly operationId?: string;
      readonly assetId?: string;
      readonly mediaBase64?: string;
      readonly strength?: number;
    };
    probe.requests += 1;
    probe.authorization = request.headers().authorization;
    probe.projectId = body.projectId;
    probe.operationId = body.operationId;
    probe.assetId = body.assetId;
    probe.strength = body.strength;
    probe.mediaBytes =
      typeof body.mediaBase64 === 'string'
        ? Buffer.from(body.mediaBase64, 'base64').byteLength
        : undefined;
    if (responseDelayMs > 0)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, responseDelayMs);
      });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          assetId: outputAssetId,
          mimeType: 'audio/wav',
          bytesBase64: output.toString('base64'),
          method: 'ffmpeg-afftdn',
          strength: 0.8,
        },
      }),
    });
  });

  return probe;
}

export async function authenticate(page: Page): Promise<void> {
  await page.addInitScript((token) => {
    window.localStorage.setItem('joy-media-session-token', token);
  }, E2E_TOKEN);
}

const PROJECT_SELECTOR_READY_TIMEOUT_MS = 20_000;

async function openReadyProjectSelector(page: Page): Promise<void> {
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response, 'The project selector navigation must return an HTTP response.').not.toBeNull();
  expect(response!.ok(), `Project selector navigation returned HTTP ${response!.status()}.`).toBe(
    true,
  );

  await expect(
    page.getByRole('heading', { name: 'Projects' }),
    'The authenticated project selector must finish rendering after a cold application load.',
  ).toBeVisible({ timeout: PROJECT_SELECTOR_READY_TIMEOUT_MS });
  await expect(
    page.getByRole('button', { name: 'New project' }),
    'The rendered project selector must be interactive before a scenario continues.',
  ).toBeEnabled({ timeout: PROJECT_SELECTOR_READY_TIMEOUT_MS });
}

export async function openReferenceWorkspace(page: Page): Promise<void> {
  await openReadyProjectSelector(page);
  await page
    .getByRole('button', { name: /Local editor project/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
  await activateTimeline(page);
}

export async function openDisposableWorkspace(page: Page, title: string): Promise<void> {
  await openReadyProjectSelector(page);
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByPlaceholder('Project name').fill(title);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
  await activateTimeline(page);
}

async function activateTimeline(page: Page): Promise<void> {
  const panel = page.locator('.timeline-panel');
  if (await panel.isVisible()) return;
  await expect(async () => {
    await page.locator('.panel-tab[aria-label="Timeline"]').first().click();
    await expect(panel).toBeVisible();
  }).toPass({ timeout: 10_000 });
}

export async function openPanel(page: Page, label: string): Promise<void> {
  const tab = page.locator(`.panel-tab[aria-label="${label}"]`).first();
  await expect(tab).toBeVisible();
  await tab.click();
  if (label === 'Joy Code') {
    await expect(page.locator('.joy-code-panel')).toBeVisible();
  } else {
    await expect(page.locator('.joy-panel-title', { hasText: label }).first()).toBeVisible();
  }
}

export async function selectFirstTimelineClip(page: Page): Promise<void> {
  const clip = page.locator('.timeline-clip[data-clip-id]').first();
  await expect(clip).toBeVisible();
  await clip.click();
  await expect(clip).toHaveAttribute('aria-pressed', 'true');
}

export async function importMediaFixture(page: Page, fileName: string): Promise<void> {
  await openPanel(page, 'Assets');
  await page.getByRole('button', { name: 'Import media' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Import media' });
  await expect(drawer).toBeVisible();
  await drawer
    .locator('input[type="file"][aria-label="Media file"]')
    .setInputFiles(join(MEDIA_FIXTURE_DIR, fileName));
  await expect(drawer.getByText(fileName, { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.locator('.asset-card', { hasText: fileName }).first()).toBeVisible({
    timeout: 15_000,
  });
}

export async function recordEvidence(testInfo: TestInfo, evidence: R5Evidence): Promise<void> {
  testInfo.annotations.push({
    type: 'r5-verdict',
    description: `CASE-${evidence.caseId}: ${evidence.functional}/${evidence.uiA11y}`,
  });
  await testInfo.attach(`r5-case-${evidence.caseId}.json`, {
    body: Buffer.from(
      `${JSON.stringify(
        {
          ...evidence,
          project: testInfo.project.name,
          viewport: testInfo.project.use.viewport,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    ),
    contentType: 'application/json',
  });
}

export async function blockCase(testInfo: TestInfo, evidence: R5Evidence): Promise<never> {
  await recordEvidence(testInfo, evidence);
  test.skip(true, evidence.blocker ?? `R5 case ${evidence.caseId} is integration-blocked`);
  throw new Error('unreachable after test.skip');
}
