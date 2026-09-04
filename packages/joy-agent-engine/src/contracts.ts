export const JOY_AGENT_PROTOCOL_VERSION = 1 as const;

export const JOY_AGENT_PHASES = [
  'connecting',
  'thinking',
  'inspecting',
  'planning',
  'previewing',
  'awaiting-approval',
  'applying',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JoyAgentPhase = (typeof JOY_AGENT_PHASES)[number];

export const JOY_AGENT_TASK_KINDS = [
  'joy-code-edit',
  'creative-brief',
  'asset-assist',
  'design-assist',
  'scene-3d-assist',
  'media-job-assist',
] as const;
export type JoyAgentTaskKind = (typeof JOY_AGENT_TASK_KINDS)[number];

export const JOY_AGENT_SURFACES = [
  'joy-code',
  'creative-brief',
  'asset-library',
  'timeline',
  'inspector',
  'effects',
  'motion',
  'color',
  'captions',
  'audio',
  'scene-3d',
  'jobs',
  'program-monitor',
] as const;
export type JoyAgentSurface = (typeof JOY_AGENT_SURFACES)[number];

export const JOY_AGENT_CAPABILITIES = [
  'untested',
  'tool-loop',
  'plan-only',
  'incompatible',
] as const;
export type JoyAgentCapability = (typeof JOY_AGENT_CAPABILITIES)[number];

export const JOY_AGENT_ERROR_CODES = [
  'JOY_AGENT_ABORTED',
  'JOY_AGENT_TIMEOUT',
  'JOY_AGENT_CORS_OR_NETWORK',
  'JOY_AGENT_AUTH_FAILED',
  'JOY_AGENT_RESPONSE_TOO_LARGE',
  'JOY_AGENT_INVALID_TOOL',
  'JOY_AGENT_INVALID_PROPOSAL',
  'JOY_AGENT_STALE_REVISION',
  'JOY_AGENT_PROVIDER_INCOMPATIBLE',
] as const;
export type JoyAgentErrorCode = (typeof JOY_AGENT_ERROR_CODES)[number];

export interface JoyAgentEventBase {
  readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
}

export interface JoyAgentActivityEvent extends JoyAgentEventBase {
  readonly type: 'activity';
  readonly phase: JoyAgentPhase;
  readonly surface: JoyAgentSurface;
  readonly activityCode: string;
}

export interface JoyAgentTextDeltaEvent extends JoyAgentEventBase {
  readonly type: 'text-delta';
  readonly text: string;
}

export interface JoyAgentCapabilityEvent extends JoyAgentEventBase {
  readonly type: 'provider-capability';
  readonly capability: JoyAgentCapability;
}

export interface JoyAgentToolRequestEvent extends JoyAgentEventBase {
  readonly type: 'tool-request';
  readonly toolId: string;
  readonly toolCallId: string;
}

export interface JoyAgentProposalEvent extends JoyAgentEventBase {
  readonly type: 'proposal';
  readonly proposalHash: string;
  readonly operationCount: number;
  readonly baseRevision: string;
}

export interface JoyAgentUsageEvent extends JoyAgentEventBase {
  readonly type: 'usage';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface JoyAgentCompletedEvent extends JoyAgentEventBase {
  readonly type: 'completed';
}

export interface JoyAgentFailedEvent extends JoyAgentEventBase {
  readonly type: 'failed';
  readonly code: JoyAgentErrorCode;
  readonly retryable: boolean;
}

export interface JoyAgentCancelledEvent extends JoyAgentEventBase {
  readonly type: 'cancelled';
}

export type JoyAgentSafeEvent =
  | JoyAgentActivityEvent
  | JoyAgentTextDeltaEvent
  | JoyAgentCapabilityEvent
  | JoyAgentToolRequestEvent
  | JoyAgentProposalEvent
  | JoyAgentUsageEvent
  | JoyAgentCompletedEvent
  | JoyAgentFailedEvent
  | JoyAgentCancelledEvent;

export interface JoyAgentRunRequest {
  readonly taskKind: JoyAgentTaskKind;
  readonly runId: string;
  readonly baseRevision: string;
  readonly request: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface JoyAgentSafeError {
  readonly code: JoyAgentErrorCode;
  readonly retryable: boolean;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_CODE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  pattern?: RegExp,
): boolean {
  const candidate = value[key];
  return (
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    (pattern === undefined || pattern.test(candidate))
  );
}

function hasCount(value: Readonly<Record<string, unknown>>, key: string, maximum: number): boolean {
  const candidate = value[key];
  return (
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate <= maximum
  );
}

/**
 * Validate one Worker event and its monotonic sequence position. The strict
 * allow-list makes adding a secret-bearing diagnostic property impossible by
 * accident.
 */
export function parseJoyAgentSafeEvent(value: unknown, previousSeq = -1): JoyAgentSafeEvent {
  if (!isRecord(value)) throw new Error('JOY_AGENT_INVALID_EVENT');
  if (
    value.protocolVersion !== JOY_AGENT_PROTOCOL_VERSION ||
    !hasString(value, 'runId', SAFE_ID) ||
    typeof value.seq !== 'number' ||
    !Number.isInteger(value.seq) ||
    value.seq <= previousSeq ||
    !hasString(value, 'at', ISO_INSTANT) ||
    Number.isNaN(Date.parse(value.at as string))
  ) {
    throw new Error('JOY_AGENT_INVALID_EVENT');
  }

  const base = {
    protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
    runId: value.runId as string,
    seq: value.seq,
    at: value.at as string,
  } as const;
  switch (value.type) {
    case 'activity':
      if (
        !exactKeys(value, [
          'protocolVersion',
          'runId',
          'seq',
          'at',
          'type',
          'phase',
          'surface',
          'activityCode',
        ]) ||
        !JOY_AGENT_PHASES.includes(value.phase as JoyAgentPhase) ||
        !JOY_AGENT_SURFACES.includes(value.surface as JoyAgentSurface) ||
        !hasString(value, 'activityCode', SAFE_CODE)
      )
        throw new Error('JOY_AGENT_INVALID_EVENT');
      return {
        ...base,
        type: 'activity',
        phase: value.phase as JoyAgentPhase,
        surface: value.surface as JoyAgentSurface,
        activityCode: value.activityCode as string,
      };
    case 'text-delta':
      if (
        !exactKeys(value, ['protocolVersion', 'runId', 'seq', 'at', 'type', 'text']) ||
        typeof value.text !== 'string' ||
        value.text.length > 8192
      )
        throw new Error('JOY_AGENT_INVALID_EVENT');
      return { ...base, type: 'text-delta', text: value.text as string };
    case 'provider-capability':
      if (
        !exactKeys(value, ['protocolVersion', 'runId', 'seq', 'at', 'type', 'capability']) ||
        !JOY_AGENT_CAPABILITIES.includes(value.capability as JoyAgentCapability)
      )
        throw new Error('JOY_AGENT_INVALID_EVENT');
      return {
        ...base,
        type: 'provider-capability',
        capability: value.capability as JoyAgentCapability,
      };
    case 'tool-request':
      if (
        !exactKeys(value, [
          'protocolVersion',
          'runId',
          'seq',
          'at',
          'type',
          'toolId',
          'toolCallId',
        ]) ||
        !hasString(value, 'toolId', SAFE_ID) ||
        !hasString(value, 'toolCallId', SAFE_ID)
      )
        throw new Error('JOY_AGENT_INVALID_EVENT');
      return {
        ...base,
        type: 'tool-request',
        toolId: value.toolId as string,
        toolCallId: value.toolCallId as string,
      };
    case 'proposal':
      if (
        !exactKeys(value, [
          'protocolVersion',
          'runId',
          'seq',
          'at',
          'type',
          'proposalHash',
          'operationCount',
          'baseRevision',
        ]) ||
        !hasString(value, 'proposalHash', SAFE_ID) ||
        !hasCount(value, 'operationCount', 32) ||
        !hasString(value, 'baseRevision', SAFE_ID)
      )
        throw new Error('JOY_AGENT_INVALID_EVENT');
      return {
        ...base,
        type: 'proposal',
        proposalHash: value.proposalHash as string,
        operationCount: value.operationCount as number,
        baseRevision: value.baseRevision as string,
      };
    case 'usage':
      if (
        !exactKeys(value, [
          'protocolVersion',
          'runId',
          'seq',
          'at',
          'type',
          'inputTokens',
          'outputTokens',
          'totalTokens',
        ]) ||
        !hasCount(value, 'inputTokens', 2_000_000) ||
        !hasCount(value, 'outputTokens', 2_000_000) ||
        !hasCount(value, 'totalTokens', 4_000_000)
      )
        throw new Error('JOY_AGENT_INVALID_EVENT');
      return {
        ...base,
        type: 'usage',
        inputTokens: value.inputTokens as number,
        outputTokens: value.outputTokens as number,
        totalTokens: value.totalTokens as number,
      };
    case 'completed':
      if (!exactKeys(value, ['protocolVersion', 'runId', 'seq', 'at', 'type']))
        throw new Error('JOY_AGENT_INVALID_EVENT');
      return { ...base, type: 'completed' };
    case 'failed':
      if (
        !exactKeys(value, ['protocolVersion', 'runId', 'seq', 'at', 'type', 'code', 'retryable']) ||
        !JOY_AGENT_ERROR_CODES.includes(value.code as JoyAgentErrorCode) ||
        typeof value.retryable !== 'boolean'
      )
        throw new Error('JOY_AGENT_INVALID_EVENT');
      return {
        ...base,
        type: 'failed',
        code: value.code as JoyAgentErrorCode,
        retryable: value.retryable,
      };
    case 'cancelled':
      if (!exactKeys(value, ['protocolVersion', 'runId', 'seq', 'at', 'type']))
        throw new Error('JOY_AGENT_INVALID_EVENT');
      return { ...base, type: 'cancelled' };
    default:
      throw new Error('JOY_AGENT_INVALID_EVENT');
  }
}

export function isJoyAgentSafeEvent(value: unknown, previousSeq = -1): value is JoyAgentSafeEvent {
  try {
    parseJoyAgentSafeEvent(value, previousSeq);
    return true;
  } catch {
    return false;
  }
}
