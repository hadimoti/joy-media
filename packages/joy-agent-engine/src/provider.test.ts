import { describe, expect, it, vi } from 'vitest';
import { generateText, streamText } from 'ai';
import { createHardenedFetch, createJoyAgentProvider } from './provider.js';
import { normalizeByokSessionConfig } from './provider-config.js';
import type { JoyFetch } from './provider.js';
import { CHATGPT_RESPONSES_BASE_URL } from '@joy-media/provider-sdk';

function response(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', ...init?.headers },
    ...init,
  });
}

describe('hardened provider fetch', () => {
  it('sends a typed OAuth bearer token without reading an API-key fallback', async () => {
    const token = 'oauth-access-token';
    const fallbackKey = 'api-key-fallback-secret';
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = fallbackKey;
    const fetchImpl = vi.fn<JoyFetch>(async (input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      expect(String(init?.headers)).not.toContain(fallbackKey);
      return response(
        JSON.stringify({
          id: 'chatcmpl-local',
          object: 'chat.completion',
          created: 1,
          model: 'MiniMax-M2.1',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });

    try {
      const config = normalizeByokSessionConfig({
        provider: 'openai-compatible',
        baseUrl: 'https://api.minimax.io/v1',
        modelId: 'MiniMax-M2.1',
        auth: { kind: 'bearer-token', token },
        consentToPublicEndpoint: true,
      });
      const { model } = createJoyAgentProvider(config, fetchImpl);
      const result = await generateText({ model, prompt: 'hello', maxRetries: 0 });

      expect(result.text).toBe('ok');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiKey;
    }
  });

  it('bridges the ChatGPT Responses event stream into the engine text stream', async () => {
    const token = 'chatgpt-access-token';
    const calls: Array<{
      url: string;
      authorization: string | null;
      accept: string | null;
      body: string;
    }> = [];
    const responsesBody = `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Hello from ChatGPT.' }] },
        ],
      },
    })}\n\n`;
    const fetchImpl = vi.fn<JoyFetch>(async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        accept: new Headers(init?.headers).get('accept'),
        body: String(init?.body),
      });
      return new Response(responsesBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const config = normalizeByokSessionConfig({
      provider: 'chatgpt-responses',
      modelId: 'gpt-test',
      auth: { kind: 'bearer-token', token },
    });
    const { model } = createJoyAgentProvider(config, fetchImpl);

    const result = await generateText({ model, prompt: 'Say hello.', maxRetries: 0 });

    expect(result.text).toBe('Hello from ChatGPT.');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${CHATGPT_RESPONSES_BASE_URL}/responses`,
      authorization: `Bearer ${token}`,
      accept: 'text/event-stream',
    });
    const request = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(request).toMatchObject({ model: 'gpt-test', store: false, stream: true });
    expect(request.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] },
    ]);
    expect(request).not.toHaveProperty('previous_response_id');
  });

  it('keeps the ChatGPT bridge streaming when the engine requests a stream', async () => {
    const token = 'chatgpt-stream-access-token';
    const calls: Array<{ url: string; accept: string | null; body: string }> = [];
    const responsesStream = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Streamed ' })}`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'Streamed answer.' }] },
          ],
        },
      })}`,
      '',
    ].join('\n\n');
    const fetchImpl = vi.fn<JoyFetch>(async (input, init) => {
      calls.push({
        url: String(input),
        accept: new Headers(init?.headers).get('accept'),
        body: String(init?.body),
      });
      return new Response(responsesStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const config = normalizeByokSessionConfig({
      provider: 'chatgpt-responses',
      modelId: 'gpt-test',
      auth: { kind: 'bearer-token', token },
    });
    const { model } = createJoyAgentProvider(config, fetchImpl);

    const result = streamText({ model, prompt: 'Say hello.', maxRetries: 0 });

    await expect(result.text).resolves.toBe('Streamed answer.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${CHATGPT_RESPONSES_BASE_URL}/responses`);
    expect(calls[0]?.accept).toBe('text/event-stream');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      model: 'gpt-test',
      store: false,
      stream: true,
    });
  });

  it('pins origin and safe request options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response('{}')) as unknown as JoyFetch;
    const fetcher = createHardenedFetch('https://provider.example/v1', fetchImpl);
    await fetcher('https://provider.example/v1/chat/completions', {
      headers: { Authorization: 'Bearer session-key' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://provider.example/v1/chat/completions',
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      }),
    );
    await expect(fetcher('https://other.example/v1/chat/completions')).rejects.toThrow(
      'JOY_AGENT_CORS_OR_NETWORK',
    );
  });

  it('rejects a redirect response crossing the configured origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response('{}', { status: 200 }));
    const fetcher = createHardenedFetch('https://provider.example/v1', fetchImpl);
    const redirectResponse = response('{}');
    Object.defineProperty(redirectResponse, 'url', {
      value: 'https://other.example/redirect',
      configurable: true,
    });
    fetchImpl.mockResolvedValue(redirectResponse);
    await expect(fetcher('https://provider.example/v1/chat/completions')).rejects.toThrow(
      'JOY_AGENT_CORS_OR_NETWORK',
    );
  });

  it('bounds content-length and streamed bodies without exposing the body', async () => {
    const tooLarge = response('x'.repeat(12), { headers: { 'content-length': '12' } });
    const fetcher = createHardenedFetch(
      'https://provider.example/v1',
      vi.fn().mockResolvedValue(tooLarge),
      8,
    );
    await expect(fetcher('https://provider.example/v1/chat/completions')).rejects.toThrow(
      'JOY_AGENT_RESPONSE_TOO_LARGE',
    );

    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('123456789'));
          controller.close();
        },
      }),
    );
    const bounded = createHardenedFetch(
      'https://provider.example/v1',
      vi.fn().mockResolvedValue(streamed),
      8,
    );
    const result = await bounded('https://provider.example/v1/chat/completions');
    await expect(result.text()).rejects.toThrow();
  });
});
