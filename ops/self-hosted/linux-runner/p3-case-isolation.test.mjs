import { describe, expect, it } from 'vitest';
import {
  effectiveProjectStateMismatches,
  hashEffectiveProjectState,
  p3CaseWorkspaceTitle,
} from './p3-case-isolation.mjs';

const identity = {
  candidateSha: 'a'.repeat(40),
  runId: '123',
  runAttempt: '1',
  pass: '2',
};

describe('P3 case isolation helpers', () => {
  it('names cases with the run identity and a collision-safe case id', () => {
    const first = p3CaseWorkspaceTitle({ ...identity, caseId: 'pack/reels-1080' });
    const second = p3CaseWorkspaceTitle({ ...identity, caseId: 'cancel/pack/reels-1080' });
    expect(first).toContain('aaaaaaaaaaaa-123-1-p2');
    expect(first).not.toContain('/');
    expect(second).not.toBe(first);
  });

  it('hashes equivalent effective state deterministically', () => {
    const state = { projectId: 'p1', timeline: { revision: 2 }, visual: { revision: 3 } };
    expect(hashEffectiveProjectState(state)).toBe(hashEffectiveProjectState({ ...state }));
    expect(hashEffectiveProjectState(state)).not.toBe(
      hashEffectiveProjectState({ ...state, projectId: 'p2' }),
    );
  });

  it('reports every authored-state identity mismatch', () => {
    const before = {
      projectId: 'p1',
      timeline: { revision: 2 },
      visual: { revision: 3 },
      contentHash: 'same',
    };
    const after = {
      projectId: 'p2',
      timeline: { revision: 4 },
      visual: { revision: 5 },
      contentHash: 'changed',
    };
    expect(effectiveProjectStateMismatches(before, after)).toEqual([
      'projectId',
      'timeline',
      'visual',
      'contentHash',
    ]);
  });
});
