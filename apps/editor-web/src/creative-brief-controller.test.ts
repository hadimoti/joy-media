/**
 * Creative Brief Controller Tests - WP-37 S4-C
 *
 * Pure reducer/state machine tests for Creative Brief UI state.
 * Tests cover all valid transitions, invalid/out-of-order events,
 * stale revision behavior, Persian preservation, and immutability.
 */

import { describe, it, expect } from 'vitest';
import type { CreativeBriefV1 } from '@joy-media/agent-tools';
import {
  creativeBriefReducer,
  INITIAL_BRIEF_STATE,
  IDLE_BRIEF_STATE,
  hasBrief,
  getBrief,
  isStale,
  isCollecting,
  isUnavailable,
  hasError,
  isIdle,
  getRequest,
  getRevisionId,
  isCreativeBriefIdleState,
  isCreativeBriefCollectingState,
  isCreativeBriefReadyState,
  isCreativeBriefUnavailableState,
  isCreativeBriefErrorState,
  isCreativeBriefStaleState,
} from './creative-brief-controller.js';
import type { CreativeBriefState, CreativeBriefEvent } from './creative-brief-controller.js';

// ==========================================================================
// Fixtures
// ==========================================================================

const REVISION_ID_A = 'rev-aaa' as const;
const REVISION_ID_B = 'rev-bbb' as const;
const PROJECT_ID = 'proj-001' as const;

const MOCK_BRIEF: CreativeBriefV1 = {
  schemaVersion: 1,
  snapshotRevisionId: 'rev-abc123',
  projectId: 'test-project-001',
  request: 'Improve the pacing of my video',
  interpretedGoal: {
    userIntent: 'Improve the pacing of my video',
    inferredGoal: 'Add b-roll and trim gaps',
    resolvedGoal: 'Add b-roll clips and remove pacing gaps',
    confidence: 'high',
  },
  distinction: {
    facts: [{ id: 'fact-001', statement: 'Scene 1 has 3 clips', source: 's2', evidence: [] }],
    inferences: [
      {
        id: 'inf-001',
        statement: 'Adding b-roll would help',
        confidence: 'medium',
        rationale: 'Visual interest',
        evidence: [],
      },
    ],
  },
  assumptions: [],
  recommendations: [],
  blockedBy: [],
  requiresHumanDecision: [],
  warnings: [],
  intelligence: {
    brand: {
      projectId: 'test-project-001',
      revisionId: 'rev-abc123',
      colorsAvailable: false,
      fontsAvailable: false,
      logoAvailable: false,
      voiceInstructionsAvailable: false,
      toneInstructionsAvailable: false,
      prohibitedClaims: [],
      prohibitedEffects: [],
      hasBrandKit: false,
      brandCompleteness: 'none',
      missingComponents: [],
      warnings: [],
      evidence: [],
    },
    scenes: [],
    project: {
      projectId: 'test-project-001',
      revisionId: 'rev-abc123',
      destination: undefined,
      destinationAligned: false,
      destinationMismatch: undefined,
      durationTargetUs: undefined,
      compositionDurationUs: 0,
      durationAligned: false,
      durationGapUs: undefined,
      aspectRatio: '0:0',
      aspectRatioAligned: false,
      aspectRatioMismatch: undefined,
      captionAvailable: false,
      audioAvailable: false,
      generatedAssetsAvailable: false,
      readinessLevel: 'unknown',
      blockers: [],
      warnings: [],
      sceneCount: 0,
      scenesWithVisuals: 0,
      scenesWithAudio: 0,
      scenesWithCaptions: 0,
      evidence: [],
    },
    rules: [],
  },
  meta: { generatedAt: '2026-08-18T10:00:00.000Z', modelAdapter: 'fake-v1', processingTimeMs: 100 },
};

const MOCK_BRIEF_WITH_REV_A: CreativeBriefV1 = {
  ...MOCK_BRIEF,
  snapshotRevisionId: REVISION_ID_A,
  intelligence: {
    ...MOCK_BRIEF.intelligence,
    brand: { ...MOCK_BRIEF.intelligence.brand, revisionId: REVISION_ID_A },
    project: { ...MOCK_BRIEF.intelligence.project, revisionId: REVISION_ID_A },
  },
};

const MOCK_BRIEF_DIFFERENT_REVISION: CreativeBriefV1 = {
  ...MOCK_BRIEF,
  snapshotRevisionId: 'rev-xyz789',
};

const PERSIAN_REQUEST = 'ویدیو من رو سریع‌تر کنید';
const PERSIAN_BRIEF: CreativeBriefV1 = {
  ...MOCK_BRIEF,
  request: PERSIAN_REQUEST,
  interpretedGoal: {
    userIntent: PERSIAN_REQUEST,
    inferredGoal: 'کاهش مدت',
    resolvedGoal: 'حذف مقاطع',
    confidence: 'high',
  },
};

// ==========================================================================
// Helper to assert type and run reducer
// ==========================================================================

function dispatch(state: CreativeBriefState, event: CreativeBriefEvent): CreativeBriefState {
  return creativeBriefReducer(state, event);
}

describe('hydrate transitions', () => {
  it('marks a saved brief stale when it belongs to an older revision', () => {
    const result = dispatch(INITIAL_BRIEF_STATE, {
      type: 'hydrate',
      brief: MOCK_BRIEF_WITH_REV_A,
      revisionId: REVISION_ID_B,
    });
    expect(result).toMatchObject({
      type: 'stale',
      revisionId: REVISION_ID_A,
      currentRevisionId: REVISION_ID_B,
      brief: MOCK_BRIEF_WITH_REV_A,
    });
  });
});

// ==========================================================================
// Initial State Tests
// ==========================================================================

describe('Initial States', () => {
  it('INITIAL_BRIEF_STATE is unavailable type', () => {
    expect(INITIAL_BRIEF_STATE.type).toBe('unavailable');
    expect(INITIAL_BRIEF_STATE.reason).toContain('adapter not available');
  });

  it('IDLE_BRIEF_STATE is idle type', () => {
    expect(IDLE_BRIEF_STATE.type).toBe('idle');
  });
});

// ==========================================================================
// Valid Transition Tests: idle → collecting
// ==========================================================================

describe('idle → collecting transitions', () => {
  it('transitions from idle to collecting on collect-start', () => {
    const result = dispatch(IDLE_BRIEF_STATE, {
      type: 'collect-start',
      request: 'test request',
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });

    expect(isCreativeBriefCollectingState(result)).toBe(true);
    if (isCreativeBriefCollectingState(result)) {
      expect(result.request).toBe('test request');
      expect(result.revisionId).toBe(REVISION_ID_A);
      expect(result.projectId).toBe(PROJECT_ID);
    }
  });

  it('preserves Persian/RTL request text byte-for-byte on collect-start', () => {
    const result = dispatch(IDLE_BRIEF_STATE, {
      type: 'collect-start',
      request: PERSIAN_REQUEST,
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });

    expect(isCreativeBriefCollectingState(result)).toBe(true);
    if (isCreativeBriefCollectingState(result)) {
      expect(result.request).toBe(PERSIAN_REQUEST);
    }
  });

  it('transitions from idle to collecting on retry', () => {
    const result = dispatch(IDLE_BRIEF_STATE, {
      type: 'retry',
      request: 'retry request',
      revisionId: REVISION_ID_B,
      projectId: PROJECT_ID,
    });

    expect(isCreativeBriefCollectingState(result)).toBe(true);
    if (isCreativeBriefCollectingState(result)) {
      expect(result.request).toBe('retry request');
    }
  });

  it('stays idle on invalid events (collect-success without prior collect)', () => {
    const result = dispatch(IDLE_BRIEF_STATE, {
      type: 'collect-success',
      brief: MOCK_BRIEF,
      revisionId: REVISION_ID_A,
    });

    expect(isIdle(result)).toBe(true);
  });

  it('stays idle on invalid events (collect-error without prior collect)', () => {
    const result = dispatch(IDLE_BRIEF_STATE, {
      type: 'collect-error',
      error: 'some error',
    });

    expect(isIdle(result)).toBe(true);
  });

  it('stays idle on invalid events (revision-change without brief)', () => {
    const result = dispatch(IDLE_BRIEF_STATE, {
      type: 'revision-change',
      newRevisionId: REVISION_ID_B,
    });

    expect(isIdle(result)).toBe(true);
  });

  it('transitions from idle to idle on reset', () => {
    const result = dispatch(IDLE_BRIEF_STATE, { type: 'reset' });
    expect(isIdle(result)).toBe(true);
  });
});

// ==========================================================================
// Valid Transition Tests: collecting → brief-ready
// ==========================================================================

describe('collecting → brief-ready transitions', () => {
  const collectingState = {
    type: 'collecting' as const,
    request: 'test request',
    revisionId: REVISION_ID_A,
    projectId: PROJECT_ID,
  };

  it('transitions from collecting to brief-ready on collect-success with matching revision', () => {
    const result = dispatch(collectingState, {
      type: 'collect-success',
      brief: MOCK_BRIEF_WITH_REV_A,
      revisionId: REVISION_ID_A,
    });

    expect(isCreativeBriefReadyState(result)).toBe(true);
    if (isCreativeBriefReadyState(result)) {
      expect(result.brief).toBe(MOCK_BRIEF_WITH_REV_A);
      expect(result.revisionId).toBe(REVISION_ID_A);
    }
  });

  it('transitions to error on collect-success with mismatched revision', () => {
    const result = dispatch(collectingState, {
      type: 'collect-success',
      brief: MOCK_BRIEF_DIFFERENT_REVISION,
      revisionId: REVISION_ID_A,
    });

    expect(hasError(result)).toBe(true);
    if (hasError(result) && isCreativeBriefErrorState(result)) {
      expect(result.error).toContain('revision mismatch');
      expect(result.error).toContain(REVISION_ID_A);
      expect(result.error).toContain('rev-xyz789');
    }
  });
});

// ==========================================================================
// Valid Transition Tests: collecting → unavailable/error
// ==========================================================================

describe('collecting → unavailable/error transitions', () => {
  const collectingState = {
    type: 'collecting' as const,
    request: 'test request',
    revisionId: REVISION_ID_A,
    projectId: PROJECT_ID,
  };

  it('transitions from collecting to unavailable on collect-unavailable', () => {
    const result = dispatch(collectingState, {
      type: 'collect-unavailable',
      reason: 'Production adapter not available',
    });

    expect(isUnavailable(result)).toBe(true);
    if (isCreativeBriefUnavailableState(result)) {
      expect(result.reason).toBe('Production adapter not available');
    }
  });

  it('transitions from collecting to error on collect-error', () => {
    const result = dispatch(collectingState, {
      type: 'collect-error',
      error: 'Network timeout',
    });

    expect(hasError(result)).toBe(true);
    if (isCreativeBriefErrorState(result)) {
      expect(result.error).toBe('Network timeout');
    }
  });

  it('transitions from collecting to idle on revision-change while collecting', () => {
    const result = dispatch(collectingState, {
      type: 'revision-change',
      newRevisionId: REVISION_ID_B,
    });

    expect(isIdle(result)).toBe(true);
  });

  it('transitions from collecting to idle on reset', () => {
    const result = dispatch(collectingState, { type: 'reset' });
    expect(isIdle(result)).toBe(true);
  });

  it('stays in collecting when already collecting and another collect-start arrives', () => {
    const result = dispatch(collectingState, {
      type: 'collect-start',
      request: 'new request',
      revisionId: REVISION_ID_B,
      projectId: PROJECT_ID,
    });

    expect(isCollecting(result)).toBe(true);
    if (isCreativeBriefCollectingState(result)) {
      // Should keep the original request, not switch to new one
      expect(result.request).toBe('test request');
      expect(result.revisionId).toBe(REVISION_ID_A);
    }
  });
});

// ==========================================================================
// Valid Transition Tests: brief-ready → stale
// ==========================================================================

describe('brief-ready → stale transitions', () => {
  const readyState: CreativeBriefState = {
    type: 'brief-ready',
    brief: MOCK_BRIEF_WITH_REV_A,
    revisionId: REVISION_ID_A,
  };

  it('transitions from brief-ready to stale on revision-change with different revision', () => {
    const result = dispatch(readyState, {
      type: 'revision-change',
      newRevisionId: REVISION_ID_B,
    });

    expect(isStale(result)).toBe(true);
    if (isCreativeBriefStaleState(result)) {
      expect(result.brief).toBe(MOCK_BRIEF_WITH_REV_A);
      expect(result.revisionId).toBe(REVISION_ID_A);
      expect(result.currentRevisionId).toBe(REVISION_ID_B);
    }
  });

  it('stays in brief-ready when revision-change has same revision', () => {
    const result = dispatch(readyState, {
      type: 'revision-change',
      newRevisionId: REVISION_ID_A,
    });

    expect(isCreativeBriefReadyState(result)).toBe(true);
    if (isCreativeBriefReadyState(result)) {
      expect(result.brief).toBe(MOCK_BRIEF_WITH_REV_A);
    }
  });

  it('transitions from brief-ready to idle on reset', () => {
    const result = dispatch(readyState, { type: 'reset' });
    expect(isIdle(result)).toBe(true);
  });

  it('transitions from brief-ready to collecting on retry', () => {
    const result = dispatch(readyState, {
      type: 'retry',
      request: 'new request',
      revisionId: REVISION_ID_B,
      projectId: PROJECT_ID,
    });

    expect(isCollecting(result)).toBe(true);
    if (isCreativeBriefCollectingState(result)) {
      expect(result.request).toBe('new request');
    }
  });

  it('stays in brief-ready on irrelevant events', () => {
    const result = dispatch(readyState, {
      type: 'collect-success',
      brief: MOCK_BRIEF,
      revisionId: REVISION_ID_A,
    });

    expect(isCreativeBriefReadyState(result)).toBe(true);
  });
});

// ==========================================================================
// Stale State Tests
// ==========================================================================

describe('stale state transitions', () => {
  const staleState: CreativeBriefState = {
    type: 'stale',
    brief: MOCK_BRIEF_WITH_REV_A,
    revisionId: REVISION_ID_A,
    currentRevisionId: REVISION_ID_B,
  };

  it('transitions from stale to idle on reset', () => {
    const result = dispatch(staleState, { type: 'reset' });
    expect(isIdle(result)).toBe(true);
  });

  it('transitions from stale to collecting on retry', () => {
    const result = dispatch(staleState, {
      type: 'retry',
      request: 'refresh request',
      revisionId: REVISION_ID_B,
      projectId: PROJECT_ID,
    });

    expect(isCollecting(result)).toBe(true);
    if (isCreativeBriefCollectingState(result)) {
      expect(result.request).toBe('refresh request');
      expect(result.revisionId).toBe(REVISION_ID_B);
    }
  });

  it('updates currentRevisionId on subsequent revision-change', () => {
    const result = dispatch(staleState, {
      type: 'revision-change',
      newRevisionId: REVISION_ID_A,
    });

    expect(isStale(result)).toBe(true);
    if (isCreativeBriefStaleState(result)) {
      expect(result.revisionId).toBe(REVISION_ID_A);
      expect(result.currentRevisionId).toBe(REVISION_ID_A);
    }
  });

  it('stays stale on collect-success (does not auto-resolve)', () => {
    const result = dispatch(staleState, {
      type: 'collect-success',
      brief: MOCK_BRIEF,
      revisionId: REVISION_ID_B,
    });

    expect(isStale(result)).toBe(true);
  });
});

// ==========================================================================
// Unavailable State Tests
// ==========================================================================

describe('unavailable state transitions', () => {
  it('transitions from unavailable to collecting on collect-start', () => {
    const result = dispatch(INITIAL_BRIEF_STATE, {
      type: 'collect-start',
      request: 'test request',
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });

    expect(isCollecting(result)).toBe(true);
  });

  it('transitions from unavailable to collecting on retry', () => {
    const result = dispatch(INITIAL_BRIEF_STATE, {
      type: 'retry',
      request: 'test request',
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });

    expect(isCollecting(result)).toBe(true);
  });

  it('transitions from unavailable to idle on reset', () => {
    const result = dispatch(INITIAL_BRIEF_STATE, { type: 'reset' });
    expect(isIdle(result)).toBe(true);
  });

  it('stays unavailable on irrelevant events', () => {
    const result = dispatch(INITIAL_BRIEF_STATE, {
      type: 'collect-success',
      brief: MOCK_BRIEF,
      revisionId: REVISION_ID_A,
    });

    expect(isUnavailable(result)).toBe(true);
  });
});

// ==========================================================================
// Error State Tests
// ==========================================================================

describe('error state transitions', () => {
  const errorState: CreativeBriefState = {
    type: 'error',
    error: 'Test error',
  };

  it('transitions from error to collecting on collect-start', () => {
    const result = dispatch(errorState, {
      type: 'collect-start',
      request: 'test request',
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });

    expect(isCollecting(result)).toBe(true);
  });

  it('transitions from error to collecting on retry', () => {
    const result = dispatch(errorState, {
      type: 'retry',
      request: 'test request',
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });

    expect(isCollecting(result)).toBe(true);
  });

  it('transitions from error to idle on reset', () => {
    const result = dispatch(errorState, { type: 'reset' });
    expect(isIdle(result)).toBe(true);
  });

  it('stays in error on irrelevant events', () => {
    const result = dispatch(errorState, {
      type: 'collect-success',
      brief: MOCK_BRIEF,
      revisionId: REVISION_ID_A,
    });

    expect(hasError(result)).toBe(true);
  });
});

// ==========================================================================
// Selector Tests
// ==========================================================================

describe('state selectors', () => {
  it('hasBrief returns true for brief-ready', () => {
    const state: CreativeBriefState = {
      type: 'brief-ready',
      brief: MOCK_BRIEF_WITH_REV_A,
      revisionId: REVISION_ID_A,
    };
    expect(hasBrief(state)).toBe(true);
  });

  it('hasBrief returns true for stale', () => {
    const state: CreativeBriefState = {
      type: 'stale',
      brief: MOCK_BRIEF_WITH_REV_A,
      revisionId: REVISION_ID_A,
      currentRevisionId: REVISION_ID_B,
    };
    expect(hasBrief(state)).toBe(true);
  });

  it('hasBrief returns false for other states', () => {
    expect(hasBrief(IDLE_BRIEF_STATE)).toBe(false);
    expect(hasBrief(INITIAL_BRIEF_STATE)).toBe(false);
    expect(hasBrief({ type: 'error', error: 'test' })).toBe(false);
    expect(
      hasBrief({
        type: 'collecting',
        request: 'test',
        revisionId: REVISION_ID_A,
        projectId: PROJECT_ID,
      }),
    ).toBe(false);
  });

  it('getBrief returns the brief for brief-ready', () => {
    const state: CreativeBriefState = {
      type: 'brief-ready',
      brief: MOCK_BRIEF_WITH_REV_A,
      revisionId: REVISION_ID_A,
    };
    expect(getBrief(state)).toBe(MOCK_BRIEF_WITH_REV_A);
  });

  it('getBrief returns the brief for stale', () => {
    const state: CreativeBriefState = {
      type: 'stale',
      brief: MOCK_BRIEF_WITH_REV_A,
      revisionId: REVISION_ID_A,
      currentRevisionId: REVISION_ID_B,
    };
    expect(getBrief(state)).toBe(MOCK_BRIEF_WITH_REV_A);
  });

  it('getBrief returns null for other states', () => {
    expect(getBrief(IDLE_BRIEF_STATE)).toBeNull();
    expect(getBrief(INITIAL_BRIEF_STATE)).toBeNull();
  });

  it('isStale returns true only for stale state', () => {
    expect(
      isStale({
        type: 'stale',
        brief: MOCK_BRIEF_WITH_REV_A,
        revisionId: REVISION_ID_A,
        currentRevisionId: REVISION_ID_B,
      }),
    ).toBe(true);
    expect(
      isStale({ type: 'brief-ready', brief: MOCK_BRIEF_WITH_REV_A, revisionId: REVISION_ID_A }),
    ).toBe(false);
    expect(isStale(IDLE_BRIEF_STATE)).toBe(false);
  });

  it('isCollecting returns true only for collecting state', () => {
    expect(
      isCollecting({
        type: 'collecting',
        request: 'test',
        revisionId: REVISION_ID_A,
        projectId: PROJECT_ID,
      }),
    ).toBe(true);
    expect(isCollecting(IDLE_BRIEF_STATE)).toBe(false);
  });

  it('isUnavailable returns true only for unavailable state', () => {
    expect(isUnavailable(INITIAL_BRIEF_STATE)).toBe(true);
    expect(isUnavailable(IDLE_BRIEF_STATE)).toBe(false);
  });

  it('hasError returns true only for error state', () => {
    expect(hasError({ type: 'error', error: 'test' })).toBe(true);
    expect(hasError(IDLE_BRIEF_STATE)).toBe(false);
  });

  it('isIdle returns true only for idle state', () => {
    expect(isIdle(IDLE_BRIEF_STATE)).toBe(true);
    expect(isIdle(INITIAL_BRIEF_STATE)).toBe(false);
  });

  it('getRequest returns request only for collecting state', () => {
    const collecting: CreativeBriefState = {
      type: 'collecting',
      request: 'test request',
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    };
    expect(getRequest(collecting)).toBe('test request');
    expect(
      getRequest({ type: 'brief-ready', brief: MOCK_BRIEF_WITH_REV_A, revisionId: REVISION_ID_A }),
    ).toBeNull();
    expect(getRequest(IDLE_BRIEF_STATE)).toBeNull();
  });

  it('getRequest preserves Persian text', () => {
    const collecting: CreativeBriefState = {
      type: 'collecting',
      request: PERSIAN_REQUEST,
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    };
    expect(getRequest(collecting)).toBe(PERSIAN_REQUEST);
  });

  it('getRevisionId returns revision for states that have one', () => {
    expect(
      getRevisionId({
        type: 'collecting',
        request: 'test',
        revisionId: REVISION_ID_A,
        projectId: PROJECT_ID,
      }),
    ).toBe(REVISION_ID_A);
    expect(
      getRevisionId({
        type: 'brief-ready',
        brief: MOCK_BRIEF_WITH_REV_A,
        revisionId: REVISION_ID_A,
      }),
    ).toBe(REVISION_ID_A);
    expect(
      getRevisionId({
        type: 'stale',
        brief: MOCK_BRIEF_WITH_REV_A,
        revisionId: REVISION_ID_A,
        currentRevisionId: REVISION_ID_B,
      }),
    ).toBe(REVISION_ID_A);
    expect(getRevisionId(IDLE_BRIEF_STATE)).toBeNull();
  });
});

// ==========================================================================
// Type Guard Tests
// ==========================================================================

describe('type guards', () => {
  it('isCreativeBriefIdleState correctly identifies idle', () => {
    expect(isCreativeBriefIdleState(IDLE_BRIEF_STATE)).toBe(true);
    expect(isCreativeBriefIdleState(INITIAL_BRIEF_STATE)).toBe(false);
  });

  it('isCreativeBriefCollectingState correctly identifies collecting', () => {
    const state: CreativeBriefState = {
      type: 'collecting',
      request: 'test',
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    };
    expect(isCreativeBriefCollectingState(state)).toBe(true);
    expect(isCreativeBriefCollectingState(IDLE_BRIEF_STATE)).toBe(false);
  });

  it('isCreativeBriefReadyState correctly identifies brief-ready', () => {
    const state: CreativeBriefState = {
      type: 'brief-ready',
      brief: MOCK_BRIEF_WITH_REV_A,
      revisionId: REVISION_ID_A,
    };
    expect(isCreativeBriefReadyState(state)).toBe(true);
    expect(isCreativeBriefReadyState(IDLE_BRIEF_STATE)).toBe(false);
  });

  it('isCreativeBriefUnavailableState correctly identifies unavailable', () => {
    expect(isCreativeBriefUnavailableState(INITIAL_BRIEF_STATE)).toBe(true);
    expect(isCreativeBriefUnavailableState(IDLE_BRIEF_STATE)).toBe(false);
  });

  it('isCreativeBriefErrorState correctly identifies error', () => {
    const state: CreativeBriefState = { type: 'error', error: 'test' };
    expect(isCreativeBriefErrorState(state)).toBe(true);
    expect(isCreativeBriefErrorState(IDLE_BRIEF_STATE)).toBe(false);
  });

  it('isCreativeBriefStaleState correctly identifies stale', () => {
    const state: CreativeBriefState = {
      type: 'stale',
      brief: MOCK_BRIEF_WITH_REV_A,
      revisionId: REVISION_ID_A,
      currentRevisionId: REVISION_ID_B,
    };
    expect(isCreativeBriefStaleState(state)).toBe(true);
    expect(isCreativeBriefStaleState(IDLE_BRIEF_STATE)).toBe(false);
  });
});

// ==========================================================================
// Immutability Tests
// ==========================================================================

describe('immutability', () => {
  it('does not mutate state object during transitions', () => {
    const originalState: CreativeBriefState = {
      type: 'brief-ready',
      brief: MOCK_BRIEF,
      revisionId: REVISION_ID_A,
    };
    const originalBrief = originalState.brief;

    const newState = dispatch(originalState, {
      type: 'revision-change',
      newRevisionId: REVISION_ID_B,
    });

    // Original state should be unchanged
    expect(originalState.type).toBe('brief-ready');
    expect(originalState.brief).toBe(originalBrief);
    expect(originalState.revisionId).toBe(REVISION_ID_A);

    // New state should be different
    expect(newState).not.toBe(originalState);
  });

  it('does not mutate event object during transitions', () => {
    const event: CreativeBriefEvent = {
      type: 'collect-start',
      request: PERSIAN_REQUEST,
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    };
    const originalRequest = event.request;

    dispatch(IDLE_BRIEF_STATE, event);

    // Event should be unchanged
    expect(event.request).toBe(originalRequest);
    expect(event.request).toBe(PERSIAN_REQUEST);
  });

  it('does not mutate brief object in brief-ready state', () => {
    const briefWithMutableArray = {
      ...MOCK_BRIEF_WITH_REV_A,
      recommendations: [{ ...MOCK_BRIEF_WITH_REV_A.recommendations[0]! }],
    };
    const state: CreativeBriefState = {
      type: 'brief-ready',
      brief: briefWithMutableArray,
      revisionId: REVISION_ID_A,
    };
    const originalRecs = state.brief.recommendations;

    const newState = dispatch(state, { type: 'reset' });

    // Original brief's array should be unchanged
    expect(state.brief.recommendations).toBe(originalRecs);
    expect(newState).toEqual(IDLE_BRIEF_STATE);
  });
});

// ==========================================================================
// Persian Preservation Tests
// ==========================================================================

describe('Persian/RTL text preservation', () => {
  it('preserves Persian request through collect-start', () => {
    const state = dispatch(IDLE_BRIEF_STATE, {
      type: 'collect-start',
      request: PERSIAN_REQUEST,
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });

    expect(isCollecting(state)).toBe(true);
    if (isCreativeBriefCollectingState(state)) {
      expect(state.request).toBe(PERSIAN_REQUEST);
    }
  });

  it('preserves Persian request through retry', () => {
    const state = dispatch(INITIAL_BRIEF_STATE, {
      type: 'retry',
      request: PERSIAN_REQUEST,
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });

    expect(isCollecting(state)).toBe(true);
    if (isCreativeBriefCollectingState(state)) {
      expect(state.request).toBe(PERSIAN_REQUEST);
    }
  });

  it('preserves Persian brief in brief-ready state', () => {
    const persianBriefWithRevA: CreativeBriefV1 = {
      ...PERSIAN_BRIEF,
      snapshotRevisionId: REVISION_ID_A,
      intelligence: {
        ...PERSIAN_BRIEF.intelligence,
        brand: { ...PERSIAN_BRIEF.intelligence.brand, revisionId: REVISION_ID_A },
        project: { ...PERSIAN_BRIEF.intelligence.project, revisionId: REVISION_ID_A },
      },
    };
    const state: CreativeBriefState = {
      type: 'brief-ready',
      brief: persianBriefWithRevA,
      revisionId: REVISION_ID_A,
    };

    const brief = getBrief(state);
    expect(brief).not.toBeNull();
    expect(brief!.request).toBe(PERSIAN_REQUEST);
    expect(brief!.interpretedGoal.userIntent).toBe(PERSIAN_REQUEST);
  });

  it('preserves Persian brief through stale transition', () => {
    const persianBriefWithRevA: CreativeBriefV1 = {
      ...PERSIAN_BRIEF,
      snapshotRevisionId: REVISION_ID_A,
      intelligence: {
        ...PERSIAN_BRIEF.intelligence,
        brand: { ...PERSIAN_BRIEF.intelligence.brand, revisionId: REVISION_ID_A },
        project: { ...PERSIAN_BRIEF.intelligence.project, revisionId: REVISION_ID_A },
      },
    };
    const readyState: CreativeBriefState = {
      type: 'brief-ready',
      brief: persianBriefWithRevA,
      revisionId: REVISION_ID_A,
    };

    const staleState = dispatch(readyState, {
      type: 'revision-change',
      newRevisionId: REVISION_ID_B,
    });

    expect(isStale(staleState)).toBe(true);
    if (isCreativeBriefStaleState(staleState)) {
      expect(staleState.brief.request).toBe(PERSIAN_REQUEST);
      expect(staleState.brief.interpretedGoal.userIntent).toBe(PERSIAN_REQUEST);
    }
  });
});

// ==========================================================================
// Full Round-Trip Tests
// ==========================================================================

describe('full round-trip transitions', () => {
  it('idle → collecting → brief-ready → stale → idle', () => {
    let state: CreativeBriefState = IDLE_BRIEF_STATE;

    state = dispatch(state, {
      type: 'collect-start',
      request: 'test',
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });
    expect(isCollecting(state)).toBe(true);

    state = dispatch(state, {
      type: 'collect-success',
      brief: MOCK_BRIEF_WITH_REV_A,
      revisionId: REVISION_ID_A,
    });
    expect(isCreativeBriefReadyState(state)).toBe(true);

    state = dispatch(state, { type: 'revision-change', newRevisionId: REVISION_ID_B });
    expect(isStale(state)).toBe(true);

    state = dispatch(state, { type: 'reset' });
    expect(isIdle(state)).toBe(true);
  });

  it('idle → collecting → error → collecting → brief-ready', () => {
    let state: CreativeBriefState = IDLE_BRIEF_STATE;

    state = dispatch(state, {
      type: 'collect-start',
      request: 'test',
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });
    expect(isCollecting(state)).toBe(true);

    state = dispatch(state, { type: 'collect-error', error: 'Network error' });
    expect(hasError(state)).toBe(true);

    state = dispatch(state, {
      type: 'retry',
      request: 'test',
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });
    expect(isCollecting(state)).toBe(true);

    state = dispatch(state, {
      type: 'collect-success',
      brief: MOCK_BRIEF_WITH_REV_A,
      revisionId: REVISION_ID_A,
    });
    expect(isCreativeBriefReadyState(state)).toBe(true);
  });

  it('unavailable → collecting → unavailable → idle', () => {
    let state: CreativeBriefState = INITIAL_BRIEF_STATE;

    state = dispatch(state, {
      type: 'collect-start',
      request: 'test',
      revisionId: REVISION_ID_A,
      projectId: PROJECT_ID,
    });
    expect(isCollecting(state)).toBe(true);

    state = dispatch(state, { type: 'collect-unavailable', reason: 'Adapter not loaded' });
    expect(isUnavailable(state)).toBe(true);

    state = dispatch(state, { type: 'reset' });
    expect(isIdle(state)).toBe(true);
  });
});
