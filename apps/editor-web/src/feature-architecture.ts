import type { TimelineElementKind } from './timeline-element-kind.js';

export type CreateToolId = 'media' | 'text' | 'captions' | 'audio' | 'templates';
export type EnhanceToolId = 'motion' | 'transitions' | 'effects' | 'filters' | 'adjust';
export type FeatureToolId = CreateToolId | EnhanceToolId;
export type FeatureHubId = 'create' | 'enhance';

export interface FeatureToolDefinition {
  readonly id: FeatureToolId;
  readonly label: string;
  readonly shortLabel: string;
  readonly timelineKinds: readonly (TimelineElementKind | 'transition')[];
  /** Explains why a feature does or does not create a standalone timeline item. */
  readonly timelineBehavior: 'layer' | 'junction' | 'property-or-layer' | 'media';
}

export interface FeatureHubDefinition {
  readonly id: FeatureHubId;
  readonly label: string;
  readonly tools: readonly FeatureToolDefinition[];
}

/**
 * One product map for the dock navigation and timeline semantics. Keeping the
 * relation explicit prevents a library tab from shipping without a matching
 * timeline representation (or inventing a layer for a cut transition).
 */
export const FEATURE_HUBS: Readonly<Record<FeatureHubId, FeatureHubDefinition>> = {
  create: {
    id: 'create',
    label: 'Create',
    tools: [
      {
        id: 'media',
        label: 'Media',
        shortLabel: 'Media',
        timelineKinds: ['video', 'overlay'],
        timelineBehavior: 'media',
      },
      {
        id: 'text',
        label: 'Text',
        shortLabel: 'Text',
        timelineKinds: ['text'],
        timelineBehavior: 'layer',
      },
      {
        id: 'captions',
        label: 'Captions',
        shortLabel: 'CC',
        timelineKinds: ['caption'],
        timelineBehavior: 'layer',
      },
      {
        id: 'audio',
        label: 'Audio',
        shortLabel: 'Audio',
        timelineKinds: ['audio'],
        timelineBehavior: 'media',
      },
      {
        id: 'templates',
        label: 'Templates',
        shortLabel: 'Templates',
        timelineKinds: ['text', 'motion'],
        timelineBehavior: 'layer',
      },
    ],
  },
  enhance: {
    id: 'enhance',
    label: 'Enhance',
    tools: [
      {
        id: 'motion',
        label: 'Animate / Motion',
        shortLabel: 'Animate',
        timelineKinds: ['motion'],
        timelineBehavior: 'property-or-layer',
      },
      {
        id: 'transitions',
        label: 'Transitions',
        shortLabel: 'Transition',
        timelineKinds: ['transition'],
        timelineBehavior: 'junction',
      },
      {
        id: 'effects',
        label: 'Effects',
        shortLabel: 'Effects',
        timelineKinds: ['effect'],
        timelineBehavior: 'property-or-layer',
      },
      {
        id: 'filters',
        label: 'Filters / Color',
        shortLabel: 'Filters',
        timelineKinds: ['filter'],
        timelineBehavior: 'property-or-layer',
      },
      {
        id: 'adjust',
        label: 'Adjustment Layers',
        shortLabel: 'Adjust',
        timelineKinds: ['adjust'],
        timelineBehavior: 'layer',
      },
    ],
  },
};

export function featureTool(hub: FeatureHubId, id: string): FeatureToolDefinition | undefined {
  return FEATURE_HUBS[hub].tools.find((tool) => tool.id === id);
}
