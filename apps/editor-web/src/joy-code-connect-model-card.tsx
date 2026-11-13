/**
 * Joy Code's one calm "not connected" card.
 *
 * Joy Code is optional: the card says so, names the single action and stops.
 * There is no technical wording here, and the chat never repeats it — the card
 * is the one message (T-D06, owner item OB-13c).
 */

export const JOY_CODE_CONNECT_MODEL_MESSAGE =
  'Joy Code is optional. Connect your own AI model to edit by describing what you want.';

export const JOY_CODE_CONNECT_MODEL_ACTION = 'Connect a model';

export interface JoyCodeConnectModelCardProps {
  /** Opens JOY Agent Settings. Without it the card shows the message only. */
  readonly onConnect?: (() => void) | undefined;
  /** Accessible name of the card, e.g. "Edit readiness". */
  readonly ariaLabel?: string | undefined;
  /** Text of the action. Defaults to "Connect a model". */
  readonly action?: string | undefined;
}

/** The card itself: one sentence, one gold action, nothing else. */
export function JoyCodeConnectModelCard({
  onConnect,
  ariaLabel,
  action = JOY_CODE_CONNECT_MODEL_ACTION,
}: JoyCodeConnectModelCardProps) {
  return (
    <div className="joy-code-connect-card" role="status" aria-label={ariaLabel}>
      <p className="joy-code-connect-card-message">{JOY_CODE_CONNECT_MODEL_MESSAGE}</p>
      {onConnect !== undefined && (
        <button
          type="button"
          className="button-primary joy-code-connect-card-action"
          onClick={onConnect}
        >
          {action}
        </button>
      )}
    </div>
  );
}

export interface JoyCodeReadinessSlotProps {
  /** True when no model is connected: one calm card replaces the notice. */
  readonly showConnectCard: boolean;
  /** The notice shown for every other disconnected state. */
  readonly readinessText: string;
  /** Accessible name of the slot, e.g. "Edit readiness". */
  readonly ariaLabel: string;
  /** Opens JOY Agent Settings. */
  readonly onOpenSettings?: (() => void) | undefined;
}

/**
 * The readiness slot the Edit, Recipes and Looks surfaces share.
 *
 * With no model the calm card is the whole message. Every other disconnected
 * state keeps its own wording, because there the user has to know what is
 * actually wrong with the model they already connected.
 */
export function JoyCodeReadinessSlot({
  showConnectCard,
  readinessText,
  ariaLabel,
  onOpenSettings,
}: JoyCodeReadinessSlotProps) {
  if (showConnectCard) {
    return (
      <JoyCodeConnectModelCard
        ariaLabel={ariaLabel}
        {...(onOpenSettings === undefined ? {} : { onConnect: onOpenSettings })}
      />
    );
  }
  return (
    <div className="joy-code-disconnected-banner" role="status" aria-label={ariaLabel}>
      <span>{readinessText}</span>
      {onOpenSettings !== undefined && (
        <button
          type="button"
          className="button-secondary joy-code-configure-agent-btn"
          onClick={onOpenSettings}
        >
          Open JOY Agent Settings
        </button>
      )}
    </div>
  );
}
