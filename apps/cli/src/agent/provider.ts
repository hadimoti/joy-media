/* global process, fetch */
import {
  OPENROUTER_BASE_URL,
  ProviderConfigError,
  createJoyAgentProvider,
  normalizeByokSessionConfig,
  type ByokSessionConfig,
  type JoyFetch,
} from '@joy-media/joy-agent-engine';
import type { LanguageModel } from 'ai';
import {
  hasAiProvider,
  loadAiProviders,
  loadCliConfig,
  type AiProviderConfig,
} from '../utils/config.js';

export interface ResolveProviderOptions {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
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

type ProviderKind = 'openrouter' | 'openai-compatible' | 'kilo' | 'custom';

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
  kilo: {
    kind: 'kilo',
    baseUrl: 'https://api.kilo.ai/api/gateway/v1',
    model: 'minimax/minimax-m3',
    envKey: 'KILO_API_KEY',
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

function storedProviderKind(stored: AiProviderConfig): ProviderKind {
  switch (stored.provider) {
    case 'openrouter':
      return 'openrouter';
    case 'kilo':
      return 'kilo';
    case 'custom':
      return 'custom';
    default:
      return 'openai-compatible';
  }
}

/**
 * Work out which provider, endpoint, model and key a run would use, without
 * contacting anything. Precedence: flags, then the stored/active provider
 * configuration, then environment variables for the default provider choice.
 */
export function resolveProviderSettings(
  options: ResolveProviderOptions = {},
): ResolvedProviderSettings {
  const cliConfig = loadCliConfig();
  const aiProviders = loadAiProviders();

  // 1. Provider name
  const providerName =
    options.provider ??
    cliConfig.activeProvider ??
    (process.env.KILO_API_KEY
      ? 'kilo'
      : process.env.OPENROUTER_API_KEY
        ? 'openrouter'
        : process.env.OPENAI_API_KEY
          ? 'openai'
          : process.env.ANTHROPIC_API_KEY
            ? 'anthropic'
            : 'openrouter');
  const stored = hasAiProvider(aiProviders, providerName) ? aiProviders[providerName] : undefined;
  const known = builtin(providerName);

  // `agent config --url/--model` and `agent model set` describe the ACTIVE
  // provider. They must not leak onto a different provider picked with
  // --provider (that would send this provider's key to another endpoint).
  const usingConfigured =
    options.provider === undefined || options.provider === cliConfig.activeProvider;
  const configuredBaseUrl = usingConfigured ? cliConfig.customBaseUrl : undefined;

  if (!stored && !known && !options.baseUrl && !configuredBaseUrl) {
    throw new AgentConfigError(
      `Unknown provider "${providerName}". Add it with "joy-media agent provider add ${providerName} --url <url>", ` +
        'or pass --url for a one-off endpoint.',
    );
  }

  // 2. API key
  let apiKey = options.apiKey?.trim() || undefined;
  let apiKeySource = apiKey ? 'flag' : 'none';
  if (!apiKey && known?.envKey && process.env[known.envKey]?.trim()) {
    apiKey = process.env[known.envKey]!.trim();
    apiKeySource = `env:${known.envKey}`;
  }
  if (!apiKey && stored?.apiKey?.trim()) {
    apiKey = stored.apiKey.trim();
    apiKeySource = `provider:${providerName}`;
  }

  // 3. Base URL — a stored provider's key stays paired with its own URL.
  const rawBaseUrl = options.baseUrl ?? stored?.baseUrl ?? configuredBaseUrl ?? known?.baseUrl;
  if (rawBaseUrl === undefined) {
    throw new AgentConfigError(`No base URL configured for provider "${providerName}".`);
  }
  const { url: baseUrl, local } = normalizeCliBaseUrl(rawBaseUrl);

  let kind: ProviderKind = stored ? storedProviderKind(stored) : (known?.kind ?? 'custom');
  if (local) kind = 'custom';

  // 4. Model
  const modelId = (
    options.model ??
    (usingConfigured ? cliConfig.defaultModel : undefined) ??
    stored?.defaultModel ??
    known?.model ??
    'gpt-4o'
  ).trim();

  return { providerName, kind, baseUrl, modelId, apiKey, apiKeySource, local };
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
  const settings = resolveProviderSettings(options);
  const { modelId, apiKey } = settings;
  if (modelId.length === 0 || modelId.length > MAX_MODEL_ID_LENGTH) {
    throw new AgentConfigError(`The model id must be 1-${MAX_MODEL_ID_LENGTH} characters long.`);
  }
  if (apiKey !== undefined && apiKey.length > MAX_API_KEY_LENGTH) {
    throw new AgentConfigError(`The API key is longer than ${MAX_API_KEY_LENGTH} characters.`);
  }

  if (settings.local) {
    // Local servers (LM Studio, Ollama...) usually need no key: send none.
    return Object.freeze({
      provider: 'custom' as const,
      baseUrl: settings.baseUrl,
      modelId,
      apiKey: apiKey ?? '',
    });
  }

  if (!apiKey) throw new AgentConfigError(missingApiKeyMessage(settings));

  try {
    return normalizeByokSessionConfig({
      provider: settings.kind,
      baseUrl: settings.baseUrl,
      modelId,
      apiKey,
    });
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      throw new AgentConfigError(
        settings.kind === 'openrouter'
          ? `Provider "${settings.providerName}" is an OpenRouter provider and only accepts ${OPENROUTER_BASE_URL}.`
          : `The endpoint for provider "${settings.providerName}" is not allowed: remote providers must be public https:// hosts (private-network addresses are blocked; use localhost for local servers).`,
      );
    }
    throw error;
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
