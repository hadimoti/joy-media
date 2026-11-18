/**
 * The one wording for a provider usage limit (HTTP 429). The desktop broker, the JOY Agent Worker, the
 * settings dialog and the CLI all show these strings, so a limit reads the same everywhere.
 */

/** The condition in one sentence, without an instruction. Other messages add their own tail to it. */
export const USAGE_LIMIT_REACHED = 'The provider says the usage limit is reached.';

/** The notice shown when a connection or a request stopped on the provider's usage limit. */
export const USAGE_LIMIT_MESSAGE = `${USAGE_LIMIT_REACHED} Try again later.`;
