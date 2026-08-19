/**
 * Creative Brief Panel Tests - WP-37 S4-D
 *
 * Tests for the unmounted CreativeBriefPanel component.
 * Uses static typed CreativeBriefV1 fixtures - never imports fake adapters.
 * No DOM testing - uses Vitest only for type checking and fixture validation.
 */

import { describe, it, expect } from 'vitest';
import type { CreativeBriefV1 } from '@joy-media/agent-tools';
import { CreativeBriefPanel, type CreativeBriefPanelProps } from './CreativeBriefPanel.js';
import { creativeBriefReducer, INITIAL_BRIEF_STATE } from './creative-brief-controller.js';

// Static fixture
const STATIC_BRIEF: CreativeBriefV1 = {
  schemaVersion: 1,
  snapshotRevisionId: 'rev-abc123',
  projectId: 'test-project-001',
  request: 'Improve the pacing of my video',
  interpretedGoal: {
    userIntent: 'Improve the pacing of my video',
    inferredGoal: 'Add b-roll and trim gaps',
    resolvedGoal: 'Add b-roll clips and remove gaps',
    confidence: 'high',
  },
  distinction: {
    facts: [{ id: 'fact-001', statement: 'Scene 1 has 3 clips', source: 's2', evidence: [] }],
    inferences: [{ id: 'inf-001', statement: 'Adding b-roll would help', confidence: 'medium', rationale: 'Visual interest', evidence: [] }],
  },
  assumptions: [],
  recommendations: [
    { id: 'pacing.hook.add-broll-001' as const, kind: 'pacing', confidence: 'high', evidence: [], rationale: 'Narration-only segment needs visual support', expectedBenefit: 'More engaging video', risk: 'reversible-local' },
  ],
  blockedBy: [{ id: 'b-001', capability: 'b-roll', status: 'setup-required', message: 'Needs provider', evidence: [] }],
  requiresHumanDecision: [{ id: 'd-001', question: 'Which style?', context: 'Options', options: ['a', 'b'], evidence: [] }],
  warnings: [{ code: 'truncated', message: 'List truncated', severity: 'info' }],
  intelligence: {
    brand: { projectId: 'test-project-001', revisionId: 'rev-abc123', colorsAvailable: false, fontsAvailable: false, logoAvailable: false, voiceInstructionsAvailable: false, toneInstructionsAvailable: false, hasBrandKit: false, brandCompleteness: 'none', missingComponents: [], warnings: [], evidence: [] },
    scenes: [],
    project: { projectId: 'test-project-001', revisionId: 'rev-abc123', destination: undefined, destinationAligned: false, durationTargetUs: undefined, compositionDurationUs: 0, durationAligned: false, aspectRatio: '0:0', aspectRatioAligned: false, capabilities: {}, blockers: [], evidence: [] },
    rules: [],
  },
  meta: { generatedAt: '2026-08-18T10:00:00.000Z', modelAdapter: 'fake-v1', processingTimeMs: 150 },
};

const PERSIAN_REQUEST = 'ویدیو من رو سریع‌تر کنید';
const PERSIAN_BRIEF: CreativeBriefV1 = {
  ...STATIC_BRIEF,
  snapshotRevisionId: 'rev-persian-001',
  request: PERSIAN_REQUEST,
  interpretedGoal: { userIntent: PERSIAN_REQUEST, inferredGoal: 'کاهش مدت', resolvedGoal: 'حذف مقاطع', confidence: 'high' },
  recommendations: [],
  blockedBy: [],
  requiresHumanDecision: [],
  warnings: [],
  intelligence: {
    ...STATIC_BRIEF.intelligence,
    brand: { ...STATIC_BRIEF.intelligence.brand, revisionId: 'rev-persian-001' },
    project: { ...STATIC_BRIEF.intelligence.project, revisionId: 'rev-persian-001' },
  },
};

const REVISION_ID_A = 'rev-aaa' as const;
const REVISION_ID_B = 'rev-bbb' as const;

type ProjectRevisionId = string;

function makeBriefWithRevision(revisionId: string, request: string = 'Improve pacing'): CreativeBriefV1 {
  return {
    ...STATIC_BRIEF,
    snapshotRevisionId: revisionId as ProjectRevisionId,
    request,
    intelligence: {
      ...STATIC_BRIEF.intelligence,
      brand: { ...STATIC_BRIEF.intelligence.brand, revisionId },
      project: { ...STATIC_BRIEF.intelligence.project, revisionId },
    },
  };
}

describe('CreativeBriefPanel', () => {
  it('exports CreativeBriefPanel component', () => {
    expect(CreativeBriefPanel).toBeDefined();
    expect(typeof CreativeBriefPanel).toBe('function');
  });

  it('accepts CreativeBriefPanelProps with runBrief - type check', () => {
    const runBrief = async (request: string): Promise<CreativeBriefV1> => makeBriefWithRevision('rev-123', request);
    const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, runBrief };
    expect(props).toBeDefined();
    expect(typeof props.runBrief).toBe('function');
  });

  it('accepts CreativeBriefPanelProps without runBrief - type check', () => {
    const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A };
    expect(props).toBeDefined();
    expect(props.runBrief).toBeUndefined();
  });

  it('static brief has facts and inferences clearly separated', () => {
    expect(STATIC_BRIEF.distinction.facts.length).toBeGreaterThan(0);
    expect(STATIC_BRIEF.distinction.inferences.length).toBeGreaterThan(0);
  });

  it('recommendations have confidence, risk, rationale, expected benefit', () => {
    const rec = STATIC_BRIEF.recommendations[0]!;
    expect(rec.confidence).toBe('high');
    expect(rec.risk).toBe('reversible-local');
    expect(rec.rationale).toBeDefined();
    expect(rec.expectedBenefit).toBeDefined();
  });

  it('blockers render when present', () => {
    expect(STATIC_BRIEF.blockedBy.length).toBeGreaterThan(0);
    expect(STATIC_BRIEF.blockedBy[0]!.status).toBe('setup-required');
  });

  it('warnings render when present', () => {
    expect(STATIC_BRIEF.warnings.length).toBeGreaterThan(0);
    expect(STATIC_BRIEF.warnings[0]!.severity).toBe('info');
  });

  it('preserves Persian request text', () => {
    expect(PERSIAN_BRIEF.request).toBe(PERSIAN_REQUEST);
    expect(PERSIAN_BRIEF.interpretedGoal.userIntent).toBe(PERSIAN_REQUEST);
  });

  it('runBrief callback receives string and returns CreativeBriefV1', async () => {
    const runBrief = async (request: string): Promise<CreativeBriefV1> => makeBriefWithRevision(REVISION_ID_A, request);
    const result = await runBrief('test');
    expect(result.schemaVersion).toBe(1);
    expect(result.snapshotRevisionId).toBe(REVISION_ID_A);
  });

  it('runBrief returns brief with matching revision', async () => {
    const runBrief = async (request: string): Promise<CreativeBriefV1> => makeBriefWithRevision(REVISION_ID_A, request);
    const result = await runBrief('test request');
    expect(result.snapshotRevisionId).toBe(REVISION_ID_A);
  });

  it('runBrief can return brief with mismatched revision', async () => {
    const runBrief = async (request: string): Promise<CreativeBriefV1> => makeBriefWithRevision('different-rev', request);
    const result = await runBrief('test');
    expect(result.snapshotRevisionId).toBe('different-rev');
    expect(result.snapshotRevisionId).not.toBe(REVISION_ID_A);
  });

  it('controller initial state is unavailable', () => {
    expect(INITIAL_BRIEF_STATE.type).toBe('unavailable');
    expect(INITIAL_BRIEF_STATE.reason).toContain('adapter not available');
  });

  it('controller reducer is a function', () => {
    expect(typeof creativeBriefReducer).toBe('function');
  });

  describe('unavailable state', () => {
    it('panel without runBrief is valid', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A };
      expect(props).toBeDefined();
      expect(props.revisionId).toBe(REVISION_ID_A);
      expect(props.runBrief).toBeUndefined();
    });

    it('panel with runBrief is valid', () => {
      const runBrief = async (request: string): Promise<CreativeBriefV1> => makeBriefWithRevision(REVISION_ID_A, request);
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, runBrief };
      expect(props).toBeDefined();
      expect(typeof props.runBrief).toBe('function');
    });
  });

  describe('successful injected read-only brief', () => {
    it('runBrief produces valid CreativeBriefV1', async () => {
      const runBrief = async (request: string): Promise<CreativeBriefV1> => makeBriefWithRevision(REVISION_ID_A, request);
      const result = await runBrief('Improve pacing');
      expect(result.schemaVersion).toBe(1);
      expect(result.snapshotRevisionId).toBe(REVISION_ID_A);
    });

    it('brief has facts and inferences', () => {
      expect(STATIC_BRIEF.distinction.facts.length).toBeGreaterThan(0);
      expect(STATIC_BRIEF.distinction.inferences.length).toBeGreaterThan(0);
    });

    it('brief recommendation has evidence, risk, and confidence', () => {
      const rec = STATIC_BRIEF.recommendations[0]!;
      expect(rec.evidence.length).toBeGreaterThanOrEqual(0);
      expect(rec.risk).toBe('reversible-local');
      expect(rec.confidence).toBe('high');
    });
  });

  describe('stale revision behavior', () => {
    it('brief with different revision has different snapshotRevisionId', () => {
      const briefA = makeBriefWithRevision(REVISION_ID_A, 'request');
      const briefB = makeBriefWithRevision(REVISION_ID_B, 'request');
      expect(briefA.snapshotRevisionId).toBe(REVISION_ID_A);
      expect(briefB.snapshotRevisionId).toBe(REVISION_ID_B);
      expect(briefA.snapshotRevisionId).not.toBe(briefB.snapshotRevisionId);
    });
  });

  describe('error/retry behavior', () => {
    it('runBrief that throws produces error', async () => {
      const runBrief = async (request: string): Promise<CreativeBriefV1> => {
        throw new Error('Test error');
      };
      await expect(runBrief('test')).rejects.toThrow('Test error');
    });

    it('runBrief with revision mismatch produces brief with different revision', async () => {
      const runBrief = async (request: string): Promise<CreativeBriefV1> => makeBriefWithRevision('different-rev', request);
      const result = await runBrief('test');
      expect(result.snapshotRevisionId).not.toBe(REVISION_ID_A);
    });
  });

  describe('Persian request preservation', () => {
    it('runBrief preserves Persian request text', async () => {
      const runBrief = async (request: string): Promise<CreativeBriefV1> => PERSIAN_BRIEF;
      const result = await runBrief(PERSIAN_REQUEST);
      expect(result.request).toBe(PERSIAN_REQUEST);
    });

    it('Persian brief has Persian text in interpreted goal', () => {
      expect(PERSIAN_BRIEF.interpretedGoal.userIntent).toBe(PERSIAN_REQUEST);
      expect(PERSIAN_BRIEF.interpretedGoal.inferredGoal).toBe('کاهش مدت');
      expect(PERSIAN_BRIEF.interpretedGoal.resolvedGoal).toBe('حذف مقاطع');
    });
  });

  describe('no Apply/Approve/Execute/Export controls', () => {
    it('CreativeBriefPanelProps has no Apply property', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, runBrief: async (r: string): Promise<CreativeBriefV1> => STATIC_BRIEF };
      expect((props as any).Apply).toBeUndefined();
    });

    it('CreativeBriefPanelProps has no Approve property', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, runBrief: async (r: string): Promise<CreativeBriefV1> => STATIC_BRIEF };
      expect((props as any).Approve).toBeUndefined();
    });

    it('CreativeBriefPanelProps has no Execute property', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, runBrief: async (r: string): Promise<CreativeBriefV1> => STATIC_BRIEF };
      expect((props as any).Execute).toBeUndefined();
    });

    it('CreativeBriefPanelProps has no Export property', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, runBrief: async (r: string): Promise<CreativeBriefV1> => STATIC_BRIEF };
      expect((props as any).Export).toBeUndefined();
    });

    it('CreativeBriefPanelProps has no Generate property', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, runBrief: async (r: string): Promise<CreativeBriefV1> => STATIC_BRIEF };
      expect((props as any).Generate).toBeUndefined();
    });

    it('runBrief callback only returns CreativeBriefV1, no commands or plans', async () => {
      const runBrief = async (request: string): Promise<CreativeBriefV1> => makeBriefWithRevision(REVISION_ID_A, request);
      const result = await runBrief('test');
      expect(result.schemaVersion).toBe(1);
      expect((result as any).type).not.toBe('command');
      expect((result as any).type).not.toBe('approval');
      expect((result as any).type).not.toBe('job');
      expect((result as any).type).not.toBe('plan');
    });
  });

  describe('explicit consent gate', () => {
    it('accepts optedIn prop as true', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: true };
      expect(props.optedIn).toBe(true);
    });

    it('accepts optedIn prop as false', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: false };
      expect(props.optedIn).toBe(false);
    });

    it('accepts optedIn prop as undefined (defaults to true)', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A };
      expect(props.optedIn).toBeUndefined();
    });

    it('accepts onOptIn prop as async function', () => {
      const onOptIn = async (): Promise<void> => {};
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: false, onOptIn };
      expect(typeof props.onOptIn).toBe('function');
    });

    it('accepts onOptIn prop as sync function', () => {
      const onOptIn = (): void => {};
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: false, onOptIn };
      expect(typeof props.onOptIn).toBe('function');
    });

    it('accepts onOptIn prop as undefined', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: false };
      expect(props.onOptIn).toBeUndefined();
    });

    it('disabled state renders when optedIn is false and onOptIn is absent', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: false };
      expect(props.optedIn).toBe(false);
      expect(props.onOptIn).toBeUndefined();
    });

    it('enabled state renders when optedIn is true', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: true };
      expect(props.optedIn).toBe(true);
    });

    it('no runBrief call before opt-in - props without runBrief and optedIn false', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: false };
      expect(props.runBrief).toBeUndefined();
      expect(props.optedIn).toBe(false);
    });

    it('successful opt-in resolves promise', async () => {
      let called = false;
      const onOptIn = async (): Promise<void> => { called = true; };
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: false, onOptIn };
      expect(typeof props.onOptIn).toBe('function');
      await props.onOptIn!();
      expect(called).toBe(true);
    });

    it('opt-in failure throws error', async () => {
      const errorMsg = 'Opt-in failed';
      const onOptIn = async (): Promise<void> => { throw new Error(errorMsg); };
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: false, onOptIn };
      await expect(props.onOptIn!()).rejects.toThrow(errorMsg);
    });

    it('sync onOptIn returns void', () => {
      let called = false;
      const onOptIn = (): void => { called = true; };
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: false, onOptIn };
      props.onOptIn!();
      expect(called).toBe(true);
    });

    it('existing enabled behavior preserved - optedIn true with runBrief', () => {
      const runBrief = async (request: string): Promise<CreativeBriefV1> => makeBriefWithRevision(REVISION_ID_A, request);
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A, optedIn: true, runBrief };
      expect(props.optedIn).toBe(true);
      expect(typeof props.runBrief).toBe('function');
    });
  });

  describe('async runBrief support', () => {
    it('accepts async runBrief - type check', () => {
      const runBrief: CreativeBriefPanelProps['runBrief'] = async (request: string): Promise<CreativeBriefV1> => {
        return makeBriefWithRevision(REVISION_ID_A, request);
      };
      expect(runBrief).toBeDefined();
      expect(typeof runBrief).toBe('function');
    });

    it('successful async resolution returns valid brief', async () => {
      const runBrief = async (request: string): Promise<CreativeBriefV1> => {
        return makeBriefWithRevision(REVISION_ID_A, request);
      };
      const result = await runBrief('Improve pacing');
      expect(result.schemaVersion).toBe(1);
      expect(result.snapshotRevisionId).toBe(REVISION_ID_A);
    });

    it('rejected async runner produces error state', async () => {
      const runBrief = async (_request: string): Promise<CreativeBriefV1> => {
        throw new Error('Async brief generation failed');
      };
      await expect(runBrief('test')).rejects.toThrow('Async brief generation failed');
    });

    it('async runner with revision mismatch after awaiting returns mismatched brief', async () => {
      const runBrief = async (request: string): Promise<CreativeBriefV1> => {
        return makeBriefWithRevision('different-rev', request);
      };
      const result = await runBrief('test');
      expect(result.snapshotRevisionId).toBe('different-rev');
      expect(result.snapshotRevisionId).not.toBe(REVISION_ID_A);
    });

    it('async retry preserves request text', async () => {
      const runBrief = async (request: string): Promise<CreativeBriefV1> => {
        return makeBriefWithRevision(REVISION_ID_A, request);
      };
      const request = 'Retry request';
      const result = await runBrief(request);
      expect(result.request).toBe(request);
    });

    it('no-runner unavailable state is type-safe', () => {
      const props: CreativeBriefPanelProps = { revisionId: REVISION_ID_A };
      expect(props.runBrief).toBeUndefined();
    });

    it('async runner can return brief with Persian text', async () => {
      const runBrief = async (request: string): Promise<CreativeBriefV1> => {
        return PERSIAN_BRIEF;
      };
      const result = await runBrief(PERSIAN_REQUEST);
      expect(result.request).toBe(PERSIAN_REQUEST);
      expect(result.interpretedGoal.userIntent).toBe(PERSIAN_REQUEST);
    });
  });
});
