/**
 * Browser-safe production quality contract helpers.
 *
 * Keep filesystem/ffmpeg inspection behind the package root entrypoint. The
 * editor only needs the deterministic manifest contract and must never pull
 * the Node inspection implementation into its browser bundle.
 */
export type {
  DeliveryManifestLike,
  DeliveryPromiseV1,
  QualityFindingV1,
  QualityStatus,
  RenderFactsV1,
  RenderReportV1,
} from './types.js';
export { assertApiSafeRenderReport, deliveryPromiseFromManifest, reportSummary } from './types.js';
