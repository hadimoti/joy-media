/** The six built-in R2 Look packs (L3). */

import type { LookDefinition } from '../types.js';
import { editorialClean } from './editorial-clean.js';
import { productPrecision } from './product-precision.js';
import { kineticType } from './kinetic-type.js';
import { quietDocumentary } from './quiet-documentary.js';
import { musicPulse } from './music-pulse.js';
import { persianEditorial } from './persian-editorial.js';

export {
  editorialClean,
  productPrecision,
  kineticType,
  quietDocumentary,
  musicPulse,
  persianEditorial,
};

export const BUILT_IN_LOOK_PACKS: readonly LookDefinition[] = [
  editorialClean,
  productPrecision,
  kineticType,
  quietDocumentary,
  musicPulse,
  persianEditorial,
];
