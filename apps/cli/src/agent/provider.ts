/* global process, console */
import {
  createJoyAgentProvider,
  normalizeByokSessionConfig,
  canonicalKiloBaseUrl,
  defaultModelFor,
  isRetiredModelId,
  KILO_GATEWAY_BASE_URL,
  OPENROUTER_BASE_URL,
  type ByokSessionConfig,
} from '@joy-media/joy-agent-engine';
import type { LanguageModel } from 'ai';
import { loadAiProviders, loadCliConfig } from '../utils/config.js';

export interface ResolveProviderOptions {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly apiKey?: string | undefined;
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
] as const;

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
    (provider === 'anthropic' ? 'claude-3-7-sonnet-20250219' : 'gpt-4o');

  let baseUrl =
    options.baseUrl ?? cliConfig.customBaseUrl ?? aiProviders[provider]?.baseUrl ?? undefined;
  if (!baseUrl) {
    if (provider === 'kilo') baseUrl = KILO_GATEWAY_BASE_URL;
    else if (provider === 'openrouter') baseUrl = OPENROUTER_BASE_URL;
    else if (provider === 'lm-studio') baseUrl = 'http://127.0.0.1:1234/v1';
    else baseUrl = 'https://api.openai.com/v1';
  }
  if (provider === 'kilo') baseUrl = canonicalKiloBaseUrl(baseUrl);

  return { provider, modelId, baseUrl, source };
}

export function resolveByokConfig(options: ResolveProviderOptions = {}): ByokSessionConfig {
  const effective = describeEffectiveConfig(options);
  const aiProviders = loadAiProviders();
  let apiKey = options.apiKey;
  if (!apiKey) {
    const keyEnv = ENV_PROVIDER_PRIORITY.find(([, name]) => name === effective.provider)?.[0];
    if (keyEnv && process.env[keyEnv]) apiKey = process.env[keyEnv];
    else apiKey = aiProviders[effective.provider]?.apiKey;
  }

  const actualProviderType =
    aiProviders[effective.provider]?.provider ??
    (effective.provider === 'kilo'
      ? 'kilo'
      : effective.provider === 'openrouter'
        ? 'openrouter'
        : effective.provider);
  const normalizedProvider: 'openrouter' | 'openai-compatible' | 'kilo' | 'custom' =
    actualProviderType === 'openrouter'
      ? 'openrouter'
      : actualProviderType === 'kilo'
        ? 'kilo'
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
