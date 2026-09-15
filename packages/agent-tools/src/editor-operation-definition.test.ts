import { describe, expect, it } from 'vitest';
import {
  assertJoyEditorOperationDefinitions,
  canAdvertiseOperation,
  type JoyEditorOperationDefinition,
  type JoyEditorOperationModelInputSchema,
} from './editor-operation-definition.js';

const verifiedEvidence = {
  id: 'test.verified',
  status: 'verified' as const,
  source: 'packages/example/src/operation.ts',
  tests: ['packages/example/src/operation.test.ts'],
};

const modelInputSchema: JoyEditorOperationModelInputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    dependsOn: { type: 'array', items: { type: 'string' } },
    kind: { const: 'timeline.trimClip' },
    compositionId: { type: 'string' },
    trackId: { type: 'string' },
    clipId: { type: 'string' },
    newStartUs: { type: 'integer', minimum: 0 },
    newEndUs: { type: 'integer', minimum: 1 },
  },
  required: [
    'id',
    'dependsOn',
    'kind',
    'compositionId',
    'trackId',
    'clipId',
    'newStartUs',
    'newEndUs',
  ],
  additionalProperties: false,
};

const definition: JoyEditorOperationDefinition = {
  kind: 'timeline.trimClip',
  domain: 'timeline',
  surface: 'timeline',
  access: 'reversible-edit',
  description: 'Trim one existing clip.',
  requiredFields: ['compositionId', 'trackId', 'clipId', 'newStartUs', 'newEndUs'],
  outputRefs: [],
  evidence: verifiedEvidence,
  contextSelectors: ['project.timeline', 'project.assets'],
  targetResolver: 'timeline.clip-by-id',
  prepareAdapter: 'joy-code-compound-compiler',
  preview: 'compound-draft',
  policy: 'approval-required',
  postconditions: ['clip range remains valid'],
  modelInputSchema,
};

describe('JOY editor operation definitions', () => {
  it('advertises only verified operations with a concrete test reference', () => {
    expect(canAdvertiseOperation(verifiedEvidence)).toBe(true);
    expect(canAdvertiseOperation({ ...verifiedEvidence, status: 'unsupported', tests: [] })).toBe(
      false,
    );
    expect(canAdvertiseOperation({ ...verifiedEvidence, tests: [] })).toBe(false);
  });

  it('rejects duplicate IDs and unsupported operations marked as verified', () => {
    expect(() => assertJoyEditorOperationDefinitions([definition, definition])).toThrow(
      'duplicate operation kind',
    );
    expect(() =>
      assertJoyEditorOperationDefinitions([
        {
          ...definition,
          evidence: { ...verifiedEvidence, source: '', tests: [] },
        },
      ]),
    ).toThrow('verified operation requires source and test evidence');
  });

  it('rejects a model input schema whose kind can drift from its definition', () => {
    expect(() =>
      assertJoyEditorOperationDefinitions([
        {
          ...definition,
          modelInputSchema: {
            ...modelInputSchema,
            properties: {
              ...modelInputSchema.properties,
              kind: { const: 'timeline.moveClip' },
            },
          },
        } as unknown as JoyEditorOperationDefinition,
      ]),
    ).toThrow('model input schema kind must match operation');
  });

  it('rejects a model input schema that omits a declared operation input', () => {
    expect(() =>
      assertJoyEditorOperationDefinitions([
        {
          ...definition,
          modelInputSchema: {
            ...modelInputSchema,
            required: ['id', 'dependsOn', 'kind', 'compositionId'],
          },
        } as unknown as JoyEditorOperationDefinition,
      ]),
    ).toThrow('model input schema missing required field: timeline.trimClip.trackId');
  });
});
