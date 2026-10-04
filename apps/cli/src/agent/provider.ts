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

let joyHostedModelCache:
  { readonly baseUrl: string; readonly expiresAt: number; readonly modelId: string } | undefined;

export async function getJoyHostedDefaultModel(
  baseUrl = DEFAULT_JOY_HOSTED_BASE_URL,
  apiKey?: string,
): Promise<string> {
  if (
    joyHostedModelCache &&
    joyHostedModelCache.baseUrl === baseUrl &&
    joyHostedModelCache.expiresAt > Date.now()
  ) {
    return joyHostedModelCache.modelId;
  }
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) throw new Error(`JOY hosted model catalog returned HTTP ${response.status}`);
  const payload = (await response.json()) as {
    models?: Array<{ id?: unknown; isDefault?: unknown }>;
  };
  const modelId = payload.models?.find(
    (model) => model.isDefault === true && typeof model.id === 'string',
  )?.id;
  if (typeof modelId !== 'string' || !modelId)
    throw new Error('JOY hosted catalog has no default model');
  joyHostedModelCache = { baseUrl, modelId, expiresAt: Date.now() + 60 * 60 * 1000 };
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

  const configuredModel = cliConfig.defaultModel;
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
  if (
    (provider === 'anthropic' || provider === 'kilo') &&
    new URL(baseUrl).origin === 'https://api.openai.com'
  ) {
    throw new Error(`Provider "${provider}" cannot use the OpenAI API origin`);
  }

  return { provider, modelId, baseUrl, source };
}

export async function resolveByokConfig(
  options: ResolveProviderOptions = {},
): Promise<ByokSessionConfig> {
  let effective = describeEffectiveConfig(options);
  const aiProviders = loadAiProviders();
  let apiKey = options.apiKey;
  if (!apiKey) {
    const keyEnv =
      options.apiKeyEnv ??
      aiProviders[effective.provider]?.apiKeyEnv ??
      ENV_PROVIDER_PRIORITY.find(([, name]) => name === effective.provider)?.[0];
    if (keyEnv && process.env[keyEnv]) apiKey = process.env[keyEnv];
    else {
      const saved = aiProviders[effective.provider];
      apiKey =
        saved?.apiKey ??
        (saved?.apiKeyProtected ? unprotectSecret(saved.apiKeyProtected) : undefined);
    }
  }
  if (effective.provider === 'joy-hosted' && !apiKey) {
    throw new Error(
      'JOY hosted provider needs a session token; run joy-media login or set JOY_MEDIA_SESSION_TOKEN',
    );
  }
  if (
    effective.provider === 'joy-hosted' &&
    !options.model &&
    !loadCliConfig().defaultModel &&
    !aiProviders[effective.provider]?.defaultModel
  ) {
    effective = {
      ...effective,
      modelId: await getJoyHostedDefaultModel(effective.baseUrl, apiKey),
    };
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
    apiKey: apiKey ?? 'not-provided',
  });
}

export function createModelFromConfig(config: ByokSessionConfig): LanguageModel {
  const { model } = createJoyAgentProvider(config);
  return model;
}
