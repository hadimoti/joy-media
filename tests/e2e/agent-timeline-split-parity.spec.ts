import { expect, test } from '@playwright/test';
import { authenticate, openPanel, openReferenceWorkspace } from './wp29-r5-harness.js';
import { configureJoyAgent, installFakeOpenAIProvider } from './fixtures/fake-openai-provider.js';

const SPLIT_PROPOSAL = {
  summary: 'Split the product shot at the approved midpoint',
  operations: [
    {
      id: 'split-product',
      dependsOn: [],
      kind: 'timeline.splitClip',
      compositionId: 'root',
      trackId: 'track-0',
      clipId: 'product',
      atUs: 15_000_000,
    },
  ],
} as const;

test.describe('JOY Agent timeline.splitClip parity', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
    await installFakeOpenAIProvider(page, { proposal: SPLIT_PROPOSAL });
    const dialog = await configureJoyAgent(page, 'JOY_E2E_TIMELINE_SPLIT_PARITY_KEY');
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  test('stages the exact split, commits only after approval, and persists its Undo/Redo result on reload', async ({
    page,
  }) => {
    const track = page.locator('.timeline-track[data-track-id="track-0"]');
    const canonicalClips = track.locator('.timeline-clip');
    const stagedSplit = page.locator('.agent-timeline-overlay [data-clip-id$="-split-0"]');
    const committedSplit = track.locator('.timeline-clip[data-clip-id$="-split-0"]');

    await expect(canonicalClips).toHaveCount(3);
    await expect(track.locator('[data-clip-id="product"]')).toHaveCount(1);

    const composer = page.getByLabel('Message Joy Code');
    // Avoid the retired local `/split` recipe matcher: this must exercise the
    // connected Worker, its bounded proposal, and the approval-bound runner.
    await composer.fill('Divide the product shot at the midpoint.');
    await composer.press('Enter');
    const proposal = page.getByRole('region', { name: 'JOY Agent live proposal' });
    await expect(proposal).toBeVisible({ timeout: 20_000 });
    await expect(proposal).toContainText('Split product');
    await expect(stagedSplit).toHaveCount(1);
    await expect(committedSplit).toHaveCount(0);
    await expect(canonicalClips).toHaveCount(3);

    await proposal.getByRole('button', { name: 'Approve & apply' }).click();
    await expect(proposal).toHaveCount(0);
    await expect(stagedSplit).toHaveCount(0);
    await expect(canonicalClips).toHaveCount(4);
    await expect(committedSplit).toHaveCount(1);

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    const redo = page.getByRole('button', { name: 'Redo', exact: true });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(canonicalClips).toHaveCount(3);
    await expect(committedSplit).toHaveCount(0);
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect(canonicalClips).toHaveCount(4);
    await expect(committedSplit).toHaveCount(1);

    await page.reload();
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
    const reloadedTrack = page.locator('.timeline-track[data-track-id="track-0"]');
    await expect(reloadedTrack.locator('.timeline-clip')).toHaveCount(4);
    await expect(reloadedTrack.locator('.timeline-clip[data-clip-id$="-split-0"]')).toHaveCount(1);
  });
});
