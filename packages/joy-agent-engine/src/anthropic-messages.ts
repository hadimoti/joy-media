import { endpointUrl } from '@joy-media/provider-sdk';
import { JOY_AGENT_ERROR_CODES } from './contracts.js';

export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const JOY_TITLE = 'JOY Media';
const JOY_TITLE_HEADER = 'x-title';
const INLINE_IMAGE = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const ERROR_CODES: ReadonlySet<string> = new Set(JOY_AGENT_ERROR_CODES);

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Block = Record<string, unknown> & { readonly type: string };
type AnthropicMessage = { readonly role: 'user' | 'assistant'; readonly content: Block[] };

/**
 * The OpenAI-compatible provider supplies this callback the same normalized request the desktop adapter consumes.
 * Convert it to Anthropic's Messages request while explicitly selecting only the fields the adapter supports.
 */
export function transformAnthropicRequestBody(input: Record<string, unknown>): Record<string, unknown> {
  const inputMessages = Array.isArray(input.messages) ? input.messages : [];
  const { system, messages } = toAnthropicMessages(inputMessages);
  const tools = Array.isArray(input.tools)
    ? input.tools.map((item) => {
        if (!isRecord(item)) throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
        return toAnthropicTool(item);
      })
    : [];
  const model = typeof input.model === 'string' ? input.model : '';
  const maxTokens =
    typeof input.max_tokens === 'number' && Number.isFinite(input.max_tokens)
      ? input.max_tokens
      : DEFAULT_MAX_TOKENS;

  return {
    model,
    max_tokens: maxTokens,
    messages,
    ...(system === undefined ? {} : { system }),
    ...(typeof input.temperature === 'number'
      ? { temperature: Math.min(input.temperature, 1) }
      : {}),
    ...(tools.length === 0
      ? {}
      : { tools, tool_choice: toToolChoice(input.tool_choice) }),
    ...(input.stream === true ? { stream: true } : {}),
  };
}

/** Rewrites the OpenAI-compatible SDK transport to Anthropic Messages and maps the response back for that SDK. */
export function createAnthropicMessagesFetch(
  config: { readonly baseUrl: string; readonly apiKey: string; readonly modelId: string },
  fetchImpl: FetchLike,
): FetchLike {
  return async (input, init = {}) => {
    const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
    if (requestUrl.origin !== new URL(config.baseUrl).origin) {
      throw safeError('JOY_AGENT_CORS_OR_NETWORK');
    }
    if (typeof init.body !== 'string') throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');

    let requestBody: unknown;
    try {
      requestBody = JSON.parse(init.body);
    } catch {
      throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
    }
    if (!isRecord(requestBody)) throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
    const streaming = requestBody.stream === true;
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    headers.set('x-api-key', config.apiKey);
    headers.set('anthropic-version', ANTHROPIC_VERSION);
    headers.set(JOY_TITLE_HEADER, JOY_TITLE);

    let response: Response;
    try {
      response = await fetchImpl(endpointUrl(config.baseUrl, 'messages'), {
        ...init,
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      throw safeError(safeErrorCode(error, 'JOY_AGENT_CORS_OR_NETWORK'));
    }

    if (!response.ok) {
      const code = errorCodeForStatus(response.status);
      await response.body?.cancel().catch(() => undefined);
      return jsonErrorResponse(response.status, code);
    }

    if (streaming) {
      return new Response(
        translateAnthropicEventStream(response.body, config.modelId, config.apiKey),
        {
          status: response.status,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        },
      );
    }

    try {
      const text = await response.text();
      const output = anthropicReplyToOpenAICompletion(text, config.modelId);
      return new Response(scrub(output, config.apiKey), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      const code = safeErrorCode(error, 'JOY_AGENT_PROVIDER_INCOMPATIBLE');
      return jsonErrorResponse(502, code);
    }
  };
}

/** Maps one Anthropic Messages JSON response to the Chat Completions shape expected by the engine. */
export function anthropicReplyToOpenAICompletion(text: string, modelId: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) {
    throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
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
  const usage = isRecord(parsed.usage)
    ? usageOf(parsed.usage)
    : undefined;

  return JSON.stringify({
    id: typeof parsed.id === 'string' ? parsed.id : 'anthropic',
    object: 'chat.completion',
    model: typeof parsed.model === 'string' ? parsed.model : modelId,
    choices: [{ index: 0, message, finish_reason: finishReason(parsed.stop_reason) }],
    ...(usage === undefined ? {} : { usage }),
  });
}

function toAnthropicMessages(messages: readonly unknown[]): {
  readonly system?: string;
  readonly messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    if (!isRecord(message)) throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      systemParts.push(textOf(message.content));
    } else if (role === 'user') {
      append(out, 'user', userBlocks(message.content));
    } else if (role === 'assistant') {
      append(out, 'assistant', assistantBlocks(message));
    } else if (role === 'tool') {
      append(out, 'user', [
        {
          type: 'tool_result',
          tool_use_id: requireString(message.tool_call_id),
          content: textOf(message.content),
        },
      ]);
    } else {
      throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
    }
  }
  const system = systemParts.filter((part) => part.length > 0).join('\n\n');
  return system.length === 0 ? { messages: out } : { system, messages: out };
}

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
  if (!Array.isArray(content)) throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
  return content.flatMap((part): Block[] => {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      return textBlocks(part.text);
    }
    if (isRecord(part) && part.type === 'image_url' && isRecord(part.image_url)) {
      return [imageBlock(part.image_url.url)];
    }
    throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
  });
}

function assistantBlocks(message: Record<string, unknown>): Block[] {
  const text = textBlocks(textOf(message.content));
  if (!Array.isArray(message.tool_calls)) return text;
  const toolUses: Block[] = [];
  for (const call of message.tool_calls) {
    if (!isRecord(call) || !isRecord(call.function)) {
      throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
    }
    toolUses.push({
      type: 'tool_use',
      id: requireString(call.id),
      name: requireString(call.function.name),
      input: parseArguments(call.function.arguments),
    });
  }
  return [...text, ...toolUses];
}

function textBlocks(text: string): Block[] {
  return text.length === 0 ? [] : [{ type: 'text', text }];
}

function imageBlock(url: unknown): Block {
  const match = typeof url === 'string' ? INLINE_IMAGE.exec(url) : null;
  if (match === null) throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
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
    throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
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
    throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
  }
  const fn = tool.function;
  const name = requireString(fn.name);
  return {
    name,
    ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
    input_schema: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
  };
}

function toToolChoice(choice: unknown): Record<string, unknown> {
  if (choice === undefined || choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  if (isRecord(choice) && choice.type === 'function' && isRecord(choice.function)) {
    return { type: 'tool', name: requireString(choice.function.name) };
  }
  throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw safeError('JOY_AGENT_PROVIDER_INCOMPATIBLE');
  }
  return value;
}

function usageOf(usage: Record<string, unknown>): Record<string, number> {
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}


function jsonErrorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { message: code } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorCodeForStatus(status: number): string {
  if (status === 401 || status === 403) return 'JOY_AGENT_AUTH_FAILED';
  if (status === 413) return 'JOY_AGENT_RESPONSE_TOO_LARGE';
  if (status === 408 || status === 429 || status >= 500) return 'JOY_AGENT_CORS_OR_NETWORK';
  return 'JOY_AGENT_PROVIDER_INCOMPATIBLE';
}

function safeErrorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  return ERROR_CODES.has(message) ? message : fallback;
}

function safeError(code: string): Error {
  return new Error(ERROR_CODES.has(code) ? code : 'JOY_AGENT_PROVIDER_INCOMPATIBLE');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scrub(value: string, secret: string): string {
  return secret.length === 0 ? value : value.split(secret).join('[Redacted]');
}

function translateAnthropicEventStream(
  source: ReadableStream<Uint8Array> | null,
  modelId: string,
  apiKey: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let responseId = 'anthropic';
  let responseModel = modelId;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: unknown;
  let finishSent = false;
  let doneSent = false;
  let nextToolIndex = 0;
  const toolIndices = new Map<number, number>();
  const textRedactors = new Map<number, SecretStreamRedactor>();
  const toolRedactors = new Map<number, SecretStreamRedactor>();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const encodeEvent = (value: Record<string, unknown>): Uint8Array =>
    encoder.encode('data: ' + scrub(JSON.stringify(value), apiKey) + '\n\n');
  const chunk = (
    choices: readonly Record<string, unknown>[],
    usage?: Record<string, number>,
  ): Uint8Array =>
    encodeEvent({
      id: responseId,
      object: 'chat.completion.chunk',
      created: 0,
      model: responseModel,
      choices,
      ...(usage === undefined ? {} : { usage }),
    });
  const emitText = (controller: ReadableStreamDefaultController<Uint8Array>, text: string): void => {
    if (text.length === 0) return;
    controller.enqueue(
      chunk([{ index: 0, delta: { content: text }, finish_reason: null }]),
    );
  };
  const totalUsage = (): Record<string, number> => ({
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  });
  const emitFinish = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (finishSent) return;
    finishSent = true;
    controller.enqueue(
      chunk(
        [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason(stopReason),
          },
        ],
        totalUsage(),
      ),
    );
  };
  const emitDone = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (doneSent) return;
    doneSent = true;
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  };
  const emitError = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    code: string,
  ): void => {
    controller.enqueue(encodeEvent({ error: { message: code } }));
    emitDone(controller);
  };
  const flushRedactors = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    for (const redactor of textRedactors.values()) emitText(controller, redactor.finish());
    for (const [providerIndex, redactor] of toolRedactors) {
      const argumentsDelta = redactor.finish();
      const toolIndex = toolIndices.get(providerIndex);
      if (argumentsDelta.length > 0 && toolIndex !== undefined) {
        controller.enqueue(
          chunk([
            {
              index: 0,
              delta: {
                tool_calls: [{ index: toolIndex, function: { arguments: argumentsDelta } }],
              },
              finish_reason: null,
            },
          ]),
        );
      }
    }
    textRedactors.clear();
    toolRedactors.clear();
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (source === null) {
        emitError(controller, 'JOY_AGENT_PROVIDER_INCOMPATIBLE');
        controller.close();
        return;
      }
      const reader = source.getReader();
      activeReader = reader;
      let buffer = '';
      let streamError = false;

      const processEvent = (event: Record<string, unknown>): void => {
        if (event.type === 'message_start' && isRecord(event.message)) {
          const message = event.message;
          if (typeof message.id === 'string') responseId = message.id;
          if (typeof message.model === 'string') responseModel = message.model;
          if (isRecord(message.usage) && typeof message.usage.input_tokens === 'number') {
            inputTokens = message.usage.input_tokens;
          }
          controller.enqueue(
            chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]),
          );
          return;
        }
        if (event.type === 'content_block_start' && isRecord(event.content_block)) {
          const providerIndex = typeof event.index === 'number' ? event.index : nextToolIndex;
          const block = event.content_block;
          if (block.type === 'text') {
            textRedactors.set(providerIndex, new SecretStreamRedactor(apiKey));
          } else if (block.type === 'tool_use') {
            const toolIndex = nextToolIndex++;
            toolIndices.set(providerIndex, toolIndex);
            toolRedactors.set(providerIndex, new SecretStreamRedactor(apiKey));
            controller.enqueue(
              chunk([
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolIndex,
                        id: typeof block.id === 'string' ? block.id : 'anthropic-tool',
                        type: 'function',
                        function: {
                          name: typeof block.name === 'string' ? block.name : 'unknown_tool',
                          arguments: '',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ]),
            );
          }
          return;
        }
        if (event.type === 'content_block_delta' && isRecord(event.delta)) {
          const providerIndex = typeof event.index === 'number' ? event.index : 0;
          const delta = event.delta;
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            const redactor = textRedactors.get(providerIndex) ?? new SecretStreamRedactor(apiKey);
            textRedactors.set(providerIndex, redactor);
            emitText(controller, redactor.push(delta.text));
          } else if (
            delta.type === 'input_json_delta' &&
            typeof delta.partial_json === 'string'
          ) {
            const redactor = toolRedactors.get(providerIndex) ?? new SecretStreamRedactor(apiKey);
            toolRedactors.set(providerIndex, redactor);
            const toolIndex = toolIndices.get(providerIndex);
            const argumentsDelta = redactor.push(delta.partial_json);
            if (argumentsDelta.length > 0 && toolIndex !== undefined) {
              controller.enqueue(
                chunk([
                  {
                    index: 0,
                    delta: {
                      tool_calls: [{ index: toolIndex, function: { arguments: argumentsDelta } }],
                    },
                    finish_reason: null,
                  },
                ]),
              );
            }
          }
          return;
        }
        if (event.type === 'content_block_stop') {
          const providerIndex = typeof event.index === 'number' ? event.index : 0;
          const textRedactor = textRedactors.get(providerIndex);
          if (textRedactor !== undefined) {
            emitText(controller, textRedactor.finish());
            textRedactors.delete(providerIndex);
          }
          const toolRedactor = toolRedactors.get(providerIndex);
          const toolIndex = toolIndices.get(providerIndex);
          if (toolRedactor !== undefined && toolIndex !== undefined) {
            const argumentsDelta = toolRedactor.finish();
            if (argumentsDelta.length > 0) {
              controller.enqueue(
                chunk([
                  {
                    index: 0,
                    delta: {
                      tool_calls: [{ index: toolIndex, function: { arguments: argumentsDelta } }],
                    },
                    finish_reason: null,
                  },
                ]),
              );
            }
            toolRedactors.delete(providerIndex);
          }
          return;
        }
        if (event.type === 'message_delta') {
          if (isRecord(event.delta)) stopReason = event.delta.stop_reason;
          if (isRecord(event.usage) && typeof event.usage.output_tokens === 'number') {
            outputTokens = event.usage.output_tokens;
          }
          flushRedactors(controller);
          emitFinish(controller);
          return;
        }
        if (event.type === 'message_stop') {
          flushRedactors(controller);
          emitFinish(controller);
          emitDone(controller);
          return;
        }
        if (event.type === 'error') {
          const error = isRecord(event.error) ? event.error : {};
          const label =
            typeof error.type === 'string'
              ? error.type
              : typeof error.code === 'string'
                ? error.code
                : '';
          const code = /auth|permission|unauthorized/i.test(label)
            ? 'JOY_AGENT_AUTH_FAILED'
            : /rate|overload|timeout/i.test(label)
              ? 'JOY_AGENT_CORS_OR_NETWORK'
              : 'JOY_AGENT_PROVIDER_INCOMPATIBLE';
          emitError(controller, code);
          streamError = true;
        }
      };

      const processBlock = (block: string): void => {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data.length === 0 || data === '[DONE]') return;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        if (isRecord(event)) processEvent(event);
      };

      try {
        while (!doneSent) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() ?? '';
          for (const block of blocks) {
            processBlock(block);
            if (doneSent) break;
          }
        }
        buffer += decoder.decode();
        if (buffer.length > 0 && !doneSent) processBlock(buffer);
        if (!doneSent && !streamError) {
          flushRedactors(controller);
          emitFinish(controller);
          emitDone(controller);
        }
        controller.close();
      } catch (error) {
        emitError(controller, safeErrorCode(error, 'JOY_AGENT_CORS_OR_NETWORK'));
        controller.close();
      } finally {
        reader.releaseLock();
        activeReader = undefined;
      }
    },
    cancel(reason) {
      return activeReader?.cancel(reason);
    },
  });
}

class SecretStreamRedactor {
  private pending = '';

  constructor(private readonly secret: string) {}

  push(value: string): string {
    this.pending += value;
    return this.take(false);
  }

  finish(): string {
    return this.take(true);
  }

  private take(final: boolean): string {
    if (this.secret.length === 0) {
      const value = this.pending;
      this.pending = '';
      return value;
    }
    this.pending = scrub(this.pending, this.secret);
    const held = trailingSecretPrefixLength(this.pending, this.secret);
    if (final) {
      const output =
        held === 0
          ? this.pending
          : this.pending.slice(0, this.pending.length - held) + '[Redacted]';
      this.pending = '';
      return output;
    }
    if (held === 0) {
      const output = this.pending;
      this.pending = '';
      return output;
    }
    const output = this.pending.slice(0, this.pending.length - held);
    this.pending = this.pending.slice(this.pending.length - held);
    return output;
  }
}

function trailingSecretPrefixLength(value: string, secret: string): number {
  const max = Math.min(value.length, secret.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(secret.slice(0, length))) return length;
  }
  return 0;
}

function finishReason(stop: unknown): string {
  if (stop === 'refusal') return 'content_filter';
  if (stop === 'tool_use') return 'tool_calls';
  if (stop === 'max_tokens') return 'length';
  return 'stop';
}
