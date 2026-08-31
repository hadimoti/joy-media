/**
 * Creative Brief UI State Controller - WP-37 S4-C
 *
 * Pure, in-memory reducer/state machine for Creative Brief UI state.
 * No React hooks, no localStorage, no network, no model calls, no providers,
 * no commands, no approvals, no jobs, no mutations.
 */

import type { CreativeBriefV1, ProjectRevisionId } from '@joy-media/agent-tools';

// ==========================================================================
// State Types
// ==========================================================================

/**
 * State when no brief is being requested or displayed.
 */
export interface CreativeBriefIdleState {
  readonly type: 'idle';
}

/**
 * State when a brief request is in progress.
 * Stores the request and revision for potential retry.
 */
export interface CreativeBriefCollectingState {
  readonly type: 'collecting';
  readonly request: string;
  readonly revisionId: ProjectRevisionId;
  readonly projectId: string;
}

/**
 * State when a valid Creative Brief is ready for display.
 */
export interface CreativeBriefReadyState {
  readonly type: 'brief-ready';
  readonly brief: CreativeBriefV1;
  readonly revisionId: ProjectRevisionId;
}

/**
 * State when the brief cannot be generated (e.g., missing production adapter).
 */
export interface CreativeBriefUnavailableState {
  readonly type: 'unavailable';
  readonly reason: string;
}

/**
 * State when an error occurred during brief generation.
 */
export interface CreativeBriefErrorState {
  readonly type: 'error';
  readonly error: string;
}

/**
 * State when the current brief is stale (revision changed).
 */
export interface CreativeBriefStaleState {
  readonly type: 'stale';
  readonly brief: CreativeBriefV1;
  readonly revisionId: ProjectRevisionId;
  readonly currentRevisionId: ProjectRevisionId;
}

/**
 * Union type of all possible Creative Brief UI states.
 */
export type CreativeBriefState =
  | CreativeBriefIdleState
  | CreativeBriefCollectingState
  | CreativeBriefReadyState
  | CreativeBriefUnavailableState
  | CreativeBriefErrorState
  | CreativeBriefStaleState;

// ==========================================================================
// Event Types
// ==========================================================================

/**
 * Event to start collecting a creative brief.
 */
export interface BriefCollectStartEvent {
  readonly type: 'collect-start';
  readonly request: string;
  readonly revisionId: ProjectRevisionId;
  readonly projectId: string;
}

/**
 * Event when brief collection succeeds.
 */
export interface BriefCollectSuccessEvent {
  readonly type: 'collect-success';
  readonly brief: CreativeBriefV1;
  readonly revisionId: ProjectRevisionId;
}

/**
 * Event when brief collection fails due to unavailability (e.g., missing adapter).
 */
export interface BriefCollectUnavailableEvent {
  readonly type: 'collect-unavailable';
  readonly reason: string;
}

/**
 * Event when brief collection fails with an error.
 */
export interface BriefCollectErrorEvent {
  readonly type: 'collect-error';
  readonly error: string;
}

/**
 * Event when the project revision changes.
 */
export interface BriefRevisionChangeEvent {
  readonly type: 'revision-change';
  readonly newRevisionId: ProjectRevisionId;
}

/**
 * Event to reset the state to idle.
 */
export interface BriefResetEvent {
  readonly type: 'reset';
}

/**
 * Event to retry brief collection (from stale/error/unavailable).
 * Same as collect-start but used for retry semantics.
 */
export interface BriefRetryEvent {
  readonly type: 'retry';
  readonly request: string;
  readonly revisionId: ProjectRevisionId;
  readonly projectId: string;
}

export interface BriefHydrateEvent {
  readonly type: 'hydrate';
  readonly brief: CreativeBriefV1;
  readonly revisionId: ProjectRevisionId;
}

/**
 * Union type of all possible Creative Brief UI events.
 */
export type CreativeBriefEvent =
  | BriefCollectStartEvent
  | BriefCollectSuccessEvent
  | BriefCollectUnavailableEvent
  | BriefCollectErrorEvent
  | BriefRevisionChangeEvent
  | BriefResetEvent
  | BriefRetryEvent
  | BriefHydrateEvent;

// ==========================================================================
// Initial State
// ==========================================================================

/**
 * The initial state of the Creative Brief UI.
 * Defaults to unavailable since the production adapter is not yet available.
 */
export const INITIAL_BRIEF_STATE: CreativeBriefUnavailableState = {
  type: 'unavailable',
  reason: 'Production creative brief adapter not available',
};

/**
 * Alternative idle initial state for when the feature is disabled.
 */
export const IDLE_BRIEF_STATE: CreativeBriefIdleState = {
  type: 'idle',
};

// ==========================================================================
// Reducer
// ==========================================================================

/**
 * Pure reducer for Creative Brief UI state.
 *
 * State transitions:
 * - idle → collecting (on collect-start or retry)
 * - collecting → brief-ready (on collect-success)
 * - collecting → unavailable (on collect-unavailable)
 * - collecting → error (on collect-error)
 * - brief-ready → stale (on revision-change when newRevisionId differs)
 * - brief-ready → idle (on reset)
 * - stale → idle or collecting (on reset or retry)
 * - error → idle or collecting (on reset or retry)
 * - unavailable → idle or collecting (on reset or retry)
 *
 * Invalid/out-of-order events leave state unchanged.
 * All inputs are treated as immutable - no mutations.
 * Persian/RTL text in request is preserved byte-for-byte.
 */
export function creativeBriefReducer(
  state: CreativeBriefState,
  event: CreativeBriefEvent,
): CreativeBriefState {
  // Freeze inputs to ensure immutability (dev mode safety)
  // In production this is a no-op but documents intent
  if (import.meta.env.DEV) {
    Object.freeze(state);
    Object.freeze(event);
  }

  if (event.type === 'hydrate') {
    if (event.brief.snapshotRevisionId !== event.revisionId)
      return {
        type: 'stale',
        brief: event.brief,
        revisionId: event.brief.snapshotRevisionId,
        currentRevisionId: event.revisionId,
      };
    return { type: 'brief-ready', brief: event.brief, revisionId: event.revisionId };
  }

  switch (state.type) {
    case 'idle':
      return reduceIdleState(state, event);

    case 'collecting':
      return reduceCollectingState(state, event);

    case 'brief-ready':
      return reduceBriefReadyState(state, event);

    case 'unavailable':
      return reduceUnavailableState(state, event);

    case 'error':
      return reduceErrorState(state, event);

    case 'stale':
      return reduceStaleState(state, event);
  }
}

function reduceIdleState(
  _state: CreativeBriefIdleState,
  event: CreativeBriefEvent,
): CreativeBriefState {
  switch (event.type) {
    case 'collect-start':
    case 'retry':
      // Preserve Persian/RTL request text byte-for-byte
      return {
        type: 'collecting',
        request: event.request,
        revisionId: event.revisionId,
        projectId: event.projectId,
      };

    case 'reset':
      return IDLE_BRIEF_STATE;

    // Invalid events for idle state - ignore
    case 'collect-success':
    case 'collect-unavailable':
    case 'collect-error':
    case 'revision-change':
    case 'hydrate':
      return _state;
  }
}

function reduceCollectingState(
  state: CreativeBriefCollectingState,
  event: CreativeBriefEvent,
): CreativeBriefState {
  switch (event.type) {
    case 'collect-success':
      // Verify the brief matches the requested revision
      if (event.brief.snapshotRevisionId === state.revisionId) {
        return {
          type: 'brief-ready',
          brief: event.brief,
          revisionId: state.revisionId,
        };
      }
      // Revision mismatch - treat as error
      return {
        type: 'error',
        error: `Brief revision mismatch: expected ${state.revisionId}, got ${event.brief.snapshotRevisionId}`,
      };

    case 'collect-unavailable':
      return {
        type: 'unavailable',
        reason: event.reason,
      };

    case 'collect-error':
      return {
        type: 'error',
        error: event.error,
      };

    case 'revision-change':
      // Revision changed while collecting - mark as stale once we have a brief
      // But we don't have one yet, so go back to idle
      return IDLE_BRIEF_STATE;

    case 'reset':
      return IDLE_BRIEF_STATE;

    case 'retry':
    case 'collect-start':
      // Already collecting - ignore new requests
      return state;
    case 'hydrate':
      return state;
  }
}

function reduceBriefReadyState(
  state: CreativeBriefReadyState,
  event: CreativeBriefEvent,
): CreativeBriefState {
  switch (event.type) {
    case 'revision-change':
      if (event.newRevisionId !== state.revisionId) {
        return {
          type: 'stale',
          brief: state.brief,
          revisionId: state.revisionId,
          currentRevisionId: event.newRevisionId,
        };
      }
      // Same revision - not stale
      return state;

    case 'reset':
      return IDLE_BRIEF_STATE;

    case 'retry':
    case 'collect-start':
      // Go back to collecting with new request
      return {
        type: 'collecting',
        request: event.request,
        revisionId: event.revisionId,
        projectId: event.projectId,
      };

    // Brief is already ready - these events don't apply
    case 'collect-success':
    case 'collect-unavailable':
    case 'collect-error':
    case 'hydrate':
      return state;
  }
}

function reduceUnavailableState(
  _state: CreativeBriefUnavailableState,
  event: CreativeBriefEvent,
): CreativeBriefState {
  switch (event.type) {
    case 'retry':
    case 'collect-start':
      return {
        type: 'collecting',
        request: event.request,
        revisionId: event.revisionId,
        projectId: event.projectId,
      };

    case 'reset':
      return IDLE_BRIEF_STATE;

    // Cannot transition to ready/unavailable/error from unavailable via these events
    case 'collect-success':
    case 'collect-unavailable':
    case 'collect-error':
    case 'revision-change':
    case 'hydrate':
      return _state;
  }
}

function reduceErrorState(
  _state: CreativeBriefErrorState,
  event: CreativeBriefEvent,
): CreativeBriefState {
  switch (event.type) {
    case 'retry':
    case 'collect-start':
      return {
        type: 'collecting',
        request: event.request,
        revisionId: event.revisionId,
        projectId: event.projectId,
      };

    case 'reset':
      return IDLE_BRIEF_STATE;

    // Cannot transition from error via these events
    case 'collect-success':
    case 'collect-unavailable':
    case 'collect-error':
    case 'revision-change':
    case 'hydrate':
      return _state;
  }
}

function reduceStaleState(
  state: CreativeBriefStaleState,
  event: CreativeBriefEvent,
): CreativeBriefState {
  switch (event.type) {
    case 'reset':
      return IDLE_BRIEF_STATE;

    case 'retry':
    case 'collect-start':
      return {
        type: 'collecting',
        request: event.request,
        revisionId: event.revisionId,
        projectId: event.projectId,
      };

    case 'revision-change':
      // Update the current revision
      return {
        type: 'stale',
        brief: state.brief,
        revisionId: state.revisionId,
        currentRevisionId: event.newRevisionId,
      };

    // Stale brief - these events don't resolve staleness
    case 'collect-success':
    case 'collect-unavailable':
    case 'collect-error':
    case 'hydrate':
      return state;
  }
}

// ==========================================================================
// State Selectors
// ==========================================================================

/**
 * Check if the current state has a brief available for display.
 */
export function hasBrief(
  state: CreativeBriefState,
): state is CreativeBriefReadyState | CreativeBriefStaleState {
  return state.type === 'brief-ready' || state.type === 'stale';
}

/**
 * Get the brief from the state if available.
 */
export function getBrief(state: CreativeBriefState): CreativeBriefV1 | null {
  switch (state.type) {
    case 'brief-ready':
    case 'stale':
      return state.brief;
    default:
      return null;
  }
}

/**
 * Check if the current brief is stale.
 */
export function isStale(state: CreativeBriefState): state is CreativeBriefStaleState {
  return state.type === 'stale';
}

/**
 * Check if brief generation is in progress.
 */
export function isCollecting(state: CreativeBriefState): state is CreativeBriefCollectingState {
  return state.type === 'collecting';
}

/**
 * Check if brief generation is unavailable.
 */
export function isUnavailable(state: CreativeBriefState): state is CreativeBriefUnavailableState {
  return state.type === 'unavailable';
}

/**
 * Check if an error occurred.
 */
export function hasError(state: CreativeBriefState): state is CreativeBriefErrorState {
  return state.type === 'error';
}

/**
 * Check if in idle state.
 */
export function isIdle(state: CreativeBriefState): state is CreativeBriefIdleState {
  return state.type === 'idle';
}

/**
 * Get the stored request text (if any), preserving Persian/RTL bytes.
 */
export function getRequest(state: CreativeBriefState): string | null {
  switch (state.type) {
    case 'collecting':
    case 'stale':
    case 'brief-ready':
      // For stale and brief-ready, we don't store the original request
      // This is intentional - the request is embedded in the brief
      // Only collecting state has the raw request
      // This selector returns null for ready/stale to avoid confusion
      return state.type === 'collecting' ? state.request : null;
    default:
      return null;
  }
}

/**
 * Get the revision ID that the current brief or collection is for.
 */
export function getRevisionId(state: CreativeBriefState): ProjectRevisionId | null {
  switch (state.type) {
    case 'collecting':
      return state.revisionId;
    case 'brief-ready':
      return state.revisionId;
    case 'stale':
      return state.revisionId;
    default:
      return null;
  }
}

// ==========================================================================
// Type Guards
// ==========================================================================

export function isCreativeBriefIdleState(
  state: CreativeBriefState,
): state is CreativeBriefIdleState {
  return state.type === 'idle';
}

export function isCreativeBriefCollectingState(
  state: CreativeBriefState,
): state is CreativeBriefCollectingState {
  return state.type === 'collecting';
}

export function isCreativeBriefReadyState(
  state: CreativeBriefState,
): state is CreativeBriefReadyState {
  return state.type === 'brief-ready';
}

export function isCreativeBriefUnavailableState(
  state: CreativeBriefState,
): state is CreativeBriefUnavailableState {
  return state.type === 'unavailable';
}

export function isCreativeBriefErrorState(
  state: CreativeBriefState,
): state is CreativeBriefErrorState {
  return state.type === 'error';
}

export function isCreativeBriefStaleState(
  state: CreativeBriefState,
): state is CreativeBriefStaleState {
  return state.type === 'stale';
}
