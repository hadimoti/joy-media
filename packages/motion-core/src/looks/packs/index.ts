/**
 * The built-in R2 Look packs (L3).
 *
 * R2 ships four. `music-pulse` is authored and kept exported (with its own
 * validation / compile coverage in `music-pulse.test.ts`) but is held out of
 * the shipping set for R2.1: its "Accent cuts" toggle compiles to a
 * permanent-on track and the slider-only pulse is rate-less. Re-add it to
 * `BUILT_IN_LOOK_PACKS` once the compiler grows a real rate control.
 *
 * `persian-editorial` was retired (2026-09-08): the app is English-only and
 * carries no Persian design requirement. The standalone `rtl-*` text templates
 * stay available in the template catalogue as ordinary options.
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
];

/** Authored but held out of the R2 shipping set (see the note above). */
export const HELD_LOOK_PACKS: readonly LookDefinition[] = [musicPulse];
