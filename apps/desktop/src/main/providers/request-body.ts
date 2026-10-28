/**
 * The only fields a caller may send to a provider (PLAN-v4 §6b). Everything else is dropped, so a
 * renderer or a Worker cannot choose a model, a stream mode, a URL or a header by adding a field.
 */

export const MAX_MESSAGES = 512;
export const MAX_TOOLS = 128;
const MAX_MAX_TOKENS = 32_000;

export interface CompletionBody {
  readonly messages: readonly Record<string, unknown>[];
  readonly tools?: readonly Record<string, unknown>[];
  readonly tool_choice?: string | Record<string, unknown>;
  readonly temperature?: number;
  readonly max_tokens?: number;
}

export type CompletionBodyResult =
  | { readonly ok: true; readonly body: CompletionBody }
  | { readonly ok: false; readonly message: string };

export function parseCompletionBody(value: unknown): CompletionBodyResult {
  if (!isRecord(value)) return invalid('The request body must be an object.');
  const { messages, tools, tool_choice: toolChoice, temperature, max_tokens: maxTokens } = value;

  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return invalid(`messages must be a list of 1 to ${MAX_MESSAGES} entries.`);
  }
  if (!messages.every((message) => isRecord(message) && typeof message.role === 'string')) {
    return invalid('Each message must be an object with a role.');
  }

  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.length > MAX_TOOLS || !tools.every(isRecord)) {
      return invalid(`tools must be a list of at most ${MAX_TOOLS} objects.`);
    }
  }
  if (toolChoice !== undefined && typeof toolChoice !== 'string' && !isRecord(toolChoice)) {
    return invalid('tool_choice must be a string or an object.');
  }
  if (
    temperature !== undefined &&
    (typeof temperature !== 'number' ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2)
  ) {
    return invalid('temperature must be a number from 0 to 2.');
  }
  if (
    maxTokens !== undefined &&
    (!Number.isInteger(maxTokens) ||
      (maxTokens as number) < 1 ||
      (maxTokens as number) > MAX_MAX_TOKENS)
  ) {
    return invalid(`max_tokens must be an integer from 1 to ${MAX_MAX_TOKENS}.`);
  }

  return {
    ok: true,
    body: {
      messages: messages as Record<string, unknown>[],
      ...(tools === undefined ? {} : { tools: tools as Record<string, unknown>[] }),
      ...(toolChoice === undefined
        ? {}
        : { tool_choice: toolChoice as string | Record<string, unknown> }),
      ...(temperature === undefined ? {} : { temperature }),
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens as number }),
    },
  };
}

function invalid(message: string): CompletionBodyResult {
  return { ok: false, message };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
