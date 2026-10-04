import { APICallError } from 'ai';
import {
  JOY_AGENT_ERROR_CODES,
  type JoyAgentErrorCode,
  type JoyAgentErrorDetail,
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
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 401 || status === 403) return 'JOY_AGENT_AUTH_FAILED';
    if (status === 404) return 'JOY_AGENT_MODEL_NOT_FOUND';
    if (status === 408 || status === 504) return 'JOY_AGENT_TIMEOUT';
    if (status === 429) return 'JOY_AGENT_RATE_LIMITED';
    if (status !== undefined && status >= 500) return 'JOY_AGENT_UPSTREAM_UNAVAILABLE';
    if (
      (status === 400 || status === 422) &&
      /tool|function/i.test(error.responseBody ?? error.message)
    )
      return 'JOY_AGENT_INVALID_TOOL';
  }
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
  if (/\b429\b|rate.?limit/i.test(message)) return 'JOY_AGENT_RATE_LIMITED';
  if (normalized.includes('too large') || normalized.includes('oversize'))
    return 'JOY_AGENT_RESPONSE_TOO_LARGE';
  if (normalized.includes('tool')) return 'JOY_AGENT_INVALID_TOOL';
  if (normalized.includes('proposal')) return 'JOY_AGENT_INVALID_PROPOSAL';
  if (normalized.includes('revision')) return 'JOY_AGENT_STALE_REVISION';
  return 'JOY_AGENT_UNKNOWN';
}

export function toSafeJoyAgentError(error: unknown): JoyAgentSafeError {
  const code = classifyJoyAgentError(error);
  return {
    code,
    retryable: (
      [
        'JOY_AGENT_TIMEOUT',
        'JOY_AGENT_CORS_OR_NETWORK',
        'JOY_AGENT_RATE_LIMITED',
        'JOY_AGENT_UPSTREAM_UNAVAILABLE',
      ] as readonly JoyAgentErrorCode[]
    ).includes(code),
  };
}

export function safeErrorDetail(error: unknown, configuredApiKey?: string): JoyAgentErrorDetail {
  const record =
    error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawBody = typeof record.responseBody === 'string' ? record.responseBody : '';
  const url = typeof record.url === 'string' ? record.url : '';
  let urlOrigin: string | undefined;
  try {
    urlOrigin = new URL(url).origin;
  } catch {
    /* omit malformed URLs */
  }
  const sanitize = (value: string) => {
    let result = value
      .replace(/Bearer\s+\S+/gi, 'Bearer [Redacted]')
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[Redacted]');
    if (configuredApiKey) result = result.split(configuredApiKey).join('[Redacted]');
    return result.slice(0, 300);
  };
  return {
    name: error instanceof Error ? error.name : 'Error',
    ...(typeof record.statusCode === 'number' ? { statusCode: record.statusCode } : {}),
    ...(urlOrigin ? { urlOrigin } : {}),
    message: sanitize(rawMessage),
    responseBodySnippet: sanitize(rawBody),
  };
}

export function isJoyAgentErrorCode(value: unknown): value is JoyAgentErrorCode {
  return typeof value === 'string' && JOY_AGENT_ERROR_CODES.includes(value as JoyAgentErrorCode);
}
