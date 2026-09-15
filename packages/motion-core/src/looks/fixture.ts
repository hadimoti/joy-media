/** A minimal but complete Look definition for tests. */

import type { LookDefinition } from './types.js';

export function fixtureDefinition(overrides: Partial<LookDefinition> = {}): LookDefinition {
  return {
    schemaVersion: 1,
    id: 'editorial-clean',
    version: 2,
    title: 'Editorial Clean',
    description: 'Restrained hierarchy and clean title rhythm.',
    slots: [
      { id: 'headline', label: 'Headline', ownerKind: 'visual-object', required: true },
      { id: 'deck', label: 'Deck', ownerKind: 'visual-object', required: false },
      { id: 'captions', label: 'Captions', ownerKind: 'caption-clip', required: false },
    ],
    bindingTargets: [
      {
        bindingId: 'headline-opacity',
        channel: 'keyframe',
        ownerSlotId: 'headline',
        ownerKind: 'visual-object',
        propertyId: 'opacity',
        timeDomain: 'composition',
      },
      {
        bindingId: 'headline-scale-x',
        channel: 'keyframe',
        ownerSlotId: 'headline',
        ownerKind: 'visual-object',
        propertyId: 'scaleX',
        timeDomain: 'composition',
      },
      {
        bindingId: 'headline-scale-y',
        channel: 'keyframe',
        ownerSlotId: 'headline',
        ownerKind: 'visual-object',
        propertyId: 'scaleY',
        timeDomain: 'composition',
      },
      {
        bindingId: 'deck-opacity',
        channel: 'keyframe',
        ownerSlotId: 'deck',
        ownerKind: 'visual-object',
        propertyId: 'opacity',
        timeDomain: 'composition',
      },
      {
        bindingId: 'headline-template',
        channel: 'text-template',
        ownerSlotId: 'headline',
        ownerKind: 'visual-object',
        propertyId: 'text-template',
        timeDomain: 'composition',
      },
      {
        bindingId: 'captions-template',
        channel: 'caption-template',
        ownerSlotId: 'captions',
        ownerKind: 'caption-clip',
        propertyId: 'caption-template',
        timeDomain: 'caption-clip-local',
      },
    ],
    controls: [
      {
        id: 'energy',
        label: 'Energy',
        kind: 'scalar',
        default: 0.5,
        drives: [
          {
            bindingId: 'headline-scale-x',
            min: 1,
            max: 1.4,
            atFractions: [0, 0.2, 1],
            interpolation: 'eased',
          },
          {
            bindingId: 'headline-scale-y',
            min: 1,
            max: 1.4,
            atFractions: [0, 0.2, 1],
            interpolation: 'eased',
          },
        ],
      },
      {
        id: 'entrance',
        label: 'Entrance',
        kind: 'enum',
        options: ['fade', 'rise', 'hold'],
        default: 'fade',
        drives: [
          {
            bindingId: 'headline-opacity',
            byOption: { fade: 0, rise: 0.2, hold: 1 },
            atFractions: [0, 0.15],
            interpolation: 'linear',
          },
        ],
      },
      {
        id: 'palette',
        label: 'Palette',
        kind: 'color',
        default: 'ink-on-paper',
        palettePairs: [
          { id: 'ink-on-paper', foreground: '#111111', background: '#fafafa' },
          { id: 'paper-on-ink', foreground: '#fafafa', background: '#111111' },
        ],
        drives: [
          {
            bindingId: 'headline-template',
            target: 'text',
            templateByOption: { 'ink-on-paper': 'clean-title', 'paper-on-ink': 'bold-stack' },
          },
        ],
      },
      {
        id: 'show-deck',
        label: 'Show deck',
        kind: 'boolean',
        default: true,
        drives: [
          {
            bindingId: 'deck-opacity',
            whenTrue: 1,
            whenFalse: 0,
            atFractions: [0, 0.2],
            interpolation: 'linear',
          },
        ],
      },
    ],
    constraints: {
      portrait: { safeMarginPx: 96, maxHeadlineChars: 42, minHoldUs: 500_000 },
      landscape: { safeMarginPx: 64, maxHeadlineChars: 64, minHoldUs: 500_000 },
    },
    provenance: { author: 'JOY', license: 'internal', notes: 'R2 fixture' },
    requiredOperationKinds: ['motion.setKeyframe', 'text.setTemplate'],
    requiredFonts: [],
    verification: [
      { id: 'safe-margins', method: 'structural', summary: 'Headline stays inside safe margins.' },
    ],
    ...overrides,
  };
}
