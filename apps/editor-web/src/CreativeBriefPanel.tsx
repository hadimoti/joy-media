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
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { CreativeBriefIcon } from './icons.js';

/**
 * Props for CreativeBriefPanel.
 * Accepts only revision ID and an optional async brief runner.
 * No raw project object, model adapter, provider, command bus, or persistence dependency.
 */
export interface CreativeBriefPanelProps {
  /** Current project revision ID. */
  readonly revisionId: ProjectRevisionId;
  /** Optional async function to run a brief request and return a Promise of CreativeBriefV1. */
  readonly runBrief?: (request: string) => Promise<CreativeBriefV1>;
  /** Whether the user has explicitly opted in to Creative Brief. */
  readonly optedIn?: boolean;
  /** Optional async callback to request opt-in. */
  readonly onOptIn?: () => Promise<void> | void;
}

/** Versioned disclosure shown immediately before project-level opt-in. */
export const CREATIVE_BRIEF_CONSENT_DISCLOSURE_V1 =
  "A bounded semantic summary of this project (not media files, URLs, or secrets) will be sent to OpenRouter's free NVIDIA Nemotron model. OpenRouter may log prompts and outputs; do not include confidential data. Paid fallback is disabled." as const;

/**
 * Creative Brief Panel Component.
 *
 * Composes the controller's state machine with the display component.
 * Shows a text input and "Improve project" control.
 * With no runBrief: shows unavailable state honestly.
 * With optedIn === false: shows consent gate, no runBrief calls.
 * With optedIn === true: creates and displays read-only briefs.
 * When revision changes after a ready brief: transitions to stale.
 * Retains user's request for retry.
 * Errors transition to error state.
 * No action controls to execute/apply recommendations.
 */
export function CreativeBriefPanel({
  revisionId,
  runBrief,
  optedIn = false,
  onOptIn,
}: CreativeBriefPanelProps) {
  const [state, dispatch] = useReducer(creativeBriefReducer, INITIAL_BRIEF_STATE);
  const [requestText, setRequestText] = useState('');
  const [optInError, setOptInError] = useState<string | null>(null);
  const [isOptingIn, setIsOptingIn] = useState(false);

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

  // Handle opt-in action
  const handleOptIn = useCallback(async () => {
    if (!onOptIn) {
      return;
    }
    setIsOptingIn(true);
    setOptInError(null);
    try {
      await onOptIn();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Opt-in failed';
      setOptInError(errorMessage);
    } finally {
      setIsOptingIn(false);
    }
  }, [onOptIn]);

  // Handle "Improve project" action
  const handleImprove = useCallback(async () => {
    const request = requestText.trim();
    if (!request) {
      return;
    }

    if (!optedIn) {
      // Opt-in required - show consent state
      dispatch({
        type: 'collect-unavailable',
        reason: 'Creative Brief opt-in required',
      });
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
      const brief = await runBrief(request);
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      dispatch({
        type: 'collect-error',
        error: errorMessage,
      });
    }
  }, [requestText, revisionId, runBrief, optedIn]);

  // Handle reset
  const handleReset = useCallback(() => {
    dispatch({ type: 'reset' });
    setRequestText('');
  }, []);

  // Handle retry
  const handleRetry = useCallback(async () => {
    const request = displayedRequest || requestText;
    if (!request.trim()) {
      return;
    }

    if (!optedIn) {
      dispatch({
        type: 'collect-unavailable',
        reason: 'Creative Brief opt-in required',
      });
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
      const brief = await runBrief(request);
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      dispatch({
        type: 'collect-error',
        error: errorMessage,
      });
    }
  }, [displayedRequest, requestText, revisionId, runBrief, optedIn]);

  // Render based on current state
  return (
    <PanelShell
      title="Creative Brief"
      iconUrl={panelTabIconUrl('creative-brief')}
      icon={<CreativeBriefIcon />}
      className="creative-brief-panel"
    >
      <div className="creative-brief-panel-inner" aria-label="Creative Brief">
        {/* Consent gate - shown when optedIn is false */}
        {!optedIn && (
          <div className="creative-brief-panel-consent" aria-label="Creative Brief consent gate">
            {onOptIn ? (
              <>
                <p>
                  <strong>Creative Brief is currently disabled.</strong>
                </p>
                <p>Enable Creative Brief to request improvements to your project.</p>
                <p className="creative-brief-panel-disclosure">
                  {CREATIVE_BRIEF_CONSENT_DISCLOSURE_V1}
                </p>
                {optInError && (
                  <p className="creative-brief-panel-error" aria-label="Opt-in error">
                    <strong>Error:</strong> {optInError}
                  </p>
                )}
                <button
                  type="button"
                  className="creative-brief-panel-button"
                  onClick={handleOptIn}
                  disabled={isOptingIn}
                  aria-label="Enable Creative Brief"
                >
                  {isOptingIn ? 'Enabling...' : 'Enable Creative Brief'}
                </button>
              </>
            ) : (
              <p>Creative Brief is not enabled.</p>
            )}
          </div>
        )}

        {/* Request Input */}
        {optedIn && (
          <div className="creative-brief-composer" aria-label="Brief request input">
            <div className="creative-brief-field">
              <label className="creative-brief-field-label" htmlFor="creative-brief-request">
                Brief request
              </label>
              <textarea
                id="creative-brief-request"
                className="creative-brief-panel-textarea"
                value={displayedRequest}
                onChange={(e) => setRequestText(e.target.value)}
                placeholder="Describe what you want to improve..."
                aria-label="Describe creative improvement"
                dir="auto"
                disabled={isCollecting(state)}
              />
            </div>
            <button
              type="button"
              className="creative-brief-panel-button"
              onClick={handleImprove}
              disabled={isCollecting(state) || (!runBrief && !isUnavailable(state))}
              aria-label="Generate brief"
            >
              {isCollecting(state) ? 'Generating…' : 'Generate brief'}
            </button>

            {isCollecting(state) && (
              <span className="creative-brief-panel-status" aria-label="Processing request">
                Processing...
              </span>
            )}
          </div>
        )}

        {/* State-specific UI */}
        <div className="creative-brief-panel-content">
          {optedIn && isUnavailable(state) && !runBrief && (
            <div
              className="creative-brief-state creative-brief-state-unavailable creative-brief-panel-unavailable"
              aria-label="Feature unavailable"
              role="status"
              aria-live="polite"
            >
              <p>Creative brief feature is not currently available.</p>
              <p>{state.reason}</p>
            </div>
          )}

          {optedIn && hasError(state) && (
            <div
              className="creative-brief-state creative-brief-state-error creative-brief-panel-error"
              aria-label="Error occurred"
              role="alert"
            >
              <p>
                <strong>Error:</strong> {state.error}
              </p>
              <div className="creative-brief-state-actions">
                <button
                  type="button"
                  className="creative-brief-panel-retry"
                  onClick={handleRetry}
                  aria-label="Retry"
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="creative-brief-panel-reset"
                  onClick={handleReset}
                  aria-label="Reset"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {optedIn && isStale(state) && (
            <div
              className="creative-brief-state creative-brief-state-stale creative-brief-panel-stale"
              aria-label="Brief is stale"
              role="status"
              aria-live="polite"
            >
              <p>
                <strong>Warning:</strong> The creative brief is stale. The project revision has
                changed.
              </p>
              <div className="creative-brief-state-actions">
                <button
                  type="button"
                  className="creative-brief-panel-retry"
                  onClick={handleRetry}
                  aria-label="Regenerate brief"
                >
                  Regenerate Brief
                </button>
                <button
                  type="button"
                  className="creative-brief-panel-reset"
                  onClick={handleReset}
                  aria-label="Reset"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {optedIn && isIdle(state) && !isUnavailable(state) && (
            <div
              className="creative-brief-state creative-brief-state-idle creative-brief-panel-idle"
              aria-label="Enter request"
              role="status"
              aria-live="polite"
            >
              <p>Enter a request above to generate a creative brief.</p>
            </div>
          )}

          {/* Display brief when available */}
          {optedIn && hasBrief(state) && !isStale(state) && getBrief(state) && (
            <CreativeBriefDisplay brief={getBrief(state)!} />
          )}

          {optedIn && isStale(state) && getBrief(state) && (
            <CreativeBriefDisplay brief={getBrief(state)!} />
          )}
        </div>
      </div>
    </PanelShell>
  );
}
