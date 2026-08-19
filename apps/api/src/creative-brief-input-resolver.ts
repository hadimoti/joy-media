/**
 * Creative Brief Input Resolver - WP-37 S4-F10-E3-A
 *
 * Canonical server-side boundary for resolving Creative Brief input from
 * validated requests and project state. This boundary ensures that only
 * server-resolved, canonical state is used for brief generation.
 *
 * No I/O, persistence, control-plane access, HTTP routes, provider calls,
 * secret handling, environment access, UI, or deployment concerns.
 */

import type {
  CreativeBriefInputV1,
  CreativeBriefRequestV1,
} from '@joy-media/agent-tools';
import type { Actor } from './control-plane.js';
import type { ControlPlane } from './control-plane.js';
import type { ProjectSnapshotService } from './project-snapshot-service.js';
import type { ProjectIntelligenceService, S2IntelligenceResult } from './project-intelligence-service.js';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import { createCreativeBriefInput } from '@joy-media/agent-tools';

// ============================================================================
// Types
// ============================================================================

/**
 * Request shape for the Creative Brief input resolver.
 * Contains only the minimal identifiers and validated request needed to
 * resolve the complete input. This intentionally CANNOT carry any snapshot,
 * intelligence, asset URL, path, credential, provider data, or browser-supplied
 * project state.
 */
export interface CreativeBriefInputResolverRequest {
  /** The project identifier. */
  readonly projectId: string;
  /** The snapshot revision identifier. */
  readonly snapshotRevisionId: string;
  /** The validated creative brief request. */
  readonly request: CreativeBriefRequestV1;
}

/**
 * Server-only resolver context containing the authenticated actor.
 * This is NOT browser-controlled and is only available on the server side.
 */
export interface CreativeBriefInputResolverContext {
  /** The authenticated actor for the current request. */
  readonly actor: Actor;
}

/**
 * Result shape for successful resolution.
 * Returns the complete CreativeBriefInputV1 resolved from canonical server-side state.
 */
export interface CreativeBriefInputResolverSuccess {
  readonly status: 'resolved';
  readonly input: CreativeBriefInputV1;
}

/**
 * Result shape for unavailable resolution.
 * The resolver cannot access the required state.
 */
export interface CreativeBriefInputResolverUnavailable {
  readonly status: 'unavailable';
  readonly code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE';
  readonly message: string;
}

/**
 * Result shape for stale revision resolution.
 * The requested revision does not match the current state.
 */
export interface CreativeBriefInputResolverStaleRevision {
  readonly status: 'stale-revision';
  readonly code: 'CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION';
  readonly message: string;
}

/**
 * All possible resolver result types.
 */
export type CreativeBriefInputResolverResult =
  | CreativeBriefInputResolverSuccess
  | CreativeBriefInputResolverUnavailable
  | CreativeBriefInputResolverStaleRevision;

/**
 * The Creative Brief input resolver interface.
 * Accepts a minimal request and server-only context, returning either a resolved
 * CreativeBriefInputV1 or a typed failure result.
 * Can be implemented synchronously or asynchronously.
 */
export interface CreativeBriefInputResolver {
  resolve(
    request: CreativeBriefInputResolverRequest,
    context: CreativeBriefInputResolverContext,
  ): CreativeBriefInputResolverResult | Promise<CreativeBriefInputResolverResult>;
}

// ============================================================================
// Constants
// ============================================================================

const STALE_REVISION_MESSAGE = 'The requested snapshot revision does not match the current project state' as const;
const UNAVAILABLE_STORE_MESSAGE = 'Project document store is unavailable' as const;
const UNAVAILABLE_INVALID_DOCUMENT_MESSAGE = 'Project document is invalid or cannot be validated as JoyProjectV1' as const;
const UNAVAILABLE_PROJECT_ID_MISMATCH_MESSAGE = 'Project document project ID does not match the request' as const;
const UNAVAILABLE_PROJECTOR_FAILURE_MESSAGE = 'Failed to create semantic snapshot from project document' as const;
const UNAVAILABLE_INTELLIGENCE_FAILURE_MESSAGE = 'Failed to compute semantic intelligence from snapshot' as const;

// ============================================================================
// Real Implementation (Canonical)
// ============================================================================

/**
 * Read-only control plane dependency for document reading.
 * Only exposes the readProjectDocument method to limit blast radius.
 */
export type ControlPlaneReader = Pick<ControlPlane, 'readProjectDocument'>;

/**
 * Options for creating the CanonicalCreativeBriefInputResolver.
 */
export interface CanonicalCreativeBriefInputResolverOptions {
  /**
   * A narrow read-only control plane for reading project documents.
   * Only provides readProjectDocument to ensure no writes are possible.
   */
  readonly controlPlane: ControlPlaneReader;
  /**
   * The project snapshot service for creating S1 snapshots.
   * Pure service with no side effects. Required to ensure no direct projector calls.
   */
  readonly snapshotService: ProjectSnapshotService;
  /**
   * The project intelligence service for computing S2 intelligence.
   * Pure service with no side effects. Required to ensure no direct compute calls.
   */
  readonly intelligenceService: ProjectIntelligenceService;
}

/**
 * Concrete async resolver class that resolves Creative Brief input from canonical
 * server-side state using JoyProjectV1 documents stored in the ControlPlane.
 *
 * This resolver:
 * - Reads JoyProjectV1 from ControlPlaneReader.readProjectDocument
 * - Validates the document is a valid JoyProjectV1 with matching projectId using a type guard
 * - Creates S1 snapshot using injected ProjectSnapshotService
 * - Computes S2 intelligence using injected ProjectIntelligenceService
 * - Builds CreativeBriefInputV1 using canonical createCreativeBriefInput
 * - Never writes documents
 * - Preserves request text byte-for-byte, including Persian/RTL
 * - Maps errors to appropriate typed results
 */
/**
 * Type guard to narrow unknown to JoyProjectV1.
 * Returns true if the value is a valid JoyProjectV1 document.
 */
function isJoyProjectV1(value: unknown): value is JoyProjectV1 {
  return validateJoyProjectV1(value).length === 0;
}

export class CanonicalCreativeBriefInputResolver implements CreativeBriefInputResolver {
  private readonly controlPlane: ControlPlaneReader;
  private readonly snapshotService: ProjectSnapshotService;
  private readonly intelligenceService: ProjectIntelligenceService;

  constructor(options: CanonicalCreativeBriefInputResolverOptions) {
    this.controlPlane = options.controlPlane;
    this.snapshotService = options.snapshotService;
    this.intelligenceService = options.intelligenceService;
  }

  async resolve(
    request: CreativeBriefInputResolverRequest,
    context: CreativeBriefInputResolverContext,
  ): Promise<CreativeBriefInputResolverResult> {
    // Read the project document from the control plane
    const readResult = await this.controlPlane.readProjectDocument(
      context.actor,
      request.projectId,
      request.snapshotRevisionId,
    );

    // Handle read failures
    if (readResult.kind === 'unavailable') {
      return {
        status: 'unavailable',
        code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE',
        message: UNAVAILABLE_STORE_MESSAGE,
      };
    }

    if (readResult.kind === 'not-found') {
      // Map not-found to stale-revision result
      return {
        status: 'stale-revision',
        code: 'CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION',
        message: STALE_REVISION_MESSAGE,
      };
    }

    if (readResult.kind === 'stale-revision') {
      // Map stale-revision to stale-revision result
      return {
        status: 'stale-revision',
        code: 'CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION',
        message: STALE_REVISION_MESSAGE,
      };
    }

    // At this point, readResult.kind === 'ready'
    const document = readResult.record.document;
    const returnedRevisionId = readResult.record.revisionId;
    const returnedProjectId = readResult.record.projectId;

    // Validate that the returned revision matches the request
    if (returnedRevisionId !== request.snapshotRevisionId) {
      return {
        status: 'stale-revision',
        code: 'CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION',
        message: STALE_REVISION_MESSAGE,
      };
    }

    // Validate that the returned project ID matches the request
    if (returnedProjectId !== request.projectId) {
      return {
        status: 'unavailable',
        code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE',
        message: UNAVAILABLE_PROJECT_ID_MISMATCH_MESSAGE,
      };
    }

    // Validate and narrow the document as JoyProjectV1 using type guard
    if (!isJoyProjectV1(document)) {
      return {
        status: 'unavailable',
        code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE',
        message: UNAVAILABLE_INVALID_DOCUMENT_MESSAGE,
      };
    }

    const project = document;

    // Ensure the project's internal ID matches the request
    if (project.id !== request.projectId) {
      return {
        status: 'unavailable',
        code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE',
        message: UNAVAILABLE_PROJECT_ID_MISMATCH_MESSAGE,
      };
    }

    // Create S1 snapshot using the injected service
    let snapshot: Parameters<typeof createCreativeBriefInput>[0];
    try {
      snapshot = this.snapshotService.createSnapshot(project, returnedRevisionId);
    } catch {
      return {
        status: 'unavailable',
        code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE',
        message: UNAVAILABLE_PROJECTOR_FAILURE_MESSAGE,
      };
    }

    // Compute S2 intelligence using the injected service
    let intelligence: S2IntelligenceResult;
    try {
      intelligence = this.intelligenceService.computeIntelligence(snapshot);
    } catch {
      return {
        status: 'unavailable',
        code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE',
        message: UNAVAILABLE_INTELLIGENCE_FAILURE_MESSAGE,
      };
    }

    // Build CreativeBriefInputV1 with canonical createCreativeBriefInput
    // The request text is preserved byte-for-byte from the input request
    const input = createCreativeBriefInput(snapshot, {
      brandReadiness: intelligence.brandReadiness,
      sceneCoverages: intelligence.sceneCoverages,
      projectReadiness: intelligence.projectReadiness,
      rules: intelligence.allRules,
    }, request.request);

    return {
      status: 'resolved',
      input,
    };
  }
}

// ============================================================================
// Default Implementation (Production)
// ============================================================================

/**
 * Production default resolver that always fails closed.
 * Performs no I/O, has no side effects, and does not access any external state.
 */
export const UnavailableCreativeBriefInputResolver: CreativeBriefInputResolver = {
  resolve(_request: CreativeBriefInputResolverRequest, _context: CreativeBriefInputResolverContext): CreativeBriefInputResolverUnavailable {
    return {
      status: 'unavailable',
      code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE',
      message: 'Creative Brief input resolver is unavailable',
    };
  },
};
