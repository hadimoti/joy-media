import type { LocalAiRequest, LocalAiResult } from '../../jobs/local-job-api.js';
import {
  MAX_WORKER_REQUEST_BYTES,
  type BrokerErrorCode,
  type BrokerFailure,
  type ProviderBroker,
} from './provider-broker.js';

/**
 * Adapts the broker to the Worker's loopback route (PLAN-v4 §6b). The Worker gets the reply text
 * or a status and a message: never a credential, a base URL or a header. The HTTP status is chosen
 * here, so the route itself stays free of provider rules.
 */
export function createWorkerCompletion(
  broker: ProviderBroker,
): (request: LocalAiRequest) => Promise<LocalAiResult> {
  return async (request) => {
    const result = await broker.complete({
      profileId: request.profileId,
      body: request.body,
      maxRequestBytes: MAX_WORKER_REQUEST_BYTES,
      signal: request.signal,
    });
    if (result.ok) return { ok: true, text: result.data.text };
    return { ok: false, status: statusFor(result.code), message: messageFor(result) };
  };
}

export function statusFor(code: BrokerErrorCode): 413 | 422 | 502 {
  switch (code) {
    case 'REQUEST_TOO_LARGE':
      return 413;
    case 'REQUEST_INVALID':
      return 422;
    default:
      return 502;
  }
}

/**
 * The Worker is told that a redirect happened, not where it led: the target names the provider's own
 * host and path, and the Worker route must not carry either (PLAN-v4 §6b).
 */
function messageFor(result: BrokerFailure): string {
  return result.code === 'REDIRECT_REFUSED'
    ? 'The provider redirected the request. Redirects are not followed.'
    : result.message;
}
