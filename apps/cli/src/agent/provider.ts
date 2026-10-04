/* global process, console */
import {
  createJoyAgentProvider,
  normalizeByokSessionConfig,
  canonicalKiloBaseUrl,
  defaultModelFor,
  isRetiredModelId,
  KILO_GATEWAY_BASE_URL,
  OPENROUTER_BASE_URL,
  JOY_HOSTED_BASE_URL as DEFAULT_JOY_HOSTED_BASE_URL,
  type ByokSessionConfig,
} from '@joy-media/joy-agent-engine';
import type { LanguageModel } from 'ai';
import { loadAiProviders, loadCliConfig } from '../utils/config.js';
import { unprotectSecret } from '../utils/secret-store.js';

export interface ResolveProviderOptions {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly apiKeyEnv?: string | undefined;
  readonly baseUrl?: string | undefined;
}

export interface EffectiveProviderConfig {
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly source: 'flag' | 'config' | 'env' | 'default';
}

const ENV_PROVIDER_PRIORITY = [
  ['KILO_API_KEY', 'kilo'],
  ['OPENROUTER_API_KEY', 'openrouter'],
  ['OPENAI_API_KEY', 'openai'],
  ['ANTHROPIC_API_KEY', 'anthropic'],
  ['JOY_MEDIA_SESSION_TOKEN', 'joy-hosted'],
] as const;

interface JoyHostedCatalogModel {
  readonly id: string;
  readonly isDefault?: boolean;
  readonly vision?: boolean;
}

let joyHostedModelCache:
  | {
      readonly baseUrl: string;
      readonly expiresAt: number;
      readonly models: readonly JoyHostedCatalogModel[];
    }
  | undefined;

async function getJoyHostedModelCatalog(
  baseUrl: string,
  apiKey?: string,
): Promise<readonly JoyHostedCatalogModel[]> {
  if (joyHostedModelCache?.baseUrl === baseUrl && joyHostedModelCache.expiresAt > Date.now())
    return joyHostedModelCache.models;
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) throw new Error(`JOY hosted model catalog returned HTTP ${response.status}`);
  const payload = (await response.json()) as { models?: Array<Record<string, unknown>> };
  const models = (payload.models ?? []).flatMap((model) =>
    typeof model.id === 'string'
      ? [
          {
            id: model.id,
            ...(model.isDefault === true ? { isDefault: true } : {}),
            ...(model.vision === true ? { vision: true } : {}),
          },
        ]
      : [],
  );
  joyHostedModelCache = { baseUrl, models, expiresAt: Date.now() + 60 * 60 * 1000 };
  return models;
}

export async function getJoyHostedDefaultModel(
  baseUrl = DEFAULT_JOY_HOSTED_BASE_URL,
  apiKey?: string,
): Promise<string> {
  const models = await getJoyHostedModelCatalog(baseUrl, apiKey);
  const modelId = models.find((model) => model.isDefault)?.id;
  if (!modelId) throw new Error('JOY hosted catalog has no default model');
  return modelId;
}

export function describeEffectiveConfig(
  options: ResolveProviderOptions = {},
): EffectiveProviderConfig {
  const cliConfig = loadCliConfig();
  const aiProviders = loadAiProviders();
  let provider: string;
  let source: EffectiveProviderConfig['source'];
  if (options.provider) {
    provider = options.provider;
    source = 'flag';
  } else if (cliConfig.activeProvider) {
    provider = cliConfig.activeProvider;
    source = 'config';
  } else {
    const envProvider = ENV_PROVIDER_PRIORITY.find(([key]) => Boolean(process.env[key]))?.[1];
    provider = envProvider ?? 'openrouter';
    source = envProvider ? 'env' : 'default';
  }

  const configuredModel = cliConfig.defaultModels?.[provider];
  if (configuredModel && isRetiredModelId(configuredModel)) {
    console.warn(`Configured model "${configuredModel}" is retired; using the provider default.`);
  }
  const providerModel = aiProviders[provider]?.defaultModel;
  const safeProviderModel =
    providerModel && !isRetiredModelId(providerModel) ? providerModel : undefined;
  const modelId =
    options.model ??
    (configuredModel && !isRetiredModelId(configuredModel) ? configuredModel : undefined) ??
    safeProviderModel ??
    defaultModelFor(provider) ??
    (provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o');

  let baseUrl =
    options.baseUrl ?? cliConfig.customBaseUrl ?? aiProviders[provider]?.baseUrl ?? undefined;
  if (!baseUrl) {
    if (provider === 'kilo') baseUrl = KILO_GATEWAY_BASE_URL;
    else if (provider === 'openrouter') baseUrl = OPENROUTER_BASE_URL;
    else if (provider === 'lm-studio') baseUrl = 'http://127.0.0.1:1234/v1';
    else if (provider === 'openai') baseUrl = 'https://api.openai.com/v1';
    else if (provider === 'anthropic') baseUrl = 'https://api.anthropic.com/v1/';
    else if (provider === 'joy-hosted') baseUrl = DEFAULT_JOY_HOSTED_BASE_URL;
    else throw new Error(`Provider "${provider}" needs --base-url`);
  }
  if (provider === 'kilo') baseUrl = canonicalKiloBaseUrl(baseUrl);
  validateProviderBaseUrl(baseUrl);
  if (
    (provider === 'anthropic' || provider === 'kilo') &&
    new URL(baseUrl).origin === 'https://api.openai.com'
  ) {
    throw new Error(`Provider "${provider}" cannot use the OpenAI API origin`);
  }

  return { provider, modelId, baseUrl, source };
}

export function validateProviderBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(
      'INSECURE_PROVIDER_URL: provider URL must be a valid HTTPS URL or a loopback HTTP URL.',
    );
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
    throw new Error(
      'INSECURE_PROVIDER_URL: HTTP is allowed only for localhost, 127.0.0.1, or [::1].',
    );
}

export async function resolveByokConfig(
  options: ResolveProviderOptions = {},
): Promise<ByokSessionConfig> {
  let effective = describeEffectiveConfig(options);
  const aiProviders = loadAiProviders();
  const keyProvider = aiProviders[effective.provider]?.provider ?? effective.provider;
  let apiKey = options.apiKey;
  const keylessLocalProvider = effective.provider === 'lm-studio';
  if (!apiKey && !keylessLocalProvider) {
    const keyEnv =
      options.apiKeyEnv ??
      aiProviders[effective.provider]?.apiKeyEnv ??
      ENV_PROVIDER_PRIORITY.find(([, name]) => name === keyProvider)?.[0];
    if (keyEnv && process.env[keyEnv]) apiKey = process.env[keyEnv];
    else {
      const saved = aiProviders[effective.provider];
      apiKey =
        saved?.apiKey ??
        (saved?.apiKeyProtected ? unprotectSecret(saved.apiKeyProtected) : undefined);
    }
  }
  if ((effective.provider === 'joy-hosted' || keyProvider === 'joy-hosted') && !apiKey) {
    throw new Error('JOY hosted provider needs a session token; set JOY_MEDIA_SESSION_TOKEN');
  }
  if (!apiKey && !keylessLocalProvider) {
    const envName =
      options.apiKeyEnv ??
      aiProviders[effective.provider]?.apiKeyEnv ??
      ENV_PROVIDER_PRIORITY.find(([, name]) => name === keyProvider)?.[0];
    const hint = envName
      ? `set ${envName} or run \`joy-media agent provider add ${effective.provider} --api-key-env ${envName}\``
      : `configure a key with \`joy-media agent provider add ${effective.provider} --api-key-env <VAR>\``;
    throw new Error(`No API key for ${effective.provider}: ${hint}`);
  }
  if (
    effective.provider === 'joy-hosted' &&
    !options.model &&
    !loadCliConfig().defaultModels?.[effective.provider] &&
    !aiProviders[effective.provider]?.defaultModel
  ) {
    effective = {
      ...effective,
      modelId: await getJoyHostedDefaultModel(effective.baseUrl, apiKey),
    };
  }
  let hostedVision: boolean | undefined;
  if (effective.provider === 'joy-hosted') {
    const catalog = await getJoyHostedModelCatalog(effective.baseUrl, apiKey);
    hostedVision = catalog.find((model) => model.id === effective.modelId)?.vision === true;
  }

  const actualProviderType =
    aiProviders[effective.provider]?.provider ??
    (effective.provider === 'kilo'
      ? 'kilo'
      : effective.provider === 'openrouter'
        ? 'openrouter'
        : effective.provider);
  const normalizedProvider: 'joy-hosted' | 'openrouter' | 'openai-compatible' | 'kilo' | 'custom' =
    actualProviderType === 'openrouter'
      ? 'openrouter'
      : actualProviderType === 'kilo'
        ? 'kilo'
        : actualProviderType === 'joy-hosted'
          ? 'joy-hosted'
          : actualProviderType === 'custom'
            ? 'custom'
            : 'openai-compatible';

  return normalizeByokSessionConfig({
    provider: normalizedProvider,
    baseUrl: effective.baseUrl,
    modelId: effective.modelId,
    apiKey: apiKey ?? 'local-no-key-required',
    ...(hostedVision === undefined ? {} : { vision: hostedVision }),
  });
}

export function createModelFromConfig(config: ByokSessionConfig): LanguageModel {
  const { model } = createJoyAgentProvider(config, (input, init) =>
    retryProviderFetch(input, init, fetch, config.provider),
  );
  return model;
}

export async function retryProviderFetch(
  input: Request | URL | string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
  providerName = 'provider',
): Promise<Response> {
  const startedAt = Date.now();
  let lastRetryAfter: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetchImpl(input, init);
    if (response.status !== 429) return response;
    await response.body?.cancel().catch(() => {});
    const retryAfter = response.headers.get('retry-after');
    lastRetryAfter = safeRetryAfter(retryAfter);
    if (attempt === 3) throw rateLimitError(providerName, attempt, lastRetryAfter);
    const dateSeconds = retryAfter ? (Date.parse(retryAfter) - Date.now()) / 1000 : Number.NaN;
    const seconds =
      retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter)
        : Number.isFinite(dateSeconds)
          ? Math.max(0, dateSeconds)
          : 1;
    const delayMs = Math.max(0, Math.ceil(seconds * 1000));
    if (Date.now() - startedAt + delayMs > 60_000)
      throw rateLimitError(providerName, attempt, lastRetryAfter);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw rateLimitError(providerName, 3, lastRetryAfter);
}

function rateLimitError(providerName: string, attempts: number, retryAfter: string | null): Error {
  return Object.assign(
    new Error(
      `JOY_AGENT_RATE_LIMITED: ${providerName} after ${attempts} attempts; last Retry-After: ${retryAfter ?? 'not provided'}.`,
    ),
    { statusCode: 429 },
  );
}

function safeRetryAfter(value: string | null): string | null {
  if (value === null) return null;
  if (value.length > 64) return '[invalid]';
  if (/^\d+(?:\.\d+)?$/.test(value) || Number.isFinite(Date.parse(value))) return value;
  return '[invalid]';
}
