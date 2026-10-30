import {
  CHATGPT_RESPONSES_BASE_URL,
  evaluateEndpoint,
  OPENROUTER_BASE_URL,
} from '@joy-media/provider-sdk';
import type { JoyAgentCapability } from './contracts.js';

export type JoyProviderMode =
  | 'joy-hosted'
  | 'chatgpt-responses'
  | 'openrouter'
  | 'openai-compatible'
  | 'anthropic-messages'
  | 'kilo'
  | 'custom';

interface ByokSessionConfigFields {
  readonly provider: JoyProviderMode;
  readonly baseUrl: string;
  readonly modelId: string;
}

/** API keys and OAuth bearer tokens remain distinct through the engine transport (D22 step 3 design §8). */
export interface ByokBearerTokenAuth {
  readonly kind: 'bearer-token';
  readonly token: string;
}

export type ByokSessionConfig = ByokSessionConfigFields &
  (
    | { readonly apiKey: string; readonly auth?: never }
    | { readonly apiKey?: never; readonly auth: ByokBearerTokenAuth }
  );

export interface ByokSessionConfigInput {
  readonly provider?: JoyProviderMode | undefined;
  readonly baseUrl?: string | undefined;
  readonly modelId?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly auth?: ByokBearerTokenAuth | undefined;
  readonly consentToPublicEndpoint?: boolean | undefined;
}

export interface ByokSessionStatus {
  readonly provider: ByokSessionConfig['provider'];
  readonly modelId: string;
  readonly capability: JoyAgentCapability;
}

export class ProviderConfigError extends Error {
  readonly code = 'JOY_AGENT_PROVIDER_CONFIG_INVALID' as const;

  constructor() {
    super('JOY_AGENT_PROVIDER_CONFIG_INVALID');
    this.name = 'ProviderConfigError';
  }
}

const MAX_MODEL_ID_LENGTH = 256;
const MAX_API_KEY_LENGTH = 512;
const MAX_BEARER_TOKEN_LENGTH = 16_384;

export function normalizeByokSessionConfig(
  input: Readonly<ByokSessionConfigInput>,
): ByokSessionConfig {
  const provider = input.provider;
  const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const bearerToken = input.auth?.kind === 'bearer-token' ? input.auth.token.trim() : '';
  const hasApiKey =
    input.auth === undefined && apiKey.length > 0 && apiKey.length <= MAX_API_KEY_LENGTH;
  const hasBearerToken =
    input.auth?.kind === 'bearer-token' &&
    input.apiKey === undefined &&
    bearerToken.length > 0 &&
    bearerToken.length <= MAX_BEARER_TOKEN_LENGTH &&
    (provider === 'openai-compatible' || provider === 'chatgpt-responses');
  // joy-hosted and kilo are retired legacy profiles, so they are refused here (PLAN-v4 §9a).
  if (
    (provider !== 'openrouter' &&
      provider !== 'chatgpt-responses' &&
      provider !== 'openai-compatible' &&
      provider !== 'anthropic-messages' &&
      provider !== 'custom') ||
    modelId.length === 0 ||
    modelId.length > MAX_MODEL_ID_LENGTH ||
    (!hasApiKey && !hasBearerToken)
  ) {
    throw new ProviderConfigError();
  }

  if (provider === 'openrouter') {
    if (
      input.baseUrl !== undefined &&
      input.baseUrl !== OPENROUTER_BASE_URL &&
      input.baseUrl !== `${OPENROUTER_BASE_URL}/`
    ) {
      throw new ProviderConfigError();
    }
    if (!hasApiKey) throw new ProviderConfigError();
    return Object.freeze({ provider, baseUrl: OPENROUTER_BASE_URL, modelId, apiKey });
  }

  if (provider === 'chatgpt-responses') {
    if (
      !hasBearerToken ||
      input.apiKey !== undefined ||
      (input.baseUrl !== undefined && input.baseUrl !== CHATGPT_RESPONSES_BASE_URL)
    ) {
      throw new ProviderConfigError();
    }
    return Object.freeze({
      provider,
      baseUrl: CHATGPT_RESPONSES_BASE_URL,
      modelId,
      auth: { kind: 'bearer-token' as const, token: bearerToken },
    });
  }

  const baseUrl =
    provider === 'anthropic-messages'
      ? normalizeAnthropicBaseUrl(input.baseUrl)
      : normalizeCustomBaseUrl(input.baseUrl, {
          consentToPublicEndpoint: input.consentToPublicEndpoint === true,
        });
  return hasBearerToken
    ? Object.freeze({
        provider,
        baseUrl,
        modelId,
        auth: { kind: 'bearer-token' as const, token: bearerToken },
      })
    : Object.freeze({ provider, baseUrl, modelId, apiKey });
}

function normalizeAnthropicBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new ProviderConfigError();
  const url = value.trim();
  const verdict = evaluateEndpoint('claude', url);
  if (!verdict.allowed) throw new ProviderConfigError();
  return verdict.origin + verdict.basePath;
}

export function safeByokSessionStatus(
  config: Pick<ByokSessionConfig, 'provider' | 'modelId'>,
  capability: JoyAgentCapability = 'untested',
): ByokSessionStatus {
  return Object.freeze({ provider: config.provider, modelId: config.modelId, capability });
}

/**
 * The base URL of a user-configured endpoint. The rule is the registry's endpoint policy (`evaluateEndpoint`), which
 * the desktop broker applies too: a loopback server is allowed, and a public endpoint is allowed only with the owner's
 * consent (S8). A base URL that already names the completion path is refused as well.
 */
export function normalizeCustomBaseUrl(
  value: unknown,
  options: { readonly consentToPublicEndpoint?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2048) {
    throw new ProviderConfigError();
  }
  const verdict = evaluateEndpoint('custom', value.trim(), {
    consentToPublicEndpoint: options.consentToPublicEndpoint === true,
  });
  if (!verdict.allowed || verdict.basePath.toLowerCase().endsWith('/chat/completions')) {
    throw new ProviderConfigError();
  }
  return `${verdict.origin}${verdict.basePath}`;
}

export { OPENROUTER_BASE_URL };
