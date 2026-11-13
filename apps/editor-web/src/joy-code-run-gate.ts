/**
 * Joy Code run gates (T-J02, OB-13b and OB-13d).
 *
 * With no connected model a Run control is disabled and says what to do, and a
 * click on its card opens the connect step. A run that is refused never adds
 * its "Run recipe" message to the chat: the message is announced only once the
 * run has really started (its first checkpoint).
 */

/** The hover text of every Run control that needs a model. */
export const CONNECT_MODEL_FIRST_TITLE = 'Connect a model first';

export interface RunControlGateInput {
  /** The runner for this surface is ready (edit ready and the runner exists). */
  readonly ready: boolean;
  /** No model is connected at all. */
  readonly noModel: boolean;
  /** Why the runner is not ready, shown as the hover text when a model is connected. */
  readonly readinessText: string;
  /** The run cannot start right now (unavailable entry, another run in progress). */
  readonly blocked: boolean;
}

export interface RunControlGate {
  readonly disabled: boolean;
  /** Hover text of the control; undefined when the control is enabled. */
  readonly title: string | undefined;
  /** A click on the card should open the connect step. */
  readonly opensConnect: boolean;
}

/** The state of one Run control. No model wins over every other reason. */
export function runControlGate(input: RunControlGateInput): RunControlGate {
  if (input.noModel)
    return { disabled: true, title: CONNECT_MODEL_FIRST_TITLE, opensConnect: true };
  if (!input.ready) return { disabled: true, title: input.readinessText, opensConnect: false };
  if (input.blocked) return { disabled: true, title: undefined, opensConnect: false };
  return { disabled: false, title: undefined, opensConnect: false };
}

export interface RunStartAnnouncer {
  /** Feed every checkpoint of the run; the announcement happens once, on the first `started`. */
  observe(checkpoint: { readonly state: string }): void;
}

/**
 * Calls `announce` once, when the run reports its first `started` checkpoint.
 * A run refused before it starts (unavailable, blocked) never announces.
 */
export function createRunStartAnnouncer(announce: () => void): RunStartAnnouncer {
  let announced = false;
  return {
    observe(checkpoint) {
      if (announced || checkpoint.state !== 'started') return;
      announced = true;
      announce();
    },
  };
}
