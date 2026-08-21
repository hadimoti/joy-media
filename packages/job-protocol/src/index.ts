/**
 * @joy-media/job-protocol — VPS/Worker protocol: handshake, job envelopes, leases, events.
 *
 * WP-00.5 state: outbound pairing, capability snapshots, and a local-only
 * thumbnail job lifecycle with progress, cancellation, and retry.
 */
export const PACKAGE_NAME = '@joy-media/job-protocol' as const;

export type {
  WorkerCapability,
  WorkerJobType,
  WorkerJobV1,
  WorkerResultReceiptV1,
  LocalGpuWorkerJobType,
  SpecializedJobType,
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
export {
  WORKER_PROTOCOL_VERSION,
  WORKER_JOB_TYPES,
  LOCAL_GPU_WORKER_CAPABILITIES,
  SPECIALIZED_JOB_TYPES,
  WorkerProtocolError,
  isWorkerJobType,
  requiredCapabilityForJobType,
  validateWorkerJobV1,
  validateWorkerReceiptForJob,
  workerCanRunJob,
  InMemoryWorkerCoordinator,
} from './protocol.js';
export type {
  RenderCapability,
  RenderExportJob,
  RenderExportReceipt,
  RenderInspectJob,
  RenderInspectReceipt,
  RenderJob,
  RenderJobPayload,
  RenderJobType,
  RenderReceipt,
} from './render-jobs.js';
export type { MediaAnalysisJob } from './media-analysis-jobs.js';
export type {
  AgentJobState,
  AgentJobRequest,
  AgentJobResult,
  AgentJobSnapshot,
  AgentJobClient,
} from './agent-jobs.js';
