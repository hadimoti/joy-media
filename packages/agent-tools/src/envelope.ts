/**
 * Command envelope for agent-issued edits.
 *
 * Until now an agent step reached the timeline as a bare `SpikeCommand`: no
 * identity, no actor, no revision. Two consequences mattered. A plan built
 * against one version of the project could be executed against a newer one and
 * would silently edit stale content; and nothing in the persisted log recorded
 * that an agent — rather than the user — made the edit.
 *
 * This is deliberately the *minimum* envelope for the first agentic vertical
 * slice, not the full P01 hardening that `@joy-media/commands` reserves for the
 * core command bus. It wraps agent commands only. Human edits still go through
 * `EditorSession.dispatchTimeline` unchanged, so nothing here changes the
 * behaviour of the editor's own undo stack.
 */

import type { Precondition } from './types.js';

export const AGENT_COMMAND_SCHEMA_VERSION = '1.0' as const;

/**
 * Opaque immutable project revision id.
 *
 * ADR-0012 already models collaboration revisions as string ids. Keeping the
 * agent contract opaque lets a local persisted revision and a future accepted
 * collaboration head use the same envelope field without another schema
 * migration.
 */
export type ProjectRevisionId = string;

/** Who issued the command. Recorded so the audit trail can distinguish them. */
export interface AgentActor {
  readonly type: 'agent' | 'human' | 'plugin';
  /** Adapter or user id. Historical values remain readable for migrations. */
  readonly id: string;
}

export interface AgentCommandEnvelope<TParams = unknown> {
  readonly schemaVersion: typeof AGENT_COMMAND_SCHEMA_VERSION;
  /** Unique per command instance; distinct from `idempotencyKey`. */
  readonly commandId: string;
  readonly projectId: string;
  /**
   * Project revision the plan was built against. Commit is refused if the
   * project has moved on — see `checkBaseRevision`.
   */
  readonly baseRevision: ProjectRevisionId;
  /** Groups every command of one plan into a single undoable transaction. */
  readonly transactionId: string;
  /** Stable across retries of the same logical step, so replay is a no-op. */
  readonly idempotencyKey: string;
  readonly actor: AgentActor;
  readonly preconditions: readonly Precondition[];
  /** Domain command type, e.g. `timeline.trimClipEnd`. */
  readonly type: string;
  readonly params: TParams;
}

export interface EnvelopeOptions<TParams> {
  readonly commandId?: string;
  readonly projectId: string;
  readonly baseRevision: ProjectRevisionId;
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly actor: AgentActor;
  readonly preconditions?: readonly Precondition[];
  readonly type: string;
  readonly params: TParams;
}

let envelopeCounter = 0;

export function createEnvelope<TParams>(
  options: EnvelopeOptions<TParams>,
): AgentCommandEnvelope<TParams> {
  return {
    schemaVersion: AGENT_COMMAND_SCHEMA_VERSION,
    commandId: options.commandId ?? `cmd-${++envelopeCounter}-${Date.now()}`,
    projectId: options.projectId,
    baseRevision: options.baseRevision,
    transactionId: options.transactionId,
    idempotencyKey: options.idempotencyKey,
    actor: options.actor,
    preconditions: options.preconditions ?? [],
    type: options.type,
    params: options.params,
  };
}

export interface EnvelopeValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Structural check only — it does not evaluate preconditions or compare
 * revisions, because both need project state this module deliberately avoids.
 */
export function validateEnvelope(envelope: AgentCommandEnvelope): EnvelopeValidation {
  const errors: string[] = [];

  if (envelope.schemaVersion !== AGENT_COMMAND_SCHEMA_VERSION) {
    errors.push(
      `unsupported schemaVersion "${String(envelope.schemaVersion)}" (expected ${AGENT_COMMAND_SCHEMA_VERSION})`,
    );
  }
  for (const field of [
    'commandId',
    'projectId',
    'transactionId',
    'idempotencyKey',
    'type',
  ] as const) {
    const value = envelope[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`${field} is required`);
    }
  }
  if (typeof envelope.baseRevision !== 'string' || envelope.baseRevision.trim().length === 0) {
    errors.push('baseRevision must be a non-empty revision id');
  }
  if (
    envelope.actor === undefined ||
    typeof envelope.actor.id !== 'string' ||
    envelope.actor.id === ''
  ) {
    errors.push('actor.id is required');
  } else if (!['agent', 'human', 'plugin'].includes(envelope.actor.type)) {
    errors.push(`invalid actor.type "${envelope.actor.type}"`);
  }
  if (!Array.isArray(envelope.preconditions)) {
    errors.push('preconditions must be an array');
  }

  return { valid: errors.length === 0, errors };
}

/** Raised when the project moved on between planning and commit. */
export class RevisionConflictError extends Error {
  readonly code = 'AGENT_REVISION_CONFLICT';
  readonly baseRevision: ProjectRevisionId;
  readonly currentRevision: ProjectRevisionId;

  constructor(baseRevision: ProjectRevisionId, currentRevision: ProjectRevisionId) {
    super(
      `plan was built against revision ${baseRevision} but the project is now at ${currentRevision}; re-plan against the current state`,
    );
    this.name = 'RevisionConflictError';
    this.baseRevision = baseRevision;
    this.currentRevision = currentRevision;
  }
}

/**
 * Fails loudly rather than editing stale content. Called immediately before
 * commit, so the window between the check and the write is as small as it can
 * be on a single-threaded client.
 */
export function checkBaseRevision(
  baseRevision: ProjectRevisionId,
  currentRevision: ProjectRevisionId,
): void {
  if (baseRevision !== currentRevision) {
    throw new RevisionConflictError(baseRevision, currentRevision);
  }
}
