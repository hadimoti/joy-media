import { describe, expect, it, vi } from 'vitest';
import type { CompletionBody } from '../request-body.js';
import {
  CHATGPT_RESPONSES_BASE_URL,
  createChatGptCatalog,
  needsModelChoice,
  prepareChatGptResponses,
  readChatGptModels,
  readChatGptStream,
} from './chatgpt-responses.js';
import { AdapterRequestError, type ModelEntry } from './types.js';

const TOKEN = 'access-token-test';

/** Every field the ChatGPT sign-in must leave out of a request (PLAN-v4 §6d). */
const OMITTED_FIELDS = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
  'max_tokens',
];

function requestOf(body: CompletionBody): Record<string, unknown> {
  const call = prepareChatGptResponses({ accessToken: TOKEN, modelId: 'gpt-test', body });
  return JSON.parse(String(call.body)) as Record<string, unknown>;
}

/** The refusal message of a request, or undefined when the request is prepared. */
function refusalOf(body: CompletionBody): string | undefined {
  try {
    prepareChatGptResponses({ accessToken: TOKEN, modelId: 'gpt-test', body });
    return undefined;
  } catch (error) {
    return error instanceof AdapterRequestError ? error.message : 'other';
  }
}

const plain: CompletionBody = { messages: [{ role: 'user', content: 'hello' }] };

describe('ChatGPT request', () => {
  it('posts to the Responses endpoint with the token and X-Title, and nothing else', () => {
    const call = prepareChatGptResponses({ accessToken: TOKEN, modelId: 'gpt-test', body: plain });
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${CHATGPT_RESPONSES_BASE_URL}/responses`);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers['x-title']).toBe('JOY Media');
  });

  it('always sends store:false and stream:true, and never a previous response id', () => {
    const payload = requestOf(plain);
    expect(payload).toMatchObject({ model: 'gpt-test', store: false, stream: true });
    expect(payload).not.toHaveProperty('previous_response_id');
  });

  it('leaves out every field the sign-in does not send, even when the caller sets it', () => {
    const payload = requestOf({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      max_tokens: 64,
    });
    for (const field of OMITTED_FIELDS) expect(payload).not.toHaveProperty(field);
  });

  it('moves system guidance into instructions and never sends a system-role item', () => {
    const payload = requestOf({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(payload.instructions).toBe('Be brief.');
    expect(payload.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    expect(JSON.stringify(payload.input)).not.toContain('"role":"system"');
  });

  it('sends the whole history as input items, with tool calls and their results', () => {
    const payload = requestOf({
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"p":1}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file text' },
      ],
    });
    expect(payload.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read it' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"p":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file text' },
    ]);
  });

  it('sends text, image and file parts as input parts', () => {
    const payload = requestOf({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'https://img.example/a.png' } },
            { type: 'file', file: { filename: 'notes.txt', file_data: 'ZGF0YQ==' } },
          ],
        },
      ],
    });
    expect(payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'https://img.example/a.png', detail: 'auto' },
          { type: 'input_file', file_data: 'ZGF0YQ==', filename: 'notes.txt' },
        ],
      },
    ]);
  });

  it('converts function tools to the Responses form, and sends none when none were offered', () => {
    const converted = requestOf({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Reads a file.',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
      tool_choice: 'auto',
    });
    expect(converted.tools).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: 'Reads a file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        strict: false,
      },
    ]);
    expect(converted.tool_choice).toBe('auto');
    expect(requestOf(plain)).not.toHaveProperty('tools');
  });

  it.each([
    'image_generation',
    'file_search',
    'code_interpreter',
    'computer_use',
    'mcp',
    'connector',
    'tool_search',
    'programmatic_tool_calling',
  ])('refuses the %s tool before sending anything', (type) => {
    expect(
      refusalOf({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type }] }),
    ).toBeDefined();
  });

  it.each(['input_audio', 'video'])('refuses %s input before sending anything', (type) => {
    expect(
      refusalOf({
        messages: [{ role: 'user', content: [{ type, [type]: { data: 'x' } }] }],
      }),
    ).toBeDefined();
  });

  it('refuses a message role it does not know', () => {
    expect(refusalOf({ messages: [{ role: 'narrator', content: 'hi' }] })).toBeDefined();
  });
});

/** One SSE event per object, in the order given. */
function sseOf(...events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

const delta = (text: string): Record<string, unknown> => ({
  type: 'response.output_text.delta',
  delta: text,
});
const message = (text: string): Record<string, unknown> => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});
const completed = (output: unknown[]): Record<string, unknown> => ({
  type: 'response.completed',
  response: { output },
});

describe('ChatGPT stream', () => {
  it('completes only on response.completed, as the Chat Completions JSON the engine reads', () => {
    const outcome = readChatGptStream(
      sseOf(delta('Hel'), delta('lo'), completed([message('Hello')])),
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(JSON.parse(outcome.completion)).toEqual({
      choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    });
  });

  it('turns a function call in the final output into a tool call', () => {
    const outcome = readChatGptStream(
      sseOf(
        completed([
          {
            type: 'function_call',
            call_id: 'call_9',
            name: 'read_file',
            arguments: '{"p":2}',
          },
        ]),
      ),
    );
    if (outcome.kind !== 'completed') throw new Error('expected a completed reply');
    expect(JSON.parse(outcome.completion)).toEqual({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_9',
                type: 'function',
                function: { name: 'read_file', arguments: '{"p":2}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
  });

  it('completes from the streamed text when the final response carries no output', () => {
    const outcome = readChatGptStream(sseOf(delta('Hel'), delta('lo'), completed([])));
    if (outcome.kind !== 'completed') throw new Error('expected a completed reply');
    expect(JSON.parse(outcome.completion).choices[0].message.content).toBe('Hello');
  });

  it('reports response.incomplete as its own result, with the text that arrived', () => {
    const outcome = readChatGptStream(
      sseOf(delta('Hel'), {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'max_output_tokens' } },
      }),
    );
    expect(outcome).toEqual({
      kind: 'incomplete',
      reason: 'max_output_tokens',
      partialText: 'Hel',
    });
  });

  it('maps response.failed to its error code', () => {
    const outcome = readChatGptStream(
      sseOf({ type: 'response.failed', response: { error: { code: 'server_error' } } }),
    );
    expect(outcome).toEqual({ kind: 'failed', code: 'server_error' });
  });

  it('maps an error event to its code', () => {
    expect(readChatGptStream(sseOf({ type: 'error', code: 'rate_limit_exceeded' }))).toEqual({
      kind: 'failed',
      code: 'rate_limit_exceeded',
    });
  });

  it('never echoes a code that is not a plain word', () => {
    expect(
      readChatGptStream(
        sseOf({ type: 'response.failed', response: { error: { code: 'Bearer sk-live-123' } } }),
      ),
    ).toEqual({ kind: 'failed', code: 'unknown' });
  });

  it('reports a stream that ends without a terminal event as interrupted', () => {
    expect(readChatGptStream(sseOf(delta('Hel')))).toEqual({
      kind: 'interrupted',
      partialText: 'Hel',
    });
    expect(readChatGptStream('')).toEqual({ kind: 'interrupted', partialText: '' });
  });

  it.each([
    [
      'response.failed',
      {
        type: 'response.failed',
        response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
      },
    ],
    ['an error event', { type: 'error', code: 'subscription_sharing_usage_unavailable' }],
  ])(
    'marks partial text incomplete when a usage limit arrives mid-stream, through %s',
    (_name, limit) => {
      expect(readChatGptStream(sseOf(delta('Hel'), limit))).toEqual({
        kind: 'plan-limit',
        partialText: 'Hel',
        incomplete: true,
      });
    },
  );
});

describe('ChatGPT model list', () => {
  it('keeps only the models the account may list, in the server order', () => {
    const models: ModelEntry[] = readChatGptModels(
      JSON.stringify({
        models: [
          { slug: 'gpt-b', display_name: 'Model B', visibility: 'list' },
          { slug: 'hidden-one', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'gpt-a', visibility: 'list' },
        ],
      }),
    ) as ModelEntry[];
    expect(models).toEqual([
      { id: 'gpt-b', name: 'Model B' },
      { id: 'gpt-a', name: 'gpt-a' },
    ]);
  });

  it('loads a list once per account, and loads it again for another account', async () => {
    const loads: string[] = [];
    const loaderFor = (accountId: string) => async (): Promise<readonly ModelEntry[]> => {
      loads.push(accountId);
      return [{ id: `model-for-${accountId}`, name: accountId }];
    };
    const catalog = createChatGptCatalog();

    await catalog.list('acct-1', loaderFor('acct-1'));
    await catalog.list('acct-1', loaderFor('acct-1'));
    expect(loads).toEqual(['acct-1']);

    await expect(catalog.list('acct-2', loaderFor('acct-2'))).resolves.toEqual([
      { id: 'model-for-acct-2', name: 'acct-2' },
    ]);
    expect(loads).toEqual(['acct-1', 'acct-2']);

    catalog.forget('acct-1');
    await catalog.list('acct-1', loaderFor('acct-1'));
    expect(loads).toEqual(['acct-1', 'acct-2', 'acct-1']);
  });

  it('refuses a reply that is not a model list, rather than reading it as an empty list', () => {
    expect(() => readChatGptModels('not json')).toThrow();
    expect(() => readChatGptModels('{"data": []}')).toThrow();
  });

  it('shares one load between overlapping calls, and loads again after a failed load', async () => {
    const catalog = createChatGptCatalog();
    let loads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async (): Promise<readonly ModelEntry[]> => {
      loads += 1;
      await gate;
      return [{ id: 'gpt-a', name: 'gpt-a' }];
    };
    const first = catalog.list('acct-1', slow);
    const second = catalog.list('acct-1', slow);
    release();
    await expect(first).resolves.toEqual([{ id: 'gpt-a', name: 'gpt-a' }]);
    await expect(second).resolves.toEqual([{ id: 'gpt-a', name: 'gpt-a' }]);
    expect(loads).toBe(1);

    let failNext = true;
    const flaky = async (): Promise<readonly ModelEntry[]> => {
      if (failNext) {
        failNext = false;
        throw new Error('offline');
      }
      return [{ id: 'gpt-b', name: 'gpt-b' }];
    };
    await expect(catalog.list('acct-2', flaky)).rejects.toThrow('offline');
    await expect(catalog.list('acct-2', flaky)).resolves.toEqual([{ id: 'gpt-b', name: 'gpt-b' }]);
  });

  it('refuses a listed model without a usable slug, and skips the entries the account does not list', () => {
    expect(() => readChatGptModels('{"models":[{"visibility":"list"}]}')).toThrow();
    expect(
      readChatGptModels('{"models":[{"visibility":"hide"},{"slug":"no-visibility"},"plain text"]}'),
    ).toEqual([]);
  });

  it('loads a list again once its time-to-live has passed', async () => {
    let clock = 0;
    const loadedAt: number[] = [];
    const catalog = createChatGptCatalog({ ttlMs: 1_000, now: () => clock });
    const load = async (): Promise<readonly ModelEntry[]> => {
      loadedAt.push(clock);
      return [{ id: 'gpt-a', name: 'gpt-a' }];
    };

    await catalog.list('acct-1', load);
    clock = 999;
    await catalog.list('acct-1', load);
    expect(loadedAt).toEqual([0]);

    clock = 1_000;
    await catalog.list('acct-1', load);
    expect(loadedAt).toEqual([0, 1_000]);
  });

  it('asks for a choice when the saved model is not in the list', () => {
    const models: ModelEntry[] = [{ id: 'gpt-a', name: 'gpt-a' }];
    expect(needsModelChoice(models, 'gpt-a')).toBe(false);
    expect(needsModelChoice(models, 'gpt-retired')).toBe(true);
  });
});
