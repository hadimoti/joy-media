/**
 * Creative Brief Panel - WP-37 S4-D
 *
 * Unmounted panel component that composes CreativeBriefDisplay and creative-brief-controller.
 * Does NOT: mount to App, accept raw project objects, call adapters, create
 * plans/commands/jobs, or execute recommendations. Model calls stay behind the
 * runner supplied by the built-in JOY Agent Engine.
 */

import { useReducer, useEffect, useState, useCallback, useRef } from 'react';
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
} from './creative-brief-controller.js';
import { CreativeBriefDisplay } from './CreativeBriefDisplay.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { AgentPreviewBadge } from './AgentPreviewBadge.js';
import {
  loadCreativeBrief,
  removeCreativeBrief,
  saveCreativeBrief,
  type CreativeBriefStorage,
} from './creative-brief-storage.js';

/**
 * Props for CreativeBriefPanel.
 * Accepts only revision ID and an optional async brief runner.
 * No raw project object, model adapter, provider, or command bus. Persistence,
 * when wanted, is injected by the writer-owning editor root.
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
  /** Stable project key used for local durable reopen state. */
  readonly projectId?: string;
  /**
   * Writer-fenced browser storage. Omit only for an intentionally in-memory
   * standalone panel; this component never reaches for global localStorage.
   */
  readonly storage?: CreativeBriefStorage;
  /** Hands a generated brief to the guarded Joy Code composer; never executes it. */
  readonly onHandOff?: (brief: CreativeBriefV1) => void;
  /** Notifies an embedding Composer when a validated artifact is ready. */
  readonly onBriefReady?: (brief: CreativeBriefV1) => void;
  /** Notifies an embedding Composer when a stored brief is restored. */
  readonly onBriefHydrated?: (brief: CreativeBriefV1) => void;
  /** Clears an embedding Composer's attached artifact when the brief is cleared. */
  readonly onBriefCleared?: () => void;
  /** Mount inside the Joy Code surface without a second visual panel header. */
  readonly embedded?: boolean;
}

/** Versioned disclosure shown immediately before project-level opt-in. */
export const CREATIVE_BRIEF_CONSENT_DISCLOSURE_V1 =
  'JOY sends only a bounded project summary — never media files, URLs, or secrets — directly to the provider you choose. Your key stays in this browser; provider use may cost money.' as const;

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
  projectId,
  onHandOff,
  onBriefReady,
  onBriefHydrated,
  onBriefCleared,
  embedded = false,
  storage,
}: CreativeBriefPanelProps) {
  const [state, dispatch] = useReducer(creativeBriefReducer, INITIAL_BRIEF_STATE);
  const [requestText, setRequestText] = useState('');
  const [optInError, setOptInError] = useState<string | null>(null);
  const [isOptingIn, setIsOptingIn] = useState(false);
  const storageProjectId = projectId ?? `revision:${revisionId}`;
  const previousStorageProjectIdRef = useRef<string | null>(null);
  const hydratedBriefKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const previousStorageProjectId = previousStorageProjectIdRef.current;
    if (previousStorageProjectId !== null && previousStorageProjectId !== storageProjectId) {
      dispatch({ type: 'reset' });
      setRequestText('');
      hydratedBriefKeyRef.current = null;
    }
    previousStorageProjectIdRef.current = storageProjectId;
    const saved = storage ? loadCreativeBrief(storage, storageProjectId) : undefined;
    if (saved !== undefined) {
      dispatch({ type: 'hydrate', brief: saved, revisionId });
      setRequestText(saved.request);
      const hydrationKey = `${storageProjectId}:${saved.snapshotRevisionId}`;
      if (saved.snapshotRevisionId === revisionId && hydratedBriefKeyRef.current !== hydrationKey) {
        hydratedBriefKeyRef.current = hydrationKey;
        onBriefHydrated?.(saved);
      }
    }
  }, [onBriefHydrated, revisionId, storage, storageProjectId]);

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
        if (storage) saveCreativeBrief(storage, storageProjectId, brief);
        setRequestText(brief.request);
        dispatch({
          type: 'collect-success',
          brief,
          revisionId,
        });
        onBriefReady?.(brief);
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
  }, [onBriefReady, optedIn, requestText, revisionId, runBrief, storage, storageProjectId]);

  // Handle reset
  const handleReset = useCallback(() => {
    dispatch({ type: 'reset' });
    setRequestText('');
    if (storage) removeCreativeBrief(storage, storageProjectId);
    onBriefCleared?.();
  }, [onBriefCleared, storage, storageProjectId]);

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
        if (storage) saveCreativeBrief(storage, storageProjectId, brief);
        setRequestText(brief.request);
        dispatch({
          type: 'collect-success',
          brief,
          revisionId,
        });
        onBriefReady?.(brief);
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
  }, [
    displayedRequest,
    onBriefReady,
    requestText,
    revisionId,
    runBrief,
    optedIn,
    storage,
    storageProjectId,
  ]);

  // Render based on current state
  const panelContent = (
    <div className="creative-brief-panel" aria-label="Creative brief panel">
      <AgentPreviewBadge surface="Creative Brief" />
      {/* Consent gate - shown when optedIn is false */}
      {!optedIn && (
        <div className="creative-brief-panel-consent" aria-label="Creative Brief consent gate">
          {onOptIn ? (
            <>
              <span className="creative-brief-panel-consent-kicker">Creative Brief</span>
              <h3>Connect a model to start</h3>
              <p className="creative-brief-panel-consent-summary">
                Add your private BYOK model in JOY Agent Settings, then turn this project into
                focused improvement ideas.
              </p>
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
                aria-label="Open JOY Agent Settings"
              >
                {isOptingIn ? 'Opening settings…' : 'Connect a model'}
              </button>
            </>
          ) : (
            <p>Creative Brief is not enabled.</p>
          )}
        </div>
      )}

      {/* Request Input */}
      {optedIn && (
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
      )}

      {/* State-specific UI */}
      <div className="creative-brief-panel-content">
        {optedIn && isUnavailable(state) && !runBrief && (
          <div className="creative-brief-panel-unavailable" aria-label="Feature unavailable">
            <p>Creative brief feature is not currently available.</p>
            <p>{state.reason}</p>
          </div>
        )}

        {optedIn && hasError(state) && (
          <div className="creative-brief-panel-error" aria-label="Error occurred">
            <p>
              <strong>Error:</strong> {state.error}
            </p>
            <button className="creative-brief-panel-retry" onClick={handleRetry} aria-label="Retry">
              Retry
            </button>
            <button className="creative-brief-panel-reset" onClick={handleReset} aria-label="Reset">
              Clear
            </button>
          </div>
        )}

        {optedIn && isStale(state) && (
          <div className="creative-brief-panel-stale" aria-label="Brief is stale">
            <p>
              <strong>Warning:</strong> The creative brief is stale. The project revision has
              changed.
            </p>
            <button
              className="creative-brief-panel-retry"
              onClick={handleRetry}
              aria-label="Regenerate brief"
            >
              Regenerate Brief
            </button>
            <button className="creative-brief-panel-reset" onClick={handleReset} aria-label="Reset">
              Clear
            </button>
          </div>
        )}

        {optedIn && isIdle(state) && !isUnavailable(state) && (
          <div className="creative-brief-panel-idle" aria-label="Enter request">
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

        {optedIn && hasBrief(state) && getBrief(state) && onHandOff && (
          <button
            className="creative-brief-panel-button"
            type="button"
            onClick={() => onHandOff(getBrief(state)!)}
            aria-label={embedded ? 'Attach brief to Joy Code edits' : 'Send brief to Joy Code'}
          >
            {embedded ? 'Attach to edits' : 'Send to Joy Code'}
          </button>
        )}
      </div>
    </div>
  );
  return embedded ? (
    panelContent
  ) : (
    <PanelShell title="Creative Brief" iconUrl={panelTabIconUrl('agent')}>
      {panelContent}
    </PanelShell>
  );
}
