import type { JoyCodeOperationKind } from './joy-code-plan.js';
import type { JsonSchema } from './types.js';

/**
 * An operation definition describes the narrow, canonical action boundary that
 * JOY can show to a model. It is deliberately not a mutation API: the editor
 * host still resolves targets, prepares a compound draft, previews it, and
 * applies an approved transaction through the command bus.
 */
export type OperationAccess =
  'read' | 'ephemeral-ui' | 'reversible-edit' | 'external-job' | 'export' | 'destructive';

/** A source-backed assertion about a capability, never a product promise. */
export type CoverageStatus =
  'verified' | 'unsupported' | 'read-only' | 'internal-inverse' | 'legacy-disabled';

export interface OperationEvidence {
  readonly id: string;
  readonly status: CoverageStatus;
  /** Owning source seam, relative to the repository root. */
  readonly source: string;
  /** Focused regression files that exercise the source seam. */
  readonly tests: readonly string[];
  readonly reason?: string;
}

export type JoyEditorOperationDomain =
  | 'timeline'
  | 'text'
  | 'captions'
  | 'motion'
  | 'effects'
  | 'transitions'
  | 'audio'
  | 'assets'
  | 'color'
  | 'camera'
  | 'scene-3d'
  | 'export';

export type JoyEditorOperationSurface =
  | 'timeline'
  | 'inspector'
  | 'captions'
  | 'motion'
  | 'transitions'
  | 'effects'
  | 'audio'
  | 'asset-library'
  | 'color'
  | 'scene-3d'
  | 'program-monitor';

export type JoyEditorOperationPreview = 'none' | 'compound-draft';
export type JoyEditorOperationPolicy = 'read-only' | 'approval-required' | 'consent-required';

/**
 * The strict JSON Schema object supplied to a model for one canonical editor
 * operation. Runtime validation remains the authority; this schema prevents
 * the model-facing catalog from silently widening or renaming an operation.
 */
export type JoyEditorOperationModelInputSchema = JsonSchema & {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
};

export interface JoyEditorOperationDefinition {
  readonly kind: JoyCodeOperationKind;
  readonly domain: JoyEditorOperationDomain;
  readonly surface: JoyEditorOperationSurface;
  readonly access: OperationAccess;
  readonly description: string;
  readonly requiredFields: readonly string[];
  /** Strict, model-visible JSON Schema for this exact operation kind. */
  readonly modelInputSchema: JoyEditorOperationModelInputSchema;
  readonly outputRefs: readonly string[];
  readonly evidence: OperationEvidence;
  /** Bounded project data needed before the target can be resolved. */
  readonly contextSelectors: readonly string[];
  /** Named host resolver; it is not an arbitrary JSON path. */
  readonly targetResolver: string;
  /** Named canonical host compiler that turns this into a safe draft. */
  readonly prepareAdapter: string;
  readonly preview: JoyEditorOperationPreview;
  readonly policy: JoyEditorOperationPolicy;
  readonly postconditions: readonly string[];
}

/** A model can see a capability only after both source and test evidence exist. */
export function canAdvertiseOperation(row: OperationEvidence): boolean {
  return row.status === 'verified' && row.source.trim().length > 0 && row.tests.length > 0;
}

/**
 * Fail fast for registry drift. This is intentionally pure so release tooling
 * and the browser host can use the same guard without importing editor code.
 */
export function assertJoyEditorOperationDefinitions(
  definitions: readonly JoyEditorOperationDefinition[],
): void {
  const kinds = new Set<string>();
  for (const definition of definitions) {
    if (kinds.has(definition.kind)) throw new Error(`duplicate operation kind: ${definition.kind}`);
    kinds.add(definition.kind);
    if (definition.evidence.status === 'verified' && !canAdvertiseOperation(definition.evidence))
      throw new Error(`verified operation requires source and test evidence: ${definition.kind}`);
    if (definition.requiredFields.length === 0)
      throw new Error(`operation requires an explicit input shape: ${definition.kind}`);
    assertModelInputSchema(definition);
    if (definition.contextSelectors.length === 0 || definition.targetResolver.length === 0)
      throw new Error(`operation requires a bounded target resolver: ${definition.kind}`);
    if (definition.prepareAdapter.length === 0 || definition.postconditions.length === 0)
      throw new Error(`operation requires preparation and postconditions: ${definition.kind}`);
  }
}

function assertModelInputSchema(definition: JoyEditorOperationDefinition): void {
  const schema = definition.modelInputSchema;
  if (
    !isRecord(schema) ||
    schema.type !== 'object' ||
    schema.additionalProperties !== false ||
    !isRecord(schema.properties) ||
    !isStringArray(schema.required)
  )
    throw new Error(`operation requires a strict model input schema: ${definition.kind}`);

  const kindSchema = schema.properties.kind;
  if (!isRecord(kindSchema) || kindSchema.const !== definition.kind)
    throw new Error(`model input schema kind must match operation: ${definition.kind}`);

  for (const field of ['id', 'dependsOn', 'kind', ...definition.requiredFields]) {
    if (!schema.required.includes(field) || !(field in schema.properties))
      throw new Error(`model input schema missing required field: ${definition.kind}.${field}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
