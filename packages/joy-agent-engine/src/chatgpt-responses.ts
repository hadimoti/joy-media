import { CHATGPT_RESPONSES_BASE_URL, endpointUrl } from '@joy-media/provider-sdk';

const JOY_TITLE = 'JOY Media';
const JOY_TITLE_HEADER = 'x-title';
const ALLOWED_TOOL_TYPES: ReadonlySet<string> = new Set(['function', 'custom']);
const TOOL_CHOICE_WORDS: ReadonlySet<string> = new Set(['auto', 'none', 'required']);
const PLAN_LIMIT_CODES: ReadonlySet<string> = new Set([
  'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_usage_unavailable',
]);
const MAX_MODEL_ID_LENGTH = 256;

/** The ChatGPT request and stream bridge follows the desktop adapter until shared parity is established (D22 §8). */
export interface ChatGptPreparedCall {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

export interface ChatGptModelEntry {
  readonly id: string;
  readonly name: string;
}

export interface ChatGptCompletionBody {
  readonly messages: readonly Record<string, unknown>[];
  readonly tools?: readonly Record<string, unknown>[];
  readonly tool_choice?: string | Record<string, unknown>;
  readonly stream?: boolean;
}

/**
 * The token count of one ChatGPT reply, as the Responses API reports it. It is absent when the reply carries no
 * count: a count is never invented, so the engine's own zero fallback decides what an absent number means.
 */
export interface ChatGptUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type ChatGptOutcome =
  | {
      readonly kind: 'completed';
      readonly completion: string;
      readonly usage?: ChatGptUsage;
    }
  | { readonly kind: 'incomplete'; readonly reason: string; readonly partialText: string }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'plan-limit'; readonly partialText: string; readonly incomplete: true }
  | { readonly kind: 'interrupted'; readonly partialText: string };

export class ChatGptResponsesRequestError extends Error {
  readonly code = 'REQUEST_INVALID' as const;
}

export { CHATGPT_RESPONSES_BASE_URL };

/** Builds the Responses request with the same allowlist the desktop adapter uses. */
export function prepareChatGptResponses(input: {
  readonly accessToken: string;
  readonly modelId: string;
  readonly body: ChatGptCompletionBody;
}): ChatGptPreparedCall {
  const { instructions, items } = responseInput(input.body.messages);
  const tools = (input.body.tools ?? []).map(responseTool);
  const toolChoice =
    input.body.tool_choice === undefined ? undefined : responseToolChoice(input.body.tool_choice);
  const payload = {
    model: input.modelId,
    input: items,
    ...(instructions === undefined ? {} : { instructions }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    store: false,
    // The ChatGPT Responses endpoint answers unstreamed requests with HTTP 400: "Stream must be set to true".
    // Request SSE here and convert it to the caller's Chat Completions shape below.
    stream: true,
  };
  return {
    method: 'POST',
    url: endpointUrl(CHATGPT_RESPONSES_BASE_URL, 'responses'),
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${input.accessToken}`,
      [JOY_TITLE_HEADER]: JOY_TITLE,
    },
    body: JSON.stringify(payload),
  };
}

/** Reads a complete Responses event stream using the desktop adapter's terminal-event rules. */
export function readChatGptStream(text: string): ChatGptOutcome {
  let partialText = '';
  const streamedItems: unknown[] = [];
  for (const event of eventsOf(text)) {
    switch (event.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') partialText += event.delta;
        break;
      case 'response.output_item.done':
        if (event.item !== undefined) streamedItems.push(event.item);
        break;
      case 'response.completed': {
        const response = isRecord(event.response) ? event.response : {};
        const output = Array.isArray(response.output) ? response.output : [];
        const items = output.length > 0 ? output : streamedItems;
        const usage = usageOf(response);
        return {
          kind: 'completed',
          completion: completionOf(items, partialText),
          ...(usage === undefined ? {} : { usage }),
        };
      }
      case 'response.incomplete':
        return { kind: 'incomplete', reason: reasonOf(event), partialText };
      case 'response.failed':
      case 'error': {
        const code = errorCodeOf(event);
        if (PLAN_LIMIT_CODES.has(code)) {
          return { kind: 'plan-limit', partialText, incomplete: true };
        }
        return { kind: 'failed', code: safeCode(code) };
      }
      default:
        break;
    }
  }
  return { kind: 'interrupted', partialText };
}

/** Reads only the models the signed-in account may list, matching the desktop adapter. */
export function readChatGptModels(text: string): readonly ChatGptModelEntry[] {
  const models = parseObject(text)?.models;
  if (!Array.isArray(models)) throw new Error('The model list was not understood.');
  return models.flatMap((model): ChatGptModelEntry[] => {
    if (!isRecord(model) || model.visibility !== 'list') return [];
    if (typeof model.slug !== 'string' || !isUsableModelId(model.slug)) {
      throw new Error('The model list was not understood.');
    }
    const name =
      typeof model.display_name === 'string' && model.display_name.length > 0
        ? model.display_name
        : model.slug;
    return [{ id: model.slug, name }];
  });
}

/** Prepares the account's model-list request without exposing its response body in errors. */
export function prepareChatGptModels(input: { readonly accessToken: string }): ChatGptPreparedCall {
  return {
    method: 'GET',
    url: endpointUrl(CHATGPT_RESPONSES_BASE_URL, 'models'),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${input.accessToken}`,
      [JOY_TITLE_HEADER]: JOY_TITLE,
    },
    body: undefined,
  };
}

export type ChatGptFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Converts the engine's Chat Completions request and the Responses stream at the fetch boundary. */
export function createChatGptResponsesFetch(input: {
  readonly accessToken: string;
  readonly modelId: string;
  readonly fetch: ChatGptFetch;
}): ChatGptFetch {
  const expectedRequest = new URL(endpointUrl(CHATGPT_RESPONSES_BASE_URL, 'chat/completions'));
  return async (request, init = {}) => {
    const requestUrl = new URL(request instanceof Request ? request.url : request.toString());
    if (
      requestUrl.origin !== expectedRequest.origin ||
      requestUrl.pathname !== expectedRequest.pathname ||
      init.method?.toUpperCase() !== 'POST'
    ) {
      return errorResponse(400, 'ChatGPT request was not understood.');
    }
    const body = parseCompletionBody(init.body);
    if (body === undefined || body.model !== input.modelId) {
      return errorResponse(400, 'ChatGPT request was not understood.');
    }

    let prepared: ChatGptPreparedCall;
    try {
      prepared = prepareChatGptResponses({
        accessToken: input.accessToken,
        modelId: input.modelId,
        body,
      });
    } catch (error) {
      const message =
        error instanceof ChatGptResponsesRequestError
          ? error.message
          : 'ChatGPT request was not understood.';
      return errorResponse(400, message);
    }

    let response: Response;
    try {
      response = await input.fetch(prepared.url, {
        method: prepared.method,
        headers: prepared.headers,
        ...(prepared.body === undefined ? {} : { body: prepared.body }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      });
    } catch {
      return errorResponse(502, 'ChatGPT Responses request failed.');
    }
    if (!response.ok) return errorResponse(response.status, 'ChatGPT Responses request failed.');

    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      return errorResponse(502, 'ChatGPT response stream could not be read.');
    }
    const eventStream = responseEvents(responseText, response.headers.get('content-type'));
    const outcome = readChatGptStream(eventStream);
    return body.stream
      ? chatCompletionStream(outcome, input.modelId)
      : chatCompletionJson(outcome, input.modelId);
  };
}

function chatCompletionStream(outcome: ChatGptOutcome, modelId: string): Response {
  const failure = outcomeFailure(outcome);
  if (failure !== undefined) return failure;
  const completion = completionFields(outcome);
  if (completion === undefined) {
    return errorResponse(502, 'The ChatGPT reply was not understood.');
  }
  const { choice, message } = completion;
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.flatMap((call, index) => {
        if (
          !isRecord(call) ||
          typeof call.id !== 'string' ||
          !isRecord(call.function) ||
          typeof call.function.name !== 'string' ||
          typeof call.function.arguments !== 'string'
        ) {
          return [];
        }
        return [
          {
            index,
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments },
          },
        ];
      })
    : [];
  const delta = {
    role: 'assistant',
    ...(typeof message.content === 'string' ? { content: message.content } : {}),
    ...(typeof message.refusal === 'string' ? { refusal: message.refusal } : {}),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
  const chunk = {
    id: 'chatcmpl-joy-media',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
      },
    ],
    // The count rides on the last chunk, in the shape the Anthropic bridge emits, so the engine reads it there.
    ...(completion.usage === undefined ? {} : { usage: chatCompletionUsage(completion.usage) }),
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function chatCompletionJson(outcome: ChatGptOutcome, modelId: string): Response {
  const failure = outcomeFailure(outcome);
  if (failure !== undefined) return failure;
  const completion = completionFields(outcome);
  if (completion === undefined) return errorResponse(502, 'The ChatGPT reply was not understood.');
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-joy-media',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        { index: 0, message: completion.message, finish_reason: completion.choice.finish_reason },
      ],
      // The count sits at the top of a non-streaming reply, under the same rule as the streamed one.
      ...(completion.usage === undefined ? {} : { usage: chatCompletionUsage(completion.usage) }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function completionFields(outcome: ChatGptOutcome):
  | {
      readonly choice: Record<string, unknown>;
      readonly message: Record<string, unknown>;
      readonly usage: ChatGptUsage | undefined;
    }
  | undefined {
  if (outcome.kind !== 'completed') return undefined;
  const choices = parseObject(outcome.completion)?.choices;
  const choice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : undefined;
  const message = choice !== undefined && isRecord(choice.message) ? choice.message : undefined;
  if (choice === undefined || message === undefined) return undefined;
  return { choice, message, usage: outcome.usage };
}

function outcomeFailure(outcome: ChatGptOutcome): Response | undefined {
  switch (outcome.kind) {
    case 'completed':
      return undefined;
    case 'plan-limit':
      return errorResponse(
        429,
        'ChatGPT plan limit reached. You can switch to an API-key profile.',
      );
    case 'incomplete':
      return errorResponse(502, 'The ChatGPT reply stopped before it finished.');
    case 'interrupted':
      return errorResponse(502, 'The ChatGPT reply was cut off before it finished.');
    case 'failed':
      return errorResponse(502, `ChatGPT reported an error (${outcome.code}).`);
  }
}

function responseEvents(text: string, contentType: string | null): string {
  if (contentType?.includes('text/event-stream') || text.trimStart().startsWith('data:')) {
    return text;
  }
  const response = parseObject(text);
  if (response === undefined) return text;
  const type =
    response.status === 'incomplete'
      ? 'response.incomplete'
      : response.status === 'failed'
        ? 'response.failed'
        : 'response.completed';
  return `data: ${JSON.stringify({ type, response })}\n\n`;
}

function errorResponse(status: number, message: string): Response {
  const safeStatus = status >= 400 && status <= 599 ? status : 502;
  return new Response(JSON.stringify({ error: { message } }), {
    status: safeStatus,
    headers: { 'content-type': 'application/json' },
  });
}

function parseCompletionBody(
  value: BodyInit | null | undefined,
): (ChatGptCompletionBody & { readonly model: string }) | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = parseObject(value);
  if (
    parsed === undefined ||
    typeof parsed.model !== 'string' ||
    !Array.isArray(parsed.messages) ||
    !parsed.messages.every((message) => isRecord(message) && typeof message.role === 'string') ||
    (parsed.tools !== undefined &&
      (!Array.isArray(parsed.tools) || !parsed.tools.every(isRecord))) ||
    (parsed.tool_choice !== undefined &&
      typeof parsed.tool_choice !== 'string' &&
      !isRecord(parsed.tool_choice)) ||
    (parsed.stream !== undefined && typeof parsed.stream !== 'boolean')
  ) {
    return undefined;
  }
  return {
    model: parsed.model,
    messages: parsed.messages,
    stream: parsed.stream === true,
    ...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
    ...(parsed.tool_choice === undefined
      ? {}
      : { tool_choice: parsed.tool_choice as string | Record<string, unknown> }),
  };
}

function responseInput(messages: readonly Record<string, unknown>[]): {
  readonly instructions: string | undefined;
  readonly items: Record<string, unknown>[];
} {
  const guidance: string[] = [];
  const items: Record<string, unknown>[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
      case 'developer':
        guidance.push(textOf(message.content));
        break;
      case 'user':
        items.push({ type: 'message', role: 'user', content: userContent(message.content) });
        break;
      case 'assistant':
        items.push(...assistantItems(message));
        break;
      case 'tool':
        items.push({
          type: 'function_call_output',
          call_id: callIdOf(message.tool_call_id),
          output: textOf(message.content),
        });
        break;
      default:
        throw refused('This kind of message cannot be sent with ChatGPT sign-in.');
    }
  }
  const instructions = guidance
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
  return { instructions: instructions.length === 0 ? undefined : instructions, items };
}

function userContent(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string') return [{ type: 'input_text', text: value }];
  if (!Array.isArray(value) || value.length === 0) {
    throw refused('A user message needs text, an image or a file.');
  }
  return value.map(userPart);
}

function userPart(part: unknown): Record<string, unknown> {
  if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
    return { type: 'input_text', text: part.text };
  }
  if (isRecord(part) && part.type === 'image_url') {
    const image = typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url;
    if (isRecord(image) && typeof image.url === 'string') {
      return {
        type: 'input_image',
        image_url: image.url,
        detail: typeof image.detail === 'string' ? image.detail : 'auto',
      };
    }
  }
  if (isRecord(part) && part.type === 'file' && isRecord(part.file)) {
    const file = fileFields(part.file);
    if (file !== undefined) return { type: 'input_file', ...file };
  }
  throw refused(
    'This kind of input cannot be sent with ChatGPT sign-in. Text, images and files can.',
  );
}

function fileFields(file: Record<string, unknown>): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  for (const name of ['file_data', 'file_id', 'filename']) {
    const value = file[name];
    if (typeof value === 'string' && value.length > 0) fields[name] = value;
  }
  return fields.file_data !== undefined || fields.file_id !== undefined ? fields : undefined;
}

function assistantItems(message: Record<string, unknown>): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const text =
    message.content === undefined || message.content === null ? '' : textOf(message.content);
  if (text.length > 0) items.push({ type: 'message', role: 'assistant', content: text });
  for (const call of toolCallsOf(message.tool_calls)) {
    items.push({
      type: 'function_call',
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }
  return items;
}

function toolCallsOf(
  value: unknown,
): readonly { readonly id: string; readonly name: string; readonly arguments: string }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw refused('Tool calls cannot be sent with ChatGPT sign-in.');
  return value.map((call) => {
    if (!isRecord(call) || !isRecord(call.function)) {
      throw refused('Tool calls cannot be sent with ChatGPT sign-in.');
    }
    const { name, arguments: args } = call.function;
    if (typeof name !== 'string' || typeof args !== 'string') {
      throw refused('Tool calls cannot be sent with ChatGPT sign-in.');
    }
    return { id: callIdOf(call.id), name, arguments: args };
  });
}

function responseTool(tool: Record<string, unknown>): Record<string, unknown> {
  if (typeof tool.type !== 'string' || !ALLOWED_TOOL_TYPES.has(tool.type)) {
    throw refused('This tool cannot be sent with ChatGPT sign-in.');
  }
  if (tool.type === 'custom') {
    if (typeof tool.name !== 'string') throw refused('A custom tool needs a name.');
    return {
      type: 'custom',
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
    };
  }
  const fn = tool.function;
  if (!isRecord(fn) || typeof fn.name !== 'string') throw refused('A function tool needs a name.');
  return {
    type: 'function',
    name: fn.name,
    ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
    parameters: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
    strict: fn.strict === true,
  };
}

function responseToolChoice(choice: string | Record<string, unknown>): unknown {
  if (typeof choice === 'string') {
    if (TOOL_CHOICE_WORDS.has(choice)) return choice;
    throw refused('This tool choice cannot be sent with ChatGPT sign-in.');
  }
  const fn = choice.function;
  if (choice.type === 'function' && isRecord(fn) && typeof fn.name === 'string') {
    return { type: 'function', name: fn.name };
  }
  throw refused('This tool choice cannot be sent with ChatGPT sign-in.');
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw refused('This message cannot be sent with ChatGPT sign-in.');
  return value
    .map((part) => {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') return part.text;
      throw refused('Only text can be sent in this part of a message with ChatGPT sign-in.');
    })
    .join('');
}

function callIdOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw refused('A tool call needs an id to be sent with ChatGPT sign-in.');
  }
  return value;
}

function completionOf(items: readonly unknown[], partialText: string): string {
  let text = '';
  let refusal: string | undefined;
  const toolCalls: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isRecord(part)) continue;
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
        if (part.type === 'refusal' && typeof part.refusal === 'string') refusal = part.refusal;
      }
    }
    if (
      item.type === 'function_call' &&
      typeof item.call_id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.arguments === 'string'
    ) {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    }
  }
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: (text.length > 0 ? text : partialText) || null,
  };
  if (refusal !== undefined) message.refusal = refusal;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return JSON.stringify({
    choices: [{ message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
  });
}

/**
 * The token count of a finished reply, read from the `usage` object the terminal event carries beside its output.
 * The input side comes from `input_tokens`, or from `prompt_tokens`; the output side from `output_tokens`, or from
 * `completion_tokens`. A value that is not a count is not trusted, so it is left out rather than believed. A reply
 * that carries no trustworthy count on a side has no count at all: no zero is invented for a side the server did not
 * report, and the engine's own zero fallback decides what an absent number means.
 */
function usageOf(response: Record<string, unknown>): ChatGptUsage | undefined {
  const usage = isRecord(response.usage) ? response.usage : undefined;
  if (usage === undefined) return undefined;
  const promptTokens = countOf(usage.input_tokens) ?? countOf(usage.prompt_tokens);
  const completionTokens = countOf(usage.output_tokens) ?? countOf(usage.completion_tokens);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  const totalTokens = countOf(usage.total_tokens) ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/** A count the server reported: a finite number of tokens, never a negative one. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The count in the Chat Completions shape the engine reads, the same shape the Anthropic bridge emits. */
function chatCompletionUsage(usage: ChatGptUsage): Record<string, number> {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
}

function eventsOf(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).replace(/^ /, ''))
      .join('\n');
    const event = parseObject(data);
    if (event !== undefined) events.push(event);
  }
  return events;
}

function reasonOf(event: Record<string, unknown>): string {
  const response = isRecord(event.response) ? event.response : {};
  const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
  return typeof details.reason === 'string' ? safeCode(details.reason) : 'unknown';
}

function errorCodeOf(event: Record<string, unknown>): string {
  const response = isRecord(event.response) ? event.response : {};
  const nested = isRecord(response.error) ? response.error : undefined;
  const direct = isRecord(event.error) ? event.error : undefined;
  const code = (nested ?? direct ?? event).code;
  return typeof code === 'string' ? code : '';
}

function safeCode(code: string): string {
  return /^[a-z_]{1,64}$/.test(code) ? code : 'unknown';
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isUsableModelId(value: string): boolean {
  if (value.trim().length === 0 || value.length > MAX_MODEL_ID_LENGTH) return false;
  return ![...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refused(message: string): ChatGptResponsesRequestError {
  return new ChatGptResponsesRequestError(message);
}
