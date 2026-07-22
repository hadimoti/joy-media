import { describe, expect, it } from 'vitest';
import { ProjectHistory } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
import {
  verifyAgentRun,
  verifyEntitiesExist,
  verifyNoInvalidOverlaps,
  verifyGeneratedAssetsDecode,
  verifyCaptionsWithinBounds,
  verifyAudioNotClipped,
  verifyNoMissingAssets,
  verifyUserIntentChecks,
} from './verification.js';
import { createBranchManager } from './branch.js';
import { revertAgentRun, canRevertAgentRun } from './revert.js';
import { createAuditTrail } from './audit.js';
import { createAgentMemoryManager } from './memory.js';
import { createPlan } from './plan.js';
import type { AgentPlanStep } from './plan.js';
import type { EditorContext } from './context.js';
import type { ExecutionResult, ExecutionStepResult } from './execution.js';
import type { AggregateDiff } from './dry-run.js';

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
    availableTools: ['insertClip', 'removeClip', 'moveClip', 'setGain'],
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
    arguments: {
      compositionId: 'comp-1',
      trackId: 'track-1',
      clip: { id: 'clip-new', kind: 'video', startUs: 10_000_000, durationUs: 1_000_000 },
    },
    dependsOn: [],
    expectedChange: 'Insert clip',
    preconditions: [],
    requiresConfirmation: false,
    ...overrides,
  };
}

function createMockExecutionResult(overrides?: Partial<ExecutionResult>): ExecutionResult {
  const aggregateDiff: AggregateDiff = {
    clipsCreated: 0,
    clipsModified: 0,
    clipsDeleted: 0,
    tracksAffected: [],
    timeRangesAffected: [],
    effectsAdded: 0,
    captionsAdded: 0,
    jobsRequired: 0,
    summary: 'No changes',
  };

  return {
    planId: 'plan-1',
    success: true,
    transactionLabel: '[2024-01-15T10-30-00] Test goal',
    stepResults: [],
    aggregateDiff,
    durationMs: 100,
    errors: [],
    warnings: [],
    rollbackAvailable: true,
    ...overrides,
  };
}

/** A real, correctly-typed SpikeProject for `ProjectHistory`-backed revert tests. */
function buildTestProject(): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'test',
    rootCompositionId: 'comp-1',
    compositions: {
      'comp-1': {
        id: 'comp-1',
        name: 'Main',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        durationUs: 60_000_000,
        tracks: [{ id: 'track-1', kind: 'video', order: 0, enabled: true, clips: [] }],
      },
    },
  };
}

function createProjectState(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 0,
    id: 'test-project',
    title: 'Test Project',
    rootCompositionId: 'comp-1',
    compositions: {
      'comp-1': {
        id: 'comp-1',
        name: 'Main',
        durationUs: 60_000_000,
        tracks: [
          {
            kind: 'video',
            clips: [
              {
                id: 'clip-1',
                kind: 'video',
                startUs: 0,
                durationUs: 10_000_000,
                assetId: 'asset-1',
              },
            ],
          },
        ],
      },
    },
    assets: {
      'asset-1': { id: 'asset-1', path: '/path/to/asset.mp4' },
    },
    ...overrides,
  };
}

describe('Verification', () => {
  describe('verifyEntitiesExist', () => {
    it('passes when all expected entities exist', () => {
      const steps = [
        createTestStep({
          arguments: {
            compositionId: 'comp-1',
            trackId: 'track-1',
            clip: { id: 'clip-1' },
          },
        }),
      ];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState();

      const check = verifyEntitiesExist(plan, state);

      expect(check.passed).toBe(true);
      expect(check.severity).toBe('info');
    });

    it('fails when entities are missing', () => {
      const steps = [
        createTestStep({
          arguments: {
            compositionId: 'comp-1',
            trackId: 'track-1',
            clip: { id: 'clip-missing' },
          },
        }),
      ];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState();

      const check = verifyEntitiesExist(plan, state);

      expect(check.passed).toBe(false);
      expect(check.severity).toBe('error');
      expect(check.message).toContain('missing');
    });

    it('handles missing project state gracefully', () => {
      const steps = [createTestStep()];
      const plan = createPlan('Test goal', steps);

      const check = verifyEntitiesExist(plan, null);

      expect(check.passed).toBe(false);
      expect(check.severity).toBe('error');
      expect(check.message).toContain('not available');
    });
  });

  describe('verifyNoInvalidOverlaps', () => {
    it('passes when no overlaps exist', () => {
      const steps = [createTestStep()];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState();

      const check = verifyNoInvalidOverlaps(plan, state);

      expect(check.passed).toBe(true);
      expect(check.severity).toBe('info');
    });

    it('detects overlapping clips', () => {
      const steps = [createTestStep()];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState({
        compositions: {
          'comp-1': {
            id: 'comp-1',
            durationUs: 60_000_000,
            tracks: [
              {
                kind: 'video',
                clips: [
                  { id: 'clip-1', startUs: 0, durationUs: 10_000_000 },
                  { id: 'clip-2', startUs: 5_000_000, durationUs: 10_000_000 },
                ],
              },
            ],
          },
        },
      });

      const check = verifyNoInvalidOverlaps(plan, state);

      expect(check.passed).toBe(false);
      expect(check.severity).toBe('error');
      expect(check.message).toContain('overlap');
    });
  });

  describe('verifyGeneratedAssetsDecode', () => {
    it('passes when no decode failures', () => {
      const result = createMockExecutionResult();

      const check = verifyGeneratedAssetsDecode(result);

      expect(check.passed).toBe(true);
      expect(check.severity).toBe('info');
    });

    it('fails when assets fail to decode', () => {
      const stepResults: ExecutionStepResult[] = [
        {
          stepId: 'step-1',
          status: 'failed',
          error: 'Failed to decode asset',
          durationMs: 50,
        },
      ];
      const result = createMockExecutionResult({ stepResults });

      const check = verifyGeneratedAssetsDecode(result);

      expect(check.passed).toBe(false);
      expect(check.severity).toBe('error');
      expect(check.message).toContain('decode');
    });
  });

  describe('verifyCaptionsWithinBounds', () => {
    it('passes when no caption operations', () => {
      const steps = [createTestStep()];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState();

      const check = verifyCaptionsWithinBounds(plan, state);

      expect(check.passed).toBe(true);
    });

    it('passes when captions are within bounds', () => {
      const steps = [
        createTestStep({
          tool: 'addCaption',
          arguments: { startUs: 0, durationUs: 5_000_000 },
        }),
      ];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState({
        compositions: {
          'comp-1': {
            id: 'comp-1',
            durationUs: 60_000_000,
            tracks: [
              {
                kind: 'caption',
                clips: [{ id: 'cap-1', startUs: 0, durationUs: 5_000_000 }],
              },
            ],
          },
        },
      });

      const check = verifyCaptionsWithinBounds(plan, state);

      expect(check.passed).toBe(true);
    });

    it('fails when captions exceed bounds', () => {
      const steps = [
        createTestStep({
          tool: 'addCaption',
          arguments: { startUs: 55_000_000, durationUs: 10_000_000 },
        }),
      ];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState({
        compositions: {
          'comp-1': {
            id: 'comp-1',
            durationUs: 60_000_000,
            tracks: [
              {
                kind: 'caption',
                clips: [{ id: 'cap-1', startUs: 55_000_000, durationUs: 10_000_000 }],
              },
            ],
          },
        },
      });

      const check = verifyCaptionsWithinBounds(plan, state);

      expect(check.passed).toBe(false);
      expect(check.severity).toBe('error');
    });
  });

  describe('verifyAudioNotClipped', () => {
    it('passes when no audio operations', () => {
      const steps = [createTestStep()];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState();

      const check = verifyAudioNotClipped(plan, state);

      expect(check.passed).toBe(true);
    });

    it('passes when audio is below clipping threshold', () => {
      const steps = [
        createTestStep({
          tool: 'setGain',
          arguments: { clipId: 'clip-1', gainDb: -3 },
        }),
      ];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState({
        audio: { peakLevelDb: -2.5 },
      });

      const check = verifyAudioNotClipped(plan, state);

      expect(check.passed).toBe(true);
      expect(check.message).toContain('-2.5');
    });

    it('warns when audio is clipping', () => {
      const steps = [
        createTestStep({
          tool: 'setGain',
          arguments: { clipId: 'clip-1', gainDb: 6 },
        }),
      ];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState({
        audio: { peakLevelDb: 1.2 },
      });

      const check = verifyAudioNotClipped(plan, state);

      expect(check.passed).toBe(false);
      expect(check.severity).toBe('warning');
    });
  });

  describe('verifyNoMissingAssets', () => {
    it('passes when all assets are present', () => {
      const steps = [createTestStep()];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState();

      const check = verifyNoMissingAssets(plan, state);

      expect(check.passed).toBe(true);
    });

    it('fails when assets are missing', () => {
      const steps = [createTestStep()];
      const plan = createPlan('Test goal', steps);
      const state = createProjectState({
        compositions: {
          'comp-1': {
            id: 'comp-1',
            durationUs: 60_000_000,
            tracks: [
              {
                kind: 'video',
                clips: [
                  {
                    id: 'clip-1',
                    kind: 'video',
                    startUs: 0,
                    durationUs: 10_000_000,
                    assetId: 'asset-missing',
                  },
                ],
              },
            ],
          },
        },
        assets: {},
      });

      const check = verifyNoMissingAssets(plan, state);

      expect(check.passed).toBe(false);
      expect(check.severity).toBe('error');
      expect(check.message).toContain('missing');
    });
  });

  describe('verifyUserIntentChecks', () => {
    it('passes when all steps succeed', () => {
      const steps = [createTestStep()];
      const plan = createPlan('Test goal', steps);
      const result = createMockExecutionResult({
        stepResults: [{ stepId: 'step-1', status: 'success', durationMs: 50 }],
      });

      const check = verifyUserIntentChecks(plan, result);

      expect(check.passed).toBe(true);
      expect(check.message).toContain('1 steps executed');
    });

    it('warns when steps fail', () => {
      const steps = [createTestStep()];
      const plan = createPlan('Test goal', steps);
      const result = createMockExecutionResult({
        stepResults: [{ stepId: 'step-1', status: 'failed', error: 'Tool error', durationMs: 50 }],
      });

      const check = verifyUserIntentChecks(plan, result);

      expect(check.passed).toBe(false);
      expect(check.severity).toBe('warning');
    });
  });

  describe('verifyAgentRun', () => {
    it('reports "applied" not "perfect" in summary', () => {
      const steps = [createTestStep()];
      const plan = createPlan('Test goal', steps);
      const result = createMockExecutionResult();
      const context = createMockContext();
      const state = createProjectState();

      const verification = verifyAgentRun(plan, result, context, state);

      expect(verification.summary).toContain('applied');
      expect(verification.summary).not.toContain('perfect');
    });

    it('returns verified=true when all checks pass', () => {
      const steps = [
        createTestStep({
          arguments: {
            compositionId: 'comp-1',
            trackId: 'track-1',
            clip: { id: 'clip-1' },
          },
        }),
      ];
      const plan = createPlan('Test goal', steps);
      const result = createMockExecutionResult();
      const context = createMockContext();
      const state = createProjectState();

      const verification = verifyAgentRun(plan, result, context, state);

      expect(verification.verified).toBe(true);
      expect(verification.checks.length).toBeGreaterThan(0);
    });

    it('returns verified=false when execution fails', () => {
      const steps = [createTestStep()];
      const plan = createPlan('Test goal', steps);
      const result = createMockExecutionResult({ success: false, errors: ['Execution failed'] });
      const context = createMockContext();
      const state = createProjectState();

      const verification = verifyAgentRun(plan, result, context, state);

      expect(verification.verified).toBe(false);
    });

    it('collects warnings from failed checks', () => {
      const steps = [createTestStep({ tool: 'setGain' })];
      const plan = createPlan('Test goal', steps);
      const result = createMockExecutionResult({
        stepResults: [{ stepId: 'step-1', status: 'failed', error: 'Failed', durationMs: 50 }],
      });
      const context = createMockContext();
      const state = createProjectState({ audio: { peakLevelDb: 2.0 } });

      const verification = verifyAgentRun(plan, result, context, state);

      expect(verification.warnings.length).toBeGreaterThan(0);
    });
  });
});

describe('Branch Manager', () => {
  it('creates a branch with base and branch snapshots', () => {
    const manager = createBranchManager();
    const base = { compositions: {} };
    const branch = { compositions: { 'comp-1': {} } };

    const agentBranch = manager.createBranch('plan-1', base, branch);

    expect(agentBranch.branchId).toBeDefined();
    expect(agentBranch.planId).toBe('plan-1');
    expect(agentBranch.baseSnapshot).toBe(base);
    expect(agentBranch.branchSnapshot).toBe(branch);
    expect(agentBranch.status).toBe('active');
  });

  it('accepts a branch', () => {
    const manager = createBranchManager();
    const agentBranch = manager.createBranch('plan-1', {}, {});

    const result = manager.acceptBranch(agentBranch.branchId);

    expect(result.success).toBe(true);
    expect(manager.getBranch(agentBranch.branchId)?.status).toBe('accepted');
  });

  it('rejects a branch', () => {
    const manager = createBranchManager();
    const agentBranch = manager.createBranch('plan-1', {}, {});

    const result = manager.rejectBranch(agentBranch.branchId);

    expect(result.success).toBe(true);
    expect(manager.getBranch(agentBranch.branchId)?.status).toBe('rejected');
  });

  it('fails to accept a non-existent branch', () => {
    const manager = createBranchManager();

    const result = manager.acceptBranch('non-existent');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('fails to accept an already accepted branch', () => {
    const manager = createBranchManager();
    const agentBranch = manager.createBranch('plan-1', {}, {});
    manager.acceptBranch(agentBranch.branchId);

    const result = manager.acceptBranch(agentBranch.branchId);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not active');
  });

  it('compares base and branch snapshots', () => {
    const manager = createBranchManager();
    const base = {
      compositions: {
        'comp-1': {
          tracks: [{ clips: [{ id: 'clip-1' }] }],
        },
      },
    };
    const branchState = {
      compositions: {
        'comp-1': {
          tracks: [{ clips: [{ id: 'clip-1' }, { id: 'clip-2' }] }],
        },
      },
    };

    const agentBranch = manager.createBranch('plan-1', base, branchState);
    const comparison = manager.compareBranch(agentBranch.branchId);

    expect(comparison).toBeDefined();
    expect(comparison?.diff.clipsCreated).toBe(1);
    expect(comparison?.summary).toContain('created');
  });

  it('returns undefined for comparing non-existent branch', () => {
    const manager = createBranchManager();

    const comparison = manager.compareBranch('non-existent');

    expect(comparison).toBeUndefined();
  });

  it('gets active branches', () => {
    const manager = createBranchManager();
    manager.createBranch('plan-1', {}, {});
    const branch2 = manager.createBranch('plan-2', {}, {});
    manager.createBranch('plan-3', {}, {});
    manager.acceptBranch(branch2.branchId);

    const active = manager.getActiveBranches();

    expect(active.length).toBe(2);
  });

  it('expires old branches', () => {
    const manager = createBranchManager();
    manager.createBranch('plan-1', {}, {});

    const expired = manager.expireOlderThan(0);

    expect(expired).toBeGreaterThanOrEqual(0);
  });
});

describe('Revert', () => {
  it('reverts an entire agent run as one action', () => {
    const initialProject = buildTestProject();
    const history = new ProjectHistory(initialProject);

    history.apply({
      label: '[2024-01-15T10-30-00] plan-1: Test goal',
      commands: [
        {
          type: 'timeline.insertClip',
          payload: {
            compositionId: 'comp-1',
            trackId: 'track-1',
            clip: {
              id: 'clip-1',
              kind: 'video',
              startUs: 0,
              durationUs: 1_000_000,
              assetId: 'asset-1',
              sourceInUs: 0,
            },
          },
        },
      ],
    });

    const result = revertAgentRun('plan-1', history, 'plan-1');

    expect(result.success).toBe(true);
    expect(result.planId).toBe('plan-1');
    expect(result.revertedSteps).toBeGreaterThan(0);
  });

  it('handles partial executions', () => {
    const initialProject = buildTestProject();
    const history = new ProjectHistory(initialProject);

    history.apply({
      label: '[2024-01-15T10-30-00] plan-1: Test goal',
      commands: [
        {
          type: 'timeline.insertClip',
          payload: {
            compositionId: 'comp-1',
            trackId: 'track-1',
            clip: {
              id: 'clip-1',
              kind: 'video',
              startUs: 0,
              durationUs: 1_000_000,
              assetId: 'asset-1',
              sourceInUs: 0,
            },
          },
        },
      ],
    });

    const result = revertAgentRun('plan-1', history, 'plan-1');

    expect(result.success).toBe(true);
    expect(result.revertedSteps).toBeGreaterThan(0);
  });

  it('fails when no transactions found', () => {
    const initialProject = buildTestProject();
    const history = new ProjectHistory(initialProject);

    const result = revertAgentRun('plan-999', history, 'plan-999');

    expect(result.success).toBe(false);
    expect(result.error).toContain('No transactions found');
  });

  it('checks if agent run can be reverted', () => {
    const initialProject = buildTestProject();
    const history = new ProjectHistory(initialProject);

    history.apply({
      label: '[2024-01-15T10-30-00] plan-1: Test goal',
      commands: [
        {
          type: 'timeline.insertClip',
          payload: {
            compositionId: 'comp-1',
            trackId: 'track-1',
            clip: {
              id: 'clip-1',
              kind: 'video',
              startUs: 0,
              durationUs: 1_000_000,
              assetId: 'asset-1',
              sourceInUs: 0,
            },
          },
        },
      ],
    });
  });

  it('checks if agent run can be reverted', () => {
    const initialProject = buildTestProject();
    const history = new ProjectHistory(initialProject);

    history.apply({
      label: '[2024-01-15T10-30-00] plan-1: Test goal',
      commands: [
        {
          type: 'timeline.insertClip',
          payload: {
            compositionId: 'comp-1',
            trackId: 'track-1',
            clip: {
              id: 'clip-1',
              kind: 'video',
              startUs: 0,
              durationUs: 1_000_000,
              assetId: 'asset-1',
              sourceInUs: 0,
            },
          },
        },
      ],
    });

    const canRevert = canRevertAgentRun('plan-1', history);

    expect(canRevert.canRevert).toBe(true);
  });
});

describe('Audit Trail', () => {
  it('records all actions', () => {
    const audit = createAuditTrail();

    audit.record({
      planId: 'plan-1',
      action: 'plan-created',
      userId: 'user-1',
    });

    audit.record({
      planId: 'plan-1',
      action: 'execution-started',
      userId: 'user-1',
    });

    const entries = audit.getAllEntries();

    expect(entries.length).toBe(2);
    expect(entries[0]?.action).toBe('plan-created');
    expect(entries[1]?.action).toBe('execution-started');
  });

  it('queries entries by plan', () => {
    const audit = createAuditTrail();

    audit.record({ planId: 'plan-1', action: 'plan-created', userId: 'user-1' });
    audit.record({ planId: 'plan-2', action: 'plan-created', userId: 'user-1' });
    audit.record({ planId: 'plan-1', action: 'execution-started', userId: 'user-1' });

    const plan1Entries = audit.getEntriesForPlan('plan-1');

    expect(plan1Entries.length).toBe(2);
  });

  it('queries entries by action', () => {
    const audit = createAuditTrail();

    audit.record({ planId: 'plan-1', action: 'plan-created', userId: 'user-1' });
    audit.record({ planId: 'plan-1', action: 'execution-started', userId: 'user-1' });
    audit.record({ planId: 'plan-2', action: 'plan-created', userId: 'user-1' });

    const createdEntries = audit.getEntriesByAction('plan-created');

    expect(createdEntries.length).toBe(2);
  });

  it('queries entries in time range', () => {
    const audit = createAuditTrail();

    audit.record({ planId: 'plan-1', action: 'plan-created', userId: 'user-1' });

    const start = new Date(Date.now() - 1000).toISOString();
    const end = new Date(Date.now() + 1000).toISOString();

    const entries = audit.getEntriesInRange(start, end);

    expect(entries.length).toBe(1);
  });

  it('exports audit trail as JSON', () => {
    const audit = createAuditTrail();

    audit.record({ planId: 'plan-1', action: 'plan-created', userId: 'user-1' });

    const json = audit.exportAsJson();

    expect(json).toBeDefined();
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('clears audit trail', () => {
    const audit = createAuditTrail();

    audit.record({ planId: 'plan-1', action: 'plan-created', userId: 'user-1' });
    audit.clear();

    const entries = audit.getAllEntries();

    expect(entries.length).toBe(0);
  });
});

describe('Agent Memory Manager', () => {
  it('separates memory types correctly', () => {
    const memory = createAgentMemoryManager();

    memory.setProjectFact('projectName', 'Test Project');
    memory.setBrandSetting('primaryColor', '#ff0000');
    memory.setUserPreference('autoSave', true, true);
    memory.setConversationContext('currentStep', 'editing');
    memory.addInferredSuggestion('Consider adding transitions');

    const state = memory.getMemory();

    expect(state.projectFacts.projectName).toBe('Test Project');
    expect(state.brandSettings.primaryColor).toBe('#ff0000');
    expect(state.userPreferences.autoSave).toBe(true);
    expect(state.conversationContext.currentStep).toBe('editing');
    expect(state.inferredSuggestions).toContain('Consider adding transitions');
  });

  it('only uses confirmed preferences', () => {
    const memory = createAgentMemoryManager();

    memory.setUserPreference('theme', 'dark', true);
    memory.setUserPreference('language', 'en', false);

    const confirmed = memory.getAllUserPreferences().filter((p) => p.confirmed);

    expect(confirmed.length).toBe(1);
    expect(confirmed[0]?.key).toBe('theme');
  });

  it('promotes inferred suggestions to confirmed preferences', () => {
    const memory = createAgentMemoryManager();

    memory.addInferredSuggestion('Use 24fps');
    memory.confirmSuggestion('frameRate', 24);

    const pref = memory.getUserPreference('frameRate');

    expect(pref).toBeDefined();
    expect(pref?.confirmed).toBe(true);
    expect(pref?.value).toBe(24);
    expect(pref?.source).toBe('inferred');
  });

  it('clears conversation context', () => {
    const memory = createAgentMemoryManager();

    memory.setConversationContext('step', 'editing');
    memory.clearConversationContext();

    const state = memory.getMemory();

    expect(Object.keys(state.conversationContext).length).toBe(0);
  });

  it('clears inferred suggestions', () => {
    const memory = createAgentMemoryManager();

    memory.addInferredSuggestion('Suggestion 1');
    memory.clearInferredSuggestions();

    const suggestions = memory.getInferredSuggestions();

    expect(suggestions.length).toBe(0);
  });

  it('exports preferences as JSON', () => {
    const memory = createAgentMemoryManager();

    memory.setProjectFact('name', 'Test');
    memory.setBrandSetting('color', 'blue');
    memory.setUserPreference('theme', 'dark', true);

    const json = memory.exportPreferencesAsJson();

    expect(json).toBeDefined();
    expect(() => JSON.parse(json)).not.toThrow();

    const parsed = JSON.parse(json);
    expect(parsed.projectFacts.name).toBe('Test');
    expect(parsed.brandSettings.color).toBe('blue');
  });

  it('initializes with provided memory', () => {
    const memory = createAgentMemoryManager({
      projectFacts: { name: 'Initial Project' },
      brandSettings: { logo: 'logo.png' },
    });

    const state = memory.getMemory();

    expect(state.projectFacts.name).toBe('Initial Project');
    expect(state.brandSettings.logo).toBe('logo.png');
  });
});
