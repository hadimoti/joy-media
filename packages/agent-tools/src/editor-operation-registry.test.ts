import { describe, expect, it } from 'vitest';
import { JOY_CODE_OPERATION_KINDS } from './joy-code-plan.js';
import {
  JOY_EDITOR_OPERATION_DEFINITIONS,
  getJoyEditorOperationDefinition,
} from './editor-operation-registry.js';

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
});
