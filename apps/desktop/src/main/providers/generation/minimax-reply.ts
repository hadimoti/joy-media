/**
 * How a MiniMax generation reply is judged before its fields are read: by its HTTP status, then by its `base_resp`
 * status code, which MiniMax sends with a 200 as well as with an error. Pure: no I/O.
 */
import { isRecord } from '../request-body.js';
import type { GenerationErrorCode } from './types.js';

export interface ReplyFailure {
  readonly code: GenerationErrorCode;
  readonly message: string;
}

/**
 * The `base_resp.status_code` values JOY reads. Only the ones named here get their own code; any other non-zero value is
 * `REJECTED`, with its number and nothing from the provider's own text. UNVERIFIED: these values are the ones JOY
 * expects from MiniMax's error list. T-C10 records the codes the owner's key actually returns, and this table is
 * corrected from that record.
 */
const STATUS_CODES: Readonly<Record<number, GenerationErrorCode>> = {
  1002: 'QUOTA',
  1004: 'AUTH',
  1008: 'QUOTA',
  1026: 'BAD_PROMPT',
  2013: 'BAD_PROMPT',
  2049: 'AUTH',
};

const MESSAGES: Readonly<Record<GenerationErrorCode, string>> = {
  AUTH: 'The provider rejected the credentials.',
  NOT_ALLOWED: 'This key does not allow that model. Check the plan on the provider account.',
  QUOTA: 'The provider account has no balance or is rate limited. Try again later or add credit.',
  BAD_PROMPT: 'The provider refused the prompt. Change the wording and try again.',
  REJECTED: 'The provider refused the request.',
  RESPONSE_INVALID: 'The provider reply was not understood.',
  ROUTE_MISSING: 'The route is not available on this account.',
};

/** The parsed reply, when it is a JSON object. Anything else is undefined. */
export function parseReply(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The failure a reply carries, or undefined when the reply is a success. The HTTP status decides first: a missing route
 * is `ROUTE_MISSING` so the broker can try the legacy route. A success status can still carry a failure in `base_resp`.
 */
export function replyFailure(status: number, text: string): ReplyFailure | undefined {
  if (status === 404) return failure('ROUTE_MISSING', undefined);
  if (status === 401) return failure('AUTH', undefined);
  if (status === 403) return failure('NOT_ALLOWED', undefined);
  if (status === 402 || status === 429) return failure('QUOTA', undefined);
  const parsed = parseReply(text);
  const code = parsed !== undefined ? baseRespCode(parsed) : undefined;
  if (code !== undefined && code !== 0) {
    const mapped = STATUS_CODES[code];
    return mapped === undefined
      ? failure('REJECTED', `The provider refused the request (code ${code}).`)
      : failure(mapped, undefined);
  }
  if (status < 200 || status > 299) {
    return failure('REJECTED', `The provider returned HTTP ${status}.`);
  }
  return undefined;
}

/** The `base_resp.status_code` of a reply, when it has one. */
function baseRespCode(parsed: Record<string, unknown>): number | undefined {
  const baseResp = parsed.base_resp;
  if (!isRecord(baseResp) || typeof baseResp.status_code !== 'number') return undefined;
  return baseResp.status_code;
}

function failure(code: GenerationErrorCode, detail: string | undefined): ReplyFailure {
  return { code, message: detail ?? MESSAGES[code] };
}
