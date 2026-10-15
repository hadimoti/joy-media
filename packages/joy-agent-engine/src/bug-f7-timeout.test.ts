// F7: when the 180 s wall-time limit fires while a slow free model is still sending its
// answer, the run failed as JOY_AGENT_UNKNOWN (o2). A local stalling server reproduces it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { JoyAgentEngine, JoyAgentRunError } from './engine.js';
import { createJoyAgentProvider } from './provider.js';
import type { JoyAgentToolBridge } from './tools.js';

const bridge: JoyAgentToolBridge = {
  readProjectSummary: async () => ({}),
  readSelection: async () => ({}),
  readTimelineWindow: async () => ({}),
  readAssetMetadata: async () => ({}),
  readStyleCatalog: async () => ({}),
  proposeTimelineOperations: async () => ({}),
  proposeDocumentOperations: async () => ({}),
  submitPlan: async () => ({}),
};

let server: http.Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

async function runAgainst(mode: 'no-headers' | 'stalled-body'): Promise<unknown> {
  server = http.createServer((_request, response) => {
    if (mode === 'stalled-body') {
      // OpenRouter keeps slow free-model requests open with a 200 and whitespace keep-alives.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(' ');
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const { model } = createJoyAgentProvider({
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test-placeholder',
    modelId: 'scripted',
  } as never);
  const engine = new JoyAgentEngine({ model, bridge, limits: { wallTimeMs: 400 } });
  return engine
    .run({ runId: 'r', taskKind: 'joy-code-edit', baseRevision: 'r1', request: 'hi', context: {} })
    .catch((error: unknown) => error);
}

describe('F7: wall-time limit is reported as a timeout', () => {
  it('while the provider is still sending a 200 body', async () => {
    const error = await runAgainst('stalled-body');
    expect(error).toBeInstanceOf(JoyAgentRunError);
    expect((error as JoyAgentRunError).code).toBe('JOY_AGENT_TIMEOUT');
  });

  it('while the provider has not answered at all', async () => {
    const error = await runAgainst('no-headers');
    expect((error as JoyAgentRunError).code).toBe('JOY_AGENT_TIMEOUT');
  });

  it('NEW-3: settles at the deadline even when the operation ignores the abort', async () => {
    const { MockLanguageModelV3 } = await import('ai/test');
    const model = new MockLanguageModelV3({
      doGenerate: () => new Promise(() => undefined), // never settles, ignores abortSignal
    });
    const engine = new JoyAgentEngine({ model, bridge, limits: { wallTimeMs: 300 } });
    const started = Date.now();
    const error = await engine
      .run({
        runId: 'r',
        taskKind: 'joy-code-edit',
        baseRevision: 'r1',
        request: 'hi',
        context: {},
      })
      .catch((caught: unknown) => caught);
    expect((error as JoyAgentRunError).code).toBe('JOY_AGENT_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('#6: the default wall-time limit is 300 s', async () => {
    const { DEFAULT_JOY_AGENT_LIMITS } = await import('./limits.js');
    expect(DEFAULT_JOY_AGENT_LIMITS.wallTimeMs).toBe(300_000);
  });
});
