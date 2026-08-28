import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';
import { upsertControlPlaneProjectBinding } from './project-control-plane.js';

/**
 * Transport for creative brief opt-in state coordination.
 * Returns the current opt-in state and lifecycle revision from the control plane.
 */
export type CreativeBriefOptInTransport = (
  controlPlaneProjectId: string,
  enabled: boolean,
  baseRevision: number,
) => Promise<{ creativeBriefOptIn: boolean; revision: number }>;

/**
 * Result type for successful opt-in coordination.
 */
export interface CreativeBriefOptInSuccess {
  readonly kind: 'success';
  readonly previousRevision: number;
  readonly newRevision: number;
}

/**
 * Result type for opt-in state mismatch.
 * The transport returned a state that doesn't match the requested enabled state.
 */
export interface CreativeBriefOptInMismatch {
  readonly kind: 'mismatch';
  readonly expectedOptIn: boolean;
  readonly actualOptIn: boolean;
  readonly responseRevision: number;
}

/**
 * Result type for invalid revision in the response.
 */
export interface CreativeBriefOptInInvalidRevision {
  readonly kind: 'invalid-revision';
  readonly revision: unknown;
}

/**
 * Result type for transport failures.
 */
export interface CreativeBriefOptInTransportFailure {
  readonly kind: 'transport-failure';
  readonly error: unknown;
}

/**
 * Union of all possible opt-in coordination outcomes.
 */
export type CreativeBriefOptInResult =
  | CreativeBriefOptInSuccess
  | CreativeBriefOptInMismatch
  | CreativeBriefOptInInvalidRevision
  | CreativeBriefOptInTransportFailure;

/**
 * Options for the creative brief opt-in coordinator.
 */
export interface CreativeBriefOptInCoordinationOptions {
  /** Owner key for the binding (default: 'local'). */
  readonly ownerKey?: string;
}

/**
 * Coordinates client-side creative brief opt-in state with the control plane.
 *
 * 1. Uses `binding.revision ?? 0` as the base revision for CAS validation.
 * 2. Calls the injected transport exactly once with the opaque control-plane ID.
 * 3. On matching successful response (response.creativeBriefOptIn === enabled),
 *    persists the same binding (with input fields unchanged) but with the returned
 *    revision using the supplied ownerKey.
 * 4. Rejects response mismatches (creativeBriefOptIn !== enabled) or invalid
 *    revisions with a typed result and does NOT persist.
 * 5. Maps transport errors to a typed failure and does NOT persist.
 * 6. Never mutates the input binding.
 *
 * This is a pure coordinator: it does NOT mount UI, modify API contracts,
 * or change server code.
 */
export function coordinateCreativeBriefOptIn(
  binding: ControlPlaneProjectBinding,
  enabled: boolean,
  storage: BrowserKeyValueStore,
  transport: CreativeBriefOptInTransport,
  options: CreativeBriefOptInCoordinationOptions = {},
): Promise<CreativeBriefOptInResult> {
  const ownerKey = options.ownerKey ?? 'local';
  const baseRevision = binding.revision ?? 0;

  // Never mutate the input binding
  return transport(binding.controlPlaneProjectId, enabled, baseRevision)
    .then((response) => {
      // Validate the revision is a valid number
      if (
        typeof response.revision !== 'number' ||
        !Number.isInteger(response.revision) ||
        response.revision < 0
      ) {
        return {
          kind: 'invalid-revision',
          revision: response.revision,
        } satisfies CreativeBriefOptInInvalidRevision;
      }

      // Check if the response opt-in state matches the requested state
      if (response.creativeBriefOptIn !== enabled) {
        return {
          kind: 'mismatch',
          expectedOptIn: enabled,
          actualOptIn: response.creativeBriefOptIn,
          responseRevision: response.revision,
        } satisfies CreativeBriefOptInMismatch;
      }

      // On match, persist with the new revision
      upsertControlPlaneProjectBinding(
        storage,
        { ...binding, revision: response.revision },
        ownerKey,
      );

      return {
        kind: 'success',
        previousRevision: baseRevision,
        newRevision: response.revision,
      } satisfies CreativeBriefOptInSuccess;
    })
    .catch((error: unknown) => {
      return {
        kind: 'transport-failure',
        error,
      } satisfies CreativeBriefOptInTransportFailure;
    });
}
