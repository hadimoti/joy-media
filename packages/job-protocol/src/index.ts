/**
 * @joy-media/job-protocol — VPS/Worker protocol: handshake, job envelopes, leases, events.
 *
 * WP-00.5 state: outbound pairing, capability snapshots, and a local-only
 * thumbnail job lifecycle with progress, cancellation, and retry.
 */
export const PACKAGE_NAME = '@joy-media/job-protocol' as const;

export {
  MAX_H264_EXPORT_DIMENSION,
  MAX_H264_EXPORT_PIXELS,
  validateH264ExportDimensions,
} from './export-dimensions.js';
export type { H264ExportDimensionsResult } from './export-dimensions.js';

export type {
  WorkerCapability,
  LocalGpuWorkerJobType,
  SpecializedJobType,
  MaskProvider,
  MaskSelectionMode,
  MaskJobPayload,
  UpscalePreset,
  UpscaleScale,
  UpscaleMemoryMode,
  UpscaleJobPayload,
  WorkerModelState,
  WorkerModelInventoryItem,
  WorkerModelInventory,
  AiJob,
  ThumbnailJobState,
  WorkerHello,
  PairingOffer,
  PairingRequest,
  PairingGrant,
  ThumbnailJob,
  ThumbnailAssignment,
  ThumbnailJobSnapshot,
  WorkerCapabilitySnapshot,
  JobEvent,
} from './protocol.js';
export { QC_FILE_FINDING_TYPES } from './qc.js';
export type {
  MediaQcJobPayload,
  QcFileFindingType,
  QcFinding,
  QcFindingState,
  QcNote,
  QcRange,
  QcReport,
  QcSeverity,
  QcTarget,
  QcTechnicalSummary,
  QcThresholds,
} from './qc.js';
export type {
  GpuPreviewFrameRequest,
  GpuPreviewFrameResponse,
  PreviewQuality,
  PreviewAssetToken,
  GpuPreviewBitmap,
  GpuPreviewSession,
  OpenGpuPreviewSessionInput,
  GpuPreviewRequestGateLimits,
  GpuPreviewAdmission,
} from './preview.js';
export {
  LatestPreviewRequestQueue,
  GpuPreviewSessionBroker,
  GpuPreviewRequestGate,
  validateGpuPreviewFrameRequest,
} from './preview.js';
export {
  WORKER_PROTOCOL_VERSION,
  LOCAL_GPU_WORKER_CAPABILITIES,
  SPECIALIZED_JOB_TYPES,
  WorkerProtocolError,
  InMemoryWorkerCoordinator,
} from './protocol.js';
export type {
  AgentJobState,
  AgentJobRequest,
  AgentJobResult,
  AgentJobSnapshot,
  AgentJobClient,
} from './agent-jobs.js';
