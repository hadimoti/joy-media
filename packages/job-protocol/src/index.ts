/**
 * @joy-media/job-protocol — VPS/Worker protocol: handshake, job envelopes, leases, events.
 *
 * WP-00.5 state: outbound pairing, capability snapshots, and a local-only
 * thumbnail job lifecycle with progress, cancellation, and retry.
 */
export const PACKAGE_NAME = '@joy-media/job-protocol' as const;

export type {
  WorkerCapability,
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
  WorkerProtocolError,
  InMemoryWorkerCoordinator,
} from './protocol.js';
