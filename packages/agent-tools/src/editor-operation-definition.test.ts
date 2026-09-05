import { describe, expect, it } from 'vitest';
import {
  assertJoyEditorOperationDefinitions,
  canAdvertiseOperation,
  type JoyEditorOperationDefinition,
} from './editor-operation-definition.js';

const verifiedEvidence = {
  id: 'test.verified',
  status: 'verified' as const,
  source: 'packages/example/src/operation.ts',
  tests: ['packages/example/src/operation.test.ts'],
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
});
