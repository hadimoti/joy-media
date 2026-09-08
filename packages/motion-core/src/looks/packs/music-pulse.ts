/**
 * Music Pulse (R2 L3) — HELD FOR R2.1, not in `BUILT_IN_LOOK_PACKS`.
 *
 * Deliberate identity: audio-linked motion with bounded amplitude and
 * restrained accent cuts. In L3 the pulse rate and depth are operator sliders;
 * L4 replaces the operator value with a measured audio envelope written to the
 * identical binding targets. Silent audio yields a stable output because the
 * L3 default depth is small and L4's silence path is a constant curve.
 *
 * Held out of the R2 shipping set (owner-delegated taste review, 2026-09-08):
 * the "Accent cuts" toggle compiles to a permanent-on track rather than a
 * beat-gated one, and the slider-only fallback has no rate control so it emits
 * only two swells per composition regardless of length. Re-ships in R2.1 once
 * the compiler grows a real rate control and a beat-gated boolean drive.
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
    { id: 'subject', label: 'Pulsing subject', ownerKind: 'visual-object', required: true },
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
      id: 'depth',
      label: 'Pulse depth',
      kind: 'scalar',
      default: 0.3,
      drives: [
        // Bounded amplitude: even at depth 1 the subject only reaches 1.12x.
        {
          bindingId: 'subject-scale-x',
          min: 1,
          max: 1.12,
          atFractions: [0, 0.25, 0.5, 0.75, 1],
          profile: [0, 1, 0, 1, 0],
          interpolation: 'eased',
        },
        {
          bindingId: 'subject-scale-y',
          min: 1,
          max: 1.12,
          atFractions: [0, 0.25, 0.5, 0.75, 1],
          profile: [0, 1, 0, 1, 0],
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
  provenance: { ...JOY_PROVENANCE, notes: 'L3 slider-driven; L4 wires the real audio envelope.' },
  requiredOperationKinds: ['motion.setKeyframe', 'text.setTemplate', 'caption.setTemplate'],
  requiredFonts: [],
  verification: [
    structuralCheck('amplitude-bounded', 'Subject scale never exceeds the 1.12x pulse ceiling.'),
    structuralCheck('silent-stable', 'A zero-depth compile writes a flat curve.'),
  ],
};
