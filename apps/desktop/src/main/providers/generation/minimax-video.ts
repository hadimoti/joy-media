/**
 * The MiniMax video adapter (T-C02). The current route is `POST /v2/video_generation` to create, `GET
 * /v2/query/video_generation/{task_id}` to query and `DELETE /v2/video_generation/{task_id}` to cancel (facts P6). The
 * legacy route is `POST /v1/video_generation`, `GET /v1/query/video_generation?task_id=` (fact P8), with no cancel call.
 * The file is fetched with `GET /v1/files/retrieve?file_id=` (fact P8).
 *
 * The broker chooses the route, sends each request through the pinned transport and asks this module to read the reply.
 *
 * UNVERIFIED: field names beyond those the facts name (`duration`, `resolution`, `status` words of the legacy route,
 * `file_id` on the current route, `file.download_url`). T-C10 settles them from one live call.
 */
import { endpointUrl, normalizeBaseUrl } from '@joy-media/provider-sdk';
import type { PreparedCall } from '../adapters/types.js';
import { JOY_TITLE, JOY_TITLE_HEADER } from '../adapters/types.js';
import { isRecord } from '../request-body.js';
import { parseReply } from './minimax-reply.js';
import { MINIMAX_GENERATION_SETTINGS } from './minimax-settings.js';
import { isSafePathId, type GenerationOutcome, type GenerationRoute } from './types.js';

export type VideoStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface MiniMaxVideoInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly prompt: string;
}

/** The current API lives at the same origin with a `/v2` path; the region base URL carries `/v1`, so the path is taken from the origin. */
function rootUrl(baseUrl: string, path: string): string {
  return `${new URL(normalizeBaseUrl(baseUrl)).origin}${path}`;
}

function headers(apiKey: string, json: boolean): Readonly<Record<string, string>> {
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    [JOY_TITLE_HEADER]: JOY_TITLE,
    authorization: `Bearer ${apiKey}`,
  };
}

export function prepareVideoCreate(route: GenerationRoute, input: MiniMaxVideoInput): PreparedCall {
  const settings = MINIMAX_GENERATION_SETTINGS.video;
  const body =
    route === 'current'
      ? {
          model: settings.model,
          prompt: input.prompt,
          resolution: settings.resolution,
          duration: settings.durationSeconds,
        }
      : {
          model: settings.legacyModel,
          prompt: input.prompt,
          resolution: settings.legacyResolution,
          duration: settings.legacyDurationSeconds,
        };
  return {
    method: 'POST',
    url:
      route === 'current'
        ? rootUrl(input.baseUrl, '/v2/video_generation')
        : endpointUrl(input.baseUrl, 'video_generation'),
    headers: headers(input.apiKey, true),
    body: JSON.stringify(body),
  };
}

export function prepareVideoQuery(
  route: GenerationRoute,
  input: { readonly baseUrl: string; readonly apiKey: string; readonly taskId: string },
): PreparedCall {
  const id = encodeURIComponent(input.taskId);
  return {
    method: 'GET',
    url:
      route === 'current'
        ? rootUrl(input.baseUrl, `/v2/query/video_generation/${id}`)
        : endpointUrl(input.baseUrl, `query/video_generation?task_id=${id}`),
    headers: headers(input.apiKey, false),
    body: undefined,
  };
}

/** The cancel call. Only the current route has one (fact P6); the caller must not send this for the legacy route. */
export function prepareVideoCancel(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly taskId: string;
}): PreparedCall {
  return {
    method: 'DELETE',
    url: rootUrl(input.baseUrl, `/v2/video_generation/${encodeURIComponent(input.taskId)}`),
    headers: headers(input.apiKey, false),
    body: undefined,
  };
}

export function prepareVideoFile(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fileId: string;
}): PreparedCall {
  return {
    method: 'GET',
    url: endpointUrl(input.baseUrl, `files/retrieve?file_id=${encodeURIComponent(input.fileId)}`),
    headers: headers(input.apiKey, false),
    body: undefined,
  };
}

/** The task id a create reply names. It goes into a URL path later, so it must be a safe id. */
export function readVideoCreate(text: string): GenerationOutcome<{ readonly taskId: string }> {
  const parsed = parseReply(text);
  const taskId = parsed?.task_id;
  if (!isSafePathId(taskId)) return invalid('The video reply had no usable task id.');
  return { ok: true, data: { taskId } };
}

/** The status words of both routes, lower-cased. The legacy words are UNVERIFIED. */
const STATUS_WORDS: Readonly<Record<string, VideoStatus>> = {
  queued: 'queued',
  queueing: 'queued',
  preparing: 'queued',
  running: 'running',
  processing: 'running',
  succeeded: 'succeeded',
  success: 'succeeded',
  failed: 'failed',
  fail: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

export function readVideoStatus(
  text: string,
): GenerationOutcome<{ readonly status: VideoStatus; readonly fileId?: string }> {
  const parsed = parseReply(text);
  if (parsed === undefined) return invalid('The video status reply was not understood.');
  const word = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
  const status = STATUS_WORDS[word];
  if (status === undefined) return invalid('The video status reply named no known status.');
  const fileId = parsed.file_id;
  return isSafePathId(fileId)
    ? { ok: true, data: { status, fileId } }
    : { ok: true, data: { status } };
}

/** The download link of a finished file. It is valid for one hour (fact P8). */
export function readVideoFile(text: string): GenerationOutcome<{ readonly downloadUrl: string }> {
  const parsed = parseReply(text);
  const file = parsed?.file;
  const url = isRecord(file) ? file.download_url : undefined;
  if (typeof url !== 'string') return invalid('The file reply had no download link.');
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:') return invalid('The download link is not HTTPS.');
  } catch {
    return invalid('The download link is not a valid URL.');
  }
  return { ok: true, data: { downloadUrl: url } };
}

function invalid(message: string): GenerationOutcome<never> {
  return { ok: false, code: 'RESPONSE_INVALID', message };
}
