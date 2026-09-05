import { describe, expect, it } from 'vitest';
import { JOY_EDITOR_OPERATION_DEFINITIONS } from '@joy-media/agent-tools';
import { listModelVisibleJoyEditorOperations } from './editor-operation-registry.js';

describe('host JOY editor operation registry', () => {
  it('derives the model-visible catalog from verified package definitions', () => {
    expect(listModelVisibleJoyEditorOperations()).toEqual(
      JOY_EDITOR_OPERATION_DEFINITIONS.filter(
        (definition) =>
          definition.evidence.status === 'verified' && definition.evidence.tests.length > 0,
      ).map((definition) => ({
        kind: definition.kind,
        surface: definition.surface,
        description: definition.description,
        requiredFields: definition.requiredFields,
        outputRefs: definition.outputRefs,
      })),
    );
  });

  it('does not expose an unsupported definition even if it has an operation shape', () => {
    const unsupported = {
      ...JOY_EDITOR_OPERATION_DEFINITIONS[0]!,
      evidence: {
        ...JOY_EDITOR_OPERATION_DEFINITIONS[0]!.evidence,
        status: 'unsupported' as const,
        tests: [],
      },
    };

    expect(listModelVisibleJoyEditorOperations([unsupported])).toEqual([]);
  });
});
