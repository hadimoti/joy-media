/* global process */
import {
  createJoyAgentProvider,
  normalizeByokSessionConfig,
  type ByokSessionConfig,
} from '@joy-media/joy-agent-engine';
import {
  defaultBaseUrl,
  evaluateEndpoint,
  findRegistryProvider,
  findRegistryRegion,
  isCustomProviderId,
  REGISTRY_PROVIDER_IDS,
} from '@joy-media/provider-sdk';
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

/** The key the environment supplies for a provider, when it has one. */
export function environmentKey(provider: string): string | undefined {
  const variable = KEY_ENVIRONMENT[provider];
  return variable === undefined ? undefined : process.env[variable];
}

export function resolveByokConfig(options: ResolveProviderOptions = {}): ByokSessionConfig {
  const cliConfig = loadCliConfig();
  const aiProviders = loadAiProviders();

  // 1. The profile: the option, the active one, or the default for the key in the environment.
  const name = options.provider ?? cliConfig.activeProvider ?? environmentDefault();
  refuseRetired(name);
  const profile = aiProviders[name];

  // 2. The provider type: the saved one, or the registry provider with the same name.
  const type = profile?.provider ?? name;
  refuseRetired(type);
  const registered = findRegistryProvider(type);
  if (registered === undefined && !isCustomProviderId(type)) {
    throw new Error(
      `Unknown provider "${type}". Run "joy-media agent provider list" to see the providers.`,
    );
  }
  if (registered !== undefined && registered.api !== 'chat-completions') {
    throw new Error(
      `${registered.label} is not available in the CLI yet. Use the desktop app for it.`,
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

  // 4. The endpoint policy, the same rules the desktop broker applies.
  const verdict = evaluateEndpoint(type, baseUrl);
  if (!verdict.allowed) {
    throw new Error(`The base URL of "${name}" is refused: ${verdict.reason}`);
  }

  // 5. The model: the option, the global default, or the profile's. There is no built-in model.
  const modelId = options.model ?? cliConfig.defaultModel ?? profile?.defaultModel;
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

  return normalizeByokSessionConfig({
    provider: engineMode(type),
    baseUrl,
    modelId,
    apiKey: apiKey ?? 'not-provided',
  });
}

export function createModelFromConfig(config: ByokSessionConfig): LanguageModel {
  const { model } = createJoyAgentProvider(config);
  return model;
}

function engineMode(type: string): 'openrouter' | 'openai-compatible' | 'custom' {
  if (type === 'openrouter') return 'openrouter';
  return isCustomProviderId(type) ? 'custom' : 'openai-compatible';
}

function environmentDefault(): string {
  return process.env.OPENROUTER_API_KEY
    ? 'openrouter'
    : process.env.OPENAI_API_KEY
      ? 'openai'
      : 'openrouter';
}

function refuseRetired(provider: string): void {
  if (isRetiredProvider(provider)) {
    throw new Error(
      `The ${provider} provider was retired from JOY Media. Choose another one with "joy-media agent provider use <name>".`,
    );
  }
}
