import { describe, expect, it } from 'vitest';
import {
  createValidFakeAsyncJoyCodePlanner,
  createUnavailableFakeAsyncJoyCodePlanner,
  createTimeoutFakeAsyncJoyCodePlanner,
} from './async-joy-code-adapter.js';

const input = {
  projectId: 'project-1',
  snapshotRevisionId: 'rev-1',
  prompt: 'Add a title',
  selection: { clipIds: ['clip-1'] },
  contextSummary: 'bounded semantic context',
  semanticSnapshot: { scenes: [] },
  intelligenceSummary: {},
  catalogs: {
    textTemplateIds: ['clean-title'],
    captionTemplateIds: ['joy-clean'],
    transitionIds: ['dissolve'],
  },
} as const;
const options = { correlationId: 'corr-1', timeoutMs: 100, spendLimitUsdCents: 0 };

describe('async Joy Code planner adapter', () => {
  it('returns a deterministic valid model plan without mutating input', async () => {
    const adapter = createValidFakeAsyncJoyCodePlanner();
    const before = JSON.stringify(input);
    const result = await adapter.createPlan(input, options);
    expect(result.category).toBe('ready');
    expect(result.result?.schemaVersion).toBe(1);
    expect(JSON.stringify(input)).toBe(before);
    expect(adapter.isTestOnly).toBe(true);
  });

  it('maps cancellation, timeout, and unavailable modes to typed outcomes', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      createValidFakeAsyncJoyCodePlanner().createPlan(input, { ...options, signal: abort.signal }),
    ).resolves.toMatchObject({ category: 'cancelled' });
    await expect(
      createTimeoutFakeAsyncJoyCodePlanner().createPlan(input, { ...options, timeoutMs: 1 }),
    ).resolves.toMatchObject({ category: 'timeout' });
    await expect(
      createUnavailableFakeAsyncJoyCodePlanner().createPlan(input, options),
    ).resolves.toMatchObject({ category: 'unavailable' });
  });
});
