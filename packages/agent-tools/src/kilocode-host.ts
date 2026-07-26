import type {
  AgentHostManifest,
  LocalExecutorReference,
  MediaProviderReference,
  ReasoningModelReference,
} from '@joy-media/provider-sdk';
import { createToolRegistry, type ToolRegistry } from './registry.js';

export const KILOCODE_AGENT_HOST_ID = 'kilocode' as const;

export interface KiloCodeHostOptions {
  readonly adapterVersion?: string;
  readonly registry?: ToolRegistry;
  readonly reasoningModels?: readonly ReasoningModelReference[];
  readonly mediaProviders?: readonly MediaProviderReference[];
  readonly localExecutors?: readonly LocalExecutorReference[];
}

/**
 * The only supported JOY Media editing-agent host. KiloCode orchestrates the
 * semantic tools but remains separate from models, generation providers, and
 * local workers supplied through the provider SDK.
 */
export function createKiloCodeAgentHostManifest(
  options: KiloCodeHostOptions = {},
): AgentHostManifest {
  const registry = options.registry ?? createToolRegistry();
  const tools = [...registry.tools.values()].map((tool) => ({
    name: tool.name,
    requiredCapabilities: tool.scope.capabilities,
  }));

  return {
    manifestVersion: 1,
    kind: 'agent-host',
    id: KILOCODE_AGENT_HOST_ID,
    displayName: 'KiloCode',
    adapterVersion: options.adapterVersion ?? '1.0.0',
    transport: 'code-server-extension',
    tools,
    reasoningModels: options.reasoningModels ?? [],
    mediaProviders: options.mediaProviders ?? [],
    localExecutors: options.localExecutors ?? [],
    health: {
      strategy: 'extension-heartbeat',
      timeoutMs: 30_000,
    },
    cancellation: {
      supported: true,
      mode: 'cooperative',
    },
    costReporting: {
      supported: true,
      source: 'provider-usage',
    },
    settings: {
      surface: 'code-server-extension',
      configurationSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          defaultReasoningModel: { type: 'string' },
          executionMode: {
            type: 'string',
            enum: ['suggest-only', 'preview-and-approve', 'auto-apply-low-risk', 'full-auto'],
          },
        },
      },
      secretReferences: [
        {
          providerId: KILOCODE_AGENT_HOST_ID,
          fieldName: 'apiKey',
          scope: 'server-only',
        },
      ],
    },
  };
}
