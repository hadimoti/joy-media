import type { LocalAiRequest, LocalAiResult } from '../../jobs/local-job-api.js';
import type { BrokerErrorCode, ProviderBroker } from './provider-broker.js';

/**
 * Adapts the broker to the Worker's loopback route (PLAN-v4 §6b). The Worker gets the reply text
 * or a status and a message: never a credential, a base URL or a header. The HTTP status is chosen
 * here, so the route itself stays free of provider rules.
 */
export function createWorkerCompletion(
  broker: ProviderBroker,
): (request: LocalAiRequest) => Promise<LocalAiResult> {
  return async (request) => {
    const result = await broker.complete({ profileId: request.profileId, body: request.body });
    if (result.ok) return { ok: true, text: result.data.text };
    return { ok: false, status: statusFor(result.code), message: result.message };
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
