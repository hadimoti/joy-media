import { describe, expect, it } from 'vitest';
import { finalizeJoyCodePlan, type JoyCodePlannerInputV1 } from './async-joy-code-plan.js';
import { JOY_CODE_PLAN_SCHEMA_VERSION, type JoyCodeModelPlanV1 } from './joy-code-plan.js';

const input: JoyCodePlannerInputV1 = {
  projectId: 'project-1',
  snapshotRevisionId: 'rev-1',
  prompt: 'Add a title',
  selection: { clipIds: [] },
  contextSummary: 'safe summary',
};
const model: JoyCodeModelPlanV1 = {
  schemaVersion: JOY_CODE_PLAN_SCHEMA_VERSION,
  goal: 'Add a title',
  summary: 'Insert a catalog title',
  operations: [
    {
      id: 'title',
      dependsOn: [],
      kind: 'text.insertTemplate',
      templateId: 'clean-title',
      content: 'Hello',
      startUs: 0,
      durationUs: 1_000_000,
      placementPreset: 'center',
    },
  ],
  assumptions: [],
  blockedBy: [],
  requiresHumanDecision: [],
};
const catalogs = {
  textTemplateIds: ['clean-title'],
  captionTemplateIds: ['joy-clean'],
  transitionIds: ['dissolve'],
  allowedModelIds: ['nvidia/nemotron-3.5-lightning:free'],
  consentVersion: 'openrouter-nvidia-free-edit-planning-v1',
} as const;

describe('async Joy Code plan finalizer', () => {
  it('attaches server-owned revision, consent, and provenance then validates', () => {
    const result = finalizeJoyCodePlan(
      input,
      model,
      {
        planId: 'plan-1',
        createdAt: '2026-08-20T00:00:00.000Z',
        catalogVersion: 'joy-code-catalog-v1',
        consentVersion: catalogs.consentVersion,
        adapterName: 'fake-joy-code-v1',
        modelId: catalogs.allowedModelIds[0]!,
      },
      catalogs,
    );
    expect(result.valid).toBe(true);
    if (result.valid)
      expect(result.value).toMatchObject({
        planId: 'plan-1',
        projectId: 'project-1',
        snapshotRevisionId: 'rev-1',
        provenance: { actor: 'joy-code-server' },
      });
  });

  it('rejects a model plan with forbidden data or wrong server identity', () => {
    expect(
      finalizeJoyCodePlan(
        input,
        { ...model, goal: 'https://bad.example' },
        {
          planId: 'plan-1',
          createdAt: '2026-08-20T00:00:00.000Z',
          catalogVersion: 'joy-code-catalog-v1',
          consentVersion: catalogs.consentVersion,
          adapterName: 'fake',
          modelId: catalogs.allowedModelIds[0]!,
        },
        catalogs,
      ).valid,
    ).toBe(false);
  });
});
