import { describe, expect, it } from 'vitest';
import { createMockProvider } from '@joy-media/provider-sdk';
import { buildEditorContext } from './context.js';
import { estimateStep } from './estimation.js';
import { createToolRegistry } from './registry.js';
import type { AgentPlanStep } from './plan.js';

describe('provider-aware agent estimation', () => {
  const provider = createMockProvider('remote-speech', ['speech.transcribe'], {
    execution: 'remote-api',
    privacy: { dataLeavesDevice: true },
  });
  const pricedProvider = {
    ...provider,
    manifest: {
      ...provider.manifest,
      capabilities: [
        {
          ...provider.manifest.capabilities[0]!,
          pricing: { model: 'per-request' as const, rate: '0.42', currency: 'USD' },
          estimatedResources: { estimatedDurationMs: 1500 },
        },
      ],
    },
  };

  const step: AgentPlanStep = {
    id: 'step-1',
    description: 'Transcribe selected clip',
    mode: 'job',
    tool: 'speechTranscribe',
    arguments: {},
    dependsOn: [],
    expectedChange: 'caption document',
    preconditions: [],
    requiresConfirmation: true,
  };

  it('builds planning context from configured providers with capabilities and prices', () => {
    const context = buildEditorContext({}, undefined, undefined, { providers: [pricedProvider] });

    expect(context.providers.localOnly).toBe(false);
    expect(context.providers.availableProviders).toEqual([
      expect.objectContaining({
        id: 'remote-speech',
        capabilities: ['speech.transcribe'],
        prices: [
          {
            capability: 'speech.transcribe',
            pricing: { model: 'per-request', rate: '0.42', currency: 'USD' },
          },
        ],
      }),
    ]);
  });

  it('estimates provider cost and privacy from configured capability pricing', () => {
    const context = buildEditorContext({}, undefined, undefined, { providers: [pricedProvider] });

    const estimation = estimateStep(step, createToolRegistry(), context);

    expect(estimation.cost).toEqual({
      localOnly: false,
      providerCost: { amount: '0.42', currency: 'USD' },
      workerTimeMs: 1500,
    });
    expect(estimation.privacy).toEqual({
      dataLeavesDevice: true,
      providerId: 'remote-speech',
      dataTypes: ['audio data'],
    });
  });
});
