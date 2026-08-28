import { describe, expect, it } from 'vitest';
import type {
  AsyncAdapterOptions,
  AsyncOutcome,
  JoyCodeModelPlanV1,
  JoyCodePlannerInputV1,
} from '@joy-media/agent-tools';
import {
  ConfiguredJoyCodeRuntime,
  DEFAULT_JOY_CODE_RUNTIME,
  type JoyCodeRuntimeInput,
} from './joy-code-runtime.js';

const modelId = 'nvidia/nemotron-3.5-lightning:free';
const validationOptions = {
  textTemplateIds: ['clean-title'],
  captionTemplateIds: ['joy-clean'],
  transitionIds: ['dissolve'],
  allowedModelIds: [modelId],
  consentVersion: 'openrouter-nvidia-free-edit-planning-v1',
} as const;
const input: JoyCodeRuntimeInput = {
  projectId: 'project-1',
  snapshotRevisionId: 'rev-1',
  prompt: 'trim the first clip',
  selection: { clipIds: ['clip-1'] },
  contextSummary: 'context',
  planId: 'plan-1',
  createdAt: '2026-08-20T00:00:00.000Z',
  catalogVersion: 'catalog-v1',
  catalogs: {
    textTemplateIds: ['clean-title'],
    captionTemplateIds: ['joy-clean'],
    transitionIds: ['dissolve'],
  },
};
const validPlan: JoyCodeModelPlanV1 = {
  schemaVersion: 1,
  goal: 'trim the first clip',
  summary: 'No edits proposed',
  operations: [],
  assumptions: [],
  blockedBy: [],
  requiresHumanDecision: [],
};
function runtimeFor(outcome: AsyncOutcome<JoyCodeModelPlanV1>) {
  return new ConfiguredJoyCodeRuntime({
    adapter: {
      adapterName: 'test-adapter',
      createPlan: async (_input: JoyCodePlannerInputV1, _options: AsyncAdapterOptions) => outcome,
    },
    modelId,
    consentVersion: validationOptions.consentVersion,
    validationOptions,
  });
}

describe('Joy Code runtime finalization', () => {
  it('returns the canonical unavailable outcome without executing a model', async () => {
    const result = await DEFAULT_JOY_CODE_RUNTIME.execute(input, { correlationId: 'corr-1' });
    expect(result.category).toBe('unavailable');
    expect(result.result).toBeUndefined();
  });
  it('rejects a ready outcome that has no model result', async () => {
    const result = await runtimeFor({ category: 'ready', retryable: false, durationMs: 2 }).execute(
      input,
      { correlationId: 'corr-2' },
    );
    expect(result).toMatchObject({
      category: 'invalid-output',
      errorCode: 'JOY_CODE_RESULT_MISSING',
    });
  });
  it('finalizes a valid model plan with server-owned provenance', async () => {
    const result = await runtimeFor({
      category: 'ready',
      result: validPlan,
      retryable: false,
      durationMs: 3,
    }).execute(input, { correlationId: 'corr-3' });
    expect(result.category).toBe('ready');
    if (result.category === 'ready' && result.result !== undefined) {
      expect(result.result.provenance).toEqual({
        actor: 'joy-code-server',
        adapterName: 'test-adapter',
        modelId,
      });
      expect(result.result.planId).toBe('plan-1');
    }
  });
  it('maps an invalid model plan to invalid-output without leaking details', async () => {
    const result = await runtimeFor({
      category: 'ready',
      result: { ...validPlan, goal: '' },
      retryable: false,
      durationMs: 4,
    }).execute(input, { correlationId: 'corr-4' });
    expect(result).toMatchObject({
      category: 'invalid-output',
      errorCode: 'JOY_CODE_FINALIZATION_INVALID',
    });
    expect(result.message).not.toContain('secret');
  });
});
