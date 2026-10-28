/**
 * Anthropic Messages adapter (PLAN-v4 §6a): Claude, through an API key only. The broker speaks the
 * Chat Completions shape to the rest of the app, so this module converts the request out and the
 * reply back. It performs no I/O.
 */
import { endpointUrl } from '@joy-media/provider-sdk';
import { isRecord, type CompletionBody } from '../request-body.js';
import {
  AdapterRequestError,
  JOY_TITLE,
  JOY_TITLE_HEADER,
  type ModelEntry,
  type PreparedCall,
} from './types.js';

export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const INLINE_IMAGE = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

type Block = Record<string, unknown> & { readonly type: string };
interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: Block[];
}

export function prepareAnthropicMessages(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly body: CompletionBody;
  /** The thinking blocks a tool use came after, by call id (see ContinuationState). */
  readonly thinkingBefore?: (callId: string) => unknown;
}): PreparedCall {
  const { system, messages } = toAnthropicMessages(input.body.messages, input.thinkingBefore);
  const tools = (input.body.tools ?? []).map(toAnthropicTool);
  const payload: Record<string, unknown> = {
    model: input.modelId,
    max_tokens: input.body.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages,
    ...(system === undefined ? {} : { system }),
    ...(input.body.temperature === undefined
      ? {}
      : { temperature: Math.min(input.body.temperature, 1) }),
    ...(tools.length === 0 ? {} : { tools, tool_choice: toToolChoice(input.body.tool_choice) }),
  };
  return {
    method: 'POST',
    url: endpointUrl(input.baseUrl, 'messages'),
    headers: headersFor(input.apiKey),
    body: JSON.stringify(payload),
  };
}

export function prepareAnthropicModels(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
}): PreparedCall {
  return {
    method: 'GET',
    // Anthropic pages its model list, 20 entries by default. 1000 is the largest page it returns.
    url: `${endpointUrl(input.baseUrl, 'models')}?limit=1000`,
    headers: headersFor(input.apiKey),
    body: undefined,
  };
}

export function parseAnthropicModels(text: string): readonly ModelEntry[] {
  const parsed: unknown = JSON.parse(text);
  const list = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : [];
  return list.flatMap((item): ModelEntry[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) return [];
    const name =
      typeof item.display_name === 'string' && item.display_name.length > 0
        ? item.display_name
        : item.id;
    return [{ id: item.id, name }];
  });
}

/**
 * Converts an Anthropic reply into a Chat Completions reply, so the engine reads one shape
 * whatever the provider. Throws when the reply has no content list.
 */
export function anthropicReplyToChatCompletion(text: string, modelId: string): string {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) {
    throw new Error('The provider reply did not contain a content list.');
  }
  const textParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of parsed.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
    if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('') : toolCalls.length > 0 ? null : '',
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
  const usage = isRecord(parsed.usage) ? usageOf(parsed.usage) : undefined;
  return JSON.stringify({
    id: typeof parsed.id === 'string' ? parsed.id : 'anthropic',
    object: 'chat.completion',
    model: modelId,
    choices: [{ index: 0, message, finish_reason: finishReason(parsed.stop_reason) }],
    ...(usage === undefined ? {} : { usage }),
  });
}

function headersFor(apiKey: string): Readonly<Record<string, string>> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    [JOY_TITLE_HEADER]: JOY_TITLE,
  };
}

function toAnthropicMessages(
  messages: readonly Record<string, unknown>[],
  thinkingBefore?: (callId: string) => unknown,
): {
  readonly system?: string;
  readonly messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    const { role } = message;
    if (role === 'system' || role === 'developer') {
      systemParts.push(textOf(message.content));
    } else if (role === 'user') {
      append(out, 'user', userBlocks(message.content));
    } else if (role === 'assistant') {
      append(out, 'assistant', assistantBlocks(message, thinkingBefore));
    } else if (role === 'tool') {
      append(out, 'user', [
        {
          type: 'tool_result',
          tool_use_id: requireString(message.tool_call_id, 'tool_call_id'),
          content: textOf(message.content),
        },
      ]);
    } else {
      throw new AdapterRequestError(`Unsupported message role "${String(role)}".`);
    }
  }
  const system = systemParts.filter((part) => part.length > 0).join('\n\n');
  return system.length === 0 ? { messages: out } : { system, messages: out };
}

/** Anthropic wants alternating turns, so consecutive blocks for one role share a message. */
function append(out: AnthropicMessage[], role: 'user' | 'assistant', blocks: Block[]): void {
  if (blocks.length === 0) return;
  const last = out[out.length - 1];
  if (last !== undefined && last.role === role) {
    last.content.push(...blocks);
    return;
  }
  out.push({ role, content: blocks });
}

function userBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return textBlocks(content);
  if (!Array.isArray(content)) throw new AdapterRequestError('User content must be text or parts.');
  return content.flatMap((part): Block[] => {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      return textBlocks(part.text);
    }
    if (isRecord(part) && part.type === 'image_url' && isRecord(part.image_url)) {
      return [imageBlock(part.image_url.url)];
    }
    throw new AdapterRequestError('This content type cannot be sent to this provider.');
  });
}

function assistantBlocks(
  message: Record<string, unknown>,
  thinkingBefore?: (callId: string) => unknown,
): Block[] {
  const text = textBlocks(textOf(message.content));
  if (!Array.isArray(message.tool_calls)) return text;
  const toolUses: Block[] = [];
  for (const call of message.tool_calls) {
    if (!isRecord(call) || !isRecord(call.function)) {
      throw new AdapterRequestError('A tool call is malformed.');
    }
    toolUses.push({
      type: 'tool_use',
      id: requireString(call.id, 'tool call id'),
      name: requireString(call.function.name, 'tool name'),
      input: parseArguments(call.function.arguments),
    });
  }
  // The thinking a tool use came after goes first, exactly as the provider sent it.
  return [...thinkingFor(message.tool_calls, thinkingBefore), ...text, ...toolUses];
}

/** The thinking blocks kept for this assistant turn, found through any of its tool calls. */
function thinkingFor(
  calls: readonly unknown[],
  thinkingBefore?: (callId: string) => unknown,
): Block[] {
  if (thinkingBefore === undefined) return [];
  for (const call of calls) {
    if (!isRecord(call) || typeof call.id !== 'string') continue;
    const kept = thinkingBefore(call.id);
    if (
      Array.isArray(kept) &&
      kept.every((block) => isRecord(block) && typeof block.type === 'string')
    ) {
      return kept as Block[];
    }
  }
  return [];
}

function textBlocks(text: string): Block[] {
  return text.length === 0 ? [] : [{ type: 'text', text }];
}

function imageBlock(url: unknown): Block {
  const match = typeof url === 'string' ? INLINE_IMAGE.exec(url) : null;
  if (match === null) {
    throw new AdapterRequestError('Only inline images can be sent to this provider.');
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: match[1], data: match[2] },
  };
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AdapterRequestError('A tool call has arguments that are not JSON.');
  }
  return isRecord(parsed) ? parsed : {};
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function toAnthropicTool(tool: Record<string, unknown>): Record<string, unknown> {
  if (tool.type !== 'function' || !isRecord(tool.function)) {
    throw new AdapterRequestError('Only function tools can be sent to this provider.');
  }
  const fn = tool.function;
  const name = requireString(fn.name, 'tool name');
  return {
    name,
    ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
    input_schema: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
  };
}

function toToolChoice(choice: CompletionBody['tool_choice']): Record<string, unknown> {
  if (choice === undefined || choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  if (isRecord(choice) && choice.type === 'function' && isRecord(choice.function)) {
    return { type: 'tool', name: requireString(choice.function.name, 'tool name') };
  }
  throw new AdapterRequestError('This tool_choice cannot be sent to this provider.');
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AdapterRequestError(`The ${label} is missing.`);
  }
  return value;
}

function finishReason(stop: unknown): string {
  if (stop === 'refusal') return 'content_filter';
  if (stop === 'tool_use') return 'tool_calls';
  if (stop === 'max_tokens') return 'length';
  return 'stop';
}

function usageOf(usage: Record<string, unknown>): Record<string, number> {
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}
