/**
 * Output-token budget for the main Joy Code agent call.
 *
 * MiniMax's chat models are thinking models: they spend the output budget on reasoning before they
 * answer, and the 2,048 default ran out with no answer at all. Thinking cannot be turned off on
 * those models, so the budget is raised for their host alone. Every other provider keeps the default.
 */
export const DEFAULT_AGENT_OUTPUT_TOKENS = 2048;
export const MINIMAX_AGENT_OUTPUT_TOKENS = 16384;

const MINIMAX_SUFFIXES = ['.minimax.io', '.minimaxi.com'] as const;

export function outputTokenBudget(connection: { readonly baseUrl: string }): number {
  return isMiniMaxBaseUrl(connection.baseUrl)
    ? MINIMAX_AGENT_OUTPUT_TOKENS
    : DEFAULT_AGENT_OUTPUT_TOKENS;
}

/** Matches the host exactly (api.minimax.io) or as a subdomain. A look-alike such as minimax.io.evil.example does not match. */
function isMiniMaxBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'api.minimax.io') return true;
  return MINIMAX_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
