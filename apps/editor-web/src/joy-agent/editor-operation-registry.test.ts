import { describe, expect, it } from 'vitest';
import {
  JOY_EDITOR_OPERATION_DEFINITIONS,
  listModelVisibleJoyCodeOperationKinds,
  listModelVisibleJoyEditorOperationDefinitions,
} from '@joy-media/agent-tools';
import { listModelVisibleJoyEditorOperations } from './editor-operation-registry.js';

describe('host JOY editor operation registry', () => {
  it('derives the model-visible catalog from verified package definitions', () => {
    expect(listModelVisibleJoyEditorOperations()).toEqual(
      listModelVisibleJoyEditorOperationDefinitions().map((definition) => ({
        kind: definition.kind,
        surface: definition.surface,
        description: definition.description,
        requiredFields: definition.requiredFields,
        outputRefs: definition.outputRefs,
      })),
    );
    expect(listModelVisibleJoyEditorOperations().map(({ kind }) => kind)).toEqual(
      listModelVisibleJoyCodeOperationKinds(),
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

  it('does not display a verified operation without both source and test evidence', () => {
    const definition = JOY_EDITOR_OPERATION_DEFINITIONS[0]!;
    for (const evidence of [
      { ...definition.evidence, source: ' ' },
      { ...definition.evidence, tests: [] },
    ]) {
      expect(listModelVisibleJoyEditorOperations([{ ...definition, evidence }])).toEqual([]);
    }
  });
});
