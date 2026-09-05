import {
  assertJoyEditorOperationDefinitions,
  type CoverageStatus,
  type JoyEditorOperationDefinition,
  type JoyEditorOperationDomain,
  type JoyEditorOperationSurface,
  type OperationAccess,
} from './editor-operation-definition.js';
import type { JoyCodeOperationKind } from './joy-code-plan.js';

/**
 * Shared semantic inventory for model tools, skills and UI capability checks.
 * Domain compilers remain in their owning packages; this file deliberately
 * describes the authority boundary but never grants mutation authority.
 */
export { canAdvertiseOperation } from './editor-operation-definition.js';
export type {
  CoverageStatus,
  JoyEditorOperationDefinition,
  JoyEditorOperationDomain,
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
