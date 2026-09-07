/**
 * Editorial Clean (R2 L3).
 *
 * Deliberate identity: restrained hierarchy and alignment, a clean title /
 * subtitle rhythm. Motion is minimal — a gentle eased fade-up on the headline
 * and deck, no scale bounce. Hierarchy comes from the text template, not from
 * exaggerated animation.
 */

import type { LookDefinition } from '../types.js';
import {
  JOY_PROVENANCE,
  captionTemplateBinding,
  constraints,
  keyframeBinding,
  structuralCheck,
  textTemplateBinding,
} from './_shared.js';

export const editorialClean: LookDefinition = {
  schemaVersion: 1,
  id: 'editorial-clean',
  version: 1,
  title: 'Editorial Clean',
  description: 'Restrained hierarchy with a clean title and subtitle rhythm.',
  slots: [
    { id: 'headline', label: 'Headline', ownerKind: 'visual-object', required: true },
    { id: 'deck', label: 'Deck / subtitle', ownerKind: 'visual-object', required: false },
    { id: 'captions', label: 'Captions', ownerKind: 'caption-clip', required: false },
  ],
  bindingTargets: [
    keyframeBinding('headline-opacity', 'headline', 'opacity'),
    keyframeBinding('headline-y', 'headline', 'y'),
    keyframeBinding('deck-opacity', 'deck', 'opacity'),
    keyframeBinding('deck-y', 'deck', 'y'),
    textTemplateBinding('headline-treatment', 'headline'),
    captionTemplateBinding('caption-treatment', 'captions'),
  ],
  controls: [
    {
      id: 'energy',
      label: 'Energy',
      kind: 'scalar',
      default: 0.35,
      drives: [
        // A low, tasteful rise: start lifted below the resting line, settle to
        // it. Higher Energy = a bigger lift to travel through.
        {
          bindingId: 'headline-y',
          min: 0,
          max: -48,
          atFractions: [0, 0.18, 1],
          profile: [1, 0, 0],
          interpolation: 'eased',
        },
        {
          bindingId: 'deck-y',
          min: 0,
          max: -36,
          atFractions: [0, 0.24, 1],
          profile: [1, 0, 0],
          interpolation: 'eased',
        },
      ],
    },
    {
      id: 'entrance',
      label: 'Entrance',
      kind: 'enum',
      options: ['fade', 'quick', 'hold'],
      default: 'fade',
      drives: [
        {
          bindingId: 'headline-opacity',
          byOption: { fade: 0, quick: 0.35, hold: 1 },
          settled: 1,
          atFractions: [0, 0.16],
          profile: [0, 1],
          interpolation: 'eased',
        },
        {
          bindingId: 'deck-opacity',
          byOption: { fade: 0, quick: 0.35, hold: 1 },
          settled: 1,
          atFractions: [0.08, 0.28],
          profile: [0, 1],
          interpolation: 'eased',
        },
      ],
    },
    {
      id: 'hierarchy',
      label: 'Headline treatment',
      kind: 'color',
      default: 'clean',
      palettePairs: [
        { id: 'clean', foreground: '#f8f2e6', background: '#111318' },
        { id: 'stacked', foreground: '#f5f0e8', background: '#111318' },
        { id: 'gradient', foreground: '#f6c453', background: '#111318' },
      ],
      drives: [
        {
          bindingId: 'headline-treatment',
          target: 'text',
          templateByOption: {
            clean: 'clean-title',
            stacked: 'bold-stack',
            gradient: 'gradient-headline',
          },
        },
      ],
    },
    {
      id: 'caption-style',
      label: 'Caption style',
      kind: 'enum',
      options: ['clean', 'karaoke'],
      default: 'clean',
      drives: [],
      templateDrives: [
        {
          bindingId: 'caption-treatment',
          target: 'caption',
          templateByOption: { clean: 'joy-clean', karaoke: 'joy-karaoke-pop' },
        },
      ],
    },
  ],
  constraints: constraints(
    { safeMarginPx: 104, maxHeadlineChars: 40, minHoldUs: 1_200_000 },
    { safeMarginPx: 72, maxHeadlineChars: 64, minHoldUs: 1_200_000 },
  ),
  provenance: { ...JOY_PROVENANCE, notes: 'Motion-minimal editorial hierarchy.' },
  requiredOperationKinds: ['motion.setKeyframe', 'text.setTemplate', 'caption.setTemplate'],
  requiredFonts: [],
  verification: [
    structuralCheck('headline-present', 'A bound headline object exists after apply.'),
    structuralCheck('rise-bounded', 'Headline travel stays within the eased rise range.'),
  ],
};
