import { evaluateEndpoint, OPENROUTER_BASE_URL } from '@joy-media/provider-sdk';
import type { JoyAgentCapability } from './contracts.js';

export type JoyProviderMode = 'joy-hosted' | 'openrouter' | 'openai-compatible' | 'kilo' | 'custom';

export interface ByokSessionConfig {
  readonly provider: JoyProviderMode;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
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

export function normalizeByokSessionConfig(
  input: Readonly<Partial<ByokSessionConfig> & { readonly consentToPublicEndpoint?: boolean }>,
): ByokSessionConfig {
  const provider = input.provider;
  const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  // joy-hosted and kilo are retired legacy profiles, so they are refused here (PLAN-v4 §9a).
  if (
    (provider !== 'openrouter' && provider !== 'openai-compatible' && provider !== 'custom') ||
    modelId.length === 0 ||
    modelId.length > MAX_MODEL_ID_LENGTH ||
    apiKey.length === 0 ||
    apiKey.length > MAX_API_KEY_LENGTH
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
    return Object.freeze({ provider, baseUrl: OPENROUTER_BASE_URL, modelId, apiKey });
  }

  const baseUrl = normalizeCustomBaseUrl(input.baseUrl, {
    consentToPublicEndpoint: input.consentToPublicEndpoint === true,
  });
  return Object.freeze({ provider, baseUrl, modelId, apiKey });
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
