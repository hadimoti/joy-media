import { describe, expect, it } from 'vitest';
import { createJoyCodeRuntimeFactory } from './joy-code-runtime-factory.js';
import { ConfiguredJoyCodeRuntime, DEFAULT_JOY_CODE_RUNTIME } from './joy-code-runtime.js';
import { JOY_CODE_MODEL_ID, JOY_CODE_SECRET_REFERENCE } from './joy-code-runtime-config.js';
import type {
  AsyncAdapterOptions,
  AsyncOutcome,
  JoyCodeModelPlanV1,
  JoyCodePlannerInputV1,
} from '@joy-media/agent-tools';
import type { JoyCodeRuntimeInput } from './joy-code-runtime.js';

const input: JoyCodeRuntimeInput = {
  projectId: 'project-1',
  snapshotRevisionId: 'rev-1',
  prompt: 'make a title',
  selection: { clipIds: ['clip-1'] },
  contextSummary: 'context',
  planId: 'plan-1',
  createdAt: '2026-08-20T00:00:00.000Z',
  catalogVersion: 'v1',
  catalogs: {
    textTemplateIds: ['clean-title'],
    captionTemplateIds: ['joy-clean'],
    transitionIds: ['dissolve'],
  },
};

const adapterOutput: JoyCodeModelPlanV1 = {
  schemaVersion: 1,
  goal: 'make a title',
  summary: 'empty plan',
  operations: [],
  assumptions: [],
  blockedBy: [],
  requiresHumanDecision: [],
};

function adapterReturning(outcome: AsyncOutcome<JoyCodeModelPlanV1>) {
  return {
    adapterName: 'test-adapter',
    createPlan: async (_input: JoyCodePlannerInputV1, _options: AsyncAdapterOptions) => outcome,
  };
}

describe('Joy Code runtime factory', () => {
  it('fails closed when disabled or dependencies are missing', () => {
    expect(createJoyCodeRuntimeFactory({ mode: 'disabled' }, {})).toBe(DEFAULT_JOY_CODE_RUNTIME);
    expect(
      createJoyCodeRuntimeFactory(
        {
          mode: 'openrouter',
          modelId: JOY_CODE_MODEL_ID,
          timeoutMs: 1000,
          spendLimitUsdCents: 0,
          secretRef: JOY_CODE_SECRET_REFERENCE,
          allowedFreeModelIds: [JOY_CODE_MODEL_ID],
        },
        {},
      ),
    ).toBe(DEFAULT_JOY_CODE_RUNTIME);
  });

  it('finalizes a ready model plan with server-owned metadata', async () => {
    const runtime = new ConfiguredJoyCodeRuntime({
      adapter: adapterReturning({
        category: 'ready',
        result: adapterOutput,
        retryable: false,
        durationMs: 1,
      }),
      modelId: JOY_CODE_MODEL_ID,
      consentVersion: 'openrouter-nvidia-free-edit-planning-v1',
      validationOptions: {
        textTemplateIds: ['clean-title'],
        captionTemplateIds: ['joy-clean'],
        transitionIds: ['dissolve'],
        allowedModelIds: [JOY_CODE_MODEL_ID],
        consentVersion: 'openrouter-nvidia-free-edit-planning-v1',
      },
    });
    const result = await runtime.execute(input, { correlationId: 'corr-1' });
    expect(result.category).toBe('ready');
    if (result.category === 'ready' && result.result !== undefined) {
      expect(result.result.provenance).toEqual({
        actor: 'joy-code-server',
        adapterName: 'test-adapter',
        modelId: JOY_CODE_MODEL_ID,
      });
      expect(result.result.planId).toBe('plan-1');
    }
  });

  it('does not expose a model result for non-ready adapter outcomes', async () => {
    const runtime = new ConfiguredJoyCodeRuntime({
      adapter: adapterReturning({
        category: 'unavailable',
        errorCode: 'TEST_UNAVAILABLE',
        message: 'not configured',
        retryable: false,
        durationMs: 1,
      }),
      modelId: JOY_CODE_MODEL_ID,
      consentVersion: 'openrouter-nvidia-free-edit-planning-v1',
      validationOptions: {
        textTemplateIds: ['clean-title'],
        captionTemplateIds: ['joy-clean'],
        transitionIds: ['dissolve'],
        allowedModelIds: [JOY_CODE_MODEL_ID],
        consentVersion: 'openrouter-nvidia-free-edit-planning-v1',
      },
    });
    expect((await runtime.execute(input, { correlationId: 'corr-2' })).result).toBeUndefined();
  });
});
