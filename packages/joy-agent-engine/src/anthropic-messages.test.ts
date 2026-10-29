import { generateText, streamText, tool } from 'ai';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createJoyAgentProvider,
  safeByokSessionStatus,
  toSafeJoyAgentError,
  type ByokSessionConfig,
  type JoyFetch,
} from './index.js';

const API_KEY = 'sk-ant-test-secret-value';
const CONFIG = {
  provider: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com/v1',
  modelId: 'claude-test',
  apiKey: API_KEY,
} as unknown as ByokSessionConfig;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function captureFetch(reply: Response, onRequest: (url: URL, init: RequestInit) => void): JoyFetch {
  return async (input, init = {}) => {
    onRequest(new URL(input instanceof Request ? input.url : input.toString()), init);
    return reply;
  };
}

function sseResponse(events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map((event) => 'event: ' + String(event.type) + '\ndata: ' + JSON.stringify(event) + '\n\n')
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Anthropic Messages provider in the JOY Agent engine', () => {
  it('sends the Messages request with API-key auth and translated conversation and tools', async () => {
    let requestUrl: URL | undefined;
    let requestInit: RequestInit | undefined;
    const fetchImpl = captureFetch(
      jsonResponse({
        id: 'msg_tool',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { query: 'title' } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 4 },
      }),
      (url, init) => {
        requestUrl = url;
        requestInit = init;
      },
    );
    const { model } = createJoyAgentProvider(CONFIG, fetchImpl);

    const result = await generateText({
      model,
      system: 'Use the lookup tool.',
      prompt: 'Find a title.',
      maxOutputTokens: 77,
      temperature: 0.4,
      toolChoice: 'required',
      tools: {
        lookup: tool({
          description: 'Look up a title.',
          inputSchema: z.object({ query: z.string() }),
        }),
      },
    });

    expect(requestUrl?.href).toBe('https://api.anthropic.com/v1/messages');
    const headers = new Headers(requestInit?.headers);
    expect(headers.get('x-api-key')).toBe(API_KEY);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('authorization')).toBeNull();
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'claude-test',
      max_tokens: 77,
      system: 'Use the lookup tool.',
      temperature: 0.4,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Find a title.' }] }],
      tool_choice: { type: 'any' },
    });
    expect(body.tools).toMatchObject([
      {
        name: 'lookup',
        description: 'Look up a title.',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ]);
    expect(result.toolCalls).toMatchObject([
      { toolCallId: 'toolu_1', toolName: 'lookup', input: { query: 'title' } },
    ]);
  });

  it('parses text blocks, finish reason, and usage from a Messages response', async () => {
    const fetchImpl = captureFetch(
      jsonResponse({
        id: 'msg_text',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [
          { type: 'text', text: 'A bounded ' },
          { type: 'text', text: 'answer.' },
        ],
        stop_reason: 'max_tokens',
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 5 },
      }),
      () => undefined,
    );
    const { model } = createJoyAgentProvider(CONFIG, fetchImpl);

    const result = await generateText({ model, prompt: 'Answer briefly.', maxOutputTokens: 20 });

    expect(result.text).toBe('A bounded answer.');
    expect(result.finishReason).toBe('length');
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 5, totalTokens: 12 });
  });

  it('parses Anthropic text deltas and completion metadata from a streamed Messages response', async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = captureFetch(
      sseResponse([
        {
          type: 'message_start',
          message: {
            id: 'msg_stream',
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Streamed ' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'answer.' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
      ]),
      (_url, init) => {
        requestInit = init;
      },
    );
    const { model } = createJoyAgentProvider(CONFIG, fetchImpl);

    const result = streamText({ model, prompt: 'Answer briefly.' });
    const text = await result.text;

    expect(JSON.parse(String(requestInit?.body))).toMatchObject({ stream: true });
    expect(text).toBe('Streamed answer.');
    expect(await result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });

  it('redacts an API key split across streamed text deltas', async () => {
    const fetchImpl = captureFetch(
      sseResponse([
        {
          type: 'message_start',
          message: {
            id: 'msg_secret',
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Accidental echo: ' + API_KEY.slice(0, 12) },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: API_KEY.slice(12) + ' should be hidden.' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
      ]),
      () => undefined,
    );
    const { model } = createJoyAgentProvider(CONFIG, fetchImpl);

    const result = streamText({ model, prompt: 'Do not repeat the key.' });
    const text = await result.text;

    expect(text).toContain('[Redacted]');
    expect(text).not.toContain(API_KEY);
  });

  it('maps authorization errors and keeps the API key out of output and logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchImpl = captureFetch(
      jsonResponse(
        { type: 'error', error: { type: 'authentication_error', message: 'Rejected ' + API_KEY } },
        401,
      ),
      () => undefined,
    );
    const { model, status } = createJoyAgentProvider(CONFIG, fetchImpl);
    let failure: unknown;
    try {
      await generateText({ model, prompt: 'Do not reveal credentials.' });
    } catch (caught) {
      failure = caught;
    }

    expect(failure).toBeDefined();
    expect(toSafeJoyAgentError(failure)).toEqual({
      code: 'JOY_AGENT_AUTH_FAILED',
      retryable: false,
    });
    expect(JSON.stringify([failure, status, safeByokSessionStatus(CONFIG)])).not.toContain(API_KEY);
    expect(JSON.stringify([log.mock.calls, warn.mock.calls, errorLog.mock.calls])).not.toContain(
      API_KEY,
    );
  });
});
