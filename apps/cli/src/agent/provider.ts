/* global process */
import {
  createJoyAgentProvider,
  normalizeByokSessionConfig,
  type ByokSessionConfig,
} from '@joy-media/joy-agent-engine';
import {
  defaultBaseUrl,
  CHATGPT_RESPONSES_BASE_URL,
  evaluateEndpoint,
  findRegistryProvider,
  findRegistryRegion,
  getProviderThinkingMode,
  isAuthMethodPermitted,
  MINIMAX_OAUTH_ENDPOINTS,
  XAI_OAUTH_INFERENCE_BASE_URL,
  isAgentSlotConfigured,
  isCustomProviderId,
  REGISTRY_PROVIDER_IDS,
  type AgentSlotId,
} from '@joy-media/provider-sdk';
import { KIMI_CODE_BASE_URL } from '@joy-media/provider-oauth';
import type { LanguageModel } from 'ai';
import { isOAuthProfileProvider } from './oauth.js';
import {
  getDefaultOAuthTokenManager,
  OAuthProfileLockTimeoutError,
  OAuthRefreshFailedError,
  type OAuthTokenManager,
} from './oauth-runtime.js';
import { loadAgentSlot } from './agent-slots.js';
import { loadAiProviders, loadCliConfig } from '../utils/config.js';
import type { OAuthCredential } from '../utils/credential-store.js';

export interface ResolveProviderOptions {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  /** One of the two agent slots. A slot names its own profile and model, so it cannot be combined with `provider`. */
  readonly slot?: AgentSlotId | undefined;
}

/** Legacy profiles that JOY Media no longer runs (PLAN-v4 §9a). They are refused, never routed. */
const RETIRED_PROVIDERS: ReadonlySet<string> = new Set(['kilo', 'joy-hosted']);

/** The environment variable a provider's key may come from, when no key is saved. */
const KEY_ENVIRONMENT: Readonly<Record<string, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export function isRetiredProvider(provider: string): boolean {
  return RETIRED_PROVIDERS.has(provider);
}

/** The provider a base URL belongs to: the registry provider with a region at exactly that URL, else a custom one. */
export function inferProviderType(baseUrl: string): string {
  return (
    REGISTRY_PROVIDER_IDS.find((id) => findRegistryRegion(id, baseUrl) !== undefined) ?? 'custom'
  );
}

/** The origin and base path of a public endpoint, the key the owner's consent is recorded under. */
export function consentKey(type: string, baseUrl: string): string | undefined {
  const verdict = evaluateEndpoint(type, baseUrl, { consentToPublicEndpoint: true });
  return verdict.allowed && verdict.kind === 'public'
    ? `${verdict.origin}${verdict.basePath}`
    : undefined;
}

/** The key the environment supplies for a provider, when it has one. */
export function environmentKey(provider: string): string | undefined {
  const variable = KEY_ENVIRONMENT[provider];
  return variable === undefined ? undefined : process.env[variable];
}

export function resolveByokConfig(options: ResolveProviderOptions = {}): ByokSessionConfig {
  const cliConfig = loadCliConfig();
  const aiProviders = loadAiProviders();

  // 1. The profile: a slot's own profile, the option, the active one, or the default for the key in the environment.
  const slot = options.slot === undefined ? undefined : loadAgentSlot(options.slot);
  if (slot !== undefined && options.provider !== undefined) {
    throw new Error('Choose either an agent slot or a provider, not both.');
  }
  if (slot !== undefined && !isAgentSlotConfigured(slot)) {
    throw new Error(
      `The ${slot.label} slot has no profile or model. Set them with: joy-media agent slot set ${slot.id} --profile <name> --model <id>`,
    );
  }
  const name =
    slot?.profileId ?? options.provider ?? cliConfig.activeProvider ?? environmentDefault();
  if (name === undefined) {
    throw new Error(
      'No provider is set. Choose one with: joy-media agent provider use <name>, or set an agent slot.',
    );
  }
  refuseRetired(name);
  const profile = aiProviders[name];
  if (profile?.authKind === 'oauth') {
    throw new Error(`Provider profile "${name}" requires OAuth-aware agent resolution.`);
  }

  // 2. The provider type: the saved one, or the registry provider with the same name.
  const type = profile?.provider ?? name;
  refuseRetired(type);
  const registered = findRegistryProvider(type);
  if (registered === undefined && !isCustomProviderId(type)) {
    throw new Error(
      `Unknown provider "${type}". Run "joy-media agent provider list" to see the providers.`,
    );
  }
  if (registered?.api === 'chatgpt-responses') {
    throw new Error(
      'ChatGPT sign-in is not available in the CLI. Use the desktop app for ChatGPT.',
    );
  }
  if (registered?.api === 'anthropic-messages' && !isAuthMethodPermitted(type, 'api-key')) {
    throw new Error(registered.label + ' does not permit API-key authentication in the CLI.');
  }
  if (
    registered !== undefined &&
    registered.api !== 'chat-completions' &&
    registered.api !== 'anthropic-messages'
  ) {
    throw new Error(
      registered.label + ' is not available in the CLI yet. Use the desktop app for it.',
    );
  }

  // 3. The base URL: the option, the global override, the saved profile, or the provider's default.
  const baseUrl =
    options.baseUrl ?? cliConfig.customBaseUrl ?? profile?.baseUrl ?? defaultBaseUrl(type);
  if (baseUrl === undefined) {
    throw new Error(
      `No base URL is set for "${name}". Add one with: joy-media agent provider add ${name} --url <url>`,
    );
  }

  // 4. The endpoint policy, the same rules the desktop broker applies. A public endpoint needs the owner's consent.
  const consented =
    profile?.endpointConsent !== undefined && profile.endpointConsent === consentKey(type, baseUrl);
  const verdict = evaluateEndpoint(type, baseUrl, { consentToPublicEndpoint: consented });
  if (!verdict.allowed) {
    throw new Error(`The base URL of "${name}" is refused: ${verdict.reason}`);
  }

  // 5. The model: the option, the global default, or the profile's. There is no built-in model.
  const modelId = options.model ?? slot?.model ?? cliConfig.defaultModel ?? profile?.defaultModel;
  if (modelId === undefined || modelId.trim().length === 0) {
    throw new Error(
      `No model is set for "${name}". Choose one with: joy-media agent model set <id>`,
    );
  }

  // 6. The key: the option, the environment, or the saved key. Only a local server may run without one.
  const apiKey = options.apiKey ?? environmentKey(type) ?? profile?.apiKey;
  if (apiKey === undefined && verdict.kind !== 'loopback') {
    throw new Error(
      `No API key is saved for "${name}". Save one with: joy-media agent provider add ${name} --url ${baseUrl} --api-key <key>`,
    );
  }

  // Request behavior follows the registry provider id before the engine mode collapses it to openai-compatible.
  const thinkingMode = getProviderThinkingMode(type);

  return normalizeByokSessionConfig({
    provider: engineMode(type),
    baseUrl,
    modelId,
    apiKey: apiKey ?? 'not-provided',
    ...(thinkingMode === undefined ? {} : { thinkingMode }),
    // The provider-specific allowlist above authorizes registry URLs. The engine's generic chat-completions mode
    // validates the same URL as a custom endpoint, so carry this already-checked registry verdict through.
    consentToPublicEndpoint: consented || verdict.kind === 'registry',
  });
}

/** Resolves a selected OAuth profile and refreshes it before model access (D22 step 3 design §6). */
export async function resolveAgentConfig(
  options: ResolveProviderOptions = {},
  tokenManager: OAuthTokenManager = getDefaultOAuthTokenManager(),
): Promise<ByokSessionConfig> {
  const cliConfig = loadCliConfig();
  const aiProviders = loadAiProviders();
  const slot = options.slot === undefined ? undefined : loadAgentSlot(options.slot);
  if (slot !== undefined && options.provider !== undefined) {
    throw new Error('Choose either an agent slot or a provider, not both.');
  }
  if (slot !== undefined && !isAgentSlotConfigured(slot)) {
    throw new Error(
      `The ${slot.label} slot has no profile or model. Set them with: joy-media agent slot set ${slot.id} --profile <name> --model <id>`,
    );
  }
  const name =
    slot?.profileId ?? options.provider ?? cliConfig.activeProvider ?? environmentDefault();
  if (name === undefined) {
    throw new Error(
      'No provider is set. Choose one with: joy-media agent provider use <name>, or set an agent slot.',
    );
  }
  const profile = aiProviders[name];
  if (profile?.authKind !== 'oauth') return resolveByokConfig(options);

  refuseRetired(name);
  const type = profile.provider ?? name;
  refuseRetired(type);
  if (!isOAuthProfileProvider(type)) {
    throw new Error(`OAuth profile "${name}" has no supported provider route.`);
  }
  if (options.apiKey !== undefined) {
    throw new Error(`OAuth profile "${name}" cannot use --api-key.`);
  }
  if (options.baseUrl !== undefined || cliConfig.customBaseUrl !== undefined) {
    throw new Error(`OAuth profile "${name}" uses its registered provider base URL.`);
  }

  const modelId = options.model ?? slot?.model ?? cliConfig.defaultModel ?? profile.defaultModel;
  if (modelId === undefined || modelId.trim().length === 0) {
    throw new Error(
      `No model is set for "${name}". Choose one with: joy-media agent model set <id>`,
    );
  }
  let credential: OAuthCredential;
  try {
    credential = await tokenManager.current(name, type as OAuthCredential['provider']);
  } catch (error) {
    if (error instanceof OAuthProfileLockTimeoutError) throw error;
    throw new OAuthRefreshFailedError(name, type as OAuthCredential['provider']);
  }

  if (type === 'chatgpt') {
    if (credential.provider !== 'chatgpt') {
      throw new OAuthRefreshFailedError(name, 'chatgpt');
    }
    return normalizeByokSessionConfig({
      provider: 'chatgpt-responses',
      baseUrl: CHATGPT_RESPONSES_BASE_URL,
      modelId,
      auth: { kind: 'bearer-token', token: credential.tokenRecord.accessToken },
    });
  }

  const baseUrl =
    credential.provider === 'minimax'
      ? MINIMAX_OAUTH_ENDPOINTS[credential.tokenRecord.region].inferenceBase
      : credential.provider === 'xai'
        ? XAI_OAUTH_INFERENCE_BASE_URL
        : KIMI_CODE_BASE_URL;
  const verdict = evaluateEndpoint(type, baseUrl);
  if (!verdict.allowed) {
    throw new Error(`The base URL of OAuth profile "${name}" is refused: ${verdict.reason}`);
  }
  return normalizeByokSessionConfig({
    provider: engineMode(type),
    baseUrl,
    modelId,
    auth: { kind: 'bearer-token', token: credential.tokenRecord.accessToken },
    consentToPublicEndpoint: verdict.kind === 'registry',
  });
}

export function createModelFromConfig(config: ByokSessionConfig): LanguageModel {
  const { model } = createJoyAgentProvider(config);
  return model;
}

function engineMode(
  type: string,
): 'chatgpt-responses' | 'openrouter' | 'openai-compatible' | 'anthropic-messages' | 'custom' {
  if (type === 'chatgpt') return 'chatgpt-responses';
  if (type === 'openrouter') return 'openrouter';
  if (type === 'claude') return 'anthropic-messages';
  return isCustomProviderId(type) ? 'custom' : 'openai-compatible';
}

/** The provider whose key is in the environment, when one is. Nothing is chosen for the owner otherwise. */
function environmentDefault(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return undefined;
}

function refuseRetired(provider: string): void {
  if (isRetiredProvider(provider)) {
    throw new Error(
      `The ${provider} provider was retired from JOY Media. Choose another one with "joy-media agent provider use <name>".`,
    );
  }
}
