import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { CONNECT_MODEL_FIRST_TITLE, runControlGate } from './joy-code-run-gate.js';

/** The visible text of the connect step. */
export const CONNECT_MODEL_BUTTON_TEXT = 'Connect a model';

/** The keys that activate a control: Enter, and Space (both the modern and the legacy name). */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

/**
 * The connect step, as a control a keyboard can reach. It is `role="button"`
 * with `tabIndex={0}`, so Tab reaches it, and Enter or Space open the connect
 * step (T-J02). Its accessible name is "Connect a model first".
 */
export function JoyCodeConnectButton({ onConnect }: { readonly onConnect: () => void }) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isActivationKey(event.key)) return;
    // Space would otherwise scroll the page; both keys open the step once.
    event.preventDefault();
    onConnect();
  };
  return (
    <div
      role="button"
      tabIndex={0}
      className="button-primary joy-code-connect-button"
      aria-label={CONNECT_MODEL_FIRST_TITLE}
      title={CONNECT_MODEL_FIRST_TITLE}
      onClick={onConnect}
      onKeyDown={onKeyDown}
    >
      {CONNECT_MODEL_BUTTON_TEXT}
    </div>
  );
}

/**
 * One recipe's Run control and, with no model connected, its connect step.
 * The gate decides the Run button's state; the connect step is shown only
 * when no model is connected and an opener is given.
 */
export function RecipeRunControls({
  title,
  ready,
  noModel,
  readinessText,
  blocked,
  running,
  onRun,
  onConnect,
}: {
  /** The recipe's title, for the Run control's accessible name. */
  readonly title: string;
  readonly ready: boolean;
  readonly noModel: boolean;
  readonly readinessText: string;
  readonly blocked: boolean;
  readonly running: boolean;
  readonly onRun: () => void;
  readonly onConnect?: (() => void) | undefined;
}) {
  const gate = runControlGate({ ready, noModel, readinessText, blocked });
  return (
    <>
      <button
        type="button"
        className="joy-code-recipe-run"
        disabled={gate.disabled}
        title={gate.title}
        aria-label={`Run ${title}`}
        onClick={onRun}
      >
        {running ? 'Running…' : 'Run'}
      </button>
      {gate.opensConnect && onConnect !== undefined && (
        <JoyCodeConnectButton onConnect={onConnect} />
      )}
    </>
  );
}
