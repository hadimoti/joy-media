import { describe, expect, it } from 'vitest';
import {
  JOY_CODE_PLAN_SCHEMA_VERSION,
  JOY_CODE_PLAN_LIMITS,
  validateJoyCodeModelPlan,
  validateJoyCodePlanProposal,
  type JoyCodeModelPlanV1,
  type JoyCodePlanProposalV1,
  type JoyCodeValidationOptions,
} from './joy-code-plan.js';

const CATALOGS: JoyCodeValidationOptions = {
  textTemplateIds: ['clean-title', 'hero-title'],
  captionTemplateIds: ['joy-clean', 'joy-karaoke-pop', 'joy-rtl-classic'],
  transitionIds: ['dissolve', 'wipe', 'slide'],
};

function trimOperation(id = 'trim-hook') {
  return {
    id,
    dependsOn: [],
    kind: 'timeline.trimClip' as const,
    compositionId: 'root',
    trackId: 'visual-main',
    clipId: 'clip-hook',
    newStartUs: 0,
    newEndUs: 1_800_000,
  };
}

function validPlan(overrides: Partial<JoyCodeModelPlanV1> = {}): JoyCodeModelPlanV1 {
  return {
    schemaVersion: JOY_CODE_PLAN_SCHEMA_VERSION,
    goal: 'Create a tighter picture mix with a clear hook.',
    summary: 'Trim the opening, add a title, style captions, and use one dissolve.',
    operations: [
      trimOperation(),
      {
        id: 'title',
        dependsOn: ['trim-hook'],
        kind: 'text.insertTemplate',
        templateId: 'hero-title',
        content: 'Build the moment',
        startUs: 0,
        durationUs: 2_500_000,
        placementPreset: 'center',
      },
      {
        id: 'captions',
        dependsOn: [],
        kind: 'caption.setTemplate',
        captionClipId: 'caption-1',
        templateId: 'joy-rtl-classic',
      },
      {
        id: 'transition',
        dependsOn: ['trim-hook'],
        kind: 'transition.addAtJunction',
        outgoingClipId: 'clip-hook',
        incomingClipId: 'clip-product',
        transitionId: 'dissolve',
        durationUs: 400_000,
      },
    ],
    assumptions: ['Existing visual clips are already registered and playable.'],
    blockedBy: [],
    requiresHumanDecision: ['Review the proposed title copy before Apply.'],
    ...overrides,
  };
}

function validProposal(overrides: Partial<JoyCodePlanProposalV1> = {}): JoyCodePlanProposalV1 {
  const modelPlan = validPlan();
  return {
    ...modelPlan,
    planId: 'joy-code-plan-001',
    projectId: 'project-1',
    snapshotRevisionId: 'rev-7',
    createdAt: '2026-08-20T12:00:00.000Z',
    consentVersion: 'openrouter-nvidia-free-edit-planning-v1',
    catalogVersion: 'joy-code-catalog-v1',
    provenance: {
      actor: 'joy-code-server',
      adapterName: 'openrouter-joy-code-v1',
      modelId: 'nvidia/nemotron-3.5-lightning:free',
    },
    ...overrides,
  };
}

describe('Joy Code plan contract', () => {
  it('accepts a bounded English plan with catalog-backed operations', () => {
    const result = validateJoyCodeModelPlan(validPlan(), CATALOGS);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    if (result.valid) expect(result.value.operations).toHaveLength(4);
  });

  it('rejects a known operation when it is absent from the model-visible catalog', () => {
    const plan = validPlan({ operations: [trimOperation()] });

    const restricted = validateJoyCodeModelPlan(plan, {
      ...CATALOGS,
      allowedOperationKinds: ['text.insertTemplate'],
    });

    expect(restricted.valid).toBe(false);
    expect(restricted.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'operation-not-model-visible' })]),
    );
    expect(validateJoyCodeModelPlan(plan, CATALOGS).valid).toBe(true);
  });

  it('accepts typed motion keyframe operations and rejects unsupported bindings', () => {
    const result = validateJoyCodeModelPlan(
      validPlan({
        operations: [
          {
            id: 'opacity-key',
            dependsOn: [],
            kind: 'motion.setKeyframe',
            binding: {
              ownerKind: 'visual-object',
              ownerId: 'object-1',
              propertyId: 'opacity',
              timeDomain: 'composition',
            },
            key: {
              kind: 'scalar',
              timeUs: 500_000,
              value: 0.75,
              interpolation: 'linear',
            },
          },
          {
            id: 'opacity-remove',
            dependsOn: ['opacity-key'],
            kind: 'motion.removeKeyframe',
            binding: {
              ownerKind: 'visual-object',
              ownerId: 'object-1',
              propertyId: 'opacity',
              timeDomain: 'composition',
            },
            timeUs: 500_000,
          },
        ],
      }),
      CATALOGS,
    );
    expect(result.valid).toBe(true);

    const rejected = validateJoyCodeModelPlan(
      validPlan({
        operations: [
          {
            id: 'bad-key',
            dependsOn: [],
            kind: 'motion.setKeyframe',
            binding: {
              ownerKind: 'not-a-real-owner',
              ownerId: 'object-1',
              propertyId: 'opacity',
              timeDomain: 'composition',
            },
            key: {
              kind: 'scalar',
              timeUs: 0,
              value: 1,
              interpolation: 'linear',
            },
          },
        ],
      }),
      CATALOGS,
    );
    expect(rejected.valid).toBe(false);
    expect(rejected.errors.some((error) => error.code === 'invalid-binding-owner')).toBe(true);
  });

  it('preserves Persian and RTL text byte-for-byte', () => {
    const input = validPlan({
      goal: 'ریتم و زیرنویس فارسی را بهتر کن',
      summary: 'متن فارسی باید بدون تغییر معنا و جهت نمایش داده شود.',
      operations: [
        {
          id: 'caption-text',
          dependsOn: [],
          kind: 'caption.setSegmentText',
          captionClipId: 'caption-1',
          segmentId: 'segment-1',
          text: 'این یک متن فارسی برای آزمایش است',
        },
      ],
    });

    const result = validateJoyCodeModelPlan(input, CATALOGS);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.goal).toBe(input.goal);
      expect(result.value.operations[0]).toEqual(input.operations[0]);
    }
  });

  it('rejects unknown top-level fields and arbitrary command payloads', () => {
    const input = {
      ...validPlan(),
      unknownField: true,
      commands: [{ type: 'timeline.deleteAll', payload: {} }],
    };

    const result = validateJoyCodeModelPlan(input, CATALOGS);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'unknown-field')).toBe(true);
  });

  it('rejects unknown operation kinds and raw command-shaped operations', () => {
    const input = {
      ...validPlan(),
      operations: [
        {
          id: 'raw',
          dependsOn: [],
          kind: 'timeline.rawCommand',
          command: { type: 'timeline.removeTrack', payload: {} },
        },
      ],
    };

    const result = validateJoyCodeModelPlan(input, CATALOGS);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'invalid-operation-kind')).toBe(true);
  });

  it('rejects model-supplied authority, provider, approval, and execution fields', () => {
    const input = {
      ...validPlan(),
      projectId: 'project-1',
      snapshotRevisionId: 'rev-7',
      provider: 'openrouter',
      approved: true,
      execute: true,
      modelId: 'nvidia/nemotron-3.5-lightning:free',
    };

    const result = validateJoyCodeModelPlan(input, CATALOGS);

    expect(result.valid).toBe(false);
    expect(result.errors.filter((error) => error.code === 'unknown-field').length).toBeGreaterThan(
      0,
    );
  });

  it('rejects unknown templates and transitions even when the operation shape is valid', () => {
    const input = validPlan({
      operations: [
        {
          id: 'title',
          dependsOn: [],
          kind: 'text.insertTemplate',
          templateId: 'model-invented-style',
          content: 'Unsafe style',
          startUs: 0,
          durationUs: 1_000_000,
          placementPreset: 'center',
        },
        {
          id: 'transition',
          dependsOn: [],
          kind: 'transition.addAtJunction',
          outgoingClipId: 'clip-a',
          incomingClipId: 'clip-b',
          transitionId: 'gl:arbitrary-shader',
          durationUs: 200_000,
        },
      ],
    });

    const result = validateJoyCodeModelPlan(input, CATALOGS);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'unknown-template')).toBe(true);
    expect(result.errors.some((error) => error.code === 'unknown-transition')).toBe(true);
  });

  it('rejects invalid ranges, negative timestamps, and oversized text', () => {
    const input = validPlan({
      operations: [
        {
          id: 'title',
          dependsOn: [],
          kind: 'text.insertTemplate',
          templateId: 'hero-title',
          content: 'x'.repeat(JOY_CODE_PLAN_LIMITS.textContent + 1),
          startUs: -1,
          durationUs: 0,
          placementPreset: 'center',
        },
      ],
    });

    const result = validateJoyCodeModelPlan(input, CATALOGS);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'invalid-range')).toBe(true);
    expect(result.errors.some((error) => error.code === 'text-too-long')).toBe(true);
  });

  it('rejects duplicate operation IDs, missing dependencies, and dependency cycles', () => {
    const duplicate = validPlan({
      operations: [trimOperation('same'), trimOperation('same')],
    });
    const missingDependency = validPlan({
      operations: [{ ...trimOperation(), dependsOn: ['does-not-exist'] }],
    });
    const cycle = validPlan({
      operations: [
        { ...trimOperation('a'), dependsOn: ['b'] },
        { ...trimOperation('b'), dependsOn: ['a'] },
      ],
    });

    expect(validateJoyCodeModelPlan(duplicate, CATALOGS).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'duplicate-operation-id' })]),
    );
    expect(validateJoyCodeModelPlan(missingDependency, CATALOGS).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unknown-dependency' })]),
    );
    expect(validateJoyCodeModelPlan(cycle, CATALOGS).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'dependency-cycle' })]),
    );
  });

  it('rejects more than the operation limit', () => {
    const input = validPlan({
      operations: Array.from({ length: JOY_CODE_PLAN_LIMITS.operations + 1 }, (_, index) =>
        trimOperation('trim-' + index),
      ),
    });

    const result = validateJoyCodeModelPlan(input, CATALOGS);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'too-many-operations')).toBe(true);
  });

  it('rejects paths, URLs, secrets, and object-store references recursively', () => {
    const input = validPlan({
      assumptions: ['https://example.invalid/private.mov'],
      blockedBy: ['Bearer abc.def.ghi'],
      requiresHumanDecision: ['Use /var/media/project.mov'],
    });

    const result = validateJoyCodeModelPlan(input, CATALOGS);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'forbidden-data')).toBe(true);
  });

  it('allows ordinary provider words when they are not credential-shaped', () => {
    const input = validPlan({
      summary: 'OpenRouter is the selected reasoning provider; no token or password is included.',
    });

    const result = validateJoyCodeModelPlan(input, CATALOGS);

    expect(result.valid).toBe(true);
  });

  it('rejects unsafe transition and caption timing values', () => {
    const input = validPlan({
      operations: [
        {
          id: 'transition',
          dependsOn: [],
          kind: 'transition.addAtJunction',
          outgoingClipId: 'clip-a',
          incomingClipId: 'clip-b',
          transitionId: 'dissolve',
          durationUs: 1,
        },
        {
          id: 'caption-time',
          dependsOn: [],
          kind: 'caption.setSegmentTiming',
          captionClipId: 'caption-1',
          segmentId: 'segment-1',
          startUs: 10_000,
          endUs: 10_000,
        },
      ],
    });

    const result = validateJoyCodeModelPlan(input, CATALOGS);

    expect(result.valid).toBe(false);
    expect(result.errors.filter((error) => error.code === 'invalid-range').length).toBeGreaterThan(
      0,
    );
  });

  it('does not mutate the input plan', () => {
    const input = validPlan();
    const before = JSON.stringify(input);

    validateJoyCodeModelPlan(input, CATALOGS);

    expect(JSON.stringify(input)).toBe(before);
  });

  it('accepts a server-owned proposal with exact provenance and consent', () => {
    const result = validateJoyCodePlanProposal(validProposal(), {
      ...CATALOGS,
      allowedModelIds: ['nvidia/nemotron-3.5-lightning:free'],
      consentVersion: 'openrouter-nvidia-free-edit-planning-v1',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects a proposal whose server-owned identity or model does not match policy', () => {
    const wrongModel = validProposal({
      provenance: {
        actor: 'joy-code-server',
        adapterName: 'openrouter-joy-code-v1',
        modelId: 'openrouter/free',
      },
    });
    const wrongActor: unknown = {
      ...validProposal(),
      provenance: {
        actor: 'kilocode',
        adapterName: 'openrouter-joy-code-v1',
        modelId: 'nvidia/nemotron-3.5-lightning:free',
      },
    };

    expect(
      validateJoyCodePlanProposal(wrongModel, {
        ...CATALOGS,
        allowedModelIds: ['nvidia/nemotron-3.5-lightning:free'],
        consentVersion: 'openrouter-nvidia-free-edit-planning-v1',
      }).errors,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'model-not-allowed' })]));
    expect(
      validateJoyCodePlanProposal(wrongActor, {
        ...CATALOGS,
        allowedModelIds: ['nvidia/nemotron-3.5-lightning:free'],
        consentVersion: 'openrouter-nvidia-free-edit-planning-v1',
      }).errors,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid-actor' })]));
  });

  it('rejects a proposal with the wrong consent version or unknown fields', () => {
    const input = {
      ...validProposal({ consentVersion: 'old-consent' }),
      executionStatus: 'ready',
    };

    const result = validateJoyCodePlanProposal(input, {
      ...CATALOGS,
      allowedModelIds: ['nvidia/nemotron-3.5-lightning:free'],
      consentVersion: 'openrouter-nvidia-free-edit-planning-v1',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'consent-version-mismatch')).toBe(true);
    expect(result.errors.some((error) => error.code === 'unknown-field')).toBe(true);
  });

  it('produces byte-stable validated output for identical input', () => {
    const first = validateJoyCodeModelPlan(validPlan(), CATALOGS);
    const second = validateJoyCodeModelPlan(validPlan(), CATALOGS);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
