/**
 * Kinetic Type (R2 L3, phrase-scoped).
 *
 * Deliberate identity: phrase-led typography with a distinct entrance, hold,
 * and exit. `motion.setKeyframe` binds a whole visual object, never a text run,
 * so the operator binds up to three phrase objects and each gets its own
 * staggered entrance/hold/exit on opacity + scaleX/scaleY + y. Per-word
 * animation and object creation are a compiler follow-up (see the R2 bundle).
 */

import type { LookDefinition } from '../types.js';
import {
  JOY_PROVENANCE,
  constraints,
  keyframeBinding,
  structuralCheck,
  textTemplateBinding,
} from './_shared.js';

const phrase = (n: 1 | 2 | 3) => {
  const slot = `phrase-${n}`;
  const stagger = [0, 0.12, 0.24][n - 1]!;
  return {
    bindings: [
      keyframeBinding(`${slot}-opacity`, slot, 'opacity'),
      keyframeBinding(`${slot}-scale-x`, slot, 'scaleX'),
      keyframeBinding(`${slot}-scale-y`, slot, 'scaleY'),
      keyframeBinding(`${slot}-y`, slot, 'y'),
    ],
    energyDrives: [
      {
        bindingId: `${slot}-scale-x`,
        min: 0.9,
        max: 0.6,
        atFractions: [stagger, stagger + 0.08, stagger + 0.16],
        interpolation: 'eased' as const,
      },
      {
        bindingId: `${slot}-scale-y`,
        min: 0.9,
        max: 0.6,
        atFractions: [stagger, stagger + 0.08, stagger + 0.16],
        interpolation: 'eased' as const,
      },
      {
        bindingId: `${slot}-y`,
        min: 0,
        max: 64,
        atFractions: [stagger, stagger + 0.1],
        interpolation: 'eased' as const,
      },
    ],
    entranceDrives: {
      bindingId: `${slot}-opacity`,
      byOption: { snap: 0, soft: 0.3, hold: 1 },
      atFractions: [stagger, stagger + 0.06],
      interpolation: 'eased' as const,
    },
  };
};

const p1 = phrase(1);
const p2 = phrase(2);
const p3 = phrase(3);

export const kineticType: LookDefinition = {
  schemaVersion: 1,
  id: 'kinetic-type',
  version: 1,
  title: 'Kinetic Type',
  description: 'Phrase-led typography with staggered entrance, hold, and exit.',
  slots: [
    { id: 'phrase-1', label: 'Phrase 1', ownerKind: 'visual-object', required: true },
    { id: 'phrase-2', label: 'Phrase 2', ownerKind: 'visual-object', required: false },
    { id: 'phrase-3', label: 'Phrase 3', ownerKind: 'visual-object', required: false },
  ],
  bindingTargets: [
    ...p1.bindings,
    ...p2.bindings,
    ...p3.bindings,
    textTemplateBinding('phrase-1-treatment', 'phrase-1'),
  ],
  controls: [
    {
      id: 'energy',
      label: 'Energy',
      kind: 'scalar',
      default: 0.6,
      drives: [...p1.energyDrives, ...p2.energyDrives, ...p3.energyDrives],
    },
    {
      id: 'entrance',
      label: 'Entrance',
      kind: 'enum',
      options: ['snap', 'soft', 'hold'],
      default: 'snap',
      drives: [p1.entranceDrives, p2.entranceDrives, p3.entranceDrives],
    },
    {
      id: 'treatment',
      label: 'Phrase treatment',
      kind: 'color',
      default: 'impact',
      palettePairs: [
        { id: 'impact', foreground: '#111318', background: '#f6c453' },
        { id: 'stack', foreground: '#f5f0e8', background: '#111318' },
      ],
      drives: [
        {
          bindingId: 'phrase-1-treatment',
          target: 'text',
          templateByOption: { impact: 'outline-impact', stack: 'bold-stack' },
        },
      ],
    },
  ],
  constraints: constraints(
    { safeMarginPx: 88, maxHeadlineChars: 22, minHoldUs: 450_000 },
    { safeMarginPx: 60, maxHeadlineChars: 34, minHoldUs: 450_000 },
  ),
  provenance: {
    ...JOY_PROVENANCE,
    notes: 'Phrase objects are operator-bound; per-word + insert are a follow-up.',
  },
  requiredOperationKinds: ['motion.setKeyframe', 'text.setTemplate'],
  requiredFonts: [],
  verification: [
    structuralCheck('phrase-1-present', 'The first phrase object is bound after apply.'),
    structuralCheck('holds-respect-min', 'Every phrase hold spans at least minHoldUs.'),
  ],
};
