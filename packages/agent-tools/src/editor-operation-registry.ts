/**
 * Shared semantic inventory for model tools, skills and UI capability checks.
 * Domain compilers remain in their owning packages; this file deliberately
 * contains metadata only and never grants mutation authority.
 */
export type JoyEditorOperationAccess =
  'read' | 'preview' | 'reversible-local' | 'external-job' | 'delivery';

export type JoyEditorOperationStatus = 'implemented' | 'planned' | 'unavailable';

export interface JoyEditorOperationDefinition {
  readonly kind: string;
  readonly domain:
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
  readonly surface:
    | 'timeline'
    | 'inspector'
    | 'captions'
    | 'motion'
    | 'effects'
    | 'audio'
    | 'asset-library'
    | 'color'
    | 'scene-3d'
    | 'program-monitor';
  readonly access: JoyEditorOperationAccess;
  readonly status: JoyEditorOperationStatus;
  readonly description: string;
  readonly requiredFields: readonly string[];
  readonly outputRefs: readonly string[];
}

const definitions: readonly JoyEditorOperationDefinition[] = [
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
].map(([kind, domain, surface, description, requiredFields, outputRefs]) => ({
  kind,
  domain,
  surface,
  access: 'reversible-local' as const,
  status: 'implemented' as const,
  description,
  requiredFields,
  outputRefs,
})) as readonly JoyEditorOperationDefinition[];

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
      (options?.status === undefined || definition.status === options.status) &&
      (options?.domain === undefined || definition.domain === options.domain),
  );
}
