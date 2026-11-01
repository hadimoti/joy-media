/* global process, fetch */
import {
  OPENROUTER_BASE_URL,
  ProviderConfigError,
  createJoyAgentProvider,
  normalizeByokSessionConfig,
  type ByokSessionConfig,
  type JoyFetch,
} from '@joy-media/joy-agent-engine';
import {
  defaultBaseUrl,
  CHATGPT_RESPONSES_BASE_URL,
  evaluateEndpoint,
  findRegistryProvider,
  findRegistryRegion,
  getProviderThinkingMode,
  isAuthMethodPermitted,
  XAI_OAUTH_INFERENCE_BASE_URL,
  isAgentSlotConfigured,
  CUSTOM_PROVIDER_ID,
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

/**
 * The provider configuration is unusable as given (unknown provider, bad URL,
 * missing API key...). Detected locally, before any network traffic; the CLI
 * reports it as a usage error (exit 2).
 */
export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

type ProviderKind = 'openrouter' | 'openai-compatible' | 'custom';

interface BuiltinProvider {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly model: string;
  readonly envKey?: string;
}

/** Providers that work without `agent provider add`. */
export const BUILTIN_PROVIDERS: Readonly<Record<string, BuiltinProvider>> = Object.freeze({
  openrouter: {
    kind: 'openrouter',
    baseUrl: OPENROUTER_BASE_URL,
    model: 'openrouter/auto',
    envKey: 'OPENROUTER_API_KEY',
  },
  openai: {
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    envKey: 'OPENAI_API_KEY',
  },
  // Anthropic's OpenAI-compatible endpoint. An Anthropic key must never be
  // sent to api.openai.com (the previous fallback for every other provider).
  anthropic: {
    kind: 'openai-compatible',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-7-sonnet-20250219',
    envKey: 'ANTHROPIC_API_KEY',
  },
  'lm-studio': { kind: 'custom', baseUrl: 'http://127.0.0.1:1234/v1', model: 'gpt-4o' },
});

function builtin(name: string): BuiltinProvider | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PROVIDERS, name)
    ? BUILTIN_PROVIDERS[name]
    : undefined;
}

export interface ResolvedProviderSettings {
  /** Provider name as the user knows it (`openrouter`, or a stored name). */
  readonly providerName: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string | undefined;
  /** Where the key came from: `flag`, `env:<VAR>`, `provider:<name>` or `none`. */
  readonly apiKeySource: string;
  /** Loopback endpoint (LM Studio, Ollama, a local proxy, a test double). */
  readonly local: boolean;
}

const MAX_MODEL_ID_LENGTH = 256;
const MAX_API_KEY_LENGTH = 512;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Validate and normalise a provider base URL. Error messages never echo the
 * URL itself: a malformed or credential-bearing URL may contain a secret.
 */
export function normalizeCliBaseUrl(raw: string): {
  readonly url: string;
  readonly local: boolean;
} {
  const candidate = raw.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AgentConfigError(
      'The provider URL is not a valid absolute URL (expected e.g. https://api.example.com/v1).',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AgentConfigError(
      'The provider URL must start with https:// (or http:// for localhost).',
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new AgentConfigError(
      'The provider URL must not contain credentials. Pass the key with --api-key instead.',
    );
  }
  if (url.search !== '' || url.hash !== '') {
    throw new AgentConfigError('The provider URL must not contain a query string or fragment.');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.toLowerCase().endsWith('/chat/completions')) {
    throw new AgentConfigError(
      'The provider URL must be the API base (e.g. https://host/v1), not the /chat/completions endpoint.',
    );
  }
  const local = isLoopbackHost(url.hostname);
  if (!local && url.protocol !== 'https:') {
    throw new AgentConfigError(
      'Remote provider URLs must use https:// (plain http:// is only allowed for localhost).',
    );
  }
  return { url: `${url.origin}${pathname}`, local };
}

/**
 * Work out which provider, endpoint, model and key a run would use, without
 * contacting anything. Precedence: flags, then the stored/active provider
 * configuration, then environment variables for the default provider choice.
 */
export function resolveProviderSettings(
  options: ResolveProviderOptions = {},
): ResolvedProviderSettings {
  const settings = resolveProfile(options);
  return {
    providerName: settings.name,
    kind: engineMode(settings.type) as ProviderKind,
    baseUrl: settings.baseUrl,
    modelId: settings.modelId,
    apiKey: settings.apiKey,
    apiKeySource: settings.apiKeySource,
    local: settings.local,
  };
}

interface ResolvedProfile {
  readonly name: string;
  readonly type: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string | undefined;
  readonly apiKeySource: string;
  readonly local: boolean;
  readonly consented: boolean;
  readonly thinkingMode: ReturnType<typeof getProviderThinkingMode>;
}

function resolveProfile(options: ResolveProviderOptions = {}): ResolvedProfile {
  const cliConfig = loadCliConfig();
  const aiProviders = loadAiProviders();

  // 1. The profile: a slot's own profile, the option, the active one, or the default for the key in the environment.
  const slot = options.slot === undefined ? undefined : loadAgentSlot(options.slot);
  if (slot !== undefined && options.provider !== undefined) {
    throw new AgentConfigError('Choose either an agent slot or a provider, not both.');
  }
  if (slot !== undefined && !isAgentSlotConfigured(slot)) {
    throw new AgentConfigError(
      `The ${slot.label} slot has no profile or model. Set them with: joy-media agent slot set ${slot.id} --profile <name> --model <id>`,
    );
  }
  const name =
    slot?.profileId ??
    options.provider ??
    cliConfig.activeProvider ??
    environmentDefault() ??
    // A one-off --url (with --api-key or --model) names the custom endpoint, as the primary branch allows.
    (options.baseUrl === undefined ? undefined : CUSTOM_PROVIDER_ID);
  if (name === undefined) {
    throw new AgentConfigError(
      'No provider is set. Choose one with: joy-media agent provider use <name>, or set an agent slot.',
    );
  }
  refuseRetired(name);
  const profile = aiProviders[name];
  if (profile?.authKind === 'oauth') {
    throw new AgentConfigError(`Provider profile "${name}" requires OAuth-aware agent resolution.`);
  }

  // 2. The provider type: the saved one, or the registry provider with the same name.
  const type = profile?.provider ?? name;
  refuseRetired(type);
  const registered = findRegistryProvider(type);
  if (registered === undefined && !isCustomProviderId(type)) {
    throw new AgentConfigError(
      `Unknown provider "${type}". Run "joy-media agent provider list" to see the providers.`,
    );
  }
  if (registered?.api === 'chatgpt-responses') {
    throw new AgentConfigError(
      'ChatGPT sign-in is not available in the CLI. Use the desktop app for ChatGPT.',
    );
  }
  if (registered?.api === 'anthropic-messages' && !isAuthMethodPermitted(type, 'api-key')) {
    throw new AgentConfigError(registered.label + ' does not permit API-key authentication in the CLI.');
  }
  if (
    registered !== undefined &&
    registered.api !== 'chat-completions' &&
    registered.api !== 'anthropic-messages'
  ) {
    throw new AgentConfigError(
      registered.label + ' is not available in the CLI yet. Use the desktop app for it.',
    );
  }

  // 3. The base URL: the option, the global override, the saved profile, or the provider's default.
  // A global override (custom URL or default model) belongs to the active provider only, so it never reaches another provider.
  const usingConfigured = name === cliConfig.activeProvider;
  const configuredBaseUrl = usingConfigured ? cliConfig.customBaseUrl : undefined;
  const baseUrl = options.baseUrl ?? configuredBaseUrl ?? profile?.baseUrl ?? defaultBaseUrl(type);
  if (baseUrl === undefined) {
    throw new AgentConfigError(
      `No base URL is set for "${name}". Add one with: joy-media agent provider add ${name} --url <url>`,
    );
  }

  // 4. The endpoint policy, the same rules the desktop broker applies. A public endpoint needs the owner's consent.
  const consented =
    profile?.endpointConsent !== undefined && profile.endpointConsent === consentKey(type, baseUrl);
  const verdict = evaluateEndpoint(type, baseUrl, { consentToPublicEndpoint: consented });
  if (!verdict.allowed) {
    throw new AgentConfigError(`The base URL of "${name}" is refused: ${verdict.reason}`);
  }

  // 5. The model: the option, the global default, or the profile's. There is no built-in model.
  const modelId =
    options.model ?? slot?.model ?? (usingConfigured ? cliConfig.defaultModel : undefined) ?? profile?.defaultModel;
  if (modelId === undefined || modelId.trim().length === 0) {
    throw new AgentConfigError(
      `No model is set for "${name}". Choose one with: joy-media agent model set <id>`,
    );
  }
  if (modelId.length > MAX_MODEL_ID_LENGTH) {
    throw new AgentConfigError(`The model id must be 1-${MAX_MODEL_ID_LENGTH} characters long.`);
  }

  // 6. The key: the option, the environment, or the saved key. Only a local server may run without one.
  const envKey = environmentKey(type);
  const apiKey = options.apiKey ?? envKey ?? profile?.apiKey;
  if (apiKey === undefined && verdict.kind !== 'loopback') {
    throw new AgentConfigError(
      `No API key is saved for "${name}". Save one with: joy-media agent provider add ${name} --url <url> --api-key <key>`,
    );
  }
  const apiKeySource = options.apiKey !== undefined
    ? 'flag'
    : envKey !== undefined
      ? `env:${KEY_ENVIRONMENT[type]}`
      : apiKey !== undefined
        ? `provider:${name}`
        : 'none';
  return {
    name,
    type,
    baseUrl,
    modelId,
    apiKey,
    apiKeySource,
    local: verdict.kind === 'loopback',
    consented: consented || verdict.kind === 'registry',
    thinkingMode: getProviderThinkingMode(type),
  };
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
    throw new AgentConfigError('Choose either an agent slot or a provider, not both.');
  }
  if (slot !== undefined && !isAgentSlotConfigured(slot)) {
    throw new AgentConfigError(
      `The ${slot.label} slot has no profile or model. Set them with: joy-media agent slot set ${slot.id} --profile <name> --model <id>`,
    );
  }
  const name =
    slot?.profileId ??
    options.provider ??
    cliConfig.activeProvider ??
    environmentDefault() ??
    // A one-off --url (with --api-key or --model) names the custom endpoint, as the primary branch allows.
    (options.baseUrl === undefined ? undefined : CUSTOM_PROVIDER_ID);
  if (name === undefined) {
    throw new AgentConfigError(
      'No provider is set. Choose one with: joy-media agent provider use <name>, or set an agent slot.',
    );
  }
  const profile = aiProviders[name];
  if (profile?.authKind !== 'oauth') return resolveByokConfig(options);

  refuseRetired(name);
  const type = profile.provider ?? name;
  refuseRetired(type);
  if (!isOAuthProfileProvider(type)) {
    throw new AgentConfigError(`OAuth profile "${name}" has no supported provider route.`);
  }
  if (options.apiKey !== undefined) {
    throw new AgentConfigError(`OAuth profile "${name}" cannot use --api-key.`);
  }
  const usingConfigured = name === cliConfig.activeProvider;
  if (options.baseUrl !== undefined || (usingConfigured && cliConfig.customBaseUrl !== undefined)) {
    throw new AgentConfigError(`OAuth profile "${name}" uses its registered provider base URL.`);
  }

  const modelId =
    options.model ?? slot?.model ?? (usingConfigured ? cliConfig.defaultModel : undefined) ?? profile.defaultModel;
  if (modelId === undefined || modelId.trim().length === 0) {
    throw new AgentConfigError(
      `No model is set for "${name}". Choose one with: joy-media agent model set <id>`,
    );
  }
  if (modelId.length > MAX_MODEL_ID_LENGTH) {
    throw new AgentConfigError(`The model id must be 1-${MAX_MODEL_ID_LENGTH} characters long.`);
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
    credential.provider === 'xai' ? XAI_OAUTH_INFERENCE_BASE_URL : KIMI_CODE_BASE_URL;
  const verdict = evaluateEndpoint(type, baseUrl);
  if (!verdict.allowed) {
    throw new AgentConfigError(`The base URL of OAuth profile "${name}" is refused: ${verdict.reason}`);
  }
  return normalizeByokSessionConfig({
    provider: engineMode(type),
    baseUrl,
    modelId,
    auth: { kind: 'bearer-token', token: credential.tokenRecord.accessToken },
    consentToPublicEndpoint: verdict.kind === 'registry',
  });
}

export function missingApiKeyMessage(settings: ResolvedProviderSettings): string {
  const envKey = builtin(settings.providerName)?.envKey;
  return (
    `No API key configured for provider "${settings.providerName}". ` +
    'Pass --api-key <key> (or --api-key - to read it from stdin)' +
    (envKey ? `, set ${envKey}` : '') +
    `, or store one with "joy-media agent provider add ${settings.providerName} --url <url> --api-key -".`
  );
}

/**
 * Resolve and validate the provider configuration for a run or probe.
 * Fails fast and locally (AgentConfigError) instead of sending a placeholder
 * key to a real endpoint.
 */
export function resolveByokConfig(options: ResolveProviderOptions = {}): ByokSessionConfig {
  const resolved = resolveProfile(options);
  const settings: ResolvedProviderSettings = {
    providerName: resolved.name,
    kind: engineMode(resolved.type) as ProviderKind,
    baseUrl: resolved.baseUrl,
    modelId: resolved.modelId,
    apiKey: resolved.apiKey,
    apiKeySource: resolved.apiKeySource,
    local: resolved.local,
  };
  const { modelId, apiKey } = resolved;
  if (modelId.length === 0 || modelId.length > MAX_MODEL_ID_LENGTH) {
    throw new AgentConfigError(`The model id must be 1-${MAX_MODEL_ID_LENGTH} characters long.`);
  }
  if (apiKey !== undefined && apiKey.length > MAX_API_KEY_LENGTH) {
    throw new AgentConfigError(`The API key is longer than ${MAX_API_KEY_LENGTH} characters.`);
  }

  if (resolved.local) {
    // Local servers (LM Studio, Ollama...) usually need no key: send none.
    return Object.freeze({
      provider: 'custom' as const,
      baseUrl: resolved.baseUrl,
      modelId,
      apiKey: apiKey ?? '',
    });
  }

  if (!apiKey) throw new AgentConfigError(missingApiKeyMessage(settings));

  try {
    return normalizeByokSessionConfig({
      provider: engineMode(resolved.type),
      baseUrl: resolved.baseUrl,
      modelId,
      apiKey,
      ...(resolved.thinkingMode === undefined ? {} : { thinkingMode: resolved.thinkingMode }),
      consentToPublicEndpoint: resolved.consented,
    });
  } catch (error) {
    if (error instanceof AgentConfigError) throw error;
    if (error instanceof ProviderConfigError) {
      throw new AgentConfigError(`The endpoint for provider "${settings.providerName}" is not allowed.`);
    }
    throw new AgentConfigError('The provider configuration is invalid.');
  }
}

/** HTTP-level facts about the provider traffic of one run (never headers or bodies). */
export interface ProviderTraffic {
  requests: number;
  lastStatus?: number | undefined;
  lastStatusText?: string | undefined;
  networkErrorCode?: string | undefined;
}

export function createModelFromConfig(
  config: ByokSessionConfig,
  traffic?: ProviderTraffic,
): LanguageModel {
  const observingFetch: JoyFetch = async (input, init) => {
    if (traffic) traffic.requests += 1;
    try {
      const response = await fetch(input, init);
      if (traffic) {
        traffic.lastStatus = response.status;
        traffic.lastStatusText = response.statusText;
      }
      return response;
    } catch (error) {
      if (traffic) {
        const cause = (error as { cause?: { code?: unknown } }).cause;
        traffic.networkErrorCode =
          typeof cause?.code === 'string' ? cause.code : (error as Error).name || 'FetchError';
      }
      throw error;
    }
  };
  const { model } = createJoyAgentProvider(config, observingFetch);
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
    throw new AgentConfigError(
      `The ${provider} provider was retired from JOY Media. Choose another one with "joy-media agent provider use <name>".`,
    );
  }
}
