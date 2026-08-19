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
 */
export interface CreativeBriefInputResolver {
  resolve(
    request: CreativeBriefInputResolverRequest,
    context: CreativeBriefInputResolverContext,
  ): CreativeBriefInputResolverResult;
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
