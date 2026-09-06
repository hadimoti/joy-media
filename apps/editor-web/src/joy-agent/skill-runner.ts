import {
  getCreativeSkill,
  resolveCreativeSkillAvailability,
  type CreativeSkillAvailability,
  type CreativeSkillCapability,
  type CreativeSkillManifest,
  type CreativeSkillRuntime,
} from '@joy-media/agent-tools';

/** A run scope is display/lifecycle identity only; it is never an edit grant. */
export interface CreativeSkillRunScope {
  readonly projectId: string;
  readonly runId: string;
  readonly epoch: number;
  readonly revision: string;
}

export type CreativeSkillArtifactKind =
  'context' | 'evidence' | 'brief' | 'moment' | 'prepared-change' | 'preview' | 'verification';

export interface CreativeSkillArtifact {
  readonly id: string;
  readonly kind: CreativeSkillArtifactKind;
  readonly summary: string;
  readonly uncertainty?: string;
}

export interface CreativeSkillStepResult {
  readonly artifacts: readonly CreativeSkillArtifact[];
}

export interface CreativeSkillCheckpointInput {
  readonly scope: CreativeSkillRunScope;
  readonly skill: CreativeSkillManifest;
  readonly checkpoint: CreativeSkillManifest['procedure'][number];
  readonly signal: AbortSignal;
}

/**
 * Trusted adapters are injected by the host. There is deliberately no `apply`
 * function: this runner can inspect, observe, prepare, preview, and verify,
 * but the existing approval/transaction boundary remains the only commit path.
 */
export interface CreativeSkillRunAdapter {
  readonly inspect?: (input: CreativeSkillCheckpointInput) => Promise<CreativeSkillStepResult>;
  readonly observe?: (input: CreativeSkillCheckpointInput) => Promise<CreativeSkillStepResult>;
  readonly propose?: (input: CreativeSkillCheckpointInput) => Promise<CreativeSkillStepResult>;
  readonly preview?: (input: CreativeSkillCheckpointInput) => Promise<CreativeSkillStepResult>;
  readonly verify?: (input: CreativeSkillCheckpointInput) => Promise<CreativeSkillStepResult>;
}

export interface CreativeSkillCheckpointEvent {
  readonly scope: CreativeSkillRunScope;
  readonly skillId: CreativeSkillManifest['id'];
  readonly checkpointId: string;
  readonly phase: CreativeSkillManifest['procedure'][number]['phase'];
  readonly state: 'started' | 'completed' | 'blocked';
  readonly at: string;
  readonly reason?: CreativeSkillBlockReason;
}

export type CreativeSkillBlockReason =
  'cancelled' | 'stale-authority' | 'adapter-unavailable' | 'adapter-failed' | 'invalid-artifact';

export type CreativeSkillRunResult =
  | {
      readonly kind: 'unavailable';
      readonly skill: CreativeSkillManifest;
      readonly missingCapabilities: readonly CreativeSkillCapability[];
      readonly missingOperations: readonly string[];
      readonly artifacts: readonly [];
    }
  | {
      readonly kind: 'blocked';
      readonly skill: CreativeSkillManifest;
      readonly reason: CreativeSkillBlockReason;
      readonly artifacts: readonly CreativeSkillArtifact[];
    }
  | {
      readonly kind: 'completed' | 'ready-for-approval';
      readonly skill: CreativeSkillManifest;
      readonly artifacts: readonly CreativeSkillArtifact[];
    };

export interface CreativeSkillRunInput {
  readonly skillId: string;
  readonly scope: CreativeSkillRunScope;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: CreativeSkillCheckpointEvent) => void;
}

export interface CreativeSkillRunnerOptions {
  readonly runtime: CreativeSkillRuntime;
  readonly adapter: CreativeSkillRunAdapter;
  /** Re-read trusted run/project authority before and after every async effect. */
  readonly isAuthorityCurrent: (scope: CreativeSkillRunScope) => boolean;
  readonly now?: () => string;
}

export interface CreativeSkillRunner {
  list(): readonly CreativeSkillAvailability[];
  run(input: CreativeSkillRunInput): Promise<CreativeSkillRunResult>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,255}$/;
const ARTIFACT_KINDS = new Set<CreativeSkillArtifactKind>([
  'context',
  'evidence',
  'brief',
  'moment',
  'prepared-change',
  'preview',
  'verification',
]);
const UNSAFE_TEXT =
  /(?:https?:\/\/|(?:^|[^a-z])(?:file|blob|data):|\b(?:api[ _-]?key|authorization|bearer|password|secret|credential)\b|\b[A-Za-z]:[\\/])/i;

/**
 * Create the host-owned recipe runner. It is intentionally small: provider
 * reasoning remains in the single Worker, while this layer turns actual host
 * effects into lifecycle events without a hidden alternate executor.
 */
export function createCreativeSkillRunner(
  options: CreativeSkillRunnerOptions,
): CreativeSkillRunner {
  if (typeof options.isAuthorityCurrent !== 'function')
    throw new TypeError('JOY_CREATIVE_SKILL_AUTHORITY_REQUIRED');
  const now = options.now ?? (() => new Date().toISOString());
  const availability = (): readonly CreativeSkillAvailability[] =>
    resolveCreativeSkillAvailability(options.runtime);

  const isCurrent = (scope: CreativeSkillRunScope): boolean => {
    try {
      return options.isAuthorityCurrent(scope);
    } catch {
      return false;
    }
  };

  return {
    list: availability,
    async run(input) {
      assertScope(input.scope);
      const skill = getCreativeSkill(input.skillId);
      if (skill === undefined) throw new TypeError('JOY_CREATIVE_SKILL_UNKNOWN');
      const state = availability().find((item) => item.skill.id === skill.id);
      if (state === undefined) throw new TypeError('JOY_CREATIVE_SKILL_UNREGISTERED');
      if (!state.available)
        return Object.freeze({
          kind: 'unavailable' as const,
          skill,
          missingCapabilities: Object.freeze([...state.missingCapabilities]),
          missingOperations: Object.freeze([...state.missingOperations]),
          artifacts: Object.freeze([]) as readonly [],
        });

      const signal = input.signal;
      const artifacts: CreativeSkillArtifact[] = [];
      for (const checkpoint of skill.procedure) {
        const blocked = currentBlockReason(input.scope, signal, isCurrent);
        if (blocked !== undefined) {
          emit(input, skill, checkpoint, 'blocked', now, blocked);
          return blockedResult(skill, blocked);
        }
        const handler = handlerForPhase(options.adapter, checkpoint.phase);
        if (handler === undefined) {
          emit(input, skill, checkpoint, 'blocked', now, 'adapter-unavailable');
          return blockedResult(skill, 'adapter-unavailable');
        }
        emit(input, skill, checkpoint, 'started', now);
        let step: CreativeSkillStepResult;
        try {
          step = await handler(
            Object.freeze({
              scope: input.scope,
              skill,
              checkpoint,
              signal: signal ?? new AbortController().signal,
            }),
          );
        } catch {
          const reason = currentBlockReason(input.scope, signal, isCurrent) ?? 'adapter-failed';
          emit(input, skill, checkpoint, 'blocked', now, reason);
          return blockedResult(skill, reason);
        }
        const after = currentBlockReason(input.scope, signal, isCurrent);
        if (after !== undefined) {
          emit(input, skill, checkpoint, 'blocked', now, after);
          return blockedResult(skill, after);
        }
        const safeArtifacts = normalizeArtifacts(step);
        if (safeArtifacts === undefined) {
          emit(input, skill, checkpoint, 'blocked', now, 'invalid-artifact');
          return blockedResult(skill, 'invalid-artifact');
        }
        artifacts.push(...safeArtifacts);
        emit(input, skill, checkpoint, 'completed', now);
      }
      const completeArtifacts = Object.freeze([...artifacts]);
      const readyForApproval = completeArtifacts.some(
        (artifact) => artifact.kind === 'prepared-change',
      );
      return Object.freeze({
        kind: readyForApproval ? ('ready-for-approval' as const) : ('completed' as const),
        skill,
        artifacts: completeArtifacts,
      });
    },
  };
}

function currentBlockReason(
  scope: CreativeSkillRunScope,
  signal: AbortSignal | undefined,
  isCurrent: (scope: CreativeSkillRunScope) => boolean,
): CreativeSkillBlockReason | undefined {
  if (signal?.aborted) return 'cancelled';
  return isCurrent(scope) ? undefined : 'stale-authority';
}

function emit(
  input: CreativeSkillRunInput,
  skill: CreativeSkillManifest,
  checkpoint: CreativeSkillManifest['procedure'][number],
  state: CreativeSkillCheckpointEvent['state'],
  now: () => string,
  reason?: CreativeSkillBlockReason,
): void {
  try {
    input.onEvent?.(
      Object.freeze({
        scope: Object.freeze({ ...input.scope }),
        skillId: skill.id,
        checkpointId: checkpoint.id,
        phase: checkpoint.phase,
        state,
        at: now(),
        ...(reason === undefined ? {} : { reason }),
      }),
    );
  } catch {
    // UI observation cannot create or cancel a host capability path.
  }
}

function blockedResult(
  skill: CreativeSkillManifest,
  reason: CreativeSkillBlockReason,
): CreativeSkillRunResult {
  return Object.freeze({
    kind: 'blocked' as const,
    skill,
    reason,
    // Do not publish a partial effect list when the run authority ceased to be current.
    artifacts: Object.freeze([]),
  });
}

function normalizeArtifacts(value: unknown): readonly CreativeSkillArtifact[] | undefined {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.prototype.hasOwnProperty.call(value, 'artifacts') ||
    Object.keys(value).length !== 1 ||
    !Array.isArray((value as Record<string, unknown>).artifacts)
  )
    return undefined;
  const rawArtifacts = (value as Record<string, unknown>).artifacts as unknown[];
  if (rawArtifacts.length > 64) return undefined;
  const ids = new Set<string>();
  const artifacts: CreativeSkillArtifact[] = [];
  for (const candidate of rawArtifacts) {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      !hasArtifactFields(candidate as Record<string, unknown>)
    )
      return undefined;
    const record = candidate as Record<string, unknown>;
    if (
      !isSafeId(record.id) ||
      typeof record.kind !== 'string' ||
      !ARTIFACT_KINDS.has(record.kind as CreativeSkillArtifactKind) ||
      !isSafeText(record.summary, 512) ||
      (record.uncertainty !== undefined && !isSafeText(record.uncertainty, 512)) ||
      ids.has(record.id)
    )
      return undefined;
    ids.add(record.id);
    artifacts.push(
      Object.freeze({
        id: record.id,
        kind: record.kind as CreativeSkillArtifactKind,
        summary: record.summary,
        ...(record.uncertainty === undefined ? {} : { uncertainty: record.uncertainty as string }),
      }),
    );
  }
  return Object.freeze(artifacts);
}

function handlerForPhase(
  adapter: CreativeSkillRunAdapter,
  phase: CreativeSkillManifest['procedure'][number]['phase'],
): ((input: CreativeSkillCheckpointInput) => Promise<CreativeSkillStepResult>) | undefined {
  switch (phase) {
    case 'inspect':
      return adapter.inspect;
    case 'observe':
      return adapter.observe;
    case 'propose':
      return adapter.propose;
    case 'preview':
      return adapter.preview;
    case 'verify':
      return adapter.verify;
  }
}

function assertScope(scope: CreativeSkillRunScope): void {
  if (
    !isSafeId(scope.projectId) ||
    !isSafeId(scope.runId) ||
    !Number.isSafeInteger(scope.epoch) ||
    scope.epoch < 1 ||
    !isSafeId(scope.revision)
  )
    throw new TypeError('JOY_CREATIVE_SKILL_SCOPE_INVALID');
}

function hasArtifactFields(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  const expected = new Set([
    'id',
    'kind',
    'summary',
    ...(value.uncertainty === undefined ? [] : ['uncertainty']),
  ]);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function isSafeText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !UNSAFE_TEXT.test(value)
  );
}
