import { describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_RESPONSES_BASE_URL,
  createChatGptResponsesFetch,
  prepareChatGptModels,
  prepareChatGptResponses,
  readChatGptModels,
  readChatGptStream,
  type ChatGptFetch,
} from './chatgpt-responses.js';

const TOKEN = 'chatgpt-access-test-token';

function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

describe('ChatGPT Responses engine bridge', () => {
  it('builds the same allowlisted Responses request as the desktop adapter', () => {
    const prepared = prepareChatGptResponses({
      accessToken: TOKEN,
      modelId: 'gpt-test',
      body: {
        messages: [
          { role: 'system', content: 'Keep the answer brief.' },
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read a project file.',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'read_file' } },
      },
    });

    expect(prepared).toMatchObject({
      method: 'POST',
      url: `${CHATGPT_RESPONSES_BASE_URL}/responses`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'text/event-stream',
        'x-title': 'JOY Media',
      },
    });
    expect(JSON.parse(prepared.body ?? '{}')).toEqual({
      model: 'gpt-test',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"a.txt"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
      ],
      instructions: 'Keep the answer brief.',
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read a project file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
          strict: false,
        },
      ],
      tool_choice: { type: 'function', name: 'read_file' },
      store: false,
      stream: true,
    });
    expect(prepared.body).not.toContain('previous_response_id');
  });

  it('converts a completed text and tool-call stream to Chat Completions SSE', async () => {
    const upstream = vi.fn<ChatGptFetch>(async (input, init) => {
      expect(input).toBe(`${CHATGPT_RESPONSES_BASE_URL}/responses`);
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      return new Response(
        event({
          type: 'response.output_text.delta',
          delta: 'The file is empty. ',
        }) +
          event({
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: 'call_2',
              name: 'write_file',
              arguments: '{"path":"a.txt","text":""}',
            },
          }) +
          event({
            type: 'response.completed',
            response: {
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'The file is empty. ' }],
                },
                {
                  type: 'function_call',
                  call_id: 'call_2',
                  name: 'write_file',
                  arguments: '{"path":"a.txt","text":""}',
                },
              ],
            },
          }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const fetch = createChatGptResponsesFetch({ accessToken: TOKEN, modelId: 'gpt-test', fetch: upstream });
    const response = await fetch(`${CHATGPT_RESPONSES_BASE_URL}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-test',
        stream: true,
        messages: [{ role: 'user', content: 'inspect the file' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const stream = await response.text();
    const chunk = JSON.parse(stream.split('\n')[0]!.slice('data: '.length)) as {
      choices: Array<{ delta: Record<string, unknown>; finish_reason: string }>;
    };
    expect(chunk.choices[0]).toMatchObject({
      delta: {
        role: 'assistant',
        content: 'The file is empty. ',
        tool_calls: [
          {
            index: 0,
            id: 'call_2',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":"a.txt","text":""}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
    expect(stream).toContain('data: [DONE]');
  });

  it('streams upstream for a non-streaming caller and returns Chat Completions JSON', async () => {
    let upstreamInit: RequestInit | undefined;
    const upstream = vi.fn<ChatGptFetch>(async (_input, init) => {
      upstreamInit = init;
      return new Response(
        event({
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'The reply.' }],
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const fetch = createChatGptResponsesFetch({ accessToken: TOKEN, modelId: 'gpt-test', fetch: upstream });
    const response = await fetch(`${CHATGPT_RESPONSES_BASE_URL}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-test',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'The reply.' }, finish_reason: 'stop' }],
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(upstreamInit?.body))).toMatchObject({ stream: true });
    expect(new Headers(upstreamInit?.headers).get('accept')).toBe('text/event-stream');
  });

  it('does not return partial text when a Responses stream ends or fails early', () => {
    expect(
      readChatGptStream(
        event({ type: 'response.output_text.delta', delta: 'partial' }),
      ),
    ).toEqual({ kind: 'interrupted', partialText: 'partial' });
    expect(
      readChatGptStream(
        event({ type: 'response.output_text.delta', delta: 'partial' }) +
          event({ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } }),
      ),
    ).toEqual({ kind: 'failed', code: 'rate_limit_exceeded' });
  });

  it('prepares and reads the account model list using the desktop visibility rules', () => {
    expect(prepareChatGptModels({ accessToken: TOKEN })).toMatchObject({
      method: 'GET',
      url: `${CHATGPT_RESPONSES_BASE_URL}/models`,
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
      body: undefined,
    });
    expect(
      readChatGptModels(
        JSON.stringify({
          models: [
            { slug: 'gpt-visible', display_name: 'Visible model', visibility: 'list' },
            { slug: 'gpt-hidden', display_name: 'Hidden model', visibility: 'hide' },
          ],
        }),
      ),
    ).toEqual([{ id: 'gpt-visible', name: 'Visible model' }]);
  });
});
