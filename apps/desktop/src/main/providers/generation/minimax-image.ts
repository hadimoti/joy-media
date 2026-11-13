/**
 * The MiniMax picture adapter (T-C02). The current route is `POST /v1/images/generations` (fact P4); the legacy route,
 * `POST /v1/image_generation` (fact P5), is tried only when the broker sees ROUTE_MISSING. It builds the request and
 * reads the reply; the broker sends the request through the same pinned transport as chat.
 *
 * UNVERIFIED: the field names of the request and reply beyond those the facts name. The reader accepts the two reply
 * shapes the facts describe (an item list with `b64_json`, and a `data` object with `image_base64`) and refuses any
 * other shape as RESPONSE_INVALID.
 */
import { endpointUrl } from '@joy-media/provider-sdk';
import type { PreparedCall } from '../adapters/types.js';
import { JOY_TITLE, JOY_TITLE_HEADER } from '../adapters/types.js';
import { isRecord } from '../request-body.js';
import { MINIMAX_GENERATION_SETTINGS } from './minimax-settings.js';
import { parseReply, replyFailure } from './minimax-reply.js';
import { sniffImageMime, type GenerationOutcome, type GenerationRoute } from './types.js';

export interface MiniMaxImageInput {
  /** The region base URL of the profile, e.g. the MiniMax API address for its region. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly prompt: string;
}

export interface MiniMaxImage {
  readonly base64: string;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

/** The request for one route. The key is only in the header, never in the body. */
export function prepareMiniMaxImage(
  route: GenerationRoute,
  input: MiniMaxImageInput,
): PreparedCall {
  const settings = MINIMAX_GENERATION_SETTINGS.image;
  const body =
    route === 'current'
      ? { model: settings.model, prompt: input.prompt, response_format: settings.responseFormat }
      : {
          model: settings.legacyModel,
          prompt: input.prompt,
          response_format: settings.legacyResponseFormat,
        };
  return {
    method: 'POST',
    url: endpointUrl(
      input.baseUrl,
      route === 'current' ? 'images/generations' : 'image_generation',
    ),
    headers: {
      'content-type': 'application/json',
      [JOY_TITLE_HEADER]: JOY_TITLE,
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

/**
 * The picture in a reply, checked to be a picture. A link-only reply is refused: the link would need a second host,
 * which the pinned transport does not reach, so the picture is requested as base64 instead.
 */
export function readMiniMaxImage(text: string): GenerationOutcome<MiniMaxImage> {
  const parsed = parseReply(text);
  if (parsed === undefined) return invalid('The provider reply was not understood.');
  const failure = replyFailure(200, text);
  if (failure !== undefined) return { ok: false, ...failure };
  const base64 = firstBase64(parsed.data);
  if (base64 === undefined) {
    return invalid('The picture reply had no base64 picture (a link-only reply cannot be read).');
  }
  const bytes = Buffer.from(base64, 'base64');
  const mimeType = sniffImageMime(bytes);
  if (mimeType === undefined) return invalid('The reply did not hold a PNG, JPEG or WebP picture.');
  return { ok: true, data: { base64, mimeType } };
}

/** The first base64 picture in `data`, in either of the two shapes the facts describe. */
function firstBase64(data: unknown): string | undefined {
  // Item list: [{ b64_json }] (the H3 route, fact P4).
  if (Array.isArray(data)) {
    for (const item of data) {
      if (isRecord(item) && typeof item.b64_json === 'string') return cleanBase64(item.b64_json);
    }
    return undefined;
  }
  // Object: { image_base64: [...] } (the legacy route, fact P5).
  if (isRecord(data) && Array.isArray(data.image_base64)) {
    const first: unknown = data.image_base64[0];
    return typeof first === 'string' ? cleanBase64(first) : undefined;
  }
  return undefined;
}

/** The base64 text without whitespace, or undefined when it is not base64 at all. */
function cleanBase64(value: string): string | undefined {
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return undefined;
  return compact;
}

function invalid(message: string): GenerationOutcome<never> {
  return { ok: false, code: 'RESPONSE_INVALID', message };
}
