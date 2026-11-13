/**
 * Joy Code's one calm failure card (T-J01, owner items OB-13a and OB-13c).
 *
 * It replaces the chat line for a failure: a title, one plain sentence and one
 * action button, all from the message table (joy-code-messages.ts). The button
 * does what its kind says: retry re-runs the request, open-settings opens Agent
 * Settings, dismiss closes the card. A kind with no handler shows no button.
 */
import { useState } from 'react';
import type { JoyCodeMessage } from './joy-code-messages.js';

export interface JoyCodeFailureCardProps {
  /** The table entry to show. */
  readonly message: JoyCodeMessage;
  /** Re-runs the request that failed. Without it a retry action shows no button. */
  readonly onRetry?: (() => void) | undefined;
  /** Opens Joy Code's Agent Settings. Without it an open-settings action shows no button. */
  readonly onOpenSettings?: (() => void) | undefined;
}

export function JoyCodeFailureCard({ message, onRetry, onOpenSettings }: JoyCodeFailureCardProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const { action } = message;
  const onAction =
    action.kind === 'retry'
      ? onRetry
      : action.kind === 'open-settings'
        ? onOpenSettings
        : () => setDismissed(true);

  return (
    <article
      className={`joy-code-failure-card is-${action.kind}`}
      role="status"
      aria-label="Joy Code"
    >
      <div className="joy-code-failure-card-text">
        <strong className="joy-code-failure-card-title">{message.title}</strong>
        <p className="joy-code-failure-card-sentence">{message.sentence}</p>
      </div>
      {onAction !== undefined && (
        <button
          type="button"
          className={`joy-code-failure-card-action ${
            action.kind === 'dismiss' ? 'button-secondary' : 'button-primary'
          }`}
          onClick={onAction}
        >
          {action.label}
        </button>
      )}
    </article>
  );
}
