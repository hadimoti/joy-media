import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { textTemplateById } from './text-template-catalog.js';
import { compileJoyCodeTextOperation } from './joy-code-text-operations.js';

describe('Joy Code text operations', () => {
  it('inserts an exact catalog template deterministically with Persian content preserved', () => {
    const template = textTemplateById('clean-title');
    expect(template).toBeDefined();
    const result = compileJoyCodeTextOperation({
      planId: 'plan-text',
      operationIndex: 0,
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      operation: {
        id: 'title',
        dependsOn: [],
        kind: 'text.insertTemplate',
        templateId: 'clean-title',
        content: 'سلام جهان',
        startUs: 2_000_000,
        durationUs: 3_000_000,
        placementPreset: 'center',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.visualObjects['text-clean-title-plan-text-0']).toMatchObject({
      text: 'سلام جهان',
      kind: 'text',
    });
    expect(result.timeline?.commands).toHaveLength(2);
    const second = compileJoyCodeTextOperation({
      planId: 'plan-text',
      operationIndex: 0,
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      operation: {
        id: 'title',
        dependsOn: [],
        kind: 'text.insertTemplate',
        templateId: 'clean-title',
        content: 'سلام جهان',
        startUs: 2_000_000,
        durationUs: 3_000_000,
        placementPreset: 'center',
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // `updatedAt` is a per-transaction document timestamp refreshed by the
    // template preparation that now persists `joy.timelineElementKinds`;
    // it is not a creative result of this operation.
    expect({
      ...result.document,
      updatedAt: second.document.updatedAt,
    }).toEqual(second.document);
  });

  it('updates only an existing text object and rejects unknown templates/invalid content', () => {
    const content = compileJoyCodeTextOperation({
      planId: 'plan-text',
      operationIndex: 1,
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      operation: {
        id: 'content',
        dependsOn: [],
        kind: 'text.setContent',
        objectId: 'intro-title',
        content: 'New title',
      },
    });
    expect(content.ok).toBe(true);
    if (content.ok) {
      expect(content.document.visualObjects['intro-title']?.text).toBe('New title');
      expect(content.document.visualObjects['product-still']).toBeUndefined();
    }
    const unknown = compileJoyCodeTextOperation({
      planId: 'plan-text',
      operationIndex: 2,
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      operation: {
        id: 'unknown',
        dependsOn: [],
        kind: 'text.insertTemplate',
        templateId: 'missing',
        content: 'x',
        startUs: 0,
        durationUs: 1_000_000,
        placementPreset: 'center',
      },
    });
    expect(unknown.ok).toBe(false);
  });
});
