/**
 * Small, serialisable lifecycle vocabulary for one project-owned JOY run.
 *
 * These values intentionally carry only opaque identities, bounded display
 * text and safe result references. Provider configuration, prompt/context
 * payloads, approval handles and editor writer capabilities never belong in
 * this event stream.
 */
export const JOY_AGENT_RUN_EVENT_VERSION = 1 as const;

export const JOY_AGENT_RUN_STATES = [
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
] as const;

export type JoyAgentRunState = (typeof JOY_AGENT_RUN_STATES)[number];
export type JoyAgentActiveRunState = Exclude<JoyAgentRunState, 'idle'>;

export const JOY_AGENT_RUN_ARTIFACT_KINDS = [
  'prepared-change',
  'execution-receipt',
  'verification',
] as const;

export type JoyAgentRunArtifactKind = (typeof JOY_AGENT_RUN_ARTIFACT_KINDS)[number];

export const JOY_AGENT_RUN_ERROR_CODES = [
  'JOY_AGENT_ABORTED',
  'JOY_AGENT_TIMEOUT',
  'JOY_AGENT_CORS_OR_NETWORK',
  'JOY_AGENT_AUTH_FAILED',
  'JOY_AGENT_RATE_LIMITED',
  'JOY_AGENT_MODEL_NOT_FOUND',
  'JOY_AGENT_UPSTREAM_UNAVAILABLE',
  'JOY_AGENT_UNKNOWN',
  'JOY_AGENT_RESPONSE_TOO_LARGE',
  'JOY_AGENT_INVALID_TOOL',
  'JOY_AGENT_INVALID_PROPOSAL',
  'JOY_AGENT_STALE_REVISION',
  'JOY_AGENT_PROVIDER_INCOMPATIBLE',
  'JOY_AGENT_INTERRUPTED',
  'JOY_AGENT_VERIFICATION_FAILED',
] as const;

export type JoyAgentRunErrorCode = (typeof JOY_AGENT_RUN_ERROR_CODES)[number];

/** Exact route for an externally produced lifecycle event. */
export interface RunScope {
  readonly projectId: string;
  readonly runId: string;
  readonly epoch: number;
  readonly seq: number;
}

/**
 * A display-safe reference to a trusted host artifact. It is not authority to
 * read, preview, commit or approve the referenced thing.
 */
export interface JoyAgentRunArtifactReference {
  readonly kind: JoyAgentRunArtifactKind;
  readonly id: string;
  /** Monotonic host-side version, such as a prepared change-set generation. */
  readonly version: number;
}

/**
 * One observed lifecycle fact. The controller accepts only an event whose
 * scope is strictly newer within the exact project/run/epoch tuple.
 */
export interface JoyAgentRunEvent {
  readonly version: typeof JOY_AGENT_RUN_EVENT_VERSION;
  readonly scope: RunScope;
  readonly state: JoyAgentActiveRunState;
  readonly at: string;
  readonly display?: string;
  readonly errorCode?: JoyAgentRunErrorCode;
  readonly changeSetVersion?: number;
  readonly artifacts?: readonly JoyAgentRunArtifactReference[];
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,255}$/;
const MAX_DISPLAY_CHARS = 512;
const MAX_ARTIFACTS = 32;
const UNSAFE_TEXT =
  /(?:bearer\s+|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|https?:\/\/|blob:|data:|file:|opfs:|(?:[A-Za-z]:[\\/]|\\\\)[^\s]+)/i;

const RUN_STATES = new Set<string>(JOY_AGENT_RUN_STATES);
const ARTIFACT_KINDS = new Set<string>(JOY_AGENT_RUN_ARTIFACT_KINDS);
const ERROR_CODES = new Set<string>(JOY_AGENT_RUN_ERROR_CODES);

const TRANSITIONS: Readonly<Record<JoyAgentRunState, readonly JoyAgentActiveRunState[]>> = {
  idle: ['inspecting', 'preparing', 'failed', 'interrupted'],
  // A bounded answer or clarification can complete after inspection without
  // preparing an edit. It still has no writer authority or preview artifact.
  inspecting: ['inspecting', 'preparing', 'completed', 'cancel-requested', 'failed', 'interrupted'],
  preparing: [
    'preparing',
    'preview-ready',
    'completed',
    'cancel-requested',
    'failed',
    'interrupted',
  ],
  'preview-ready': [
    'preview-ready',
    'preparing',
    'awaiting-approval',
    'cancel-requested',
    'failed',
    'interrupted',
  ],
  'awaiting-approval': [
    'awaiting-approval',
    'committing',
    'cancel-requested',
    'failed',
    'interrupted',
  ],
  committing: ['committing', 'verifying', 'completed', 'cancel-requested', 'failed', 'interrupted'],
  verifying: ['verifying', 'completed', 'cancel-requested', 'failed', 'interrupted'],
  'cancel-requested': [
    'cancel-requested',
    'cancelled',
    'verifying',
    'completed',
    'failed',
    'interrupted',
  ],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export function isTerminalJoyAgentRunState(state: JoyAgentRunState): boolean {
  return (
    state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted'
  );
}

export function isAllowedJoyAgentRunTransition(
  current: JoyAgentRunState,
  next: JoyAgentActiveRunState,
): boolean {
  return TRANSITIONS[current].includes(next);
}

/**
 * This deliberately allows a gap: a bounded Worker or host may coalesce
 * intermediate UI events, but it can never resend or reorder an old event.
 */
export function isNextEvent(current: RunScope, next: RunScope): boolean {
  return (
    isRunScope(current) &&
    isRunScope(next) &&
    next.projectId === current.projectId &&
    next.runId === current.runId &&
    next.epoch === current.epoch &&
    next.seq > current.seq
  );
}

export function isRunScope(value: unknown): value is RunScope {
  if (!isRecord(value) || !hasExactKeys(value, ['projectId', 'runId', 'epoch', 'seq']))
    return false;
  return (
    isSafeOpaqueId(value.projectId) &&
    isSafeOpaqueId(value.runId) &&
    isPositiveSafeInteger(value.epoch) &&
    isNonNegativeSafeInteger(value.seq)
  );
}

export function isJoyAgentRunArtifactReference(
  value: unknown,
): value is JoyAgentRunArtifactReference {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'id', 'version']) &&
    typeof value.kind === 'string' &&
    ARTIFACT_KINDS.has(value.kind) &&
    isSafeOpaqueId(value.id) &&
    isPositiveSafeInteger(value.version)
  );
}

export function isJoyAgentRunEvent(value: unknown): value is JoyAgentRunEvent {
  if (!isRecord(value)) return false;
  const keys = [
    'version',
    'scope',
    'state',
    'at',
    ...(value.display === undefined ? [] : ['display']),
    ...(value.errorCode === undefined ? [] : ['errorCode']),
    ...(value.changeSetVersion === undefined ? [] : ['changeSetVersion']),
    ...(value.artifacts === undefined ? [] : ['artifacts']),
  ];
  if (!hasExactKeys(value, keys)) return false;
  if (
    value.version !== JOY_AGENT_RUN_EVENT_VERSION ||
    !isRunScope(value.scope) ||
    typeof value.state !== 'string' ||
    !RUN_STATES.has(value.state) ||
    value.state === 'idle' ||
    !isSafeTimestamp(value.at)
  ) {
    return false;
  }
  if (value.display !== undefined && !isSafeDisplayText(value.display)) return false;
  if (
    value.errorCode !== undefined &&
    (typeof value.errorCode !== 'string' || !ERROR_CODES.has(value.errorCode))
  ) {
    return false;
  }
  if (value.changeSetVersion !== undefined && !isNonNegativeSafeInteger(value.changeSetVersion))
    return false;
  return (
    value.artifacts === undefined ||
    (Array.isArray(value.artifacts) &&
      value.artifacts.length <= MAX_ARTIFACTS &&
      value.artifacts.every(isJoyAgentRunArtifactReference) &&
      hasDistinctArtifactReferences(value.artifacts))
  );
}

/** Validate, clone and freeze one transport/persistence-safe event. */
export function cloneJoyAgentRunEvent(event: JoyAgentRunEvent): JoyAgentRunEvent {
  if (!isJoyAgentRunEvent(event)) throw new TypeError('JOY_AGENT_RUN_EVENT_INVALID');
  return Object.freeze({
    version: JOY_AGENT_RUN_EVENT_VERSION,
    scope: Object.freeze({ ...event.scope }),
    state: event.state,
    at: event.at,
    ...(event.display === undefined ? {} : { display: event.display }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    ...(event.changeSetVersion === undefined ? {} : { changeSetVersion: event.changeSetVersion }),
    ...(event.artifacts === undefined
      ? {}
      : {
          artifacts: Object.freeze(
            event.artifacts.map((artifact) => Object.freeze({ ...artifact })),
          ),
        }),
  });
}

export function cloneJoyAgentRunArtifactReferences(
  artifacts: readonly JoyAgentRunArtifactReference[],
): readonly JoyAgentRunArtifactReference[] {
  if (
    artifacts.length > MAX_ARTIFACTS ||
    !artifacts.every(isJoyAgentRunArtifactReference) ||
    !hasDistinctArtifactReferences(artifacts)
  ) {
    throw new TypeError('JOY_AGENT_RUN_ARTIFACT_INVALID');
  }
  return Object.freeze(artifacts.map((artifact) => Object.freeze({ ...artifact })));
}

export function isSafeJoyAgentRunDisplayText(value: unknown): value is string {
  return isSafeDisplayText(value);
}

/** Reusable boundary check for project, conversation, run and artifact IDs. */
export function isSafeJoyAgentRunOpaqueId(value: unknown): value is string {
  return isSafeOpaqueId(value);
}

function hasDistinctArtifactReferences(
  artifacts: readonly JoyAgentRunArtifactReference[],
): boolean {
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    const key = `${artifact.kind}:${artifact.id}:${artifact.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function isSafeOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value) && !UNSAFE_TEXT.test(value);
}

function isSafeTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    !UNSAFE_TEXT.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isSafeDisplayText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DISPLAY_CHARS &&
    !UNSAFE_TEXT.test(value)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
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
