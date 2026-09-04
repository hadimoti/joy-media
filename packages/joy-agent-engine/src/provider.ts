import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ByokSessionConfig, ByokSessionStatus } from './provider-config.js';
import { safeByokSessionStatus } from './provider-config.js';

export const DEFAULT_PROVIDER_RESPONSE_BYTES = 2_097_152;

export type JoyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Restrict provider traffic to the one configured origin. This wrapper also
 * prevents ambient browser credentials and redirects from crossing the
 * boundary, and bounds streamed response bodies before the SDK can parse them.
 */
export function createHardenedFetch(
  expectedBaseUrl: string,
  fetchImpl: JoyFetch = (input, init) => fetch(input, init),
  maxResponseBytes = DEFAULT_PROVIDER_RESPONSE_BYTES,
): JoyFetch {
  const expectedOrigin = new URL(expectedBaseUrl).origin;
  return async (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
    if (requestUrl.origin !== expectedOrigin) throw new Error('JOY_AGENT_CORS_OR_NETWORK');

    const headers = new Headers(init?.headers);
    const response = await fetchImpl(input, {
      ...init,
      headers,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    if (response.url !== '' && new URL(response.url).origin !== expectedOrigin) {
      throw new Error('JOY_AGENT_CORS_OR_NETWORK');
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > maxResponseBytes) {
      throw new Error('JOY_AGENT_RESPONSE_TOO_LARGE');
    }
    if (response.body === null) return response;

    const source = response.body;
    let bytesRead = 0;
    const boundedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const reader = source.getReader();
          const result = await reader.read();
          reader.releaseLock();
          if (result.done) {
            controller.close();
            return;
          }
          bytesRead += result.value.byteLength;
          if (bytesRead > maxResponseBytes) {
            await source.cancel('JOY_AGENT_RESPONSE_TOO_LARGE');
            controller.error(new Error('JOY_AGENT_RESPONSE_TOO_LARGE'));
            return;
          }
          controller.enqueue(result.value);
        } catch (error) {
          controller.error(
            error instanceof Error
              ? new Error('JOY_AGENT_RESPONSE_TOO_LARGE')
              : new Error('JOY_AGENT_CORS_OR_NETWORK'),
          );
        }
      },
      cancel(reason) {
        return source.cancel(reason);
      },
    });
    return new Response(boundedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export function createJoyAgentProvider(
  config: ByokSessionConfig,
  fetchImpl?: JoyFetch,
): { readonly model: LanguageModel; readonly status: ByokSessionStatus } {
  const provider = createOpenAICompatible({
    name: 'joy-byok',
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    fetch: createHardenedFetch(config.baseUrl, fetchImpl),
    includeUsage: true,
  });
  return {
    model: provider(config.modelId),
    status: safeByokSessionStatus(config),
  };
}
