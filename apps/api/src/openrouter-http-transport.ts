import type { HttpPostTransport } from '@joy-media/adapter-openrouter';

/** The only origin and endpoint permitted for the Creative Brief transport. */
export const OPENROUTER_CHAT_COMPLETIONS_URL =
  'https://openrouter.ai/api/v1/chat/completions' as const;

type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Fixed-origin HTTP transport for the OpenRouter adapter.
 *
 * The transport owns no credentials and does not rewrite URLs. It only
 * forwards the exact endpoint after validating origin and path, preserving
 * the adapter-provided AbortSignal and request headers.
 */
export class OpenRouterHttpPostTransport implements HttpPostTransport {
  readonly #fetch: FetchImplementation;

  constructor(fetchImplementation: FetchImplementation = globalThis.fetch.bind(globalThis)) {
    this.#fetch = fetchImplementation;
  }

  async post(url: string, options: RequestInit): Promise<Response> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('OpenRouter request must use the fixed OpenRouter origin');
    }

    if (parsed.origin !== 'https://openrouter.ai') {
      throw new Error('OpenRouter request must use the fixed OpenRouter origin');
    }
    if (url !== OPENROUTER_CHAT_COMPLETIONS_URL) {
      throw new Error('OpenRouter request must use the fixed OpenRouter endpoint');
    }
    if ((options.method ?? 'GET').toUpperCase() !== 'POST') {
      throw new Error('OpenRouter request must use POST');
    }

    return this.#fetch(url, options);
  }
}

export type { FetchImplementation };
