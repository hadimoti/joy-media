export const JOY_AGENT_PROTOCOL_VERSION = 1 as const;

/** Exhaustive, product-owned inventory of AI entry points. */
export type JoyAgentTaskKind =
  | 'joy-code'
  | 'creative-brief'
  | 'asset-edit'
  | 'text'
  | 'effects'
  | 'filters'
  | 'transitions'
  | 'color'
  | 'motion'
  | 'camera'
  | 'captions'
  | 'audio'
  | '3d'
  | 'workflow'
  | 'media-job';

export type JoyAgentPhase =
  | 'connecting'
  | 'thinking'
  | 'inspecting'
  | 'planning'
  | 'previewing'
  | 'awaiting-approval'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type JoyAgentErrorCode =
  | 'JOY_AGENT_ABORTED'
  | 'JOY_AGENT_TIMEOUT'
  | 'JOY_AGENT_CORS_OR_NETWORK'
  | 'JOY_AGENT_AUTH_FAILED'
  | 'JOY_AGENT_RESPONSE_TOO_LARGE'
  | 'JOY_AGENT_INVALID_TOOL'
  | 'JOY_AGENT_INVALID_PROPOSAL'
  | 'JOY_AGENT_STALE_REVISION'
  | 'JOY_AGENT_PROVIDER_INCOMPATIBLE';

export interface ByokSessionConfig {
  readonly provider: 'openrouter' | 'openai-compatible';
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
}

export interface ByokSessionStatus {
  readonly provider: ByokSessionConfig['provider'];
  readonly modelId: string;
  readonly capability: 'untested' | 'tool-loop' | 'plan-only' | 'incompatible';
  readonly message?: string;
}

export interface JoyAgentRunRequest {
  readonly runId: string;
  readonly taskKind?: JoyAgentTaskKind;
  readonly prompt: string;
  readonly baseRevision?: string;
  readonly context?: unknown;
  readonly mode?: 'tool-loop' | 'plan-only';
}

export interface JoyAgentSafeEvent {
  readonly protocolVersion: 1;
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
  readonly phase: JoyAgentPhase;
  readonly target?: { readonly panelId: string; readonly sectionId?: string };
  readonly progress?: { readonly current: number; readonly total: number };
  readonly message?: string;
  readonly taskKind?: JoyAgentTaskKind;
  readonly errorCode?: JoyAgentErrorCode;
  /** Read-only structured output for non-mutating tasks (for example Brief). */
  readonly result?: unknown;
  readonly proposal?: {
    readonly summary: string;
    readonly operations: readonly unknown[];
    readonly baseRevision: string;
  };
}

export type MainToWorkerMessage =
  | { readonly protocolVersion: 1; readonly type: 'configure'; readonly config: ByokSessionConfig }
  | { readonly protocolVersion: 1; readonly type: 'test' }
  | { readonly protocolVersion: 1; readonly type: 'run'; readonly request: JoyAgentRunRequest }
  | { readonly protocolVersion: 1; readonly type: 'cancel'; readonly runId: string }
  | { readonly protocolVersion: 1; readonly type: 'dispose' };

export type WorkerToMainMessage =
  | { readonly protocolVersion: 1; readonly type: 'run-finished'; readonly runId: string }
  | { readonly protocolVersion: 1; readonly type: 'configured'; readonly status: ByokSessionStatus }
  | { readonly protocolVersion: 1; readonly type: 'event'; readonly event: JoyAgentSafeEvent }
  | {
      readonly protocolVersion: 1;
      readonly type: 'error';
      readonly requestId?: string;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: 'test-result';
      readonly status: ByokSessionStatus;
    };

const PHASES: ReadonlySet<string> = new Set([
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
]);
const CAPABILITIES: ReadonlySet<string> = new Set([
  'untested',
  'tool-loop',
  'plan-only',
  'incompatible',
]);
const ERROR_CODES: ReadonlySet<string> = new Set([
  'JOY_AGENT_ABORTED',
  'JOY_AGENT_TIMEOUT',
  'JOY_AGENT_CORS_OR_NETWORK',
  'JOY_AGENT_AUTH_FAILED',
  'JOY_AGENT_RESPONSE_TOO_LARGE',
  'JOY_AGENT_INVALID_TOOL',
  'JOY_AGENT_INVALID_PROPOSAL',
  'JOY_AGENT_STALE_REVISION',
  'JOY_AGENT_PROVIDER_INCOMPATIBLE',
]);

function isSafeStatus(value: unknown): value is ByokSessionStatus {
  if (typeof value !== 'object' || value === null) return false;
  const status = value as Record<string, unknown>;
  return (
    (status.provider === 'openrouter' || status.provider === 'openai-compatible') &&
    typeof status.modelId === 'string' &&
    status.modelId.length <= 256 &&
    typeof status.capability === 'string' &&
    CAPABILITIES.has(status.capability) &&
    (status.message === undefined ||
      (typeof status.message === 'string' && status.message.length <= 512)) &&
    Object.keys(status).every((key) =>
      ['provider', 'modelId', 'capability', 'message'].includes(key),
    )
  );
}

export function isWorkerToMainMessage(value: unknown): value is WorkerToMainMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.protocolVersion !== JOY_AGENT_PROTOCOL_VERSION ||
    typeof candidate.type !== 'string'
  )
    return false;
  if (candidate.type === 'event') {
    const event = candidate.event as Record<string, unknown> | undefined;
    if (!(
      event !== undefined &&
      event.protocolVersion === 1 &&
      typeof event.runId === 'string' &&
      typeof event.seq === 'number' &&
      Number.isSafeInteger(event.seq) &&
      event.seq >= 0 &&
      typeof event.phase === 'string' &&
      PHASES.has(event.phase) &&
      event.runId.length <= 256 &&
      (event.message === undefined ||
        (typeof event.message === 'string' && event.message.length <= 512)) &&
      (event.errorCode === undefined ||
        (typeof event.errorCode === 'string' && ERROR_CODES.has(event.errorCode)))
    ))
      return false;
    if (
      !Object.keys(event).every((key) =>
        [
          'protocolVersion',
          'runId',
          'seq',
          'at',
          'phase',
          'target',
          'progress',
          'message',
          'taskKind',
          'result',
          'proposal',
          'errorCode',
        ].includes(key),
      )
    )
      return false;
    if (event.proposal !== undefined) {
      const proposal = event.proposal as Record<string, unknown>;
      if (
        typeof proposal.summary !== 'string' ||
        proposal.summary.length > 512 ||
        typeof proposal.baseRevision !== 'string' ||
        !Array.isArray(proposal.operations) ||
        proposal.operations.length > 32
      )
        return false;
      try {
        if (new TextEncoder().encode(JSON.stringify(proposal)).byteLength > 65_536) return false;
        const forbidden = /apiKey|authorization|endpoint|headers|selector|className/i;
        if (forbidden.test(JSON.stringify(proposal.operations))) return false;
      } catch {
        return false;
      }
    }
    if (event.result !== undefined) {
      try {
        const serialized = JSON.stringify(event.result);
        if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > 65_536)
          return false;
        // Results are data, never executable instructions or transport metadata.
        if (/apiKey|authorization|endpoint|headers|selector|className|cookie/i.test(serialized))
          return false;
      } catch {
        return false;
      }
    }
    if (event.taskKind !== undefined && !TASK_KINDS.has(event.taskKind as string)) return false;
    return true;
  }
  if (candidate.type === 'run-finished')
    return typeof candidate.runId === 'string' && candidate.runId.length <= 256;
  if (candidate.type === 'error')
    return (
      typeof candidate.code === 'string' &&
      candidate.code.length <= 96 &&
      (candidate.requestId === undefined ||
        (typeof candidate.requestId === 'string' && candidate.requestId.length <= 256)) &&
      typeof candidate.message === 'string' &&
      candidate.message.length <= 512 &&
      !/apiKey|authorization|endpoint|headers|cookie/i.test(candidate.message)
    );
  if (candidate.type === 'configured' || candidate.type === 'test-result')
    return isSafeStatus(candidate.status);
  return false;
}

const TASK_KINDS: ReadonlySet<string> = new Set([
  'joy-code',
  'creative-brief',
  'asset-edit',
  'text',
  'effects',
  'filters',
  'transitions',
  'color',
  'motion',
  'camera',
  'captions',
  'audio',
  '3d',
  'workflow',
  'media-job',
]);
