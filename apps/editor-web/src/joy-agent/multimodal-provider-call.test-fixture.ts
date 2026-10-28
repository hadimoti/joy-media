import type { MultimodalProviderCall } from './multimodal-transport.js';
import { ProviderCallError } from './provider-call.js';

/** A fake provider endpoint, shaped like the fetch the direct transport used to call. */
export type FakeProviderFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Adapts a fake provider into the broker-backed call the transport uses now. The fake sees the same
 * endpoint and body the broker would send; a failed reply becomes the broker's error codes.
 */
export function providerCallFromFetch(fetcher: FakeProviderFetch): MultimodalProviderCall {
  return async ({ connection, body, signal }) => {
    const endpoint = `${connection.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ProviderCallError('AUTH_FAILED', 'The provider rejected the credentials.');
    }
    if (!response.ok) {
      throw new ProviderCallError('PROVIDER_HTTP_ERROR', 'The provider returned an error.');
    }
    return readUntilAborted(response, signal);
  };
}

/** Reads the reply text, but gives up as soon as the caller aborts, even if the stream never ends. */
function readUntilAborted(
  response: Response,
  signal: AbortSignal | null | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void =>
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted === true) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    response
      .text()
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', onAbort));
  });
}
