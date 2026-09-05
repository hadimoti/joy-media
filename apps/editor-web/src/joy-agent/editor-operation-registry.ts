import {
  canAdvertiseOperation,
  JOY_EDITOR_OPERATION_DEFINITIONS,
  type JoyEditorOperationDefinition,
} from '@joy-media/agent-tools';

/**
 * The Worker receives this compact, derived catalog rather than a second
 * hand-maintained capability list. The full typed schema remains enforced by
 * the plan validator and the canonical compound compiler.
 */
export interface ModelVisibleJoyEditorOperation {
  readonly kind: JoyEditorOperationDefinition['kind'];
  readonly surface: JoyEditorOperationDefinition['surface'];
  readonly description: string;
  readonly requiredFields: readonly string[];
  readonly outputRefs: readonly string[];
}

export function listModelVisibleJoyEditorOperations(
  definitions: readonly JoyEditorOperationDefinition[] = JOY_EDITOR_OPERATION_DEFINITIONS,
): readonly ModelVisibleJoyEditorOperation[] {
  return definitions
    .filter((definition) => canAdvertiseOperation(definition.evidence))
    .map(({ kind, surface, description, requiredFields, outputRefs }) => ({
      kind,
      surface,
      description,
      requiredFields,
      outputRefs,
    }));
}
