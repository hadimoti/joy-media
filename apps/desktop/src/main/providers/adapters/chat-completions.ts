/**
 * Chat Completions adapter (PLAN-v4 §6a): OpenRouter, Grok, MiniMax, Gemini, Kimi, an OpenAI key
 * and a custom endpoint all speak this format. It builds the request and reads the model list.
 * It performs no I/O; the broker sends the request.
 */
import { endpointUrl } from '@joy-media/provider-sdk';
import type { CompletionBody } from '../request-body.js';
import { isRecord } from '../request-body.js';
import type { PreparedCall, ModelEntry } from './types.js';
import { JOY_TITLE_HEADER, JOY_TITLE } from './types.js';

export function prepareChatCompletion(input: {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly modelId: string;
  readonly body: CompletionBody;
}): PreparedCall {
  const payload = { ...input.body, model: input.modelId, stream: false };
  return {
    method: 'POST',
    url: endpointUrl(input.baseUrl, 'chat/completions'),
    headers: headersFor(input.apiKey),
    body: JSON.stringify(payload),
  };
}

export function prepareChatModels(input: {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}): PreparedCall {
  return {
    method: 'GET',
    url: endpointUrl(input.baseUrl, 'models'),
    headers: headersFor(input.apiKey),
    body: undefined,
  };
}

/** Reads `{ data: [{ id }] }` or a bare array, the two shapes these providers return. */
export function parseChatModels(text: string): readonly ModelEntry[] {
  const parsed: unknown = JSON.parse(text);
  const list = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : parsed;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): ModelEntry[] => {
    if (typeof item === 'string') return item.length > 0 ? [{ id: item, name: item }] : [];
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) return [];
    const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : item.id;
    return [{ id: item.id, name }];
  });
}

function headersFor(apiKey: string | undefined): Readonly<Record<string, string>> {
  return {
    'content-type': 'application/json',
    [JOY_TITLE_HEADER]: JOY_TITLE,
    ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
  };
}
