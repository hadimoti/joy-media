export const JOY_AGENT_PROTOCOL_VERSION = 1 as const;

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
      PHASES.has(event.phase)
    ))
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
    return true;
  }
  if (candidate.type === 'error')
    return typeof candidate.code === 'string' && typeof candidate.message === 'string';
  if (candidate.type === 'configured' || candidate.type === 'test-result')
    return isSafeStatus(candidate.status);
  return false;
}
