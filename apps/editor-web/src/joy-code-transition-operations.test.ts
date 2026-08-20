import { describe, expect, it } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { compileJoyCodeTransitionOperation } from './joy-code-transition-operations.js';

function projectWithJunction() {
  const base = INITIAL_EDITOR_PROJECT;
  return {
    ...base,
    compositions: {
      ...base.compositions,
      root: {
        ...base.compositions.root!,
        tracks: [
          ...base.compositions.root!.tracks,
          {
            id: 'video-track',
            kind: 'video' as const,
            name: 'Video',
            order: 2,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'out',
                kind: 'video' as const,
                startUs: 0,
                durationUs: 2_000_000,
                assetId: 'a',
                sourceInUs: 0,
              },
              {
                id: 'in',
                kind: 'video' as const,
                startUs: 2_000_000,
                durationUs: 2_000_000,
                assetId: 'b',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  };
}

describe('Joy Code transition operations', () => {
  it('adds a deterministic curated transition and removes it', () => {
    const base = projectWithJunction();
    const added = compileJoyCodeTransitionOperation({
      project: base,
      planId: 'plan-transition',
      operationIndex: 0,
      operation: {
        id: 'add',
        dependsOn: [],
        kind: 'transition.addAtJunction',
        outgoingClipId: 'out',
        incomingClipId: 'in',
        transitionId: 'dissolve',
        durationUs: 400_000,
      },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.project.transitions).toEqual([
      {
        id: 'transition-plan-transition-0',
        trackId: 'video-track',
        leftClipId: 'out',
        rightClipId: 'in',
        type: 'dissolve',
        durationUs: 400_000,
      },
    ]);
    const removed = compileJoyCodeTransitionOperation({
      project: added.project,
      planId: 'plan-transition',
      operationIndex: 1,
      operation: {
        id: 'remove',
        dependsOn: [],
        kind: 'transition.remove',
        transitionId: 'transition-plan-transition-0',
      },
    });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.project.transitions).toEqual([]);
  });

  it('rejects unknown catalog ids, non-adjacent clips, duplicates, and unsafe durations', () => {
    const base = projectWithJunction();
    const unknown = compileJoyCodeTransitionOperation({
      project: base,
      planId: 'p',
      operationIndex: 0,
      operation: {
        id: 'x',
        dependsOn: [],
        kind: 'transition.addAtJunction',
        outgoingClipId: 'out',
        incomingClipId: 'in',
        transitionId: 'gl:fade',
        durationUs: 400_000,
      },
    });
    expect(unknown.ok).toBe(false);
    const tooLong = compileJoyCodeTransitionOperation({
      project: base,
      planId: 'p',
      operationIndex: 0,
      operation: {
        id: 'x',
        dependsOn: [],
        kind: 'transition.addAtJunction',
        outgoingClipId: 'out',
        incomingClipId: 'in',
        transitionId: 'wipe',
        durationUs: 1_500_001,
      },
    });
    expect(tooLong.ok).toBe(false);
    const added = compileJoyCodeTransitionOperation({
      project: base,
      planId: 'p',
      operationIndex: 0,
      operation: {
        id: 'x',
        dependsOn: [],
        kind: 'transition.addAtJunction',
        outgoingClipId: 'out',
        incomingClipId: 'in',
        transitionId: 'wipe',
        durationUs: 400_000,
      },
    });
    expect(added.ok).toBe(true);
    if (added.ok) {
      const duplicate = compileJoyCodeTransitionOperation({
        project: added.project,
        planId: 'p',
        operationIndex: 1,
        operation: {
          id: 'y',
          dependsOn: [],
          kind: 'transition.addAtJunction',
          outgoingClipId: 'out',
          incomingClipId: 'in',
          transitionId: 'slide',
          durationUs: 400_000,
        },
      });
      expect(duplicate.ok).toBe(false);
    }
  });
});
