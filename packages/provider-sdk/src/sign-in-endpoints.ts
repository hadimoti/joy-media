/**
 * The fixed origins of the sign-in flows and of the ChatGPT Responses API (PLAN-v4 §5, §6d). They are kept here,
 * with the rest of the provider origins in the registry, so the desktop main process names no remote host itself.
 */

/** OpenRouter's sign-in page, its key exchange, and the base URL a signed-in profile uses. */
export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_KEY_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
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
