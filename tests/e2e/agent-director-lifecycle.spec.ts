import { expect, test, type Locator, type Page } from '@playwright/test';
import { authenticate, openPanel, openReferenceWorkspace } from './wp29-r5-harness.js';
import { configureJoyAgent, installFakeOpenAIProvider } from './fixtures/fake-openai-provider.js';

const TITLE_AND_KEYFRAME_PROPOSAL = {
  summary: 'Create and animate a title',
  operations: [
    {
      id: 'title',
      dependsOn: [],
      kind: 'text.insertTemplate',
      templateId: 'clean-title',
      content: 'Lifecycle fixture title',
      startUs: 0,
      durationUs: 1_000_000,
      placementPreset: 'center',
      outputRef: { kind: 'visual-object', ref: 'title-output' },
    },
    {
      id: 'animate',
      dependsOn: ['title'],
      kind: 'motion.setKeyframe',
      binding: {
        ownerKind: 'visual-object',
        ownerRef: { kind: 'visual-object', ref: 'title-output' },
        propertyId: 'opacity',
        timeDomain: 'composition',
      },
      key: { kind: 'scalar', timeUs: 500_000, value: 0.5, interpolation: 'linear' },
    },
  ],
} as const;

async function openJoyCode(page: Page): Promise<void> {
  await authenticate(page);
  await openReferenceWorkspace(page);
  await openPanel(page, 'Joy Code');
}

async function configureFixtureAgent(page: Page, key: string): Promise<void> {
  await installFakeOpenAIProvider(page, { proposal: TITLE_AND_KEYFRAME_PROPOSAL });
  const dialog = await configureJoyAgent(page, key);
  await dialog.getByRole('button', { name: 'Done' }).click();
}

async function requestTitlePreview(page: Page): Promise<Locator> {
  const composer = page.getByLabel('Message Joy Code');
  await composer.fill('Create a title and animate its opacity.');
  await composer.press('Enter');
  const proposal = page.getByRole('region', { name: 'JOY Agent live proposal' });
  await expect(proposal).toBeVisible({ timeout: 20_000 });
  return proposal;
}

test.describe('JOY Live Director lifecycle evidence', () => {
  test('makes approval available only after the published preview has rendered', async ({
    page,
  }) => {
    await openJoyCode(page);
    await configureFixtureAgent(page, 'JOY_E2E_LIFECYCLE_RENDER_KEY');

    const proposal = await requestTitlePreview(page);
    const approve = proposal.getByRole('button', { name: 'Approve & apply' });

    // React may coalesce the short pending state before Playwright receives a
    // scheduling turn, so this asserts the observable safety contract: the
    // real Timeline and Program Monitor preview surfaces are present before
    // the card becomes approval-capable. The underlying store tests cover
    // each individual pending acknowledgement transition.
    await expect
      .poll(() => page.locator('[data-agent-preview="true"]').count(), { timeout: 20_000 })
      .toBeGreaterThan(0);
    await expect(page.getByRole('region', { name: 'Program Monitor agent preview' })).toBeVisible();
    await expect(proposal).toHaveAttribute('data-agent-preview-ready', 'true', {
      timeout: 20_000,
    });
    await expect(proposal).toHaveAttribute('data-agent-lifecycle-state', 'awaiting-approval');
    await expect(approve).toBeEnabled();
  });

  test('does not revive an approval-capable preview after a browser reload', async ({ page }) => {
    await openJoyCode(page);
    await configureFixtureAgent(page, 'JOY_E2E_LIFECYCLE_RELOAD_KEY');

    const proposal = await requestTitlePreview(page);
    await expect(proposal).toHaveAttribute('data-agent-preview-ready', 'true', {
      timeout: 20_000,
    });
    await expect(proposal.getByRole('button', { name: 'Approve & apply' })).toBeEnabled();

    await page.reload({ waitUntil: 'domcontentloaded' });
    // Reload resumes the selected editor workspace; it intentionally does not
    // force the owner back through the project picker.
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await openPanel(page, 'Joy Code');

    // The persisted lifecycle checkpoint may record an interruption, but a
    // memory-only staged preview and its authority must never survive reload.
    await expect(page.getByRole('region', { name: 'JOY Agent live proposal' })).toHaveCount(0);
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve & apply' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Joy Code composer' })).not.toHaveAttribute(
      'data-agent-phase',
      'awaiting-approval',
    );
  });

  test('does not acknowledge a timeline preview while its Dockview tab is inactive', async ({
    page,
  }) => {
    await openJoyCode(page);
    await configureFixtureAgent(page, 'JOY_E2E_LIFECYCLE_HIDDEN_TIMELINE_KEY');

    // Flow and Timeline intentionally share one Dockview group. Switching to
    // Flow leaves Timeline mounted but makes it non-owner-visible.
    await page.locator('.panel-tab[aria-label="Flow"]').first().click();
    await expect(page.getByRole('article', { name: 'Dual Lens', exact: true })).toBeVisible();
    await expect(page.locator('.timeline-panel')).not.toBeVisible();

    const proposal = await requestTitlePreview(page);
    const approve = proposal.getByRole('button', { name: 'Approve & apply' });
    await expect(page.getByRole('region', { name: 'Program Monitor agent preview' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(proposal).toHaveAttribute('data-agent-preview-ready', 'false', {
      timeout: 20_000,
    });
    await expect(approve).toBeDisabled();

    await openPanel(page, 'Timeline');
    await expect(page.locator('.agent-timeline-overlay')).toBeVisible({ timeout: 20_000 });
    await expect(proposal).toHaveAttribute('data-agent-preview-ready', 'true', { timeout: 20_000 });
    await expect(approve).toBeEnabled();
  });

  test('resets Before for each new staged document before allowing comparison', async ({
    page,
  }) => {
    await openJoyCode(page);
    await configureFixtureAgent(page, 'JOY_E2E_LIFECYCLE_BEFORE_RESET_KEY');

    const firstProposal = await requestTitlePreview(page);
    await expect(firstProposal).toHaveAttribute('data-agent-preview-ready', 'true', {
      timeout: 20_000,
    });
    const beforeToggle = page.getByRole('checkbox', { name: 'Before' });
    await expect(beforeToggle).toBeEnabled();
    await beforeToggle.check();
    await expect(beforeToggle).toBeChecked();
    await firstProposal.getByRole('button', { name: 'Reject' }).click();
    await expect(firstProposal).toHaveCount(0);

    const secondProposal = await requestTitlePreview(page);
    const secondApprove = secondProposal.getByRole('button', { name: 'Approve & apply' });
    await expect(beforeToggle).not.toBeChecked({ timeout: 20_000 });
    await expect(secondProposal).toHaveAttribute('data-agent-preview-ready', 'true', {
      timeout: 20_000,
    });
    await expect(secondApprove).toBeEnabled();
  });

  test('clears an epoch-qualified staged preview when the owner stops the run', async ({
    page,
  }) => {
    await openJoyCode(page);
    await configureFixtureAgent(page, 'JOY_E2E_LIFECYCLE_STOP_STAGED_KEY');

    const proposal = await requestTitlePreview(page);
    await expect(proposal).toHaveAttribute('data-agent-preview-ready', 'true', {
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click();

    await expect(proposal).toHaveCount(0);
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Joy Code composer' })).toHaveAttribute(
      'data-agent-phase',
      'cancelled',
    );
  });

  test('uses the prior committed title entity for a second-turn edit', async ({ page }) => {
    await openJoyCode(page);
    let referencedTitleId: string | undefined;
    const provider = await installFakeOpenAIProvider(page, {
      proposalForContext: (context) => {
        const title = context.recentEntityReferences.find(
          (reference) => reference.entityKind === 'visual-text',
        );
        if (title === undefined) return TITLE_AND_KEYFRAME_PROPOSAL;
        referencedTitleId = title.entityId;
        return {
          summary: 'Make the referenced title smaller',
          operations: [
            {
              id: 'shrink-referenced-title',
              dependsOn: [],
              kind: 'motion.setKeyframe',
              binding: {
                ownerKind: 'visual-object',
                ownerId: title.entityId,
                propertyId: 'scaleX',
                timeDomain: 'composition',
              },
              key: { kind: 'scalar', timeUs: 0, value: 0.8, interpolation: 'linear' },
            },
          ],
        };
      },
    });
    const dialog = await configureJoyAgent(page, 'JOY_E2E_LIFECYCLE_SECOND_TURN_KEY');
    await dialog.getByRole('button', { name: 'Done' }).click();

    const firstProposal = await requestTitlePreview(page);
    await expect(firstProposal).toHaveAttribute('data-agent-preview-ready', 'true', {
      timeout: 20_000,
    });
    await firstProposal.getByRole('button', { name: 'Approve & apply' }).click();
    await expect(firstProposal).toHaveCount(0);

    const composer = page.getByLabel('Message Joy Code');
    await composer.fill('Make that title smaller.');
    await composer.press('Enter');
    const secondProposal = page.getByRole('region', { name: 'JOY Agent live proposal' });
    await expect(secondProposal).toBeVisible({ timeout: 20_000 });
    await expect(secondProposal).toContainText('Set scaleX keyframe at 0µs');
    await expect(secondProposal).toHaveAttribute('data-agent-preview-ready', 'true', {
      timeout: 20_000,
    });
    expect(referencedTitleId).toMatch(/^text-/);
    expect(
      provider.contexts.some((context) =>
        context.recentEntityReferences.some(
          (reference) =>
            reference.entityId === referencedTitleId && reference.entityKind === 'visual-text',
        ),
      ),
    ).toBe(true);

    await secondProposal.getByRole('button', { name: 'Approve & apply' }).click();
    await expect(secondProposal).toHaveCount(0);
    await expect(page.getByText(/Approved and applied/).last()).toBeVisible();
  });

  test('rejects a follow-up proposal that targets another valid title', async ({ page }) => {
    await openJoyCode(page);
    let resolvedTitleId: string | undefined;
    const provider = await installFakeOpenAIProvider(page, {
      proposalForContext: (context) => {
        const title = context.recentEntityReferences.find(
          (reference) => reference.entityKind === 'visual-text',
        );
        if (title === undefined) return TITLE_AND_KEYFRAME_PROPOSAL;
        resolvedTitleId = title.entityId;
        // `intro-title` is a real, existing text object in the reference
        // workspace. The host must reject it because this turn resolved the
        // newly created title instead.
        return {
          summary: 'Incorrectly edit a different title',
          operations: [
            {
              id: 'wrong-existing-title',
              dependsOn: [],
              kind: 'motion.setKeyframe',
              binding: {
                ownerKind: 'visual-object',
                ownerId: 'intro-title',
                propertyId: 'scaleX',
                timeDomain: 'composition',
              },
              key: { kind: 'scalar', timeUs: 0, value: 0.8, interpolation: 'linear' },
            },
          ],
        };
      },
    });
    const dialog = await configureJoyAgent(page, 'JOY_E2E_LIFECYCLE_TARGET_CONSTRAINT_KEY');
    await dialog.getByRole('button', { name: 'Done' }).click();

    const firstProposal = await requestTitlePreview(page);
    await expect(firstProposal).toHaveAttribute('data-agent-preview-ready', 'true', {
      timeout: 20_000,
    });
    await firstProposal.getByRole('button', { name: 'Approve & apply' }).click();
    await expect(firstProposal).toHaveCount(0);

    const composer = page.getByLabel('Message Joy Code');
    await composer.fill('Make that title smaller.');
    await composer.press('Enter');
    await expect
      .poll(
        () =>
          provider.contexts.some((context) =>
            context.recentEntityReferences.some(
              (reference) =>
                reference.entityId === resolvedTitleId && reference.entityKind === 'visual-text',
            ),
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect(page.getByRole('region', { name: 'Joy Code composer' })).toHaveAttribute(
      'data-agent-phase',
      'failed',
      { timeout: 20_000 },
    );
    await expect(page.getByRole('region', { name: 'JOY Agent live proposal' })).toHaveCount(0);
    await expect(page.locator('[data-agent-preview="true"]')).toHaveCount(0);
  });

  test('clarifies locally instead of targeting a deleted conversation entity', async ({ page }) => {
    await openJoyCode(page);
    const provider = await installFakeOpenAIProvider(page, {
      proposal: TITLE_AND_KEYFRAME_PROPOSAL,
    });
    const dialog = await configureJoyAgent(page, 'JOY_E2E_LIFECYCLE_DELETED_ENTITY_KEY');
    await dialog.getByRole('button', { name: 'Done' }).click();

    const proposal = await requestTitlePreview(page);
    await expect(proposal).toHaveAttribute('data-agent-preview-ready', 'true', { timeout: 20_000 });
    await proposal.getByRole('button', { name: 'Approve & apply' }).click();
    await expect(proposal).toHaveCount(0);
    await expect(page.locator('[data-clip-id^="clip-text-clean-title-"]')).toHaveCount(1);

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(page.locator('[data-clip-id^="clip-text-clean-title-"]')).toHaveCount(0);
    const requestsBeforeFollowUp = provider.requests;

    const composer = page.getByLabel('Message Joy Code');
    await composer.fill('Make that title smaller.');
    await composer.press('Enter');
    await expect(
      page.getByText(
        'A previously edited item is no longer available. Select an existing item before continuing.',
        { exact: true },
      ),
    ).toBeVisible();
    expect(provider.requests).toBe(requestsBeforeFollowUp);
    await expect(page.getByRole('region', { name: 'JOY Agent live proposal' })).toHaveCount(0);
  });
});
