import {
  JOY_AGENT_ERROR_CODES,
  type JoyAgentErrorCode,
  type JoyAgentSafeError,
} from './contracts.js';

const SECRET_KEYS =
  /^(api[-_]?key|authorization|endpoint|prompt|raw[-_]?request|raw[-_]?response|reasoning|selector|className|headers?)$/i;
const CIRCULAR = '[Circular]';
const OMITTED = '[Omitted]';
const MAX_DEPTH = 6;
const MAX_KEYS = 64;

export function redactUnknownValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return project(value, seen, 0);
}

function project(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return typeof value === 'string' && value.length > 4096 ? `${value.slice(0, 4096)}…` : value;
  }
  if (typeof value === 'bigint') return '[BigInt]';
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return OMITTED;
  if (typeof value !== 'object' || value === null) return OMITTED;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  if (Array.isArray(value))
    return value.slice(0, MAX_KEYS).map((entry) => project(entry, seen, depth + 1));
  const objectValue = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(objectValue).slice(0, MAX_KEYS)) {
    if (SECRET_KEYS.test(key)) {
      result[key] = '[Redacted]';
      continue;
    }
    try {
      result[key] = project(objectValue[key], seen, depth + 1);
    } catch {
      result[key] = '[Unavailable]';
    }
  }
  return result;
}

export function classifyJoyAgentError(error: unknown): JoyAgentErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('abort') || normalized.includes('cancel')) return 'JOY_AGENT_ABORTED';
  if (normalized.includes('timeout') || normalized.includes('timed out'))
    return 'JOY_AGENT_TIMEOUT';
  if (normalized.includes('cors') || normalized.includes('network') || normalized.includes('fetch'))
    return 'JOY_AGENT_CORS_OR_NETWORK';
  if (
    normalized.includes('401') ||
    normalized.includes('403') ||
    normalized.includes('unauthorized')
  )
    return 'JOY_AGENT_AUTH_FAILED';
  if (normalized.includes('too large') || normalized.includes('oversize'))
    return 'JOY_AGENT_RESPONSE_TOO_LARGE';
  if (normalized.includes('tool')) return 'JOY_AGENT_INVALID_TOOL';
  if (normalized.includes('proposal')) return 'JOY_AGENT_INVALID_PROPOSAL';
  if (normalized.includes('revision')) return 'JOY_AGENT_STALE_REVISION';
  return 'JOY_AGENT_PROVIDER_INCOMPATIBLE';
}

export function toSafeJoyAgentError(error: unknown): JoyAgentSafeError {
  const code = classifyJoyAgentError(error);
  return {
    code,
    retryable: !(
      [
        'JOY_AGENT_ABORTED',
        'JOY_AGENT_AUTH_FAILED',
        'JOY_AGENT_INVALID_TOOL',
        'JOY_AGENT_INVALID_PROPOSAL',
        'JOY_AGENT_STALE_REVISION',
        'JOY_AGENT_PROVIDER_INCOMPATIBLE',
      ] as readonly JoyAgentErrorCode[]
    ).includes(code),
  };
}

export function isJoyAgentErrorCode(value: unknown): value is JoyAgentErrorCode {
  return typeof value === 'string' && JOY_AGENT_ERROR_CODES.includes(value as JoyAgentErrorCode);
}
