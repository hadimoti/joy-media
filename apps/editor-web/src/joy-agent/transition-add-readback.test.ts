import type { JoyProjectV1 } from '@joy-media/project-schema';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { describe, expect, it } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { compileJoyCodeCompoundDraft } from '../joy-code-compound-compiler.js';
import {
  assertAddedTransitionProjectReadback,
  assertRemovedTransitionProjectReadback,
} from './transition-add-readback.js';

function visualProjectWithReferenceJunction(): JoyProjectV1 {
  const timeline = buildReferenceSpikeProject();
  const track = timeline.compositions.root?.tracks.find((candidate) => candidate.id === 'track-0');
  if (track === undefined || track.kind !== 'video')
    throw new Error('reference fixture has no primary video track');
  const root = INITIAL_EDITOR_PROJECT.compositions.root;
  if (root === undefined) throw new Error('editor fixture has no root composition');
  return {
    ...INITIAL_EDITOR_PROJECT,
    compositions: {
      ...INITIAL_EDITOR_PROJECT.compositions,
      root: {
        ...root,
        tracks: [
          ...root.tracks,
          {
            id: track.id,
            kind: 'video',
            name: 'Primary video',
            order: track.order,
            enabled: track.enabled,
            locked: false,
            clips: track.clips,
          },
        ],
      },
    },
  };
}

function addDraft(project = visualProjectWithReferenceJunction()) {
  const timeline = buildReferenceSpikeProject();
  return compileJoyCodeCompoundDraft({
    planId: 'transition-add-readback',
    baseRevision: 'revision-1',
    timeline,
    visualProject: project,
    operations: [
      {
        id: 'add-dissolve',
        dependsOn: [],
        kind: 'transition.addAtJunction',
        outgoingClipId: 'intro',
        incomingClipId: 'product',
        transitionId: 'dissolve',
        durationUs: 400_000,
      },
    ],
  });
}

function removeDraft(project: JoyProjectV1) {
  const timeline = buildReferenceSpikeProject();
  return compileJoyCodeCompoundDraft({
    planId: 'transition-remove-readback',
    baseRevision: 'revision-2',
    timeline,
    visualProject: project,
    operations: [
      {
        id: 'remove-dissolve',
        dependsOn: [],
        kind: 'transition.remove',
        transitionId: 'transition-transition-add-readback-0',
      },
    ],
  });
}

describe('transition.addAtJunction project-state readback', () => {
  it('verifies one exact curated transition on its durable visual junction', () => {
    const before = visualProjectWithReferenceJunction();
    const draft = addDraft(before);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    expect(() => assertAddedTransitionProjectReadback(before, draft.document, draft)).not.toThrow();
    expect(draft.document.transitions).toEqual([
      {
        id: 'transition-transition-add-readback-0',
        trackId: 'track-0',
        leftClipId: 'intro',
        rightClipId: 'product',
        type: 'dissolve',
        durationUs: 400_000,
      },
    ]);
  });

  it('rejects a missing, changed, or non-adjacent committed transition instead of reporting it', () => {
    const before = visualProjectWithReferenceJunction();
    const draft = addDraft(before);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    expect(() => assertAddedTransitionProjectReadback(before, before, draft)).toThrow(
      'JOY_CODE_TRANSITION_ADD_READBACK_MISMATCH',
    );
    const expected = draft.document.transitions?.[0];
    if (expected === undefined) throw new Error('fixture transition is missing');
    const changed = {
      ...draft.document,
      transitions: [{ ...expected, durationUs: 1_000_001 }],
    };
    expect(() => assertAddedTransitionProjectReadback(before, changed, draft)).toThrow(
      'JOY_CODE_TRANSITION_ADD_READBACK_MISMATCH',
    );
  });

  it('verifies one exact source-backed transition removal without relabeling a no-op', () => {
    const before = visualProjectWithReferenceJunction();
    const added = addDraft(before);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const removed = removeDraft(added.document);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;

    expect(() =>
      assertRemovedTransitionProjectReadback(added.document, removed.document, removed),
    ).not.toThrow();
    expect(removed.document.transitions).toEqual([]);
    expect(() =>
      assertRemovedTransitionProjectReadback(added.document, added.document, removed),
    ).toThrow('JOY_CODE_TRANSITION_ADD_READBACK_MISMATCH');
  });
});
