import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainToWorkerMessage, WorkerToMainMessage } from './protocol.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('browser Worker transport lifecycle', () => {
  it('closes approval transport and completes another request without a provider credential', async () => {
    const output: WorkerToMainMessage[] = [];
    let receive!: (event: MessageEvent<MainToWorkerMessage>) => void;
    vi.stubGlobal('addEventListener', (_: string, listener: typeof receive) => {
      receive = listener;
    });
    vi.stubGlobal('postMessage', (message: WorkerToMainMessage) => output.push(message));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Captions',
                      operations: [
                        { id: 'caption', dependsOn: [], kind: 'caption.setBurnIn', enabled: true },
                      ],
                    }),
                  },
                },
              ],
            }),
          ),
      ),
    );
    await import('./engine.worker.js');
    const send = (data: MainToWorkerMessage) =>
      receive({ data } as MessageEvent<MainToWorkerMessage>);
    send({
      protocolVersion: 1,
      type: 'configure',
      config: {
        provider: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        modelId: 'fixture-model',
        apiKey: 'fixture-only',
      },
    });
    for (const runId of ['first', 'second']) {
      send({
        protocolVersion: 1,
        type: 'run',
        request: { runId, prompt: 'captions', baseRevision: 'revision', mode: 'plan-only' },
      });
      await vi.waitFor(() =>
        expect(output).toContainEqual({ protocolVersion: 1, type: 'run-finished', runId }),
      );
      expect(output).toContainEqual(
        expect.objectContaining({
          type: 'event',
          event: expect.objectContaining({ runId, phase: 'awaiting-approval' }),
        }),
      );
    }
    expect(JSON.stringify(output)).not.toContain('fixture-only');
  });
});
