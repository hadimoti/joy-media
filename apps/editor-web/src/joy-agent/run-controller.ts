import {
  JOY_AGENT_RUN_EVENT_VERSION,
  isAllowedJoyAgentRunTransition,
  isJoyAgentRunEvent,
  isNextEvent,
  isSafeJoyAgentRunDisplayText,
  isSafeJoyAgentRunOpaqueId,
  isTerminalJoyAgentRunState,
  cloneJoyAgentRunArtifactReferences,
  cloneJoyAgentRunEvent,
  type JoyAgentActiveRunState,
  type JoyAgentRunArtifactReference,
  type JoyAgentRunErrorCode,
  type JoyAgentRunEvent,
  type JoyAgentRunState,
  type RunScope,
} from './run-events.js';

export const JOY_AGENT_RUN_CONTROLLER_VERSION = 1 as const;

/**
 * Snapshot exposed to React and checkpoint storage. It is read-only display
 * state: an artifact reference is never a prepared-change approval handle.
 */
export interface JoyAgentRunRecord {
  readonly scope: RunScope;
  readonly state: JoyAgentActiveRunState;
  readonly changeSetVersion: number;
  readonly artifacts: readonly JoyAgentRunArtifactReference[];
  readonly updatedAt: string;
  readonly display?: string;
  readonly errorCode?: JoyAgentRunErrorCode;
}

export interface JoyAgentRunControllerSnapshot {
  readonly version: typeof JOY_AGENT_RUN_CONTROLLER_VERSION;
  readonly projectId: string;
  readonly conversationId: string;
  readonly state: JoyAgentRunState;
  readonly run?: JoyAgentRunRecord;
}

export interface JoyAgentRunControllerStart {
  readonly runId: string;
  readonly epoch: number;
  readonly at: string;
  readonly state?: Extract<JoyAgentActiveRunState, 'inspecting' | 'preparing'>;
  readonly display?: string;
}

export type JoyAgentRunEventRejectionReason =
  | 'invalid-event'
  | 'no-active-run'
  | 'scope-mismatch'
  | 'non-monotonic-sequence'
  | 'invalid-transition'
  | 'change-set-regression'
  | 'prepared-change-conflict'
  | 'false-cancel-after-commit';

export interface JoyAgentRunEventAcceptance {
  readonly accepted: boolean;
  readonly snapshot: JoyAgentRunControllerSnapshot;
  readonly reason?: JoyAgentRunEventRejectionReason;
}

export interface JoyAgentRunController {
  getSnapshot(): JoyAgentRunControllerSnapshot;
  subscribe(listener: () => void): () => void;
  start(input: JoyAgentRunControllerStart): JoyAgentRunControllerSnapshot;
  accept(event: unknown): JoyAgentRunEventAcceptance;
  requestCancel(at: string, display?: string): JoyAgentRunEventAcceptance;
  interrupt(at: string, display?: string): JoyAgentRunEventAcceptance;
  /** Reload never resumes an in-flight authority or an old approval. */
  restore(checkpoint: unknown, at: string): boolean;
}

export interface JoyAgentRunControllerOptions {
  readonly projectId: string;
  readonly conversationId: string;
}

/**
 * Project-scoped lifecycle authority which survives a dock-panel remount.
 * It owns only lifecycle metadata; the canonical compiler, PreparedChangeStore
 * and EditorSession remain separate trusted authorities.
 */
export function createJoyAgentRunController(
  options: JoyAgentRunControllerOptions,
): JoyAgentRunController {
  if (!isSafeJoyAgentRunOpaqueId(options.projectId))
    throw new TypeError('JOY_AGENT_RUN_PROJECT_INVALID');
  if (!isSafeJoyAgentRunOpaqueId(options.conversationId))
    throw new TypeError('JOY_AGENT_RUN_CONVERSATION_INVALID');

  const listeners = new Set<() => void>();
  const highestEpochByRunId = new Map<string, number>();
  let snapshot = freezeSnapshot({
    version: JOY_AGENT_RUN_CONTROLLER_VERSION,
    projectId: options.projectId,
    conversationId: options.conversationId,
    state: 'idle',
  });

  const publish = (next: JoyAgentRunControllerSnapshot): void => {
    if (snapshotEquals(snapshot, next)) return;
    snapshot = freezeSnapshot(next);
    for (const listener of listeners) listener();
  };

  const rejection = (reason: JoyAgentRunEventRejectionReason): JoyAgentRunEventAcceptance =>
    freezeAcceptance({ accepted: false, reason, snapshot });

  const accept = (candidate: unknown): JoyAgentRunEventAcceptance => {
    if (!isJoyAgentRunEvent(candidate)) return rejection('invalid-event');
    const event = cloneJoyAgentRunEvent(candidate);
    const current = snapshot.run;
    if (current === undefined) return rejection('no-active-run');
    if (
      event.scope.projectId !== snapshot.projectId ||
      event.scope.runId !== current.scope.runId ||
      event.scope.epoch !== current.scope.epoch
    ) {
      return rejection('scope-mismatch');
    }
    if (!isNextEvent(current.scope, event.scope)) return rejection('non-monotonic-sequence');
    if (!isAllowedJoyAgentRunTransition(current.state, event.state))
      return rejection('invalid-transition');

    const nextChangeSetVersion = event.changeSetVersion ?? current.changeSetVersion;
    if (nextChangeSetVersion < current.changeSetVersion) return rejection('change-set-regression');
    if (hasPreparedChangeConflict(current, event, nextChangeSetVersion))
      return rejection('prepared-change-conflict');
    // A terminal cancellation must never add a receipt while claiming that no
    // commit occurred. Check the merged artifact view, not only the prior
    // checkpoint, because a late valid-shaped event may carry the receipt.
    if (
      event.state === 'cancelled' &&
      hasCommittedReceipt(mergeArtifacts(current.artifacts, event.artifacts))
    )
      return rejection('false-cancel-after-commit');

    const nextRun = runRecordFromEvent(current, event, nextChangeSetVersion);
    publish({
      version: JOY_AGENT_RUN_CONTROLLER_VERSION,
      projectId: snapshot.projectId,
      conversationId: snapshot.conversationId,
      state: nextRun.state,
      run: nextRun,
    });
    return freezeAcceptance({ accepted: true, snapshot });
  };

  const localTransition = (
    state: Extract<JoyAgentActiveRunState, 'cancel-requested' | 'interrupted'>,
    at: string,
    display: string | undefined,
  ): JoyAgentRunEventAcceptance => {
    const current = snapshot.run;
    if (current === undefined || isTerminalJoyAgentRunState(current.state))
      return rejection('no-active-run');
    const event: JoyAgentRunEvent = {
      version: JOY_AGENT_RUN_EVENT_VERSION,
      scope: {
        projectId: snapshot.projectId,
        runId: current.scope.runId,
        epoch: current.scope.epoch,
        seq: current.scope.seq + 1,
      },
      state,
      at,
      changeSetVersion: current.changeSetVersion,
      ...(display === undefined ? {} : { display }),
      ...(state === 'interrupted' ? { errorCode: 'JOY_AGENT_INTERRUPTED' as const } : {}),
    };
    return accept(event);
  };

  return {
    // Snapshots are deeply frozen at every publication. Returning the stable
    // identity is required by useSyncExternalStore and cannot expose mutable
    // lifecycle authority.
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: (input) => {
      if (!isSafeJoyAgentRunOpaqueId(input.runId)) throw new TypeError('JOY_AGENT_RUN_ID_INVALID');
      if (!isPositiveSafeInteger(input.epoch)) throw new RangeError('JOY_AGENT_RUN_EPOCH_INVALID');
      if (!isSafeTimestamp(input.at)) throw new TypeError('JOY_AGENT_RUN_TIMESTAMP_INVALID');
      if (input.display !== undefined && !isSafeJoyAgentRunDisplayText(input.display))
        throw new TypeError('JOY_AGENT_RUN_DISPLAY_INVALID');
      const initialState = input.state ?? 'inspecting';
      if (initialState !== 'inspecting' && initialState !== 'preparing')
        throw new TypeError('JOY_AGENT_RUN_INITIAL_STATE_INVALID');
      if (snapshot.run !== undefined && !isTerminalJoyAgentRunState(snapshot.run.state))
        throw new Error('JOY_AGENT_RUN_ALREADY_ACTIVE');
      const previousEpoch = highestEpochByRunId.get(input.runId);
      if (previousEpoch !== undefined && input.epoch <= previousEpoch)
        throw new Error('JOY_AGENT_RUN_EPOCH_REUSED');
      highestEpochByRunId.set(input.runId, input.epoch);
      const run: JoyAgentRunRecord = {
        scope: Object.freeze({
          projectId: snapshot.projectId,
          runId: input.runId,
          epoch: input.epoch,
          seq: 0,
        }),
        state: initialState,
        changeSetVersion: 0,
        artifacts: Object.freeze([]),
        updatedAt: input.at,
        ...(input.display === undefined ? {} : { display: input.display }),
      };
      publish({
        version: JOY_AGENT_RUN_CONTROLLER_VERSION,
        projectId: snapshot.projectId,
        conversationId: snapshot.conversationId,
        state: run.state,
        run,
      });
      return cloneSnapshot(snapshot);
    },
    accept,
    requestCancel: (at, display) => {
      if (!isSafeTimestamp(at)) return rejection('invalid-event');
      if (display !== undefined && !isSafeJoyAgentRunDisplayText(display))
        return rejection('invalid-event');
      return localTransition('cancel-requested', at, display);
    },
    interrupt: (at, display) => {
      if (!isSafeTimestamp(at)) return rejection('invalid-event');
      const safeDisplay = display ?? 'Run interrupted; reconnect before continuing.';
      if (!isSafeJoyAgentRunDisplayText(safeDisplay)) return rejection('invalid-event');
      return localTransition('interrupted', at, safeDisplay);
    },
    restore: (checkpoint, at) => {
      if (!isSafeTimestamp(at) || !isJoyAgentRunControllerSnapshot(checkpoint)) return false;
      if (
        checkpoint.projectId !== snapshot.projectId ||
        checkpoint.conversationId !== snapshot.conversationId
      )
        return false;
      const restored = cloneSnapshot(checkpoint);
      const run = restored.run;
      if (run === undefined) {
        publish({
          version: JOY_AGENT_RUN_CONTROLLER_VERSION,
          projectId: snapshot.projectId,
          conversationId: restored.conversationId,
          state: 'idle',
        });
        return true;
      }
      highestEpochByRunId.set(
        run.scope.runId,
        Math.max(highestEpochByRunId.get(run.scope.runId) ?? 0, run.scope.epoch),
      );
      if (isTerminalJoyAgentRunState(run.state)) {
        publish(restored);
        return true;
      }
      // A checkpoint is only evidence. Reloading cannot resume an in-flight
      // authority or recreate a PreparedChangeStore approval handle.
      const interrupted: JoyAgentRunRecord = {
        ...run,
        state: 'interrupted',
        updatedAt: at,
        display: 'Run interrupted after reload; reconnect before continuing.',
        errorCode: 'JOY_AGENT_INTERRUPTED',
      };
      publish({
        version: JOY_AGENT_RUN_CONTROLLER_VERSION,
        projectId: snapshot.projectId,
        conversationId: restored.conversationId,
        state: 'interrupted',
        run: interrupted,
      });
      return true;
    },
  };
}

export function isJoyAgentRunControllerSnapshot(
  value: unknown,
): value is JoyAgentRunControllerSnapshot {
  if (!isRecord(value)) return false;
  const hasRun = Object.prototype.hasOwnProperty.call(value, 'run');
  const keys = ['version', 'projectId', 'conversationId', 'state', ...(hasRun ? ['run'] : [])];
  if (!hasExactKeys(value, keys)) return false;
  if (
    value.version !== JOY_AGENT_RUN_CONTROLLER_VERSION ||
    !isSafeJoyAgentRunOpaqueId(value.projectId) ||
    !isSafeJoyAgentRunOpaqueId(value.conversationId) ||
    !isRunState(value.state)
  ) {
    return false;
  }
  if (!hasRun) return value.state === 'idle';
  if (!isJoyAgentRunRecord(value.run)) return false;
  return value.state === value.run.state && value.projectId === value.run.scope.projectId;
}

export function cloneJoyAgentRunControllerSnapshot(
  snapshot: JoyAgentRunControllerSnapshot,
): JoyAgentRunControllerSnapshot {
  if (!isJoyAgentRunControllerSnapshot(snapshot))
    throw new TypeError('JOY_AGENT_RUN_SNAPSHOT_INVALID');
  return cloneSnapshot(snapshot);
}

function runRecordFromEvent(
  current: JoyAgentRunRecord,
  event: JoyAgentRunEvent,
  changeSetVersion: number,
): JoyAgentRunRecord {
  return freezeRunRecord({
    scope: event.scope,
    state: event.state,
    changeSetVersion,
    artifacts: mergeArtifacts(current.artifacts, event.artifacts),
    updatedAt: event.at,
    ...(event.display === undefined ? {} : { display: event.display }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
  });
}

function mergeArtifacts(
  current: readonly JoyAgentRunArtifactReference[],
  incoming: readonly JoyAgentRunArtifactReference[] | undefined,
): readonly JoyAgentRunArtifactReference[] {
  if (incoming === undefined || incoming.length === 0)
    return cloneJoyAgentRunArtifactReferences(current);
  const merged = new Map<string, JoyAgentRunArtifactReference>();
  for (const artifact of current) merged.set(artifactKey(artifact), artifact);
  for (const artifact of incoming) merged.set(artifactKey(artifact), artifact);
  return cloneJoyAgentRunArtifactReferences([...merged.values()]);
}

function hasPreparedChangeConflict(
  current: JoyAgentRunRecord,
  event: JoyAgentRunEvent,
  nextChangeSetVersion: number,
): boolean {
  const incomingPrepared =
    event.artifacts?.filter((artifact) => artifact.kind === 'prepared-change') ?? [];
  if (incomingPrepared.length === 0) return false;
  if (event.changeSetVersion === undefined || nextChangeSetVersion < current.changeSetVersion)
    return true;
  const currentPrepared = current.artifacts.filter(
    (artifact) => artifact.kind === 'prepared-change',
  );
  if (nextChangeSetVersion > current.changeSetVersion) return false;
  return incomingPrepared.some(
    (incoming) =>
      !currentPrepared.some((existing) => artifactKey(existing) === artifactKey(incoming)),
  );
}

function hasCommittedReceipt(artifacts: readonly JoyAgentRunArtifactReference[]): boolean {
  return artifacts.some((artifact) => artifact.kind === 'execution-receipt');
}

function artifactKey(artifact: JoyAgentRunArtifactReference): string {
  return `${artifact.kind}:${artifact.id}:${artifact.version}`;
}

function freezeAcceptance(value: JoyAgentRunEventAcceptance): JoyAgentRunEventAcceptance {
  return Object.freeze({
    accepted: value.accepted,
    snapshot: cloneSnapshot(value.snapshot),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  });
}

function freezeRunRecord(record: JoyAgentRunRecord): JoyAgentRunRecord {
  if (!isJoyAgentRunRecord(record)) throw new TypeError('JOY_AGENT_RUN_RECORD_INVALID');
  return Object.freeze({
    scope: Object.freeze({ ...record.scope }),
    state: record.state,
    changeSetVersion: record.changeSetVersion,
    artifacts: cloneJoyAgentRunArtifactReferences(record.artifacts),
    updatedAt: record.updatedAt,
    ...(record.display === undefined ? {} : { display: record.display }),
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
  });
}

function freezeSnapshot(snapshot: JoyAgentRunControllerSnapshot): JoyAgentRunControllerSnapshot {
  if (!isJoyAgentRunControllerSnapshot(snapshot))
    throw new TypeError('JOY_AGENT_RUN_SNAPSHOT_INVALID');
  return Object.freeze({
    version: JOY_AGENT_RUN_CONTROLLER_VERSION,
    projectId: snapshot.projectId,
    conversationId: snapshot.conversationId,
    state: snapshot.state,
    ...(snapshot.run === undefined ? {} : { run: freezeRunRecord(snapshot.run) }),
  });
}

function cloneSnapshot(snapshot: JoyAgentRunControllerSnapshot): JoyAgentRunControllerSnapshot {
  return freezeSnapshot(snapshot);
}

function isJoyAgentRunRecord(value: unknown): value is JoyAgentRunRecord {
  if (!isRecord(value)) return false;
  const keys = [
    'scope',
    'state',
    'changeSetVersion',
    'artifacts',
    'updatedAt',
    ...(value.display === undefined ? [] : ['display']),
    ...(value.errorCode === undefined ? [] : ['errorCode']),
  ];
  if (!hasExactKeys(value, keys)) return false;
  const event = {
    version: JOY_AGENT_RUN_EVENT_VERSION,
    scope: value.scope,
    state: value.state,
    at: value.updatedAt,
    changeSetVersion: value.changeSetVersion,
    artifacts: value.artifacts,
    ...(value.display === undefined ? {} : { display: value.display }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
  };
  return isJoyAgentRunEvent(event);
}

function isRunState(value: unknown): value is JoyAgentRunState {
  return (
    typeof value === 'string' &&
    [
      'idle',
      'inspecting',
      'preparing',
      'preview-ready',
      'awaiting-approval',
      'committing',
      'verifying',
      'completed',
      'failed',
      'cancel-requested',
      'cancelled',
      'interrupted',
    ].includes(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function snapshotEquals(
  left: JoyAgentRunControllerSnapshot,
  right: JoyAgentRunControllerSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
