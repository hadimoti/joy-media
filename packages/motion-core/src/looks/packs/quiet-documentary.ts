/**
 * Quiet Documentary (R2 L3).
 *
 * Deliberate identity: minimal lower thirds, gentle fades, listening space.
 * Opacity-only motion — deliberately no scale or position travel — with long
 * holds gated by a large `minHoldUs`. No invented speaker identity; the
 * operator binds a real name/role object.
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

export const quietDocumentary: LookDefinition = {
  schemaVersion: 1,
  id: 'quiet-documentary',
  version: 1,
  title: 'Quiet Documentary',
  description: 'Minimal lower thirds and gentle fades with plenty of listening space.',
  slots: [
    { id: 'lower-third', label: 'Name / role', ownerKind: 'visual-object', required: true },
    { id: 'title', label: 'Title card', ownerKind: 'visual-object', required: false },
    { id: 'captions', label: 'Captions', ownerKind: 'caption-clip', required: false },
  ],
  bindingTargets: [
    keyframeBinding('lower-third-opacity', 'lower-third', 'opacity'),
    keyframeBinding('title-opacity', 'title', 'opacity'),
    textTemplateBinding('lower-third-treatment', 'lower-third'),
    captionTemplateBinding('caption-treatment', 'captions'),
  ],
  controls: [
    {
      id: 'reveal',
      label: 'Reveal',
      kind: 'scalar',
      // Defaults to fully revealed — the required lower third must be legible.
      // Lower values hold it more transparent for an even quieter treatment;
      // the "gentle" identity is the eased profile + long holds, not a dim
      // endpoint.
      default: 1,
      drives: [
        // A slow, soft eased fade in. The profile shapes the approach; the
        // operator value sets how far it settles (1 = full opacity).
        {
          bindingId: 'lower-third-opacity',
          min: 0,
          max: 1,
          atFractions: [0, 0.18, 0.4],
          profile: [0, 0.55, 1],
          interpolation: 'eased',
        },
        {
          bindingId: 'title-opacity',
          min: 0,
          max: 1,
          atFractions: [0, 0.22, 0.5],
          profile: [0, 0.55, 1],
          interpolation: 'eased',
        },
      ],
    },
    {
      id: 'lower-third-treatment',
      label: 'Lower third',
      kind: 'color',
      default: 'name-role',
      palettePairs: [
        { id: 'name-role', foreground: '#f8f2e6', background: '#0c0d10' },
        { id: 'accent', foreground: '#f6c453', background: '#0c0d10' },
      ],
      drives: [
        {
          bindingId: 'lower-third-treatment',
          target: 'text',
          templateByOption: { 'name-role': 'name-role', accent: 'accent-lower-third' },
        },
      ],
    },
    {
      id: 'caption-style',
      label: 'Captions',
      kind: 'enum',
      options: ['clean', 'rtl-classic'],
      default: 'clean',
      drives: [],
      templateDrives: [
        {
          bindingId: 'caption-treatment',
          target: 'caption',
          templateByOption: { clean: 'joy-clean', 'rtl-classic': 'joy-rtl-classic' },
        },
      ],
    },
  ],
  constraints: constraints(
    { safeMarginPx: 120, maxHeadlineChars: 44, minHoldUs: 2_500_000 },
    { safeMarginPx: 88, maxHeadlineChars: 68, minHoldUs: 2_500_000 },
  ),
  provenance: { ...JOY_PROVENANCE, notes: 'Opacity-only, long holds, listening space.' },
  requiredOperationKinds: ['motion.setKeyframe', 'text.setTemplate', 'caption.setTemplate'],
  requiredFonts: [],
  verification: [
    structuralCheck('lower-third-present', 'A bound lower-third object exists after apply.'),
    structuralCheck('no-position-motion', 'No x/y/scale keyframes are written — opacity only.'),
  ],
};
