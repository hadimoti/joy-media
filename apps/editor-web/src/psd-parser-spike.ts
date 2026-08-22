/** @deprecated Use the bounded production PSD import workflow. */
export {
  PsdImportError,
  buildPsdDocumentSnapshot,
  parsePsdFile,
  registerPsdAssets,
} from './psd-import.js';
export type {
  PsdAssetRefs,
  PsdImportErrorCode,
  PsdLayerDto,
  PsdLayerMapping,
  PsdParseResult,
  PsdWarning,
} from './psd-import.js';
