/* global process */
import {
  createJoyAgentProvider,
  normalizeByokSessionConfig,
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

/** Legacy profiles that JOY Media no longer runs (PLAN-v4 §9a). They are refused, never routed. */
const RETIRED_PROVIDERS: ReadonlySet<string> = new Set(['kilo', 'joy-hosted']);

export function resolveByokConfig(options: ResolveProviderOptions = {}): ByokSessionConfig {
  const cliConfig = loadCliConfig();
  const aiProviders = loadAiProviders();

  // 1. Determine provider
  const provider =
    options.provider ??
    cliConfig.activeProvider ??
    (process.env.OPENROUTER_API_KEY
      ? 'openrouter'
      : process.env.OPENAI_API_KEY
        ? 'openai'
        : process.env.ANTHROPIC_API_KEY
          ? 'anthropic'
          : 'openrouter');
  refuseRetired(provider);

  // 2. Determine API key
  let apiKey = options.apiKey;
  if (!apiKey) {
    if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
      apiKey = process.env.OPENROUTER_API_KEY;
    } else if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      apiKey = process.env.OPENAI_API_KEY;
    } else if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      apiKey = process.env.ANTHROPIC_API_KEY;
    } else if (aiProviders[provider]?.apiKey) {
      apiKey = aiProviders[provider]!.apiKey;
    }
  }

  // 3. Determine base URL and normalized provider
  const actualProviderType =
    aiProviders[provider]?.provider ?? (provider.includes('openrouter') ? 'openrouter' : provider);
  refuseRetired(actualProviderType);

  const normalizedProvider: 'openrouter' | 'openai-compatible' | 'custom' =
    actualProviderType === 'openrouter'
      ? 'openrouter'
      : actualProviderType === 'custom'
        ? 'custom'
        : 'openai-compatible';

  let resolvedBaseUrl =
    options.baseUrl ?? cliConfig.customBaseUrl ?? aiProviders[provider]?.baseUrl;

  if (!resolvedBaseUrl) {
    if (normalizedProvider === 'openrouter') {
      resolvedBaseUrl = OPENROUTER_BASE_URL;
    } else if (provider === 'lm-studio') {
      resolvedBaseUrl = 'http://127.0.0.1:1234/v1';
    } else {
      resolvedBaseUrl = 'https://api.openai.com/v1';
    }
  }

  // 4. Determine model ID
  const modelId =
    options.model ??
    cliConfig.defaultModel ??
    aiProviders[provider]?.defaultModel ??
    (provider === 'openrouter'
      ? 'openrouter/auto'
      : provider === 'anthropic'
        ? 'claude-3-7-sonnet-20250219'
        : 'gpt-4o');

  return normalizeByokSessionConfig({
    provider: normalizedProvider,
    baseUrl: resolvedBaseUrl,
    modelId,
    apiKey: apiKey ?? 'not-provided',
  });
}

/** Refuses a retired legacy profile, and names the command that picks another provider. */
function refuseRetired(provider: string): void {
  if (RETIRED_PROVIDERS.has(provider)) {
    throw new Error(
      `The ${provider} provider was retired from JOY Media. Choose another one with "joy-media agent provider use <name>".`,
    );
  }
}

export function createModelFromConfig(config: ByokSessionConfig): LanguageModel {
  const { model } = createJoyAgentProvider(config);
  return model;
}
