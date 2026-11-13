/**
 * Plain messages for every Joy Code failure (T-J01, owner items OB-13a and OB-13c).
 *
 * One table holds every reason and failure code the Joy Code surface can show.
 * Each entry has a title, one plain sentence and one action button. A raw code
 * is never shown to the owner: the code goes to the log, and the owner reads
 * the sentence. The table is typed against the real unions, so a new reason or
 * code without an entry fails the typecheck, and the unit test reads the same
 * runtime lists so a missing entry fails the test too.
 */
import {
  CREATIVE_SKILL_BLOCK_REASONS,
  type CreativeSkillBlockReason,
} from './joy-agent/skill-runner.js';
import {
  CREATIVE_SKILL_HOST_FAILURE_CODES,
  type CreativeSkillHostFailureCode,
} from './joy-agent/creative-skill-host-adapter.js';
import { JOY_AGENT_RUN_ERROR_CODES, type JoyAgentRunErrorCode } from './joy-agent/run-events.js';

export type JoyCodeActionKind = 'retry' | 'open-settings' | 'dismiss';

export interface JoyCodeMessage {
  /** Short heading for the card. */
  readonly title: string;
  /** One plain sentence for a graphic designer. Never a code or an internal name. */
  readonly sentence: string;
  /** The single action button on the card. */
  readonly action: { readonly label: string; readonly kind: JoyCodeActionKind };
}

/** Message keys that are not reasons or codes: the surfaces that stop on their own. */
export const JOY_CODE_UI_MESSAGE_KEYS = [
  'no-model',
  'recipe-unavailable',
  'recipe-temporarily-unavailable',
  'look-no-operations',
  'look-invalid-proposal',
  'look-compile-failed',
  'look-staging-failed',
  'look-unknown',
  'unexpected-failure',
] as const;

export type JoyCodeUiMessageKey = (typeof JOY_CODE_UI_MESSAGE_KEYS)[number];

/** Every key the table must hold: block reasons, host failure codes, run error codes and UI keys. */
export type JoyCodeMessageKey =
  | CreativeSkillBlockReason
  | CreativeSkillHostFailureCode
  | JoyAgentRunErrorCode
  | JoyCodeUiMessageKey;

const NOTHING_APPLIED = 'No edits were applied.';

const TRY_AGAIN = { label: 'Try again', kind: 'retry' } as const;
const DISMISS = { label: 'Dismiss', kind: 'dismiss' } as const;
const CONNECT = { label: 'Connect a model', kind: 'open-settings' } as const;

const SOURCE_NOT_READ: JoyCodeMessage = {
  title: 'Joy Code could not read the source',
  sentence: `Joy Code could not read enough of the source to finish. ${NOTHING_APPLIED}`,
  action: TRY_AGAIN,
};

export const JOY_CODE_MESSAGES: Readonly<Record<JoyCodeMessageKey, JoyCodeMessage>> = {
  // Recipe runner: reasons a run can stop before a result.
  cancelled: {
    title: 'Run stopped',
    sentence: `You stopped this run. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  'stale-authority': {
    title: 'The project changed',
    sentence: `The project changed while Joy Code was working. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  'adapter-unavailable': {
    title: 'Part of Joy Code is missing',
    sentence: `This step needs a part of Joy Code that this build does not have. ${NOTHING_APPLIED}`,
    action: DISMISS,
  },
  'adapter-failed': {
    title: 'Joy Code could not finish',
    sentence: `Joy Code could not finish this step. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  'invalid-artifact': {
    title: 'The result was not safe to use',
    sentence: `Joy Code's result did not pass its safety check. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },

  // Host adapter failure codes (creative-skill-host-adapter.ts).
  OBSERVATION_MISSING_EVIDENCE: SOURCE_NOT_READ,
  OBSERVATION_MISSING_COVERAGE: SOURCE_NOT_READ,
  OBSERVATION_INCOMPLETE_COVERAGE: SOURCE_NOT_READ,
  OBSERVATION_MISSING_MOMENT: SOURCE_NOT_READ,
  NO_PREPARED_CHANGE: {
    title: 'No change was ready',
    sentence: `Joy Code could not prepare a change for this request. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  PREVIEW_WITHOUT_PREPARED_CHANGE: {
    title: 'The preview is not ready',
    sentence: `The preview was asked for before a change was ready. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  PREVIEW_NOT_RENDERED: {
    title: 'The preview did not appear',
    sentence: `The preview could not be shown on screen. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },

  // Run error codes (run-events.ts). The engine's provider mapping feeds these.
  JOY_AGENT_ABORTED: {
    title: 'Run stopped',
    sentence: `You stopped this run. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  JOY_AGENT_TIMEOUT: {
    title: 'The model took too long',
    sentence: `The model did not answer in time. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  JOY_AGENT_CORS_OR_NETWORK: {
    title: 'You are offline',
    sentence: `You appear to be offline, or the model cannot be reached. ${NOTHING_APPLIED}`,
    action: { label: 'Retry', kind: 'retry' },
  },
  JOY_AGENT_AUTH_FAILED: {
    title: 'Your sign-in has expired',
    sentence: `Your sign-in has expired, or the model rejected your key. ${NOTHING_APPLIED}`,
    action: { label: 'Sign in again', kind: 'open-settings' },
  },
  JOY_AGENT_BILLING_REQUIRED: {
    title: 'The model account needs attention',
    sentence: `Your model account is out of credit or has reached its usage limit. ${NOTHING_APPLIED}`,
    action: { label: 'Open Agent Settings', kind: 'open-settings' },
  },
  JOY_AGENT_RESPONSE_TOO_LARGE: {
    title: 'The model answer was too large',
    sentence: `The model's answer was too large to use. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  JOY_AGENT_INVALID_TOOL: {
    title: 'The model asked for something Joy Code cannot do',
    sentence: `The model asked for an action Joy Code cannot run. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  JOY_AGENT_INVALID_PROPOSAL: {
    title: 'Joy Code could not check the change',
    sentence: `Joy Code could not check this change safely. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  JOY_AGENT_STALE_REVISION: {
    title: 'The project changed',
    sentence: `The project changed while Joy Code was working. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  JOY_AGENT_PROVIDER_INCOMPATIBLE: {
    title: 'This model cannot run Joy Code',
    sentence: `This model cannot run Joy Code's edit tools. ${NOTHING_APPLIED}`,
    action: { label: 'Choose another model', kind: 'open-settings' },
  },
  JOY_AGENT_INTERRUPTED: {
    title: 'The run was interrupted',
    sentence: `Joy Code was interrupted before it finished. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  JOY_AGENT_VERIFICATION_FAILED: {
    title: 'The edit did not pass its checks',
    sentence: `The finished edit did not pass its checks. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },

  // Surfaces that stop on their own.
  'no-model': {
    title: 'Joy Code needs a model',
    sentence:
      'No AI model is connected. Connect one in Agent Settings to edit by describing what you want.',
    action: CONNECT,
  },
  'recipe-unavailable': {
    title: 'Recipe not available',
    sentence: `This recipe needs a part of Joy Code that this build does not have yet. ${NOTHING_APPLIED}`,
    action: DISMISS,
  },
  'recipe-temporarily-unavailable': {
    title: 'Recipes are paused',
    sentence: `Recipes are paused while Joy Code finishes its safety checks. Describe the change in Edit instead. ${NOTHING_APPLIED}`,
    action: DISMISS,
  },
  'look-no-operations': {
    title: 'No change to apply',
    sentence: `The request did not produce a change Joy Code can apply. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  'look-invalid-proposal': {
    title: 'Joy Code could not check the change',
    sentence: `Joy Code could not check this change safely. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  'look-compile-failed': {
    title: 'The look could not be built',
    sentence: `Joy Code could not turn this look into a safe change. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  'look-staging-failed': {
    title: 'The preview could not be prepared',
    sentence: `Joy Code could not prepare the preview. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  'look-unknown': {
    title: 'Joy Code could not prepare this',
    sentence: `Joy Code could not prepare a safe change from this request. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
  'unexpected-failure': {
    title: 'Joy Code stopped',
    sentence: `Joy Code could not finish this run safely. ${NOTHING_APPLIED}`,
    action: TRY_AGAIN,
  },
};

/** The message for a recipe run that stopped with a block reason. */
export function joyCodeMessageForBlockReason(reason: string): JoyCodeMessage {
  return (CREATIVE_SKILL_BLOCK_REASONS as readonly string[]).includes(reason)
    ? JOY_CODE_MESSAGES[reason as CreativeSkillBlockReason]
    : JOY_CODE_MESSAGES['unexpected-failure'];
}

/** The message for a Look run that was blocked. The Look host reports its reason as text. */
export function joyCodeMessageForLookBlockReason(reason: string): JoyCodeMessage {
  if (reason === 'stale-authority' || reason === 'LOOK_PREVIEW_AUTHORITY_LOST')
    return JOY_CODE_MESSAGES['stale-authority'];
  if (reason === 'no-operations') return JOY_CODE_MESSAGES['look-no-operations'];
  if (reason === 'invalid-proposal') return JOY_CODE_MESSAGES['look-invalid-proposal'];
  if (reason === 'compile-failed' || reason.startsWith('LOOK_COMPILE_'))
    return JOY_CODE_MESSAGES['look-compile-failed'];
  if (reason === 'staging-failed' || reason === 'staging-rejected')
    return JOY_CODE_MESSAGES['look-staging-failed'];
  return JOY_CODE_MESSAGES['look-unknown'];
}

/** The message for a run error code. Unknown codes fall back to the generic message. */
export function joyCodeMessageForRunError(code: unknown): JoyCodeMessage {
  return (JOY_AGENT_RUN_ERROR_CODES as readonly unknown[]).includes(code)
    ? JOY_CODE_MESSAGES[code as JoyAgentRunErrorCode]
    : JOY_CODE_MESSAGES['unexpected-failure'];
}

/**
 * The message for a thrown error. Only a run error code carried on the error
 * picks a message; the error's own text is never shown, because it can name
 * internal codes and paths.
 */
export function joyCodeMessageForThrown(error: unknown): JoyCodeMessage {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return joyCodeMessageForRunError(code);
}

/**
 * The message for a host failure. The thrown text is `CODE` or `CODE:reason`;
 * only the code picks the message, and the reason stays out of the sentence.
 */
export function joyCodeMessageForHostFailure(thrown: string): JoyCodeMessage {
  const code = thrown.split(':', 1)[0] ?? '';
  return (CREATIVE_SKILL_HOST_FAILURE_CODES as readonly string[]).includes(code)
    ? JOY_CODE_MESSAGES[code as CreativeSkillHostFailureCode]
    : JOY_CODE_MESSAGES['unexpected-failure'];
}
