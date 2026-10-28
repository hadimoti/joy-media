import { findRegistryProvider } from '@joy-media/provider-sdk';

/**
 * The one way the agent reaches a model (PLAN-v4 §6a). A call names a saved profile, its base URL
 * (checked by the broker against that profile) and the model. The key stays in the main process.
 */
export interface ProviderCallRequest {
  readonly profileId: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Resolves to the provider's reply text. Rejects with a ProviderCallError carrying the broker's code. */
export type ProviderCall = (request: ProviderCallRequest) => Promise<string>;

export class ProviderCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderCallError';
  }
}

/**
 * The session provider for a saved profile, or undefined when this build cannot run it yet. A v1.0.x
 * `custom` profile is the same provider as `openai-compatible`.
 */
export function sessionProviderFor(
  provider: string,
): 'openrouter' | 'openai-compatible' | undefined {
  if (provider === 'openrouter') return 'openrouter';
  if (provider === 'openai-compatible' || provider === 'custom') return 'openai-compatible';
  // A registry provider is reached through the broker; the session only names the chat transport.
  if (findRegistryProvider(provider) !== undefined) return 'openai-compatible';
  return undefined;
}
