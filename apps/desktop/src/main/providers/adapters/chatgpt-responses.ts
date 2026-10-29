/**
 * ChatGPT Responses adapter (PLAN-v4 §6a, §6d). It sends a Chat Completions-shaped request as a Responses request, and
 * reads the Responses stream back into the Chat Completions JSON the engine reads. It performs no I/O; the broker
 * sends the request. Requests go only to the Responses base URL of the shared provider package, never to the backend
 * API (PLAN-v4 §6d).
 */
import { CHATGPT_RESPONSES_BASE_URL, endpointUrl } from '@joy-media/provider-sdk';
import type { CompletionBody } from '../request-body.js';
import { isRecord } from '../request-body.js';
import {
  AdapterRequestError,
  JOY_TITLE,
  JOY_TITLE_HEADER,
  type ModelEntry,
  type PreparedCall,
} from './types.js';

export { CHATGPT_RESPONSES_BASE_URL };

/**
 * Usage-limit codes (PLAN-v4 §6d). They may arrive after streaming has started, so the partial text is marked
 * incomplete.
 */
export const PLAN_LIMIT_CODES: ReadonlySet<string> = new Set([
  'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_usage_unavailable',
]);

/** The tool types a ChatGPT sign-in may send. Every other type is refused before anything is sent (PLAN-v4 §6d). */
const ALLOWED_TOOL_TYPES: ReadonlySet<string> = new Set(['function', 'custom']);
const TOOL_CHOICE_WORDS: ReadonlySet<string> = new Set(['auto', 'none', 'required']);

/** How one ChatGPT stream ended. Success is only `completed` (PLAN-v4 §6d). */
export type ChatGptOutcome =
  | { readonly kind: 'completed'; readonly completion: string }
  | { readonly kind: 'incomplete'; readonly reason: string; readonly partialText: string }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'plan-limit'; readonly partialText: string; readonly incomplete: true }
  | { readonly kind: 'interrupted'; readonly partialText: string };

/**
 * The Responses request for one conversation. `store` and `stream` are always set, and no field outside the sign-in's
 * list is sent (PLAN-v4 §6d). A tool type the sign-in does not send, or an input type it does not accept, is refused
 * here, before anything leaves the machine.
 */
export function prepareChatGptResponses(input: {
  readonly accessToken: string;
  readonly modelId: string;
  readonly body: CompletionBody;
}): PreparedCall {
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

/**
 * Reads the Responses stream to its end. Text is kept from the deltas, so a stream that ends early still shows what
 * arrived, marked as incomplete. A success is only `response.completed`; no retry is made (PLAN-v4 §6d).
 */
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
        return { kind: 'completed', completion: completionOf(items, partialText) };
      }
      case 'response.incomplete':
        return { kind: 'incomplete', reason: reasonOf(event), partialText };
      case 'response.failed':
      case 'error': {
        const code = errorCodeOf(event);
        if (PLAN_LIMIT_CODES.has(code))
          return { kind: 'plan-limit', partialText, incomplete: true };
        return { kind: 'failed', code: safeCode(code) };
      }
      default:
        break;
    }
  }
  return { kind: 'interrupted', partialText };
}

/**
 * The model list: only the models the account may list, in the order the server gives (PLAN-v4 §6d).
 */
export function readChatGptModels(text: string): readonly ModelEntry[] {
  const models = parseObject(text)?.models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((model): ModelEntry[] => {
    if (
      !isRecord(model) ||
      model.visibility !== 'list' ||
      typeof model.slug !== 'string' ||
      model.slug.length === 0
    ) {
      return [];
    }
    const name =
      typeof model.display_name === 'string' && model.display_name.length > 0
        ? model.display_name
        : model.slug;
    return [{ id: model.slug, name }];
  });
}

/** Whether the saved model is missing from the list, so the person must choose again (PLAN-v4 §6d). */
export function needsModelChoice(models: readonly ModelEntry[], modelId: string): boolean {
  return !models.some((model) => model.id === modelId);
}

/**
 * How long a model list is kept before it is loaded again. A model the account stops listing is therefore not sent for
 * long, even when nobody reloads the list.
 */
export const CATALOG_TTL_MS = 10 * 60_000;

/** The model list of each account (PLAN-v4 §6d). It is kept per account, for a time-to-live. */
export interface ChatGptCatalog {
  /** The list of an account. `load` runs only when the account has no list, or its list is older than the time-to-live. */
  list(
    accountId: string,
    load: () => Promise<readonly ModelEntry[]>,
  ): Promise<readonly ModelEntry[]>;
  /** Drops the list of an account, so the next call loads it again. */
  forget(accountId: string): void;
}

export function createChatGptCatalog(
  options: { readonly ttlMs?: number; readonly now?: () => number } = {},
): ChatGptCatalog {
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
  const now = options.now ?? Date.now;
  const byAccount = new Map<
    string,
    { readonly loadedAt: number; readonly loading: Promise<readonly ModelEntry[]> }
  >();
  return {
    list(accountId, load) {
      const cached = byAccount.get(accountId);
      if (cached !== undefined && now() - cached.loadedAt < ttlMs) return cached.loading;
      const loading = load();
      byAccount.set(accountId, { loadedAt: now(), loading });
      // A list that failed to load is not kept, so the next call loads it again.
      void loading.catch(() => {
        if (byAccount.get(accountId)?.loading === loading) byAccount.delete(accountId);
      });
      return loading;
    },
    forget(accountId) {
      byAccount.delete(accountId);
    },
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
        // System guidance goes in `instructions`. A system-role item is never sent (PLAN-v4 §6d).
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

/** The text of a message: a string, or text parts only. Any other part is refused. */
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

/** The Chat Completions JSON the engine reads, built from the Responses output items (PLAN-v4 §6b). */
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

/** The data of each SSE event, parsed. A block that is not JSON is skipped. */
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

/** A code is shown only when it is a plain word. Anything else is reported as unknown, never echoed. */
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

/** The model list request: a GET that carries the token and no body (PLAN-v4 §6d). */
export function prepareChatGptModels(input: { readonly accessToken: string }): PreparedCall {
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

function refused(message: string): AdapterRequestError {
  return new AdapterRequestError(message);
}
