/**
 * Persian Editorial (R2 L3).
 *
 * Deliberate identity: native RTL hierarchy and mixed-script typography. The
 * RTL comes from the text and caption templates (`rtl-editorial-title`,
 * `rtl-name-role`, `joy-rtl-classic`) on the deployed Vazirmatn face — the
 * retired commercial-foundry gate stays closed. Motion mirrors the editorial
 * rise but travels
 * from the reading side; `x` offsets are positive (leading edge on the right).
 * Idiomatic Persian typographic quality is owner-gated in the R2 bundle.
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

export const persianEditorial: LookDefinition = {
  schemaVersion: 1,
  id: 'persian-editorial',
  version: 1,
  title: 'Persian Editorial',
  description: 'Right-to-left editorial hierarchy with mixed-script typography.',
  slots: [
    { id: 'headline', label: 'عنوان (Headline)', ownerKind: 'visual-object', required: true },
    { id: 'byline', label: 'نام و نقش (Name / role)', ownerKind: 'visual-object', required: false },
    { id: 'captions', label: 'زیرنویس (Captions)', ownerKind: 'caption-clip', required: false },
  ],
  bindingTargets: [
    keyframeBinding('headline-opacity', 'headline', 'opacity'),
    keyframeBinding('headline-x', 'headline', 'x'),
    keyframeBinding('byline-opacity', 'byline', 'opacity'),
    textTemplateBinding('headline-treatment', 'headline'),
    textTemplateBinding('byline-treatment', 'byline'),
    captionTemplateBinding('caption-treatment', 'captions'),
  ],
  controls: [
    {
      id: 'energy',
      label: 'انرژی (Energy)',
      kind: 'scalar',
      default: 0.35,
      drives: [
        // Positive x: the headline drifts in from the reading (right) side and
        // settles onto the baseline.
        {
          bindingId: 'headline-x',
          min: 0,
          max: 56,
          atFractions: [0, 0.2, 1],
          profile: [1, 0, 0],
          interpolation: 'eased',
        },
      ],
    },
    {
      id: 'entrance',
      label: 'ورود (Entrance)',
      kind: 'enum',
      options: ['fade', 'quick'],
      default: 'fade',
      drives: [
        {
          bindingId: 'headline-opacity',
          byOption: { fade: 0, quick: 0.35 },
          settled: 1,
          atFractions: [0, 0.16],
          profile: [0, 1],
          interpolation: 'eased',
        },
        {
          bindingId: 'byline-opacity',
          byOption: { fade: 0, quick: 0.35 },
          settled: 1,
          atFractions: [0.1, 0.3],
          profile: [0, 1],
          interpolation: 'eased',
        },
      ],
    },
    {
      id: 'treatment',
      label: 'صفحه‌آرایی (Layout)',
      kind: 'color',
      default: 'editorial',
      palettePairs: [
        { id: 'editorial', foreground: '#f8f2e6', background: '#111318' },
        { id: 'quote', foreground: '#f6c453', background: '#111318' },
      ],
      drives: [
        {
          bindingId: 'headline-treatment',
          target: 'text',
          templateByOption: { editorial: 'rtl-editorial-title', quote: 'rtl-quote-focus' },
        },
        {
          bindingId: 'byline-treatment',
          target: 'text',
          templateByOption: { editorial: 'rtl-name-role', quote: 'rtl-name-role' },
        },
      ],
    },
    {
      id: 'caption-style',
      label: 'زیرنویس (Captions)',
      kind: 'enum',
      options: ['rtl-classic', 'clean'],
      default: 'rtl-classic',
      drives: [],
      templateDrives: [
        {
          bindingId: 'caption-treatment',
          target: 'caption',
          templateByOption: { 'rtl-classic': 'joy-rtl-classic', clean: 'joy-clean' },
        },
      ],
    },
  ],
  constraints: constraints(
    { safeMarginPx: 120, maxHeadlineChars: 36, minHoldUs: 1_400_000 },
    { safeMarginPx: 88, maxHeadlineChars: 56, minHoldUs: 1_400_000 },
  ),
  provenance: {
    ...JOY_PROVENANCE,
    notes: 'RTL via Vazirmatn text/caption templates; idiomatic quality owner-gated.',
  },
  requiredOperationKinds: ['motion.setKeyframe', 'text.setTemplate', 'caption.setTemplate'],
  requiredFonts: ['Vazirmatn Variable'],
  verification: [
    structuralCheck('headline-present', 'A bound RTL headline object exists after apply.'),
    structuralCheck('rtl-template', 'The headline treatment resolves to an rtl-* text template.'),
  ],
};
