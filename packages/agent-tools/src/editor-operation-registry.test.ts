import { describe, expect, it } from 'vitest';
import { JOY_CODE_OPERATION_KINDS, JOY_CODE_PLAN_LIMITS } from './joy-code-plan.js';
import {
  JOY_EDITOR_OPERATION_DEFINITIONS,
  createModelVisibleJoyCodeProposalParameters,
  getJoyEditorOperationDefinition,
  listModelVisibleJoyCodeOperationKinds,
  listModelVisibleJoyEditorOperationDefinitions,
} from './editor-operation-registry.js';
import type { JoyEditorOperationDefinition } from './editor-operation-definition.js';
import type { JsonSchema } from './types.js';

describe('JOY editor operation registry', () => {
  it('covers every operation accepted by the plan validator', () => {
    expect(new Set(JOY_EDITOR_OPERATION_DEFINITIONS.map((definition) => definition.kind))).toEqual(
      new Set(JOY_CODE_OPERATION_KINDS),
    );
  });

  it('describes keyframe operations as source-backed reversible editor work', () => {
    expect(getJoyEditorOperationDefinition('motion.setKeyframe')).toMatchObject({
      access: 'reversible-edit',
      evidence: {
        status: 'verified',
        source: 'apps/editor-web/src/joy-code-compound-compiler.ts',
      },
      requiredFields: expect.arrayContaining(['binding', 'key']),
    });
    expect(getJoyEditorOperationDefinition('motion.removeKeyframe')).toMatchObject({
      access: 'reversible-edit',
      evidence: {
        status: 'verified',
        source: 'apps/editor-web/src/joy-code-compound-compiler.ts',
      },
      requiredFields: expect.arrayContaining(['binding', 'timeUs']),
    });
  });

  it('derives model-visible operation schemas and proposal parameters from verified definitions', () => {
    const visibleDefinitions = listModelVisibleJoyEditorOperationDefinitions();
    const visibleKinds = listModelVisibleJoyCodeOperationKinds();
    expect(visibleDefinitions).toEqual(JOY_EDITOR_OPERATION_DEFINITIONS);
    expect(visibleKinds).toEqual(JOY_CODE_OPERATION_KINDS);
    expect(visibleDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelInputSchema: expect.objectContaining({
            type: 'object',
            additionalProperties: false,
          }),
        }),
      ]),
    );

    const parameters = createModelVisibleJoyCodeProposalParameters();
    if (parameters === undefined)
      throw new Error('verified catalog unexpectedly has no proposal schema');
    expect(parameters).toMatchObject({
      type: 'object',
      required: ['summary', 'operations'],
      additionalProperties: false,
    });
    const operations = (parameters.properties as Record<string, unknown>).operations as {
      readonly maxItems?: unknown;
      readonly items?: { readonly oneOf?: readonly JsonSchema[] };
    };
    expect(operations.maxItems).toBe(JOY_CODE_PLAN_LIMITS.operations);
    expect(
      operations.items?.oneOf?.map(
        (schema) =>
          ((schema.properties as Record<string, unknown>).kind as { readonly const?: unknown })
            .const,
      ),
    ).toEqual(JOY_CODE_OPERATION_KINDS);

    const hiddenDefinition: JoyEditorOperationDefinition = {
      ...JOY_EDITOR_OPERATION_DEFINITIONS[0]!,
      evidence: {
        ...JOY_EDITOR_OPERATION_DEFINITIONS[0]!.evidence,
        status: 'unsupported',
        tests: [],
      },
    };
    expect(listModelVisibleJoyEditorOperationDefinitions([hiddenDefinition])).toEqual([]);
    expect(listModelVisibleJoyCodeOperationKinds([hiddenDefinition])).toEqual([]);
    expect(createModelVisibleJoyCodeProposalParameters([hiddenDefinition])).toBeUndefined();
  });
});
