import { describe, expect, it } from 'vitest';
import {
  createPlan,
  validatePlan,
  addStepToPlan,
  updatePlanStatus,
  ApprovalEngine,
  createDefaultApprovalPolicy,
  createPermissiveApprovalPolicy,
  createStrictApprovalPolicy,
  estimatePlan,
  isPlanLocalOnly,
  validatePlanAgainstContext,
  validateStepDependencies,
  createToolRegistry,
} from './index.js';
import type { AgentPlanStep, AgentEditPlan } from './plan.js';
import type { EditorContext } from './context.js';

function createMockContext(overrides?: Partial<EditorContext>): EditorContext {
  return {
    project: {
      id: 'test-project',
      name: 'Test Project',
      durationUs: 60_000_000,
      compositionCount: 1,
      trackCount: 2,
      clipCount: 2,
      hasCaptions: false,
      hasAudio: true,
      missingAssets: [],
    },
    selection: {
      selectedClipIds: [],
      selectedTrackIds: [],
      playheadUs: 0,
    },
    timeline: {
      compositions: [],
      totalDurationUs: 60_000_000,
    },
    audio: {
      clipCount: 0,
      busCount: 0,
      hasDialogue: false,
    },
    providers: {
      availableProviders: [],
      localOnly: true,
    },
    availableTools: ['insertClip', 'removeClip', 'moveClip'],
    recentHistory: [],
    constraints: [],
    ...overrides,
  };
}

function createTestStep(overrides?: Partial<AgentPlanStep>): AgentPlanStep {
  return {
    id: 'step-1',
    description: 'Test step',
    mode: 'command',
    tool: 'insertClip',
    arguments: {},
    dependsOn: [],
    expectedChange: 'Insert clip',
    preconditions: [],
    requiresConfirmation: false,
    ...overrides,
  };
}

describe('Plan Creation', () => {
  it('creates plan with valid steps', () => {
    const steps = [createTestStep()];
    const plan = createPlan('Test goal', steps);

    expect(plan.planVersion).toBe(1);
    expect(plan.goal).toBe('Test goal');
    expect(plan.steps).toHaveLength(1);
    expect(plan.status).toBe('draft');
    expect(plan.planId).toBeDefined();
  });

  it('creates plan with custom options', () => {
    const steps = [createTestStep()];
    const plan = createPlan('Test goal', steps, {
      planId: 'custom-id',
      assumptions: ['assumption 1'],
      risks: ['risk 1'],
      status: 'pending-approval',
    });

    expect(plan.planId).toBe('custom-id');
    expect(plan.assumptions).toEqual(['assumption 1']);
    expect(plan.risks).toEqual(['risk 1']);
    expect(plan.status).toBe('pending-approval');
  });

  it('computes estimate from steps', () => {
    const steps = [
      createTestStep({ id: 'step-1', mode: 'command' }),
      createTestStep({ id: 'step-2', mode: 'job' }),
      createTestStep({ id: 'step-3', mode: 'command' }),
    ];
    const plan = createPlan('Test goal', steps);

    expect(plan.estimated.commandCount).toBe(2);
    expect(plan.estimated.generationJobs).toBe(1);
  });
});

describe('Plan Validation', () => {
  it('validates plan structure', () => {
    const steps = [createTestStep()];
    const plan = createPlan('Test goal', steps);
    const result = validatePlan(plan);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('catches missing goal', () => {
    const steps = [createTestStep()];
    const plan = createPlan('', steps);
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('goal'))).toBe(true);
  });

  it('catches empty steps', () => {
    const plan = createPlan('Test goal', []);
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('step'))).toBe(true);
  });

  it('catches duplicate step IDs', () => {
    const steps = [createTestStep({ id: 'step-1' }), createTestStep({ id: 'step-1' })];
    const plan = createPlan('Test goal', steps);
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate'))).toBe(true);
  });

  it('catches missing tools in context validation', () => {
    const steps = [createTestStep({ tool: 'nonexistentTool' })];
    const plan = createPlan('Test goal', steps);
    const registry = createToolRegistry();
    const context = createMockContext();

    const result = validatePlanAgainstContext(plan, registry, context);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.stepId === 'step-1')).toBe(true);
  });
});

describe('Step Dependencies', () => {
  it('validates valid dependencies', () => {
    const steps = [
      createTestStep({ id: 'step-1' }),
      createTestStep({ id: 'step-2', dependsOn: ['step-1'] }),
    ];
    const plan = createPlan('Test goal', steps);
    const result = validateStepDependencies(plan);

    expect(result.valid).toBe(true);
  });

  it('catches invalid dependencies', () => {
    const steps = [createTestStep({ id: 'step-1', dependsOn: ['nonexistent'] })];
    const plan = createPlan('Test goal', steps);
    const result = validateStepDependencies(plan);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'INVALID_DEPENDENCY')).toBe(true);
  });

  it('catches circular dependencies', () => {
    const steps = [
      createTestStep({ id: 'step-1', dependsOn: ['step-2'] }),
      createTestStep({ id: 'step-2', dependsOn: ['step-1'] }),
    ];
    const plan = createPlan('Test goal', steps);
    const result = validateStepDependencies(plan);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEPENDENCY_CYCLE')).toBe(true);
  });
});

describe('Approval Engine', () => {
  it('auto-approves reversible local edits', () => {
    const policy = createPermissiveApprovalPolicy();
    const engine = new ApprovalEngine(policy);
    const step = createTestStep({ requiresConfirmation: false });
    const context = createMockContext();

    const decision = engine.evaluateStep(step, context);
    expect(decision.decision).toBe('auto-approved');
  });

  it('requires explicit approval before remote uploads in the default mode', () => {
    const policy = createDefaultApprovalPolicy();
    const engine = new ApprovalEngine(policy);
    const step = createTestStep({
      estimatedCost: {
        workerTimeMs: 1000,
        providerCost: { amount: '0.00', currency: 'USD' },
        localOnly: false,
      },
    });
    const context = createMockContext();

    const decision = engine.evaluateStep(step, context);
    expect(decision.decision).toBe('requires-manual');
    expect(decision.request.privacyImpact.dataLeavesDevice).toBe(true);
  });

  it('blocks voice cloning when policy says so', () => {
    const policy = createDefaultApprovalPolicy();
    const engine = new ApprovalEngine(policy);
    const step = createTestStep({ tool: 'voiceClone' });
    const context = createMockContext();

    const decision = engine.evaluateStep(step, context);
    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toContain('Voice');
  });

  it('requires explicit approval before destructive edits in the default mode', () => {
    const policy = createDefaultApprovalPolicy();
    const engine = new ApprovalEngine(policy);
    const step = createTestStep({ requiresConfirmation: true });
    const context = createMockContext();

    const decision = engine.evaluateStep(step, context);
    expect(decision.decision).toBe('requires-manual');
    expect(decision.request.reason).toBe('destructive-edit');
  });

  it('requires approval for high cost operations', () => {
    const policy = createDefaultApprovalPolicy();
    const engine = new ApprovalEngine(policy);
    const step = createTestStep({
      estimatedCost: {
        workerTimeMs: 1000,
        providerCost: { amount: '100.00', currency: 'USD' },
        localOnly: true,
      },
    });
    const context = createMockContext();

    const decision = engine.evaluateStep(step, context);
    expect(decision.decision).toBe('requires-manual');
  });

  it('requires approval for unresolved assumptions', () => {
    const policy = createDefaultApprovalPolicy();
    const engine = new ApprovalEngine(policy);
    const steps = [createTestStep()];
    const plan = createPlan('Test goal', steps, {
      assumptions: ['assumption 1'],
    });
    const context = createMockContext();

    const decisions = engine.evaluatePlan(plan, context);
    const assumptionDecision = decisions.find((d) => d.reason.includes('assumptions'));
    expect(assumptionDecision).toBeDefined();
    expect(assumptionDecision?.decision).toBe('requires-manual');
  });

  it('surfaces provider preflight as a pending approval for Joy Code and workflow plans', () => {
    const policy = createDefaultApprovalPolicy();
    const engine = new ApprovalEngine(policy);
    const plan = createPlan('Generate narration', [
      createTestStep({
        id: 'tts-step',
        mode: 'job',
        tool: 'speechSynthesize',
        arguments: {
          providerApprovalPreflight: {
            providerId: 'edge-tts',
            capability: 'speech.synthesize',
            dataLeavesDevice: true,
            dataBeingSent: ['text data'],
            purpose: 'Synthesize speech from text',
            estimatedSizeBytes: 1000,
            transformations: ['remote API call'],
            requiresUserApproval: true,
            requestDigest: 'sha256:abc123',
            retentionDisclosure: 'Text is sent to Microsoft Edge online TTS for synthesis',
            estimatedCost: { amount: '0.00', currency: 'USD' },
          },
        },
      }),
    ]);
    const context = createMockContext();

    const decisions = engine.evaluatePlan(plan, context);

    expect(decisions).toContainEqual(
      expect.objectContaining({
        decision: 'requires-manual',
        request: expect.objectContaining({
          id: 'approval-provider-sha256:abc123',
          stepId: 'tts-step',
          reason: 'paid-generation',
          estimatedCost: { amount: '0.00', currency: 'USD' },
          privacyImpact: expect.objectContaining({
            dataLeavesDevice: true,
            providerId: 'edge-tts',
            dataTypes: ['text data'],
          }),
        }),
      }),
    );
  });

  it('records approval correctly', () => {
    const policy = createDefaultApprovalPolicy();
    const engine = new ApprovalEngine(policy);
    const steps = [createTestStep()];
    const plan = createPlan('Test goal', steps, {
      requiredApprovals: [
        {
          id: 'approval-1',
          stepId: 'step-1',
          reason: 'paid-generation',
          description: 'Test approval',
          privacyImpact: { dataLeavesDevice: false, dataTypes: [] },
          isReversible: true,
          status: 'pending',
        },
      ],
    });

    const updatedPlan = engine.recordApproval(plan, 'approval-1', true);
    const approval = updatedPlan.requiredApprovals.find((a) => a.id === 'approval-1');
    expect(approval?.status).toBe('approved');
  });

  it('canProceed checks all approvals resolved', () => {
    const policy = createDefaultApprovalPolicy();
    const engine = new ApprovalEngine(policy);

    const planWithPending: AgentEditPlan = createPlan('Test', [createTestStep()], {
      requiredApprovals: [
        {
          id: 'approval-1',
          stepId: 'step-1',
          reason: 'paid-generation',
          description: 'Test',
          privacyImpact: { dataLeavesDevice: false, dataTypes: [] },
          isReversible: true,
          status: 'pending',
        },
      ],
    });

    expect(engine.canProceed(planWithPending)).toBe(false);

    const planApproved = engine.recordApproval(planWithPending, 'approval-1', true);
    expect(engine.canProceed(planApproved)).toBe(true);
  });
});

describe('Cost Estimation', () => {
  it('aggregates step costs', () => {
    const steps = [
      createTestStep({
        id: 'step-1',
        estimatedCost: {
          workerTimeMs: 1000,
          providerCost: { amount: '10.00', currency: 'USD' },
          localOnly: true,
        },
      }),
      createTestStep({
        id: 'step-2',
        estimatedCost: {
          workerTimeMs: 2000,
          providerCost: { amount: '20.00', currency: 'USD' },
          localOnly: true,
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const registry = createToolRegistry();
    const context = createMockContext();

    const estimation = estimatePlan(plan, registry, context);
    expect(parseFloat(estimation.totalCost.max.amount)).toBeGreaterThan(0);
  });

  it('detects remote data transfer', () => {
    const steps = [
      createTestStep({
        estimatedCost: {
          workerTimeMs: 1000,
          providerCost: { amount: '10.00', currency: 'USD' },
          localOnly: false,
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const registry = createToolRegistry();
    const context = createMockContext({
      providers: {
        availableProviders: [
          {
            id: 'test-provider',
            displayName: 'Test Provider',
            execution: 'remote-api',
            capabilities: ['speech.transcribe'],
            dataLeavesDevice: true,
          },
        ],
        localOnly: false,
      },
    });

    const estimation = estimatePlan(plan, registry, context);
    expect(estimation.dataLeavesDevice).toBe(true);
  });
});

describe('Local-Only Check', () => {
  it('identifies local-only plans', () => {
    const steps = [
      createTestStep({
        estimatedCost: {
          workerTimeMs: 1000,
          localOnly: true,
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const registry = createToolRegistry();
    const context = createMockContext();

    const isLocal = isPlanLocalOnly(plan, registry, context);
    expect(isLocal).toBe(true);
  });

  it('identifies plans with remote operations', () => {
    const steps = [
      createTestStep({
        tool: 'speechTranscribe',
        estimatedCost: {
          workerTimeMs: 1000,
          providerCost: { amount: '10.00', currency: 'USD' },
          localOnly: false,
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const registry = createToolRegistry();
    const context = createMockContext({
      providers: {
        availableProviders: [
          {
            id: 'test-provider',
            displayName: 'Test Provider',
            execution: 'remote-api',
            capabilities: ['speech.transcribe'],
            dataLeavesDevice: true,
          },
        ],
        localOnly: false,
      },
    });

    const isLocal = isPlanLocalOnly(plan, registry, context);
    expect(isLocal).toBe(false);
  });
});

describe('Plan Status Transitions', () => {
  it('updates status correctly', () => {
    const steps = [createTestStep()];
    const plan = createPlan('Test goal', steps);

    expect(plan.status).toBe('draft');

    const pendingPlan = updatePlanStatus(plan, 'pending-approval');
    expect(pendingPlan.status).toBe('pending-approval');

    const approvedPlan = updatePlanStatus(pendingPlan, 'approved');
    expect(approvedPlan.status).toBe('approved');

    const executingPlan = updatePlanStatus(approvedPlan, 'executing');
    expect(executingPlan.status).toBe('executing');

    const completedPlan = updatePlanStatus(executingPlan, 'completed');
    expect(completedPlan.status).toBe('completed');
  });
});

describe('Plan Modification', () => {
  it('adds step to plan', () => {
    const steps = [createTestStep({ id: 'step-1' })];
    const plan = createPlan('Test goal', steps);

    const newStep = createTestStep({ id: 'step-2' });
    const updatedPlan = addStepToPlan(plan, newStep);

    expect(updatedPlan.steps).toHaveLength(2);
    expect(updatedPlan.steps[1]?.id).toBe('step-2');
  });
});

describe('Policy Presets', () => {
  it('creates default policy', () => {
    const policy = createDefaultApprovalPolicy();
    expect(policy.executionMode).toBe('preview-and-approve');
    expect(policy.blockRemoteUploads).toBe(false);
    expect(policy.blockVoiceCloning).toBe(true);
    expect(policy.blockDestructiveEdits).toBe(false);
  });

  it('creates permissive policy', () => {
    const policy = createPermissiveApprovalPolicy();
    expect(policy.executionMode).toBe('full-auto-limited');
    expect(policy.blockRemoteUploads).toBe(false);
    expect(policy.blockVoiceCloning).toBe(false);
    expect(policy.blockDestructiveEdits).toBe(false);
    expect(policy.allowUnresolvedAssumptions).toBe(true);
  });

  it('creates strict policy', () => {
    const policy = createStrictApprovalPolicy();
    expect(policy.blockRemoteUploads).toBe(true);
    expect(policy.blockVoiceCloning).toBe(true);
    expect(policy.blockDestructiveEdits).toBe(true);
    expect(policy.allowUnresolvedAssumptions).toBe(false);
    expect(policy.maxPlanSteps).toBeLessThan(50);
  });
});
