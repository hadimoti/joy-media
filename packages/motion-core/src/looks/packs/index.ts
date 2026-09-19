/**
 * The built-in R2 Look packs (L3).
 *
 * R2 ships five. `persian-editorial` was retired (2026-09-08): the app is
 * English-only and carries no Persian design requirement. The standalone
 * `rtl-*` text templates stay available in the template catalogue as ordinary
 * options.
 */

import type { LookDefinition } from '../types.js';
import { editorialClean } from './editorial-clean.js';
import { productPrecision } from './product-precision.js';
import { kineticType } from './kinetic-type.js';
import { quietDocumentary } from './quiet-documentary.js';
import { musicPulse } from './music-pulse.js';

export { editorialClean, productPrecision, kineticType, quietDocumentary, musicPulse };

export const BUILT_IN_LOOK_PACKS: readonly LookDefinition[] = [
  editorialClean,
  productPrecision,
  kineticType,
  quietDocumentary,
  musicPulse,
];
