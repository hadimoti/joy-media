/**
 * Product Precision (R2 L3, timed-callout scope).
 *
 * Deliberate identity: controlled framing with callouts and timed emphasis.
 * R1's vocabulary has no reframe / crop / mask operation, so this pack does
 * not touch the product footage — it drives timed opacity + position emphasis
 * on operator-bound callout, benefit, and CTA objects, held clear of the
 * subject by the `safeMarginPx` constraint. Auto-placed callouts via
 * `text.insertTemplate` are a compiler follow-up (see the R2 bundle).
 */

import type { LookDefinition } from '../types.js';
import {
  JOY_PROVENANCE,
  constraints,
  keyframeBinding,
  structuralCheck,
  textTemplateBinding,
} from './_shared.js';

export const productPrecision: LookDefinition = {
  schemaVersion: 1,
  id: 'product-precision',
  version: 1,
  title: 'Product Precision',
  description: 'Timed callout and CTA emphasis held clear of the product.',
  slots: [
    { id: 'callout', label: 'Callout', ownerKind: 'visual-object', required: true },
    { id: 'benefit', label: 'Benefit line', ownerKind: 'visual-object', required: false },
    { id: 'cta', label: 'Call to action', ownerKind: 'visual-object', required: false },
  ],
  bindingTargets: [
    keyframeBinding('callout-opacity', 'callout', 'opacity'),
    keyframeBinding('callout-x', 'callout', 'x'),
    keyframeBinding('benefit-opacity', 'benefit', 'opacity'),
    keyframeBinding('cta-opacity', 'cta', 'opacity'),
    keyframeBinding('cta-scale-x', 'cta', 'scaleX'),
    keyframeBinding('cta-scale-y', 'cta', 'scaleY'),
    textTemplateBinding('callout-treatment', 'callout'),
    textTemplateBinding('cta-treatment', 'cta'),
  ],
  controls: [
    {
      id: 'emphasis',
      label: 'Emphasis',
      kind: 'scalar',
      default: 0.4,
      drives: [
        // CTA pulse ceiling scales with emphasis but never past 1.1x.
        {
          bindingId: 'cta-scale-x',
          min: 1,
          max: 1.1,
          atFractions: [0.6, 0.7, 0.8],
          profile: [0, 1, 0],
          interpolation: 'eased',
        },
        {
          bindingId: 'cta-scale-y',
          min: 1,
          max: 1.1,
          atFractions: [0.6, 0.7, 0.8],
          profile: [0, 1, 0],
          interpolation: 'eased',
        },
        {
          bindingId: 'callout-x',
          min: 0,
          max: -24,
          atFractions: [0, 0.15],
          profile: [1, 0],
          interpolation: 'eased',
        },
      ],
    },
    {
      id: 'reveal',
      label: 'Reveal',
      kind: 'enum',
      options: ['staged', 'together'],
      default: 'staged',
      drives: [
        // "staged": the benefit line holds hidden until a third of the way in.
        // "together": it is already up with the callout.
        {
          bindingId: 'benefit-opacity',
          byOption: { staged: 0, together: 1 },
          settled: 1,
          atFractions: [0.05, 0.3],
          profile: [0, 1],
          interpolation: 'hold',
        },
      ],
    },
    {
      id: 'reveal-callout',
      label: 'Callout reveal',
      kind: 'scalar',
      default: 1,
      drives: [
        {
          bindingId: 'callout-opacity',
          min: 0,
          max: 1,
          atFractions: [0.05, 0.2],
          profile: [0, 1],
          interpolation: 'eased',
        },
        {
          bindingId: 'cta-opacity',
          min: 0,
          max: 1,
          atFractions: [0.6, 0.72],
          profile: [0, 1],
          interpolation: 'eased',
        },
      ],
    },
    {
      id: 'treatment',
      label: 'Callout treatment',
      kind: 'color',
      default: 'accent',
      palettePairs: [
        { id: 'accent', foreground: '#f6c453', background: '#0b0d12' },
        { id: 'stat', foreground: '#fff4c9', background: '#0b0d12' },
      ],
      drives: [
        {
          bindingId: 'callout-treatment',
          target: 'text',
          templateByOption: { accent: 'accent-lower-third', stat: 'number-statistic' },
        },
        {
          bindingId: 'cta-treatment',
          target: 'text',
          templateByOption: { accent: 'cta-punch', stat: 'cta-punch' },
        },
      ],
    },
  ],
  constraints: constraints(
    { safeMarginPx: 128, maxHeadlineChars: 30, minHoldUs: 700_000 },
    { safeMarginPx: 96, maxHeadlineChars: 46, minHoldUs: 700_000 },
  ),
  provenance: {
    ...JOY_PROVENANCE,
    notes: 'Emphasis on operator-bound callouts; no footage reframing.',
  },
  requiredOperationKinds: ['motion.setKeyframe', 'text.setTemplate'],
  requiredFonts: [],
  verification: [
    structuralCheck('callout-present', 'A bound callout object exists after apply.'),
    structuralCheck('cta-pulse-bounded', 'CTA scale never exceeds the 1.1x emphasis ceiling.'),
  ],
};
