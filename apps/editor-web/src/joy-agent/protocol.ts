import type { HostRpcWireMessage } from './host-rpc.js';
import {
  isJoyAgentHostToolName,
  JOY_AGENT_HOST_TOOL_NAMES,
  type JoyAgentHostToolName,
} from './host-tool-contract.js';

/**
 * Public main-thread/Worker transport version. V2 deliberately removes the
 * old implicit structured-run context channel: structured runs get bounded
 * facts and compiler results through host RPC instead.
 */
export const JOY_AGENT_PROTOCOL_VERSION = 2 as const;

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
  /** Volatile only: never present in a Worker event or host RPC envelope. */
  readonly apiKey: string;
}

export interface ByokSessionStatus {
  readonly provider: ByokSessionConfig['provider'];
  readonly modelId: string;
  readonly capability: 'untested' | 'tool-loop' | 'plan-only' | 'incompatible';
  readonly message?: string;
}

/**
 * These are deliberately limited to media that can be tested with a tiny,
 * product-owned synthetic payload. A successful capability probe is not an
 * owner-media consent grant and it never carries a media payload over this
 * public Worker boundary.
 */
export const JOY_AGENT_MEDIA_MODALITIES = ['image', 'audio', 'video'] as const;

export type JoyAgentMediaModality = (typeof JOY_AGENT_MEDIA_MODALITIES)[number];

/** `unavailable` means unsupported, rejected, malformed, or not proven. */
export type JoyAgentMediaCapabilityState = 'supported' | 'unavailable';

/**
 * Redacted, in-memory result of an explicit media capability probe. It omits
 * the endpoint, credential, prompt, synthetic payload, and provider body.
 */
export interface JoyAgentMediaCapabilityReport {
  readonly modelId: string;
  readonly image: JoyAgentMediaCapabilityState;
  readonly audio: JoyAgentMediaCapabilityState;
  readonly video: JoyAgentMediaCapabilityState;
  /** Canonical subset of the independently-proven modality fields above. */
  readonly modalities: readonly JoyAgentMediaModality[];
}

export interface JoyAgentRunRequest {
  readonly runId: string;
  /** Minted by the client; rejects stale messages if a run ID is reused. */
  readonly runEpoch?: number;
  readonly taskKind?: JoyAgentTaskKind;
  readonly prompt: string;
  readonly baseRevision?: string;
  /**
   * Data-only context is used only by text/brief plan-only requests. The
   * client removes it before a structured run crosses into the Worker.
   */
  readonly context?: unknown;
  /** A user execution policy, never a claim about provider capability. */
  readonly mode?: 'tool-loop' | 'plan-only';
  /**
   * Exact, host-approved structured-tool subset for this one run. The client
   * derives this from the main-thread host rather than trusting UI text or a
   * provider response. It is public transport data only: it cannot grant a
   * host method that the mounted RPC host did not expose.
   */
  readonly allowedToolNames?: readonly JoyAgentHostToolName[];
}

export interface JoyAgentPreparedProposal {
  readonly summary: string;
  readonly baseRevision: string;
  /** Opaque main-thread prepared-change identity, never a writer capability. */
  readonly changeSetId: string;
  readonly operationDigest: string;
  readonly bindingDigest: string;
  readonly operationCount: number;
}

export interface JoyAgentSafeEvent {
  readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
  readonly runId: string;
  readonly runEpoch: number;
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
  readonly proposal?: JoyAgentPreparedProposal;
}

export type MainToWorkerMessage =
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      readonly type: 'configure';
      readonly config: ByokSessionConfig;
    }
  | { readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION; readonly type: 'test' }
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      /** Explicit only; configuration and `test` never trigger this probe. */
      readonly type: 'probe-media-capabilities';
      readonly requestId: string;
    }
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      readonly type: 'run';
      readonly request: JoyAgentRunRequest;
    }
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      readonly type: 'cancel';
      readonly runId: string;
      readonly runEpoch: number;
    }
  | { readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION; readonly type: 'dispose' }
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      readonly type: 'host-rpc';
      /** Only a response is legal in this direction. */
      readonly message: HostRpcWireMessage;
    };

export type WorkerToMainMessage =
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      readonly type: 'run-finished';
      readonly runId: string;
      readonly runEpoch: number;
    }
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      readonly type: 'configured';
      readonly status: ByokSessionStatus;
    }
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      readonly type: 'event';
      readonly event: JoyAgentSafeEvent;
    }
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      readonly type: 'error';
      readonly requestId?: string;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      readonly type: 'test-result';
      readonly status: ByokSessionStatus;
    }
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      readonly type: 'media-capability-result';
      readonly requestId: string;
      readonly report: JoyAgentMediaCapabilityReport;
    }
  | {
      readonly protocolVersion: typeof JOY_AGENT_PROTOCOL_VERSION;
      readonly type: 'host-rpc';
      /** Only requests and cancellations are legal in this direction. */
      readonly message: HostRpcWireMessage;
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
const MEDIA_CAPABILITY_STATES: ReadonlySet<string> = new Set(['supported', 'unavailable']);
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
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SHA_256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_RESULT_KEYS =
  /apiKey|authorization|endpoint|headers|selector|className|cookie|secret|token|credential|writer|storage|url|uri|path/i;
const UNSAFE_CONTEXT_VALUE =
  /(?:bearer\s+|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|https?:\/\/|blob:|data:|file:|opfs:|(?:[A-Za-z]:[\\/]|\\\\)[^\s]+)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return (
    Object.keys(value).length === keys.length && Object.keys(value).every((key) => allowed.has(key))
  );
}

function isSafeStatus(value: unknown): value is ByokSessionStatus {
  if (!isRecord(value)) return false;
  return (
    (value.provider === 'openrouter' || value.provider === 'openai-compatible') &&
    typeof value.modelId === 'string' &&
    value.modelId.length <= 256 &&
    typeof value.capability === 'string' &&
    CAPABILITIES.has(value.capability) &&
    (value.message === undefined ||
      (typeof value.message === 'string' && value.message.length <= 512)) &&
    exactKeys(value, [
      'provider',
      'modelId',
      'capability',
      ...(value.message === undefined ? [] : ['message']),
    ])
  );
}

function isSafePublicModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !UNSAFE_CONTEXT_VALUE.test(value)
  );
}

function isSafeMediaCapabilityReport(value: unknown): value is JoyAgentMediaCapabilityReport {
  if (!isRecord(value) || !exactKeys(value, ['modelId', 'image', 'audio', 'video', 'modalities']))
    return false;
  if (
    !isSafePublicModelId(value.modelId) ||
    typeof value.image !== 'string' ||
    !MEDIA_CAPABILITY_STATES.has(value.image) ||
    typeof value.audio !== 'string' ||
    !MEDIA_CAPABILITY_STATES.has(value.audio) ||
    typeof value.video !== 'string' ||
    !MEDIA_CAPABILITY_STATES.has(value.video) ||
    !Array.isArray(value.modalities) ||
    value.modalities.length > JOY_AGENT_MEDIA_MODALITIES.length
  )
    return false;
  const expected = JOY_AGENT_MEDIA_MODALITIES.filter((modality) => value[modality] === 'supported');
  return (
    value.modalities.length === expected.length &&
    value.modalities.every((modality, index) => modality === expected[index])
  );
}

function isSafeConfig(value: unknown): value is ByokSessionConfig {
  return (
    isRecord(value) &&
    (value.provider === 'openrouter' || value.provider === 'openai-compatible') &&
    typeof value.baseUrl === 'string' &&
    value.baseUrl.length > 0 &&
    value.baseUrl.length <= 2_048 &&
    isSafePublicModelId(value.modelId) &&
    typeof value.apiKey === 'string' &&
    value.apiKey.length > 0 &&
    value.apiKey.length <= 4_096 &&
    exactKeys(value, ['provider', 'baseUrl', 'modelId', 'apiKey'])
  );
}

function isSafePreparedProposal(value: unknown): value is JoyAgentPreparedProposal {
  if (!isRecord(value)) return false;
  if (
    typeof value.summary !== 'string' ||
    value.summary.length > 512 ||
    typeof value.baseRevision !== 'string' ||
    value.baseRevision.length > 256 ||
    typeof value.changeSetId !== 'string' ||
    !OPAQUE_ID.test(value.changeSetId) ||
    typeof value.operationDigest !== 'string' ||
    !SHA_256.test(value.operationDigest) ||
    typeof value.bindingDigest !== 'string' ||
    !SHA_256.test(value.bindingDigest) ||
    typeof value.operationCount !== 'number' ||
    !Number.isSafeInteger(value.operationCount) ||
    value.operationCount <= 0 ||
    value.operationCount > 32 ||
    !exactKeys(value, [
      'summary',
      'baseRevision',
      'changeSetId',
      'operationDigest',
      'bindingDigest',
      'operationCount',
    ])
  )
    return false;
  try {
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= 65_536 &&
      !FORBIDDEN_RESULT_KEYS.test(serialized) &&
      isSafeDataValue(value)
    );
  } catch {
    return false;
  }
}

/** Shared boundary guard for provider-derived results before they cross to the UI. */
export function isSafeResult(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= 65_536 &&
      !FORBIDDEN_RESULT_KEYS.test(serialized) &&
      isSafeDataValue(value)
    );
  } catch {
    return false;
  }
}

/** Plan-only brief context is data-only and bounded; structured runs use RPC. */
function isSafeDataValue(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): boolean => {
    if (depth > 12) return false;
    if (candidate === null || typeof candidate === 'boolean') return true;
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate === 'string')
      return candidate.length <= 8_192 && !UNSAFE_CONTEXT_VALUE.test(candidate);
    if (Array.isArray(candidate))
      return candidate.length <= 1_024 && candidate.every((item) => visit(item, depth + 1));
    if (!isRecord(candidate) || seen.has(candidate)) return false;
    seen.add(candidate);
    const keys = Object.keys(candidate);
    return (
      keys.length <= 256 &&
      keys.every(
        (key) =>
          key.length <= 128 && !FORBIDDEN_RESULT_KEYS.test(key) && visit(candidate[key], depth + 1),
      )
    );
  };
  return visit(value, 0);
}

function isSafeRunContext(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= 60_000 &&
      isSafeDataValue(value)
    );
  } catch {
    return false;
  }
}

/**
 * Keep the Worker protocol closed even if a caller constructs a raw message.
 * This is deliberately a narrow transport allowlist, not a capability grant:
 * the main-thread Host RPC object remains the final authority.
 */
function isSafeAllowedToolNames(value: unknown): value is readonly JoyAgentHostToolName[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > JOY_AGENT_HOST_TOOL_NAMES.length)
    return false;
  const seen = new Set<string>();
  for (const name of value) {
    if (!isJoyAgentHostToolName(name) || seen.has(name)) return false;
    seen.add(name);
  }
  // Every provider-visible operation starts from an explicitly frozen context
  // read. This also keeps an accidental media-only catalog from bypassing the
  // bounded project view.
  return seen.has('read_project_context');
}

function isSafeTarget(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.panelId === 'string' &&
    OPAQUE_ID.test(value.panelId) &&
    (value.sectionId === undefined ||
      (typeof value.sectionId === 'string' && OPAQUE_ID.test(value.sectionId))) &&
    exactKeys(value, ['panelId', ...(value.sectionId === undefined ? [] : ['sectionId'])])
  );
}

function isSafeProgress(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.current === 'number' &&
    Number.isSafeInteger(value.current) &&
    value.current >= 0 &&
    typeof value.total === 'number' &&
    Number.isSafeInteger(value.total) &&
    value.total >= value.current &&
    exactKeys(value, ['current', 'total'])
  );
}

function isHostRpcEnvelope(
  value: unknown,
  direction: 'main-to-worker' | 'worker-to-main',
): boolean {
  if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.type !== 'string')
    return false;
  if (direction === 'main-to-worker') return value.type === 'host-rpc-response';
  return value.type === 'host-rpc-request' || value.type === 'host-rpc-cancel';
}

/**
 * Validate main-thread messages before the Worker acts. The host-rpc module
 * performs the deeper schema validation of its nested wire envelope.
 */
export function isMainToWorkerMessage(value: unknown): value is MainToWorkerMessage {
  if (!isRecord(value) || value.protocolVersion !== JOY_AGENT_PROTOCOL_VERSION) return false;
  if (value.type === 'configure')
    return exactKeys(value, ['protocolVersion', 'type', 'config']) && isSafeConfig(value.config);
  if (value.type === 'test' || value.type === 'dispose')
    return exactKeys(value, ['protocolVersion', 'type']);
  if (value.type === 'probe-media-capabilities')
    return (
      exactKeys(value, ['protocolVersion', 'type', 'requestId']) &&
      typeof value.requestId === 'string' &&
      OPAQUE_ID.test(value.requestId)
    );
  if (value.type === 'cancel')
    return (
      exactKeys(value, ['protocolVersion', 'type', 'runId', 'runEpoch']) &&
      typeof value.runId === 'string' &&
      OPAQUE_ID.test(value.runId) &&
      typeof value.runEpoch === 'number' &&
      Number.isSafeInteger(value.runEpoch) &&
      value.runEpoch > 0
    );
  if (value.type === 'run') {
    if (!exactKeys(value, ['protocolVersion', 'type', 'request']) || !isRecord(value.request))
      return false;
    const request = value.request;
    return (
      typeof request.runId === 'string' &&
      OPAQUE_ID.test(request.runId) &&
      typeof request.runEpoch === 'number' &&
      Number.isSafeInteger(request.runEpoch) &&
      request.runEpoch > 0 &&
      typeof request.prompt === 'string' &&
      request.prompt.length <= 8_000 &&
      (request.taskKind === undefined ||
        (typeof request.taskKind === 'string' && TASK_KINDS.has(request.taskKind))) &&
      (request.baseRevision === undefined ||
        (typeof request.baseRevision === 'string' && request.baseRevision.length <= 256)) &&
      (request.mode === undefined ||
        request.mode === 'tool-loop' ||
        request.mode === 'plan-only') &&
      (request.context === undefined || isSafeRunContext(request.context)) &&
      (request.mode !== 'tool-loop' || request.context === undefined) &&
      (request.allowedToolNames === undefined ||
        (request.mode === 'tool-loop' &&
          request.taskKind !== 'creative-brief' &&
          isSafeAllowedToolNames(request.allowedToolNames))) &&
      Object.keys(request).every((key) =>
        [
          'runId',
          'runEpoch',
          'taskKind',
          'prompt',
          'baseRevision',
          'context',
          'mode',
          'allowedToolNames',
        ].includes(key),
      )
    );
  }
  return (
    value.type === 'host-rpc' &&
    exactKeys(value, ['protocolVersion', 'type', 'message']) &&
    isHostRpcEnvelope(value.message, 'main-to-worker')
  );
}

/**
 * Validate Worker-to-main messages before they reach UI state or an RPC host.
 * The client turns a version rejection into an actionable reload/reconnect
 * failure instead of coercing a stale cached Worker message.
 */
export function isWorkerToMainMessage(value: unknown): value is WorkerToMainMessage {
  if (!isRecord(value) || value.protocolVersion !== JOY_AGENT_PROTOCOL_VERSION) return false;
  if (value.type === 'event') {
    const event = value.event;
    if (
      !isRecord(event) ||
      event.protocolVersion !== JOY_AGENT_PROTOCOL_VERSION ||
      typeof event.runId !== 'string' ||
      !OPAQUE_ID.test(event.runId) ||
      typeof event.runEpoch !== 'number' ||
      !Number.isSafeInteger(event.runEpoch) ||
      event.runEpoch <= 0 ||
      typeof event.seq !== 'number' ||
      !Number.isSafeInteger(event.seq) ||
      event.seq < 0 ||
      typeof event.at !== 'string' ||
      event.at.length > 64 ||
      typeof event.phase !== 'string' ||
      !PHASES.has(event.phase) ||
      !(
        event.message === undefined ||
        (typeof event.message === 'string' && event.message.length <= 512)
      ) ||
      !(
        event.errorCode === undefined ||
        (typeof event.errorCode === 'string' && ERROR_CODES.has(event.errorCode))
      ) ||
      !(
        event.taskKind === undefined ||
        (typeof event.taskKind === 'string' && TASK_KINDS.has(event.taskKind))
      ) ||
      !(event.target === undefined || isSafeTarget(event.target)) ||
      !(event.progress === undefined || isSafeProgress(event.progress)) ||
      !Object.keys(event).every((key) =>
        [
          'protocolVersion',
          'runId',
          'runEpoch',
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
    return (
      (event.proposal === undefined || isSafePreparedProposal(event.proposal)) &&
      (event.result === undefined || isSafeResult(event.result))
    );
  }
  if (value.type === 'run-finished')
    return (
      exactKeys(value, ['protocolVersion', 'type', 'runId', 'runEpoch']) &&
      typeof value.runId === 'string' &&
      OPAQUE_ID.test(value.runId) &&
      typeof value.runEpoch === 'number' &&
      Number.isSafeInteger(value.runEpoch) &&
      value.runEpoch > 0
    );
  if (value.type === 'error')
    return (
      exactKeys(value, [
        'protocolVersion',
        'type',
        'code',
        'message',
        ...(value.requestId === undefined ? [] : ['requestId']),
      ]) &&
      typeof value.code === 'string' &&
      value.code.length <= 96 &&
      (value.requestId === undefined ||
        (typeof value.requestId === 'string' && OPAQUE_ID.test(value.requestId))) &&
      typeof value.message === 'string' &&
      value.message.length <= 512 &&
      !FORBIDDEN_RESULT_KEYS.test(value.message)
    );
  if (value.type === 'configured' || value.type === 'test-result')
    return exactKeys(value, ['protocolVersion', 'type', 'status']) && isSafeStatus(value.status);
  if (value.type === 'media-capability-result')
    return (
      exactKeys(value, ['protocolVersion', 'type', 'requestId', 'report']) &&
      typeof value.requestId === 'string' &&
      OPAQUE_ID.test(value.requestId) &&
      isSafeMediaCapabilityReport(value.report)
    );
  return (
    value.type === 'host-rpc' &&
    exactKeys(value, ['protocolVersion', 'type', 'message']) &&
    isHostRpcEnvelope(value.message, 'worker-to-main')
  );
}
