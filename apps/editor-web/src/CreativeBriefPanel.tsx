/**
 * Creative Brief Panel - WP-37 S4-D
 *
 * Unmounted panel component that composes CreativeBriefDisplay and creative-brief-controller.
 * Does NOT: mount to App, accept raw project objects, call models, call adapters,
 * mutate state, persist data, create plans/commands/jobs, or execute recommendations.
 */

import { useReducer, useEffect, useState, useCallback } from 'react';
import type { CreativeBriefV1, ProjectRevisionId } from '@joy-media/agent-tools';
import {
  creativeBriefReducer,
  INITIAL_BRIEF_STATE,
  hasBrief,
  getBrief,
  isStale,
  isCollecting,
  isUnavailable,
  hasError,
  isIdle,
  getRequest,
  type CreativeBriefState,
} from './creative-brief-controller.js';
import { CreativeBriefDisplay } from './CreativeBriefDisplay.js';

/**
 * Props for CreativeBriefPanel.
 * Accepts only revision ID and an optional synchronous brief runner.
 * No raw project object, model adapter, provider, command bus, or persistence dependency.
 */
export interface CreativeBriefPanelProps {
  /** Current project revision ID. */
  readonly revisionId: ProjectRevisionId;
  /** Optional synchronous function to run a brief request and return a CreativeBriefV1. */
  readonly runBrief?: (request: string) => CreativeBriefV1;
}

/**
 * Creative Brief Panel Component.
 *
 * Composes the controller's state machine with the display component.
 * Shows a text input and "Improve project" control.
 * With no runBrief: shows unavailable state honestly.
 * With runBrief: creates and displays read-only briefs.
 * When revision changes after a ready brief: transitions to stale.
 * Retains user's request for retry.
 * Errors transition to error state.
 * No action controls to execute/apply recommendations.
 */
export function CreativeBriefPanel({ revisionId, runBrief }: CreativeBriefPanelProps) {
  const [state, dispatch] = useReducer(creativeBriefReducer, INITIAL_BRIEF_STATE);
  const [requestText, setRequestText] = useState('');

  // Track previous revision to detect changes
  const [previousRevisionId, setPreviousRevisionId] = useState<ProjectRevisionId | null>(null);

  // When revision changes, check if we need to transition to stale
  useEffect(() => {
    if (previousRevisionId !== null && previousRevisionId !== revisionId) {
      // Only stale if we have a ready brief
      if (hasBrief(state) && !isStale(state)) {
        dispatch({
          type: 'revision-change',
          newRevisionId: revisionId,
        });
      }
    }
    setPreviousRevisionId(revisionId);
  }, [revisionId, previousRevisionId, state]);

  // Get the stored request for retry purposes
  const storedRequest = getRequest(state);
  const displayedRequest = storedRequest ?? requestText;

  // Handle "Improve project" action
  const handleImprove = useCallback(() => {
    const request = requestText.trim();
    if (!request) {
      return;
    }

    if (!runBrief) {
      // No adapter available - show unavailable
      dispatch({
        type: 'collect-unavailable',
        reason: 'No brief runner configured',
      });
      return;
    }

    dispatch({
      type: 'collect-start',
      request,
      revisionId,
      projectId: 'unknown', // Will be populated by the actual brief
    });

    try {
      const brief = runBrief(request);
      // Verify the brief matches the requested revision
      if (brief.snapshotRevisionId === revisionId) {
        dispatch({
          type: 'collect-success',
          brief,
          revisionId,
        });
      } else {
        dispatch({
          type: 'collect-error',
          error: `Brief revision mismatch: expected ${revisionId}, got ${brief.snapshotRevisionId}`,
        });
      }
    } catch (error) {
      dispatch({
        type: 'collect-error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [requestText, revisionId, runBrief]);

  // Handle reset
  const handleReset = useCallback(() => {
    dispatch({ type: 'reset' });
    setRequestText('');
  }, []);

  // Handle retry
  const handleRetry = useCallback(() => {
    const request = displayedRequest || requestText;
    if (!request.trim()) {
      return;
    }

    if (!runBrief) {
      dispatch({
        type: 'collect-unavailable',
        reason: 'No brief runner configured',
      });
      return;
    }

    dispatch({
      type: 'retry',
      request,
      revisionId,
      projectId: 'unknown',
    });

    try {
      const brief = runBrief(request);
      if (brief.snapshotRevisionId === revisionId) {
        dispatch({
          type: 'collect-success',
          brief,
          revisionId,
        });
      } else {
        dispatch({
          type: 'collect-error',
          error: `Brief revision mismatch: expected ${revisionId}, got ${brief.snapshotRevisionId}`,
        });
      }
    } catch (error) {
      dispatch({
        type: 'collect-error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [displayedRequest, requestText, revisionId, runBrief]);

  // Render based on current state
  return (
    <div className="creative-brief-panel" aria-label="Creative brief panel">
      {/* Request Input */}
      <div className="creative-brief-panel-input" aria-label="Brief request input">
        <textarea
          className="creative-brief-panel-textarea"
          value={displayedRequest}
          onChange={(e) => setRequestText(e.target.value)}
          placeholder="Describe what you want to improve..."
          aria-label="Describe creative improvement"
          disabled={isCollecting(state)}
        />
        <button
          className="creative-brief-panel-button"
          onClick={handleImprove}
          disabled={isCollecting(state) || (!runBrief && !isUnavailable(state))}
          aria-label="Improve project"
        >
          Improve project
        </button>

        {isCollecting(state) && (
          <span className="creative-brief-panel-status" aria-label="Processing request">
            Processing...
          </span>
        )}
      </div>

      {/* State-specific UI */}
      <div className="creative-brief-panel-content">
        {isUnavailable(state) && !runBrief && (
          <div className="creative-brief-panel-unavailable" aria-label="Feature unavailable">
            <p>Creative brief feature is not currently available.</p>
            <p>{state.reason}</p>
          </div>
        )}

        {hasError(state) && (
          <div className="creative-brief-panel-error" aria-label="Error occurred">
            <p><strong>Error:</strong> {state.error}</p>
            <button
              className="creative-brief-panel-retry"
              onClick={handleRetry}
              aria-label="Retry"
            >
              Retry
            </button>
            <button
              className="creative-brief-panel-reset"
              onClick={handleReset}
              aria-label="Reset"
            >
              Clear
            </button>
          </div>
        )}

        {isStale(state) && (
          <div className="creative-brief-panel-stale" aria-label="Brief is stale">
            <p><strong>Warning:</strong> The creative brief is stale. The project revision has changed.</p>
            <button
              className="creative-brief-panel-retry"
              onClick={handleRetry}
              aria-label="Regenerate brief"
            >
              Regenerate Brief
            </button>
            <button
              className="creative-brief-panel-reset"
              onClick={handleReset}
              aria-label="Reset"
            >
              Clear
            </button>
          </div>
        )}

        {isIdle(state) && !isUnavailable(state) && (
          <div className="creative-brief-panel-idle" aria-label="Enter request">
            <p>Enter a request above to generate a creative brief.</p>
          </div>
        )}

        {/* Display brief when available */}
        {hasBrief(state) && !isStale(state) && getBrief(state) && (
          <CreativeBriefDisplay brief={getBrief(state)!} />
        )}

        {isStale(state) && getBrief(state) && (
          <CreativeBriefDisplay brief={getBrief(state)!} />
        )}
      </div>
    </div>
  );
}
