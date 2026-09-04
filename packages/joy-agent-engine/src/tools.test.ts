import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_JOY_AGENT_LIMITS } from './limits.js';
import {
  JOY_AGENT_TOOL_METADATA,
  createJoyAgentTools,
  parseJoyTimelineOperations,
  validateOperationDependencies,
  type JoyAgentToolBridge,
} from './tools.js';

const insert = (id: string) => ({
  kind: 'insert' as const,
  id,
  assetId: 'asset-1',
  trackId: 'track-1',
  startUs: 0,
  durationUs: 1_000_000,
  dependsOn: [],
});

function bridge(overrides: Partial<JoyAgentToolBridge> = {}): JoyAgentToolBridge {
  return {
    readProjectSummary: async () => ({ ok: true }),
    readSelection: async () => ({ ok: true }),
    readTimelineWindow: async () => ({ ok: true }),
    readAssetMetadata: async () => ({ ok: true }),
    readStyleCatalog: async () => ({ ok: true }),
    proposeTimelineOperations: async () => ({ ok: true }),
    proposeDocumentOperations: async () => ({ ok: true }),
    submitPlan: async () => ({ ok: true }),
    ...overrides,
  };
}

describe('JOY Agent tool catalog', () => {
  it('strictly rejects unknown keys and model-owned UI/network fields', () => {
    expect(() =>
      parseJoyTimelineOperations([{ ...insert('op-1'), panelId: 'timeline' }]),
    ).toThrow();
    expect(() => parseJoyTimelineOperations([{ ...insert('op-1'), selector: '.clip' }])).toThrow();
    expect(() =>
      parseJoyTimelineOperations([{ ...insert('op-1'), endpoint: 'https://provider.invalid' }]),
    ).toThrow();
    expect(() =>
      parseJoyTimelineOperations(Array.from({ length: 33 }, (_, index) => insert(`op-${index}`))),
    ).toThrow();
  });

  it('rejects unsupported operation kinds and dependency cycles', () => {
    expect(() =>
      parseJoyTimelineOperations([{ kind: 'warp', id: 'op-1', dependsOn: [] }]),
    ).toThrow();
    expect(() =>
      validateOperationDependencies([
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['a'] },
      ]),
    ).toThrow('JOY_AGENT_INVALID_TOOL');
  });

  it('bounds operation strings and tool results', async () => {
    expect(() =>
      parseJoyTimelineOperations([{ ...insert('op-1'), assetId: 'x'.repeat(129) }]),
    ).toThrow();
    const tools = createJoyAgentTools(
      bridge({
        readProjectSummary: async () => 'x'.repeat(DEFAULT_JOY_AGENT_LIMITS.toolPayloadBytes + 1),
      }),
    );
    await expect(
      (tools.read_project_summary as { execute: () => Promise<unknown> }).execute(),
    ).rejects.toThrow('JOY_AGENT_INVALID_TOOL');
  });

  it('only marks read tools parallel and caps concurrent reads at two', async () => {
    expect(
      Object.values(JOY_AGENT_TOOL_METADATA)
        .filter((metadata) => metadata.parallel)
        .every((metadata) => metadata.access === 'read'),
    ).toBe(true);
    let active = 0;
    let maximum = 0;
    const tools = createJoyAgentTools(
      bridge({
        readProjectSummary: async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { ok: true };
        },
      }),
    );
    const execute = (tools.read_project_summary as { execute: () => Promise<unknown> }).execute;
    await Promise.all([execute(), execute(), execute(), execute()]);
    expect(maximum).toBeLessThanOrEqual(2);
  });

  it('serializes proposal tools and forwards only validated operations', async () => {
    const propose = vi.fn(async () => ({ accepted: true }));
    const tools = createJoyAgentTools(bridge({ proposeTimelineOperations: propose }));
    const execute = (
      tools.propose_timeline_operations as { execute: (input: unknown) => Promise<unknown> }
    ).execute;
    await execute({ operations: [insert('op-1')] });
    expect(propose).toHaveBeenCalledWith({ operations: [insert('op-1')] });
    const inputSchema = (
      tools.propose_timeline_operations as { inputSchema: { parse: (input: unknown) => unknown } }
    ).inputSchema;
    expect(() => inputSchema.parse({ operations: [{ ...insert('op-1'), headers: {} }] })).toThrow();
  });
});
