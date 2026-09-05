import {
  assertJoyEditorOperationDefinitions,
  canAdvertiseOperation,
  type CoverageStatus,
  type JoyEditorOperationDefinition,
  type JoyEditorOperationDomain,
  type JoyEditorOperationModelInputSchema,
  type JoyEditorOperationSurface,
  type OperationAccess,
} from './editor-operation-definition.js';
import { JOY_CODE_PLAN_LIMITS, type JoyCodeOperationKind } from './joy-code-plan.js';
import type { JsonSchema } from './types.js';

/**
 * Shared semantic inventory for model tools, skills and UI capability checks.
 * Domain compilers remain in their owning packages; this file deliberately
 * describes the authority boundary but never grants mutation authority.
 */
export { canAdvertiseOperation };
export type {
  CoverageStatus,
  JoyEditorOperationDefinition,
  JoyEditorOperationDomain,
  JoyEditorOperationModelInputSchema,
  JoyEditorOperationPolicy,
  JoyEditorOperationPreview,
  JoyEditorOperationSurface,
  OperationAccess,
  OperationEvidence,
} from './editor-operation-definition.js';

/** @deprecated Use OperationAccess. */
export type JoyEditorOperationAccess = OperationAccess;
/** @deprecated Use CoverageStatus. */
export type JoyEditorOperationStatus = CoverageStatus;

type DefinitionSeed = readonly [
  JoyCodeOperationKind,
  JoyEditorOperationDomain,
  JoyEditorOperationSurface,
  string,
  readonly string[],
  readonly string[],
];

const OPERATION_EVIDENCE: Readonly<
  Record<JoyCodeOperationKind, JoyEditorOperationDefinition['evidence']>
> = {
  'timeline.trimClip': {
    id: 'joy-code.timeline-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-timeline-compiler.ts',
    tests: ['apps/editor-web/src/joy-code-timeline-compiler.test.ts'],
  },
  'timeline.splitClip': {
    id: 'joy-code.timeline-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-timeline-compiler.ts',
    tests: ['apps/editor-web/src/joy-code-timeline-compiler.test.ts'],
  },
  'timeline.moveClip': {
    id: 'joy-code.timeline-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-timeline-compiler.ts',
    tests: ['apps/editor-web/src/joy-code-timeline-compiler.test.ts'],
  },
  'timeline.removeClip': {
    id: 'joy-code.timeline-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-timeline-compiler.ts',
    tests: ['apps/editor-web/src/joy-code-timeline-compiler.test.ts'],
  },
  'timeline.insertExistingAsset': {
    id: 'joy-code.timeline-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-timeline-compiler.ts',
    tests: ['apps/editor-web/src/joy-code-timeline-compiler.test.ts'],
  },
  'text.insertTemplate': {
    id: 'joy-code.text-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-text-operations.ts',
    tests: ['apps/editor-web/src/joy-code-text-operations.test.ts'],
  },
  'text.setContent': {
    id: 'joy-code.text-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-text-operations.ts',
    tests: ['apps/editor-web/src/joy-code-text-operations.test.ts'],
  },
  'text.setTemplate': {
    id: 'joy-code.text-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-text-operations.ts',
    tests: ['apps/editor-web/src/joy-code-text-operations.test.ts'],
  },
  'motion.setKeyframe': {
    id: 'joy-code.motion-compound-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-compound-compiler.ts',
    tests: ['apps/editor-web/src/joy-code-compound-compiler.test.ts'],
  },
  'motion.removeKeyframe': {
    id: 'joy-code.motion-compound-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-compound-compiler.ts',
    tests: ['apps/editor-web/src/joy-code-compound-compiler.test.ts'],
  },
  'caption.setSegmentText': {
    id: 'joy-code.caption-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-caption-operations.ts',
    tests: ['apps/editor-web/src/joy-code-caption-operations.test.ts'],
  },
  'caption.setSegmentTiming': {
    id: 'joy-code.caption-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-caption-operations.ts',
    tests: ['apps/editor-web/src/joy-code-caption-operations.test.ts'],
  },
  'caption.setTemplate': {
    id: 'joy-code.caption-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-caption-operations.ts',
    tests: ['apps/editor-web/src/joy-code-caption-operations.test.ts'],
  },
  'caption.setBurnIn': {
    id: 'joy-code.caption-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-caption-operations.ts',
    tests: ['apps/editor-web/src/joy-code-caption-operations.test.ts'],
  },
  'transition.addAtJunction': {
    id: 'joy-code.transition-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-transition-operations.ts',
    tests: ['apps/editor-web/src/joy-code-transition-operations.test.ts'],
  },
  'transition.remove': {
    id: 'joy-code.transition-compiler',
    status: 'verified',
    source: 'apps/editor-web/src/joy-code-transition-operations.ts',
    tests: ['apps/editor-web/src/joy-code-transition-operations.test.ts'],
  },
};

function createOperationInputSchema(
  kind: JoyCodeOperationKind,
  operationProperties: Readonly<Record<string, JsonSchema>>,
  operationRequired: readonly string[],
): JoyEditorOperationModelInputSchema {
  return {
    type: 'object',
    properties: {
      id: { type: 'string' },
      dependsOn: { type: 'array', items: { type: 'string' } },
      kind: { const: kind },
      ...operationProperties,
    },
    required: ['id', 'dependsOn', 'kind', ...operationRequired],
    additionalProperties: false,
  };
}

function createVisualObjectRefSchema(): JsonSchema {
  return {
    type: 'object',
    properties: { kind: { const: 'visual-object' }, ref: { type: 'string' } },
    required: ['kind', 'ref'],
    additionalProperties: false,
  };
}

function createMotionBindingSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      ownerKind: { type: 'string' },
      ownerId: { type: 'string' },
      ownerRef: createVisualObjectRefSchema(),
      propertyId: { type: 'string' },
      timeDomain: { type: 'string' },
    },
    required: ['ownerKind', 'propertyId', 'timeDomain'],
    oneOf: [{ required: ['ownerId'] }, { required: ['ownerRef'] }],
    additionalProperties: false,
  };
}

const OPERATION_INPUT_SCHEMAS = {
  'timeline.trimClip': createOperationInputSchema(
    'timeline.trimClip',
    {
      compositionId: { type: 'string' },
      trackId: { type: 'string' },
      clipId: { type: 'string' },
      newStartUs: { type: 'integer', minimum: 0 },
      newEndUs: { type: 'integer', minimum: 1 },
    },
    ['compositionId', 'trackId', 'clipId', 'newStartUs', 'newEndUs'],
  ),
  'timeline.splitClip': createOperationInputSchema(
    'timeline.splitClip',
    {
      compositionId: { type: 'string' },
      trackId: { type: 'string' },
      clipId: { type: 'string' },
      atUs: { type: 'integer', minimum: 1 },
    },
    ['compositionId', 'trackId', 'clipId', 'atUs'],
  ),
  'timeline.moveClip': createOperationInputSchema(
    'timeline.moveClip',
    {
      compositionId: { type: 'string' },
      sourceTrackId: { type: 'string' },
      targetTrackId: { type: 'string' },
      clipId: { type: 'string' },
      newStartUs: { type: 'integer', minimum: 0 },
    },
    ['compositionId', 'sourceTrackId', 'targetTrackId', 'clipId', 'newStartUs'],
  ),
  'timeline.removeClip': createOperationInputSchema(
    'timeline.removeClip',
    {
      compositionId: { type: 'string' },
      trackId: { type: 'string' },
      clipId: { type: 'string' },
    },
    ['compositionId', 'trackId', 'clipId'],
  ),
  'timeline.insertExistingAsset': createOperationInputSchema(
    'timeline.insertExistingAsset',
    {
      compositionId: { type: 'string' },
      targetTrackId: { type: 'string' },
      assetId: { type: 'string' },
      startUs: { type: 'integer', minimum: 0 },
      durationUs: { type: 'integer', minimum: 1 },
    },
    ['compositionId', 'targetTrackId', 'assetId', 'startUs', 'durationUs'],
  ),
  'text.insertTemplate': createOperationInputSchema(
    'text.insertTemplate',
    {
      templateId: { type: 'string' },
      content: { type: 'string', minLength: 1, maxLength: 500 },
      startUs: { type: 'integer', minimum: 0 },
      durationUs: { type: 'integer', minimum: 1 },
      placementPreset: { enum: ['center', 'top', 'bottom', 'lower-third'] },
      outputRef: createVisualObjectRefSchema(),
    },
    ['templateId', 'content', 'startUs', 'durationUs', 'placementPreset'],
  ),
  'text.setContent': createOperationInputSchema(
    'text.setContent',
    {
      objectId: { type: 'string' },
      content: { type: 'string', minLength: 1, maxLength: 500 },
    },
    ['objectId', 'content'],
  ),
  'text.setTemplate': createOperationInputSchema(
    'text.setTemplate',
    {
      objectId: { type: 'string' },
      templateId: { type: 'string' },
    },
    ['objectId', 'templateId'],
  ),
  'motion.setKeyframe': createOperationInputSchema(
    'motion.setKeyframe',
    {
      binding: createMotionBindingSchema(),
      key: {
        type: 'object',
        properties: {
          kind: { enum: ['scalar', 'angle', 'hue'] },
          timeUs: { type: 'integer', minimum: 0 },
          value: { type: 'number' },
          interpolation: { enum: ['hold', 'linear', 'eased', 'bezier'] },
          bezier: {
            type: 'object',
            properties: {
              x1: { type: 'number' },
              y1: { type: 'number' },
              x2: { type: 'number' },
              y2: { type: 'number' },
            },
            required: ['x1', 'y1', 'x2', 'y2'],
            additionalProperties: false,
          },
        },
        required: ['kind', 'timeUs', 'value', 'interpolation'],
        additionalProperties: false,
      },
    },
    ['binding', 'key'],
  ),
  'motion.removeKeyframe': createOperationInputSchema(
    'motion.removeKeyframe',
    {
      binding: createMotionBindingSchema(),
      timeUs: { type: 'integer', minimum: 0 },
    },
    ['binding', 'timeUs'],
  ),
  'caption.setSegmentText': createOperationInputSchema(
    'caption.setSegmentText',
    {
      captionClipId: { type: 'string' },
      segmentId: { type: 'string' },
      text: { type: 'string', minLength: 1, maxLength: 500 },
    },
    ['captionClipId', 'segmentId', 'text'],
  ),
  'caption.setSegmentTiming': createOperationInputSchema(
    'caption.setSegmentTiming',
    {
      captionClipId: { type: 'string' },
      segmentId: { type: 'string' },
      startUs: { type: 'integer', minimum: 0 },
      endUs: { type: 'integer', minimum: 1 },
    },
    ['captionClipId', 'segmentId', 'startUs', 'endUs'],
  ),
  'caption.setTemplate': createOperationInputSchema(
    'caption.setTemplate',
    {
      captionClipId: { type: 'string' },
      templateId: { type: 'string' },
    },
    ['captionClipId', 'templateId'],
  ),
  'caption.setBurnIn': createOperationInputSchema(
    'caption.setBurnIn',
    { enabled: { type: 'boolean' } },
    ['enabled'],
  ),
  'transition.addAtJunction': createOperationInputSchema(
    'transition.addAtJunction',
    {
      outgoingClipId: { type: 'string' },
      incomingClipId: { type: 'string' },
      transitionId: { type: 'string' },
      durationUs: { type: 'integer', minimum: 1 },
    },
    ['outgoingClipId', 'incomingClipId', 'transitionId', 'durationUs'],
  ),
  'transition.remove': createOperationInputSchema(
    'transition.remove',
    { transitionId: { type: 'string' } },
    ['transitionId'],
  ),
} satisfies Readonly<Record<JoyCodeOperationKind, JoyEditorOperationModelInputSchema>>;

const seeds = [
  [
    'timeline.trimClip',
    'timeline',
    'timeline',
    'Trim an existing clip.',
    ['compositionId', 'trackId', 'clipId', 'newStartUs', 'newEndUs'],
    [],
  ],
  [
    'timeline.splitClip',
    'timeline',
    'timeline',
    'Split an existing clip.',
    ['compositionId', 'trackId', 'clipId', 'atUs'],
    [],
  ],
  [
    'timeline.moveClip',
    'timeline',
    'timeline',
    'Move a clip between tracks or times.',
    ['compositionId', 'sourceTrackId', 'targetTrackId', 'clipId', 'newStartUs'],
    [],
  ],
  [
    'timeline.removeClip',
    'timeline',
    'timeline',
    'Remove an existing clip safely.',
    ['compositionId', 'trackId', 'clipId'],
    [],
  ],
  [
    'timeline.insertExistingAsset',
    'assets',
    'timeline',
    'Place a registered asset on a compatible track.',
    ['compositionId', 'targetTrackId', 'assetId', 'startUs', 'durationUs'],
    [],
  ],
  [
    'text.insertTemplate',
    'text',
    'inspector',
    'Create a text object from an allowlisted template.',
    ['templateId', 'content', 'startUs', 'durationUs', 'placementPreset'],
    ['visual-object'],
  ],
  [
    'text.setContent',
    'text',
    'inspector',
    'Replace existing text content.',
    ['objectId', 'content'],
    ['objectId'],
  ],
  [
    'text.setTemplate',
    'text',
    'inspector',
    'Apply an allowlisted text template.',
    ['objectId', 'templateId'],
    ['objectId'],
  ],
  [
    'motion.setKeyframe',
    'motion',
    'motion',
    'Add or replace a typed property keyframe.',
    ['binding', 'key'],
    ['binding.ownerId', 'binding.propertyId'],
  ],
  [
    'motion.removeKeyframe',
    'motion',
    'motion',
    'Remove a typed property keyframe.',
    ['binding', 'timeUs'],
    ['binding.ownerId', 'binding.propertyId'],
  ],
  [
    'caption.setSegmentText',
    'captions',
    'captions',
    'Replace one caption segment.',
    ['captionClipId', 'segmentId', 'text'],
    ['captionClipId', 'segmentId'],
  ],
  [
    'caption.setSegmentTiming',
    'captions',
    'captions',
    'Set one caption segment range.',
    ['captionClipId', 'segmentId', 'startUs', 'endUs'],
    ['captionClipId', 'segmentId'],
  ],
  [
    'caption.setTemplate',
    'captions',
    'captions',
    'Apply an allowlisted caption template.',
    ['captionClipId', 'templateId'],
    ['captionClipId'],
  ],
  ['caption.setBurnIn', 'captions', 'captions', 'Toggle bounded caption burn-in.', ['enabled'], []],
  [
    'transition.addAtJunction',
    'transitions',
    'transitions',
    'Add an allowlisted junction transition.',
    ['outgoingClipId', 'incomingClipId', 'transitionId', 'durationUs'],
    ['transitionId'],
  ],
  [
    'transition.remove',
    'transitions',
    'transitions',
    'Remove an existing transition.',
    ['transitionId'],
    [],
  ],
] satisfies readonly DefinitionSeed[];

const definitions: readonly JoyEditorOperationDefinition[] = seeds.map(
  ([kind, domain, surface, description, requiredFields, outputRefs]) => ({
    kind,
    domain,
    surface,
    access: 'reversible-edit' as const,
    description,
    requiredFields,
    modelInputSchema: OPERATION_INPUT_SCHEMAS[kind],
    outputRefs,
    evidence: OPERATION_EVIDENCE[kind],
    contextSelectors: ['project.timeline', 'project.assets', 'project.visual-document'],
    targetResolver: 'joy-code-operation-references',
    prepareAdapter: 'joy-code-compound-compiler',
    preview: 'compound-draft' as const,
    policy: 'approval-required' as const,
    postconditions: ['canonical compiler accepts the operation', 'approved draft remains undoable'],
  }),
);

assertJoyEditorOperationDefinitions(definitions);

export const JOY_EDITOR_OPERATION_DEFINITIONS = definitions;

/** Pure, model-facing projection: only source- and test-backed operations. */
export function listModelVisibleJoyEditorOperationDefinitions(
  definitions: readonly JoyEditorOperationDefinition[] = JOY_EDITOR_OPERATION_DEFINITIONS,
): readonly JoyEditorOperationDefinition[] {
  return definitions.filter((definition) => canAdvertiseOperation(definition.evidence));
}

/** Pure model-facing operation-kind projection, ordered as its definitions. */
export function listModelVisibleJoyCodeOperationKinds(
  definitions: readonly JoyEditorOperationDefinition[] = JOY_EDITOR_OPERATION_DEFINITIONS,
): readonly JoyCodeOperationKind[] {
  return listModelVisibleJoyEditorOperationDefinitions(definitions).map(
    (definition) => definition.kind,
  );
}

/**
 * Strict proposal parameters assembled from the verified model-visible catalog.
 * The package owns this projection so a host cannot accidentally hand a model
 * a schema that no longer corresponds to an advertised operation.
 */
export function createModelVisibleJoyCodeProposalParameters(
  definitions: readonly JoyEditorOperationDefinition[] = JOY_EDITOR_OPERATION_DEFINITIONS,
): JsonSchema | undefined {
  const visibleDefinitions = listModelVisibleJoyEditorOperationDefinitions(definitions);
  // A JSON Schema `oneOf: []` is invalid. Withhold proposal parameters when
  // no verified operations are visible so hosts can omit the mutation tool.
  if (visibleDefinitions.length === 0) return undefined;
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      operations: {
        type: 'array',
        items: {
          oneOf: visibleDefinitions.map((definition) => definition.modelInputSchema),
        },
        maxItems: JOY_CODE_PLAN_LIMITS.operations,
      },
    },
    required: ['summary', 'operations'],
    additionalProperties: false,
  };
}

export function getJoyEditorOperationDefinition(
  kind: string,
): JoyEditorOperationDefinition | undefined {
  return definitions.find((definition) => definition.kind === kind);
}

export function listJoyEditorOperations(options?: {
  readonly status?: JoyEditorOperationStatus;
  readonly domain?: JoyEditorOperationDefinition['domain'];
}): readonly JoyEditorOperationDefinition[] {
  return definitions.filter(
    (definition) =>
      (options?.status === undefined || definition.evidence.status === options.status) &&
      (options?.domain === undefined || definition.domain === options.domain),
  );
}
