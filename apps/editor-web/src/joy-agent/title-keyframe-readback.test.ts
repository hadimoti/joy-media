import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { describe, expect, it } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import {
  compileJoyCodeCompoundDraft,
  type JoyCodeCompoundDraft,
} from '../joy-code-compound-compiler.js';
import { assertCreatedTitleOpacityKeyframeProjectReadback } from './title-keyframe-readback.js';

function titleOpacityDraft(): JoyCodeCompoundDraft {
  const result = compileJoyCodeCompoundDraft({
    planId: 'title-readback',
    baseRevision: 'rev-title-readback',
    timeline: buildReferenceSpikeProject(),
    visualProject: INITIAL_EDITOR_PROJECT,
    // The dependent key appears first to prove its owner is resolved from the
    // created title rather than a model-supplied object id.
    operations: [
      {
        id: 'opacity',
        dependsOn: ['title'],
        kind: 'motion.setKeyframe',
        binding: {
          ownerKind: 'visual-object',
          ownerRef: { kind: 'visual-object', ref: 'created-title' },
          propertyId: 'opacity',
          timeDomain: 'composition',
        },
        key: { kind: 'scalar', timeUs: 1_500_000, value: 0.5, interpolation: 'linear' },
      },
      {
        id: 'title',
        dependsOn: [],
        kind: 'text.insertTemplate',
        templateId: 'clean-title',
        content: 'Read back this title',
        startUs: 1_000_000,
        durationUs: 2_000_000,
        placementPreset: 'center',
        outputRef: { kind: 'visual-object', ref: 'created-title' },
      },
    ],
  });
  if (!result.ok) throw new Error(`fixture did not compile: ${result.error.code}`);
  return result;
}

describe('created title opacity project-state readback', () => {
  it('asserts the exact text object and typed V2 opacity curve, without claiming renderer pixels', () => {
    const draft = titleOpacityDraft();

    expect(() =>
      assertCreatedTitleOpacityKeyframeProjectReadback(
        INITIAL_EDITOR_PROJECT,
        draft.document,
        draft,
      ),
    ).not.toThrow();
  });

  it('rejects a committed title or typed keyframe that differs from the approved state', () => {
    const draft = titleOpacityDraft();
    const objectId = 'text-clean-title-title-readback-1';
    const title = draft.document.visualObjects[objectId];
    if (title === undefined || title.kind !== 'text') throw new Error('fixture title is missing');
    const titleMismatch = {
      ...draft.document,
      visualObjects: {
        ...draft.document.visualObjects,
        [objectId]: { ...title, text: 'Tampered title' },
      },
    };
    expect(() =>
      assertCreatedTitleOpacityKeyframeProjectReadback(
        INITIAL_EDITOR_PROJECT,
        titleMismatch,
        draft,
      ),
    ).toThrow('JOY_CODE_TITLE_OPACITY_READBACK_MISMATCH');

    const keyMismatch = { ...draft.document, propertyAnimations: {} };
    expect(() =>
      assertCreatedTitleOpacityKeyframeProjectReadback(INITIAL_EDITOR_PROJECT, keyMismatch, draft),
    ).toThrow('JOY_CODE_TITLE_OPACITY_READBACK_MISMATCH');
  });

  it('does not treat an existing-text edit as a newly created-title slice', () => {
    const draft = titleOpacityDraft();
    const objectId = 'text-clean-title-title-readback-1';
    const before = {
      ...INITIAL_EDITOR_PROJECT,
      visualObjects: {
        ...INITIAL_EDITOR_PROJECT.visualObjects,
        [objectId]: draft.document.visualObjects[objectId]!,
      },
    };

    expect(() =>
      assertCreatedTitleOpacityKeyframeProjectReadback(before, draft.document, draft),
    ).not.toThrow();
  });
});
