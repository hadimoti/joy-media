import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { runReleaseObserverTimelineProbe } from './release-observer-timeline.js';

describe('release observer timeline probe', () => {
  it('exercises 100 durable operations and preserves canonical state after reload', () => {
    const result = runReleaseObserverTimelineProbe(
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(result).toEqual({
      operations: 100,
      countSequence: [2, 4, 3, 4],
      uniqueIds: true,
      orphanReferences: 0,
      canonicalModelEqualAfterReload: true,
    });
  });
});
