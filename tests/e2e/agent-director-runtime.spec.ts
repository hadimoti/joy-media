import { expect, test, type Page } from '@playwright/test';
import { authenticate, openPanel, openReferenceWorkspace } from './wp29-r5-harness.js';
import { configureJoyAgent, installFakeOpenAIProvider } from './fixtures/fake-openai-provider.js';
import {
  allowExpectedAssetFixtureMisses,
  assertBrowserAudit,
  setupBrowserAudit,
} from './helpers/browser-console-audit.js';

const INVALID_CANONICAL_PROPOSAL = {
  summary: 'Apply a caption style to a missing clip',
  operations: [
    {
      id: 'missing-caption-style',
      dependsOn: [],
      kind: 'caption.setTemplate',
      captionClipId: 'missing-caption',
      templateId: 'joy-rtl-classic',
    },
  ],
} as const;

const REPAIRED_PROPOSAL = {
  summary: 'Apply the approved caption style',
  operations: [
    {
      id: 'caption-style-repaired',
      dependsOn: [],
      kind: 'caption.setTemplate',
      captionClipId: 'caption-clip-1',
      templateId: 'joy-rtl-classic',
    },
  ],
} as const;

async function openJoyCode(page: Page): Promise<void> {
  await authenticate(page);
  await openReferenceWorkspace(page);
  await openPanel(page, 'Joy Code');
}

async function requestPreview(page: Page, prompt: string): Promise<void> {
  const composer = page.getByLabel('Message Joy Code');
  await composer.fill(prompt);
  await composer.press('Enter');
  await expect(page.getByRole('region', { name: 'JOY Code agent preview' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: /Approve & apply/ })).toBeVisible();
}

test.describe('JOY Live Director runtime boundary', () => {
  const DIRECTOR_ASSET_MISS_MAP: Record<string, number> = {
    'cancellation rejects a delayed provider reply before it can stage a preview': 2,
    'proves the provider handshake, repairs only through the canonical host, and requires approval': 9,
    'invalidates a real Worker preview when its revision becomes stale': 5,
    'clearing a model connection terminalizes an in-flight run without reviving a preview': 2,
    'reports a provider adapter failure without suggesting an edit was applied': 2,
  };

  test.beforeEach(({ page }, testInfo) => {
    setupBrowserAudit(page);
    const count = DIRECTOR_ASSET_MISS_MAP[testInfo.title];
    if (count != null) allowExpectedAssetFixtureMisses(page, count);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await assertBrowserAudit(page, testInfo);
  });

  test('proves the provider handshake, repairs only through the canonical host, and requires approval', async ({
    page,
  }) => {
    await openJoyCode(page);
    const provider = await installFakeOpenAIProvider(page, {
      proposal: INVALID_CANONICAL_PROPOSAL,
      repairProposal: REPAIRED_PROPOSAL,
    });
    const dialog = await configureJoyAgent(page, 'JOY_E2E_DIRECTOR_KEY');
    expect(provider.stages).toEqual(['forced-probe', 'probe-continuation', 'plan-only-probe']);
    await dialog.getByRole('button', { name: 'Done' }).click();

    const canonicalClipCount = await page.locator('.timeline-clip').count();
    await requestPreview(page, 'Make the captions easier to read.');
    expect(provider.stages).toEqual([
      'forced-probe',
      'probe-continuation',
      'plan-only-probe',
      'structured-read',
      'structured-validate',
      'structured-repair',
    ]);
    // The failed model operation is a host-only repair fact, never UI data.
    await expect(page.getByText('missing-caption', { exact: true })).toHaveCount(0);
    expect(await page.locator('.timeline-clip').count()).toBe(canonicalClipCount);

    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
    expect(await page.locator('.timeline-clip').count()).toBe(canonicalClipCount);

    await requestPreview(page, 'Apply the repaired caption style.');
    expect(await page.locator('.timeline-clip').count()).toBe(canonicalClipCount);
    await page.getByRole('button', { name: /Approve & apply/ }).click();
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
  });

  test('invalidates a real Worker preview when its revision becomes stale', async ({ page }) => {
    await openJoyCode(page);
    await installFakeOpenAIProvider(page);
    const dialog = await configureJoyAgent(page, 'JOY_E2E_DIRECTOR_STALE_KEY');
    await dialog.getByRole('button', { name: 'Done' }).click();

    await requestPreview(page, 'Update the selected caption style.');
    const clip = page.locator('.timeline-clip[data-clip-id]').first();
    await clip.click();
    await page.locator('.app-menu-trigger').filter({ hasText: 'Edit' }).click();
    await page.getByRole('menuitem', { name: /Duplicate Clip/ }).click();

    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Approve & apply/ })).toHaveCount(0);
  });

  test('cancellation rejects a delayed provider reply before it can stage a preview', async ({
    page,
  }) => {
    await openJoyCode(page);
    const provider = await installFakeOpenAIProvider(page, { runDelayMs: 800 });
    const dialog = await configureJoyAgent(page, 'JOY_E2E_DIRECTOR_CANCEL_KEY');
    await dialog.getByRole('button', { name: 'Done' }).click();

    const canonicalClipCount = await page.locator('.timeline-clip').count();
    const composer = page.getByLabel('Message Joy Code');
    await composer.fill('Start an edit, then stop it.');
    await composer.press('Enter');
    await expect.poll(() => provider.stages.includes('structured-read')).toBe(true);
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Joy Code composer' })).toHaveAttribute(
      'data-agent-phase',
      'cancelled',
    );
    const cancellationMessage = page.getByText('JOY run cancelled. No edits were applied.', {
      exact: true,
    });
    await expect(cancellationMessage).toHaveCount(1);
    await expect(cancellationMessage).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
    expect(await page.locator('.timeline-clip').count()).toBe(canonicalClipCount);
  });

  test('reports a provider adapter failure without suggesting an edit was applied', async ({
    page,
  }) => {
    await openJoyCode(page);
    await installFakeOpenAIProvider(page);
    const dialog = await configureJoyAgent(page, 'JOY_E2E_DIRECTOR_ADAPTER_FAILURE_KEY');
    await dialog.getByRole('button', { name: 'Done' }).click();

    await page.unroute('https://joy-agent-fixture.example/**');
    await page.route('https://joy-agent-fixture.example/**', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'authorization, content-type',
            'access-control-allow-methods': 'POST, OPTIONS',
          },
        });
      } else {
        await route.abort('failed');
      }
    });

    const canonicalClipCount = await page.locator('.timeline-clip').count();
    const composer = page.getByLabel('Message Joy Code');
    await composer.fill('Try an edit while the provider is unavailable.');
    await composer.press('Enter');

    await expect(page.getByRole('region', { name: 'Joy Code composer' })).toHaveAttribute(
      'data-agent-phase',
      'failed',
      { timeout: 20_000 },
    );
    await expect(page.getByText(/No edits were applied\./)).toBeVisible();
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
    expect(await page.locator('.timeline-clip').count()).toBe(canonicalClipCount);
  });

  test('clearing a model connection terminalizes an in-flight run without reviving a preview', async ({
    page,
  }) => {
    await openJoyCode(page);
    const provider = await installFakeOpenAIProvider(page, { runDelayMs: 2_000 });
    const dialog = await configureJoyAgent(page, 'JOY_E2E_DIRECTOR_CONNECTION_CLEAR_KEY');
    await dialog.getByRole('button', { name: 'Done' }).click();

    const canonicalClipCount = await page.locator('.timeline-clip').count();
    const composer = page.getByLabel('Message Joy Code');
    await composer.fill('Start an edit, then change the model connection.');
    await composer.press('Enter');
    await expect.poll(() => provider.stages.includes('structured-read')).toBe(true);

    await page.locator('.app-menu-trigger').filter({ hasText: 'Joy Code' }).click();
    await page.getByRole('menuitem', { name: 'Joy Code Settings…', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Joy Code Settings' });
    await settings.getByRole('button', { name: 'Clear connection', exact: true }).click();

    const composerPanel = page.getByRole('region', { name: 'Joy Code composer' });
    await expect(composerPanel).toHaveAttribute('data-agent-phase', 'cancelled');
    await expect(composerPanel).toHaveAttribute('aria-busy', 'false');
    await expect(composerPanel).not.toHaveClass(/is-agent-busy/);
    await expect(page.getByRole('region', { name: 'JOY Agent live proposal' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Approve & apply/ })).toHaveCount(0);
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
    expect(await page.locator('.timeline-clip').count()).toBe(canonicalClipCount);
    await expect
      .poll(async () =>
        page.evaluate(() =>
          Object.keys(window.localStorage)
            .filter((key) => key.startsWith('joy-media.joy-agent-run-checkpoint.v1:'))
            .flatMap((key) => {
              try {
                const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as {
                  snapshot?: { state?: unknown };
                };
                return typeof parsed.snapshot?.state === 'string' ? [parsed.snapshot.state] : [];
              } catch {
                return [];
              }
            }),
        ),
      )
      .toContain('cancelled');

    // The delayed response was already on the fake provider route. Its late
    // fulfillment cannot revive a run that Clear connection terminalized.
    await page.waitForTimeout(2_200);
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'JOY Agent live proposal' })).toHaveCount(0);
  });
});
