import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';
import type { CreativeBriefRequestV1, CreativeBriefV1 } from '@joy-media/agent-tools';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';
import type { SyncProjectDocument } from './project-document-sync.js';
import { coordinateCreativeBriefRequest } from './creative-brief-request-coordinator.js';
import type { CreativeBriefTransport } from './creative-brief-request-coordinator.js';

/**
 * Runner error for blank input - no network calls made.
 */
export interface CreativeBriefRunnerBlankInputError {
  readonly kind: 'blank-input';
  readonly reason: 'Input is blank after trimming';
}

/**
 * Runner error for parity failure from coordination.
 * Wraps the original coordination parity failure result.
 */
export interface CreativeBriefRunnerParityError {
  readonly kind: 'parity-failure';
  readonly reason: 'projectId-mismatch' | 'snapshotRevisionId-mismatch';
  readonly expectedProjectId: string;
  readonly actualProjectId: string;
  readonly expectedSnapshotRevisionId: ProjectRevisionId;
  readonly actualSnapshotRevisionId: ProjectRevisionId;
}

/**
 * Runner error for stale document from coordination.
 * Wraps the original coordination stale result.
 */
export interface CreativeBriefRunnerStaleError {
  readonly kind: 'stale';
  readonly message: string;
}

/**
 * Runner error for sync failure from coordination.
 * Wraps the original coordination sync failure result.
 */
export interface CreativeBriefRunnerSyncError {
  readonly kind: 'sync-failure';
  readonly error: unknown;
}

/**
 * Runner error for brief failure from coordination.
 * Wraps the original coordination brief failure result.
 */
export interface CreativeBriefRunnerBriefError {
  readonly kind: 'brief-failure';
  readonly error: unknown;
}

/**
 * Result type for the creative brief panel runner.
 * Either a successful CreativeBriefV1 or a typed error.
 */
export type CreativeBriefRunnerResult =
  | { readonly kind: 'success'; readonly brief: CreativeBriefV1 }
  | CreativeBriefRunnerBlankInputError
  | CreativeBriefRunnerParityError
  | CreativeBriefRunnerStaleError
  | CreativeBriefRunnerSyncError
  | CreativeBriefRunnerBriefError;

/**
 * Union type of all creative brief runner errors.
 */
export type CreativeBriefRunnerError =
  | CreativeBriefRunnerBlankInputError
  | CreativeBriefRunnerParityError
  | CreativeBriefRunnerStaleError
  | CreativeBriefRunnerSyncError
  | CreativeBriefRunnerBriefError;

/**
 * Error class for creative brief panel runner failures.
 * Wraps typed error details while preserving the Error interface.
 */
export class CreativeBriefPanelRunnerError extends Error {
  readonly details: CreativeBriefRunnerError;

  constructor(details: CreativeBriefRunnerError) {
    super(`Creative brief panel runner error: ${details.kind}`);
    this.name = 'CreativeBriefPanelRunnerError';
    this.details = details;
  }
}

/**
 * Request factory type injected into the runner options.
 * Takes trimmed text, projectId, and revisionId, returns a CreativeBriefRequestV1.
 */
export type CreativeBriefRequestFactory = (
  trimmedText: string,
  projectId: string,
  revisionId: ProjectRevisionId,
) => CreativeBriefRequestV1;

/**
 * Options for creating a CreativeBriefPanel runner.
 */
export interface CreateCreativeBriefPanelRunnerOptions {
  readonly controlPlaneProjectBinding: ControlPlaneProjectBinding;
  readonly joyProject: JoyProjectV1;
  readonly projectRevisionId: ProjectRevisionId;
  readonly browserKeyValueStore: BrowserKeyValueStore;
  readonly syncProjectDocument: SyncProjectDocument;
  readonly creativeBriefTransport: CreativeBriefTransport;
  readonly requestFactory: CreativeBriefRequestFactory;
  readonly ownerKey?: string;
}

/**
 * Creates a creative brief panel runner function.
 *
 * The returned function accepts request text and returns a Promise of CreativeBriefV1
 * for successful results. For failures, it throws a typed CreativeBriefRunnerResult
 * that preserves the original error information.
 *
 * Behavior:
 * 1. Trims input; blank text fails locally with no network calls.
 * 2. Builds the request only through the injected request factory.
 * 3. Delegates to coordinateCreativeBriefRequest for sync-then-brief coordination.
 * 4. Returns the brief only for a successful coordination result.
 * 5. Converts parity, stale, sync, and brief failures into typed runner errors
 *    without losing the original result information.
 * 6. Preserves project/revision identity and never mutates inputs.
 *
 * This is a pure adapter: it does NOT mount UI, change React components, API routes,
 * providers, runtime wiring, or deployment.
 */
export function createCreativeBriefPanelRunner(
  options: CreateCreativeBriefPanelRunnerOptions,
): (requestText: string) => Promise<CreativeBriefV1> {
  const {
    controlPlaneProjectBinding,
    joyProject,
    projectRevisionId,
    browserKeyValueStore,
    syncProjectDocument,
    creativeBriefTransport,
    requestFactory,
    ownerKey,
  } = options;

  return async (requestText: string): Promise<CreativeBriefV1> => {
    // 1. Trim input; blank text fails locally with no network calls
    const trimmedText = requestText.trim();
    if (trimmedText === '') {
      const error: CreativeBriefRunnerBlankInputError = {
        kind: 'blank-input',
        reason: 'Input is blank after trimming',
      };
      throw new CreativeBriefPanelRunnerError(error);
    }

    // 2. Build the request only through the injected request factory
    const request: CreativeBriefRequestV1 = requestFactory(
      trimmedText,
      joyProject.id,
      projectRevisionId,
    );

    // 3. Delegate to coordinateCreativeBriefRequest
    const coordinationResult = await coordinateCreativeBriefRequest(
      controlPlaneProjectBinding,
      joyProject,
      projectRevisionId,
      request,
      browserKeyValueStore,
      syncProjectDocument,
      creativeBriefTransport,
      { ownerKey },
    );

    // 4. Return the brief only for a successful coordination result
    if (coordinationResult.kind === 'success') {
      return coordinationResult.brief;
    }

    // 5. Convert failures into typed runner errors without losing original info
    switch (coordinationResult.kind) {
      case 'parity-failure': {
        const error: CreativeBriefRunnerParityError = {
          kind: 'parity-failure',
          reason: coordinationResult.reason,
          expectedProjectId: coordinationResult.expectedProjectId,
          actualProjectId: coordinationResult.actualProjectId,
          expectedSnapshotRevisionId: coordinationResult.expectedSnapshotRevisionId,
          actualSnapshotRevisionId: coordinationResult.actualSnapshotRevisionId,
        };
        throw new CreativeBriefPanelRunnerError(error);
      }

      case 'stale': {
        const error: CreativeBriefRunnerStaleError = {
          kind: 'stale',
          message: coordinationResult.syncConflict.message,
        };
        throw new CreativeBriefPanelRunnerError(error);
      }

      case 'sync-failure': {
        const error: CreativeBriefRunnerSyncError = {
          kind: 'sync-failure',
          error: coordinationResult.syncResult.error,
        };
        throw new CreativeBriefPanelRunnerError(error);
      }

      case 'brief-failure': {
        const error: CreativeBriefRunnerBriefError = {
          kind: 'brief-failure',
          error: coordinationResult.error,
        };
        throw new CreativeBriefPanelRunnerError(error);
      }

      default: {
        // This should never happen, but we handle it for type safety
        const error: CreativeBriefRunnerBriefError = {
          kind: 'brief-failure',
          error: new Error(`Unknown coordination result kind: ${coordinationResult as never}`),
        };
        throw new CreativeBriefPanelRunnerError(error);
      }
    }
  };
}
