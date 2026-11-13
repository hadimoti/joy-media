/**
 * "Try again" targets for Joy Code's failure cards (T-J01, review 2).
 *
 * A failure card's retry re-runs the exact request that failed. The request is
 * saved at the moment the failure is shown, under that failure message's id, so
 * a card retries its own request and never a later one. A path with no safe
 * request to replay (an apply, or a plan that already ran) saves nothing: its
 * card shows Dismiss in place of Try again.
 */
import type { AgentIntent } from './agent-panel-intents.js';
import type { LivingLooksRunInput } from './LivingLooksPanel.js';
import type { JoyCodeMessage } from './joy-code-messages.js';

/** The Look requests a baked run can start from: an apply or an update. */
export type JoyCodeBakeRequest = Extract<LivingLooksRunInput, { kind: 'apply' | 'update' }>;

export type JoyCodeRetryRequest =
  | { readonly kind: 'prompt'; readonly prompt: string }
  | { readonly kind: 'recipe'; readonly skillId: string }
  | { readonly kind: 'agent-look'; readonly prompt: string }
  | { readonly kind: 'look'; readonly request: LivingLooksRunInput }
  | { readonly kind: 'bake'; readonly request: JoyCodeBakeRequest }
  | { readonly kind: 'plan'; readonly intent: AgentIntent; readonly threadId: string };

/** The starters a retry calls. Each one runs the request it is given. */
export interface JoyCodeRetryRunners {
  readonly prompt: (prompt: string) => void;
  readonly recipe: (skillId: string) => void;
  readonly agentLook: (prompt: string) => void;
  readonly look: (request: LivingLooksRunInput) => void;
  readonly bake: (request: JoyCodeBakeRequest) => void;
  readonly plan: (intent: AgentIntent, threadId: string) => void;
}

/** Runs a saved request through the starter for its kind, with the same object. */
export function runJoyCodeRetry(request: JoyCodeRetryRequest, runners: JoyCodeRetryRunners): void {
  switch (request.kind) {
    case 'prompt':
      runners.prompt(request.prompt);
      return;
    case 'recipe':
      runners.recipe(request.skillId);
      return;
    case 'agent-look':
      runners.agentLook(request.prompt);
      return;
    case 'look':
      runners.look(request.request);
      return;
    case 'bake':
      runners.bake(request.request);
      return;
    case 'plan':
      runners.plan(request.intent, request.threadId);
      return;
  }
}

export interface JoyCodeRetryTargets {
  /** Saves the request that failed under its failure message's id. */
  save(messageId: string, request: JoyCodeRetryRequest): void;
  /** The saved request for a failure message, or undefined when it has none. */
  get(messageId: string): JoyCodeRetryRequest | undefined;
}

export function createJoyCodeRetryTargets(): JoyCodeRetryTargets {
  const saved = new Map<string, JoyCodeRetryRequest>();
  return {
    save: (messageId, request) => {
      saved.set(messageId, request);
    },
    get: (messageId) => saved.get(messageId),
  };
}

/**
 * The card for a failure with no saved request: its Try again becomes Dismiss,
 * so the card never offers a button that does nothing. Other actions stay.
 */
export function joyCodeMessageWithoutRetry(message: JoyCodeMessage): JoyCodeMessage {
  if (message.action.kind !== 'retry') return message;
  return { ...message, action: { label: 'Dismiss', kind: 'dismiss' } };
}
