/** Shared shapes for the provider adapters. Plain data: no I/O and no credential is stored here. */

export const JOY_TITLE_HEADER = 'x-title';
/** The only identifying header a provider request carries (D14). */
export const JOY_TITLE = 'JOY Media';

export interface PreparedCall {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

export interface ModelEntry {
  readonly id: string;
  readonly name: string;
}

/** Thrown by an adapter for a body it cannot translate. The message is safe to show. */
export class AdapterRequestError extends Error {
  readonly code = 'REQUEST_INVALID';
}
