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

  it('exposes bounded domain tools without granting them a default executor', async () => {
    const readBrief = vi.fn(async () => ({ request: 'brief' }));
    const tools = createJoyAgentTools(bridge({ readBrief }));
    expect(JOY_AGENT_TOOL_METADATA.read_brief?.surface).toBe('creative-brief');
    expect(JOY_AGENT_TOOL_METADATA.propose_scene_3d?.access).toBe('preview');
    const read = (tools.read_brief as { execute: () => Promise<unknown> }).execute;
    await expect(read()).resolves.toEqual({ request: 'brief' });
    const propose = (
      tools.propose_asset as {
        execute: (input: unknown) => Promise<unknown>;
      }
    ).execute;
    await expect(propose({ assetId: 'asset-1', summary: 'retime' })).rejects.toThrow(
      'JOY_AGENT_UNAVAILABLE',
    );
  });

  it('registers frame observation only for consented vision models with a frame reader', () => {
    const visionModel = 'byteplus-coding/dola-seed-2.0-pro';
    expect(
      createJoyAgentTools(bridge(), DEFAULT_JOY_AGENT_LIMITS, {
        modelId: visionModel,
        allowFrames: true,
      }),
    ).not.toHaveProperty('read_frame');
    expect(
      createJoyAgentTools(
        bridge({ readFrame: async () => ({ unavailable: 'missing' }) }),
        DEFAULT_JOY_AGENT_LIMITS,
        { modelId: 'byteplus-coding/deepseek-v4-flash', allowFrames: true },
      ),
    ).not.toHaveProperty('read_frame');
    expect(
      createJoyAgentTools(
        bridge({ readFrame: async () => ({ unavailable: 'missing' }) }),
        DEFAULT_JOY_AGENT_LIMITS,
        { modelId: visionModel },
      ),
    ).not.toHaveProperty('read_frame');
    expect(
      createJoyAgentTools(
        bridge({ readFrame: async () => ({ unavailable: 'missing' }) }),
        DEFAULT_JOY_AGENT_LIMITS,
        { modelId: visionModel, allowFrames: true },
      ),
    ).toHaveProperty('read_frame');
  });

  it('caps frame reads at three and returns an unavailable result on the fourth call', async () => {
    const readFrame = vi.fn(async () => ({
      mediaType: 'image/jpeg' as const,
      base64: 'ZmFrZQ==',
      width: 1,
      height: 1,
    }));
    const tools = createJoyAgentTools(bridge({ readFrame }), DEFAULT_JOY_AGENT_LIMITS, {
      modelId: 'byteplus-coding/dola-seed-2.0-pro',
      allowFrames: true,
    });
    const execute = (tools.read_frame as { execute: (input: { atUs: number }) => Promise<unknown> })
      .execute;
    await execute({ atUs: 0 });
    await execute({ atUs: 1 });
    await execute({ atUs: 2 });
    await expect(execute({ atUs: 3 })).resolves.toMatchObject({ unavailable: expect.any(String) });
    expect(readFrame).toHaveBeenCalledTimes(3);
  });

  it('maps JPEG tool results to AI SDK multipart file output within the payload limit', async () => {
    const base64 = 'ZmFrZQ==';
    const tools = createJoyAgentTools(
      bridge({ readFrame: async () => ({ mediaType: 'image/jpeg', base64, width: 1, height: 1 }) }),
      DEFAULT_JOY_AGENT_LIMITS,
      { modelId: 'byteplus-coding/dola-seed-2.0-pro', allowFrames: true },
    );
    const frameTool = tools.read_frame as unknown as {
      execute: (input: { atUs: number }) => Promise<unknown>;
      toModelOutput: (options: {
        output: { mediaType: 'image/jpeg'; base64: string; width: number; height: number };
      }) => unknown;
    };
    const output = await frameTool.execute({ atUs: 500_000 });
    expect(
      frameTool.toModelOutput({
        output: output as {
          mediaType: 'image/jpeg';
          base64: string;
          width: number;
          height: number;
        },
      }),
    ).toEqual({
      type: 'content',
      value: [{ type: 'file', data: { type: 'data', data: base64 }, mediaType: 'image/jpeg' }],
    });
  });

  it('rejects frame payloads larger than the configured tool payload limit', async () => {
    const tools = createJoyAgentTools(
      bridge({
        readFrame: async () => ({
          mediaType: 'image/jpeg',
          base64: 'A'.repeat(DEFAULT_JOY_AGENT_LIMITS.toolPayloadBytes + 1),
          width: 1,
          height: 1,
        }),
      }),
      DEFAULT_JOY_AGENT_LIMITS,
      { modelId: 'byteplus-coding/dola-seed-2.0-pro', allowFrames: true },
    );
    const execute = (tools.read_frame as { execute: (input: { atUs: number }) => Promise<unknown> })
      .execute;
    await expect(execute({ atUs: 0 })).resolves.toMatchObject({ unavailable: expect.any(String) });
  });

  it('rejects frame dimensions beyond the requested edge limit', async () => {
    const tools = createJoyAgentTools(
      bridge({
        readFrame: async () => ({
          mediaType: 'image/jpeg',
          base64: 'ZmFrZQ==',
          width: 1025,
          height: 1,
        }),
      }),
      DEFAULT_JOY_AGENT_LIMITS,
      { modelId: 'byteplus-coding/dola-seed-2.0-pro', allowFrames: true },
    );
    const execute = (tools.read_frame as { execute: (input: { atUs: number }) => Promise<unknown> })
      .execute;
    await expect(execute({ atUs: 0 })).resolves.toMatchObject({ unavailable: expect.any(String) });
  });
});
