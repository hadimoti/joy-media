import { isRecord } from './is-record.js';
import { OAuthFlowError } from './errors.js';

/** The `fetch` the sign-in flows use. It is injected, so tests never reach a real provider. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A CLI can present device authorization without changing the provider flow (D22 step 3 design §7). */
export interface OAuthAuthorizationPresentation {
  readonly url: string;
  readonly userCode?: string;
  /** Epoch milliseconds from the provider's device-code response. */
  readonly expiresAt?: number;
}

/** The largest token or key-set reply a sign-in reads. Each is a few kilobytes, so a longer one is refused. */
const MAX_REPLY_CHARS = 64 * 1024;
/**
 * The largest model catalog a ChatGPT sign-in reads. The catalog lists every model with its details, so it runs far
 * longer than a token reply. The bound is 4 MiB, the broker's bound for a provider response.
 */
export const MAX_CATALOG_CHARS = 4 * 1024 * 1024;

/** The reply text. A reply longer than `maxChars` is refused, and its text is never part of the error. */
export async function replyText(response: Response, maxChars = MAX_REPLY_CHARS): Promise<string> {
  const text = await response.text();
  if (text.length > maxChars) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'The provider reply was too large.');
  }
  return text;
}

/** A reply that is a JSON object, or undefined. The text is never kept. */
export function parseReplyObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
