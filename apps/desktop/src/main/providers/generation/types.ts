/**
 * Shared shapes for the generation adapters (pictures and videos, T-C02). Plain data: no I/O, and no key is stored or
 * returned here. The broker sends the requests and turns a failed outcome into a typed broker error.
 */

/**
 * The reasons a generation call can fail. `AUTH` is a refused key, `NOT_ALLOWED` a key whose plan does not allow the
 * model, `QUOTA` a balance or rate limit, `BAD_PROMPT` a prompt the provider or JOY refuses, `REJECTED` any other
 * refusal, and `RESPONSE_INVALID` a reply that is not the shape the adapter reads. `ROUTE_MISSING` means the current
 * route does not exist on this account or server, and the broker then tries the legacy route; it never reaches the
 * owner.
 */
export type GenerationErrorCode =
  | 'AUTH'
  | 'NOT_ALLOWED'
  | 'QUOTA'
  | 'BAD_PROMPT'
  | 'REJECTED'
  | 'RESPONSE_INVALID'
  | 'ROUTE_MISSING';

export type GenerationOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: GenerationErrorCode; readonly message: string };

/** Which MiniMax route answered: the current H3 API, or the legacy API that the broker falls back to. */
export type GenerationRoute = 'current' | 'legacy';

/** A prompt is text with something in it, within the limit set for the route. Returns a message when it is refused. */
export function promptProblem(prompt: string, maxCharacters: number): string | undefined {
  if (prompt.trim().length === 0) return 'Write a prompt first.';
  if ([...prompt].length > maxCharacters) {
    return `The prompt is longer than ${maxCharacters} characters.`;
  }
  return undefined;
}

/**
 * A provider id, task id or file id that is put into a URL path. Only letters, digits, underscores and dashes are
 * allowed, up to 128 characters, so no id can change the path it is placed in.
 */
const PATH_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafePathId(value: unknown): value is string {
  return typeof value === 'string' && PATH_ID.test(value);
}

/**
 * The image type a picture's bytes name, from their first bytes: PNG, JPEG or WebP. Undefined for anything else, so a
 * reply that is not a picture is refused rather than saved as one.
 */
export function sniffImageMime(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}
