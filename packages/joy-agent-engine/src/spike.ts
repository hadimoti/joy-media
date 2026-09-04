import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { stepCountIs, ToolLoopAgent, tool } from 'ai';
import { z } from 'zod';

export interface JoyAgentSpikeConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
}

/**
 * Minimal dependency spike. The real engine is added in the following
 * milestones; keeping this function tiny makes the Worker graph measurable
 * before any product surface depends on it.
 */
export function createJoyAgentSpike(config: JoyAgentSpikeConfig): ToolLoopAgent<any, any> {
  const provider = createOpenAICompatible({
    name: 'joy-byok-spike',
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });

  return new ToolLoopAgent({
    model: provider(config.modelId),
    instructions: 'Use the probe tool only when asked. Never mutate editor state.',
    tools: {
      probe: tool({
        description: 'Return a harmless readiness probe.',
        inputSchema: z.object({ value: z.string().max(64) }),
        execute: async ({ value }) => ({ ok: true as const, value }),
      }),
    },
    stopWhen: stepCountIs(1),
  });
}
