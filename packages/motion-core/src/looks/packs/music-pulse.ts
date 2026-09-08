/**
 * Music Pulse (R2 L3).
 *
 * Deliberate identity: audio-linked motion with a bounded amplitude and
 * restrained accent cuts.
 *
 * In L3 the operator picks a pulse *rate* (calm / steady / driving) which the
 * compiler expands into that many rest -> peak -> rest cycles across the
 * composition — a real repeating pulse, not two fixed swells. The amplitude is
 * fixed and bounded (the subject only ever reaches 1.12x). "Accent cuts" is a
 * genuine on/off cut pattern: the boolean drive shapes an excursion from the
 * `rest` opacity to full and back on its beat fractions, so turning it off
 * removes the keyframes entirely.
 *
 * L4 replaces the whole slider path with a measured audio envelope
 * (`LookCompileInput.audioBakes`) written to the identical `subject-scale-*`
 * bindings; silence / low confidence yields a flat rest line.
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

export const musicPulse: LookDefinition = {
  schemaVersion: 1,
  id: 'music-pulse',
  version: 1,
  title: 'Music Pulse',
  description: 'Audio-reactive scale and opacity pulse with a bounded amplitude.',
  slots: [
    {
      id: 'subject',
      label: 'Pulsing headline / logotype',
      ownerKind: 'visual-object',
      required: true,
    },
    { id: 'accent', label: 'Accent mark', ownerKind: 'visual-object', required: false },
    { id: 'captions', label: 'Captions', ownerKind: 'caption-clip', required: false },
  ],
  bindingTargets: [
    keyframeBinding('subject-scale-x', 'subject', 'scaleX'),
    keyframeBinding('subject-scale-y', 'subject', 'scaleY'),
    keyframeBinding('accent-opacity', 'accent', 'opacity'),
    textTemplateBinding('subject-treatment', 'subject'),
    captionTemplateBinding('caption-treatment', 'captions'),
  ],
  controls: [
    {
      id: 'rate',
      label: 'Pulse rate',
      kind: 'enum',
      options: ['calm', 'steady', 'driving'],
      default: 'steady',
      drives: [
        // Bounded amplitude: rest 1 -> peak 1.12x. The rate picks how many
        // rest -> peak -> rest cycles the compiler generates across the
        // composition, so a longer clip keeps the same pulse, not a slower one.
        {
          bindingId: 'subject-scale-x',
          byOption: { calm: 1, steady: 1, driving: 1 },
          settled: 1.12,
          periodsByOption: { calm: 2, steady: 4, driving: 6 },
          interpolation: 'eased',
        },
        {
          bindingId: 'subject-scale-y',
          byOption: { calm: 1, steady: 1, driving: 1 },
          settled: 1.12,
          periodsByOption: { calm: 2, steady: 4, driving: 6 },
          interpolation: 'eased',
        },
      ],
    },
    {
      id: 'accent',
      label: 'Accent cuts',
      kind: 'boolean',
      default: false,
      drives: [
        {
          bindingId: 'accent-opacity',
          rest: 0,
          whenTrue: 1,
          whenFalse: 'omit',
          atFractions: [0, 0.1, 0.5, 0.6, 1],
          profile: [0, 1, 0, 1, 0],
          interpolation: 'hold',
        },
      ],
    },
    {
      id: 'subject-treatment',
      label: 'Subject treatment',
      kind: 'color',
      default: 'neon',
      palettePairs: [
        { id: 'neon', foreground: '#b9f6ff', background: '#0a0a12' },
        { id: 'gold', foreground: '#f6c453', background: '#0a0a12' },
      ],
      drives: [
        {
          bindingId: 'subject-treatment',
          target: 'text',
          templateByOption: { neon: 'neon-keyword', gold: 'number-statistic' },
        },
      ],
    },
    {
      id: 'caption-style',
      label: 'Captions',
      kind: 'enum',
      options: ['pop', 'clean'],
      default: 'pop',
      drives: [],
      templateDrives: [
        {
          bindingId: 'caption-treatment',
          target: 'caption',
          templateByOption: { pop: 'joy-karaoke-pop', clean: 'joy-clean' },
        },
      ],
    },
  ],
  constraints: constraints(
    { safeMarginPx: 96, maxHeadlineChars: 28, minHoldUs: 300_000 },
    { safeMarginPx: 64, maxHeadlineChars: 40, minHoldUs: 300_000 },
  ),
  provenance: {
    ...JOY_PROVENANCE,
    notes:
      'L3 rate-driven repeating pulse; L4 wires the real audio envelope onto the same bindings.',
  },
  requiredOperationKinds: ['motion.setKeyframe', 'text.setTemplate', 'caption.setTemplate'],
  requiredFonts: [],
  verification: [
    structuralCheck('amplitude-bounded', 'Subject scale never exceeds the 1.12x pulse ceiling.'),
    structuralCheck(
      'pulse-repeats',
      'The rate control emits at least two full rest -> peak cycles.',
    ),
  ],
};
