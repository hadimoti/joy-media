import { useEffect } from 'react';
import { CloseIcon } from './icons.js';
import {
  checkForDesktopUpdate,
  isDesktopHost,
  type DesktopUpdateBlockReason,
  type DesktopUpdateDecision,
} from './desktop-client.js';
import './AppSettingsDialog.css';

/**
 * The last update check of this session. The check runs only when the user presses the button, so this state starts
 * as `idle` and is never filled in by the dialog opening or by the app starting.
 */
export type UpdateCheckState =
  | { readonly status: 'idle' }
  | { readonly status: 'checking' }
  | { readonly status: 'done'; readonly decision: DesktopUpdateDecision }
  | { readonly status: 'failed'; readonly message: string };

export interface AppSettingsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly updateState: UpdateCheckState;
  readonly onUpdateStateChange: (state: UpdateCheckState) => void;
}

const BLOCKED_MESSAGES: Record<DesktopUpdateBlockReason, string> = {
  'release-key-unconfigured':
    'This build has no release signing key, so updates cannot be verified. Nothing was downloaded.',
  'installed-version-invalid':
    'This installation’s version could not be read, so the update check did not run.',
  'signature-invalid':
    'The release manifest’s signature did not verify. Nothing was downloaded or installed.',
  'manifest-invalid': 'The release manifest is malformed. Nothing was downloaded or installed.',
  'channel-mismatch':
    'The release manifest is for a different channel. Nothing was downloaded or installed.',
  'network-unavailable': 'The release service could not be reached. Try again later.',
};

/** Describes a decision in plain words. Updates are never installed from here: the text only points to the release. */
export function describeUpdateDecision(decision: DesktopUpdateDecision): string {
  switch (decision.status) {
    case 'blocked':
      return BLOCKED_MESSAGES[decision.reason];
    case 'current':
      return `You have the latest release (${decision.latestVersion}).`;
    case 'update':
      return decision.forced
        ? `Version ${decision.latestVersion} is available, and this update is required. It is not installed automatically.`
        : `Version ${decision.latestVersion} is available. It is not installed automatically.`;
  }
}

/** The small, non-modal signal that an update exists. It appears on the Updates entry only, never as a pop-up. */
export function hasUpdateAvailable(state: UpdateCheckState): boolean {
  return state.status === 'done' && state.decision.status === 'update';
}

export function AppSettingsDialog({
  open,
  onClose,
  updateState,
  onUpdateStateChange,
}: AppSettingsDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const checking = updateState.status === 'checking';
  const runCheck = async () => {
    onUpdateStateChange({ status: 'checking' });
    try {
      const decision = await checkForDesktopUpdate();
      onUpdateStateChange({ status: 'done', decision });
    } catch (err: unknown) {
      onUpdateStateChange({
        status: 'failed',
        message: err instanceof Error ? err.message : 'The update check failed.',
      });
    }
  };

  return (
    <div className="agent-settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="agent-settings-dialog app-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="agent-settings-header">
          <div>
            <span className="agent-settings-kicker">Application</span>
            <h2 id="app-settings-title">Settings</h2>
          </div>
          <button
            type="button"
            className="agent-settings-close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="app-settings-layout">
          <nav className="app-settings-nav" aria-label="Settings sections">
            <button type="button" className="app-settings-nav-item is-active" aria-current="page">
              Updates
              {hasUpdateAvailable(updateState) && (
                <span
                  className="app-settings-update-dot"
                  role="img"
                  aria-label="Update available"
                />
              )}
            </button>
          </nav>

          <div className="agent-settings-body app-settings-body">
            <section
              className="agent-settings-section"
              aria-labelledby="app-settings-updates-title"
            >
              <div className="agent-settings-section-heading">
                <h3 id="app-settings-updates-title">Updates</h3>
              </div>
              <p className="agent-settings-hint">
                Updates are checked only when you press the button below. The check reads the signed
                release manifest and reports what it finds. It never downloads or installs anything.
              </p>

              {!isDesktopHost() ? (
                <div className="agent-settings-notice is-info">
                  <span>Update checks are available in the JOY Media desktop application.</span>
                </div>
              ) : (
                <div className="agent-settings-actions">
                  <button
                    type="button"
                    className="app-settings-check-button"
                    onClick={() => void runCheck()}
                    disabled={checking}
                    aria-busy={checking}
                  >
                    {checking ? 'Checking…' : 'Check for Updates'}
                  </button>
                </div>
              )}

              <div role="status" aria-live="polite" className="app-settings-status">
                {updateState.status === 'done' && (
                  <p data-update-status={updateState.decision.status}>
                    {describeUpdateDecision(updateState.decision)}
                  </p>
                )}
                {updateState.status === 'done' && updateState.decision.status === 'update' && (
                  <p className="app-settings-release-link">
                    Release page: <code>{updateState.decision.releaseUrl}</code>
                  </p>
                )}
                {updateState.status === 'failed' && (
                  <p role="alert" data-update-status="failed">
                    {updateState.message}
                  </p>
                )}
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
