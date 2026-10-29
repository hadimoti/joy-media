/**
 * The fixed origins of the sign-in flows and of the ChatGPT Responses API (PLAN-v4 §5, §6d). They are kept here,
 * with the rest of the provider origins in the registry, so the desktop main process names no remote host itself.
 */

/** OpenRouter's API base URL. OpenRouter is an API-key provider under D20, so it has no sign-in origin here. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * ChatGPT's OAuth endpoints, from the issuer's OpenID discovery document (checked 2026-10-29). The base URL is the
 * Responses API that a signed-in account calls. backend-api is never called (PLAN-v4 §6d).
 */
export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';
export const CHATGPT_RESPONSES_BASE_URL = 'https://api.openai.com/v1';

/** MiniMax's account base, its sign-in page and its inference base, for one region (PLAN-v4 §6d, §6d-1). */
export const MINIMAX_OAUTH_ENDPOINTS = {
  global: {
    accountBase: 'https://account.minimax.io',
    authorizeUrl: 'https://platform.minimax.io/oauth-authorize',
    inferenceBase: 'https://api.minimax.io/v1',
  },
  cn: {
    accountBase: 'https://account.minimaxi.com',
    authorizeUrl: 'https://platform.minimaxi.com/oauth-authorize',
    inferenceBase: 'https://api.minimax.cn/v1',
  },
} as const;

export type MiniMaxRegion = keyof typeof MINIMAX_OAUTH_ENDPOINTS;

/**
 * PLAN-v4 §6d's `openid profile coding_plan` scope follows the owner's research. OpenClaw currently requests
 * `group_id profile model.completion`; JOY Media's exact scope stays unverified until MiniMax confirms it through its
 * own client-registration path.
 */
export const MINIMAX_OAUTH_SCOPE = 'openid profile coding_plan';
