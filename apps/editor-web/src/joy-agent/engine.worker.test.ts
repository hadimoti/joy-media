import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainToWorkerMessage, WorkerToMainMessage } from './protocol.js';
import { briefFixture } from './creative-brief.test-fixture.js';
import { createJoyAgentContextSnapshot } from './context-snapshot.js';
import { createAgentPreviewStore } from '../agent-preview-store.js';
import { EditorSession } from '../editor-session.js';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { compileJoyCodeCompoundDraft } from '../joy-code-compound-compiler.js';
import { stageJoyAgentPreview } from './stage-preview.js';

async function mountedWorker(fetcher: typeof fetch) {
  const output: WorkerToMainMessage[] = [];
  let receive!: (event: MessageEvent<MainToWorkerMessage>) => void;
  vi.stubGlobal('addEventListener', (_: string, listener: typeof receive) => {
    receive = listener;
  });
  vi.stubGlobal('postMessage', (message: WorkerToMainMessage) => output.push(message));
  vi.stubGlobal('fetch', fetcher);
  await import('./engine.worker.js');
  const send = (data: MainToWorkerMessage) =>
    receive({ data } as MessageEvent<MainToWorkerMessage>);
  send({
    protocolVersion: 1,
    type: 'configure',
    config: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      modelId: 'fixture',
      apiKey: 'fixture-only',
    },
  });
  return { output, send };
}

const toolResponse = (id: string, name: string, args: unknown = {}) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('browser Worker transport lifecycle', () => {
  it('executes read → invalid proposal → repair → final, then stages a document preview without applying', async () => {
    const editor = new EditorSession(
      { getItem: () => null, setItem: () => {} },
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const before = editor.visualProject;
    const brief = briefFixture(before.id, editor.projectRevisionId, 'Make captions readable');
    const context = createJoyAgentContextSnapshot({
      projectId: before.id,
      revision: editor.projectRevisionId,
      creativeBrief: brief,
    });
    const proposal = {
      summary: 'Readable captions',
      operations: [{ id: 'captions', kind: 'caption.setBurnIn', enabled: true, dependsOn: [] }],
    };
    let calls = 0;
    const { output, send } = await mountedWorker(async (_input, init) => {
      const body = JSON.parse(init!.body as string);
      const result = calls === 0 ? undefined : JSON.parse(body.messages.at(-1).content);
      switch (calls++) {
        case 0:
          return toolResponse('read', 'read_project_context');
        case 1:
          expect(result.context.creativeBrief.request).toBe('Make captions readable');
          return toolResponse('invalid', 'validate_proposal', {
            ...proposal,
            operations: [{ ...proposal.operations[0], enabled: 'yes' }],
          });
        case 2:
          expect(result).toMatchObject({ ok: false, repairable: true, applied: false });
          return toolResponse('repair', 'validate_proposal', proposal);
        default:
          expect(result).toMatchObject({ staged: true, applied: false, proposal });
          return new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }] }),
          );
      }
    });
    send({
      protocolVersion: 1,
      type: 'run',
      request: {
        runId: 'semantic',
        prompt: 'Use attached direction',
        baseRevision: editor.projectRevisionId,
        context,
        mode: 'tool-loop',
      },
    });
    await vi.waitFor(() =>
      expect(output.at(-1)).toEqual({
        protocolVersion: 1,
        type: 'run-finished',
        runId: 'semantic',
      }),
    );
    expect(calls).toBe(4);
    const event = output.find((item) => item.type === 'event' && item.event.proposal !== undefined);
    if (event?.type !== 'event' || event.event.proposal === undefined)
      throw new Error('Missing preview proposal');
    const draft = compileJoyCodeCompoundDraft({
      planId: 'semantic',
      baseRevision: editor.projectRevisionId,
      timeline: editor.timelineProject,
      visualProject: editor.visualProject,
      registeredAssetIds: [],
      operations: event.event.proposal.operations as never,
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const preview = createAgentPreviewStore();
    stageJoyAgentPreview(preview, editor, draft);
    expect(preview.getState().document?.preview.pluginData['joy.captions.burnIn']).toBe(true);
    expect(editor.visualProject).toBe(before);
    expect(output).toContainEqual(
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({ phase: 'awaiting-approval' }),
      }),
    );
    expect(JSON.stringify(output)).not.toContain('fixture-only');
  });

  it('normalizes malformed provider JSON and closes without a preview', async () => {
    const { output, send } = await mountedWorker(async () => new Response('{not-json'));
    send({
      protocolVersion: 1,
      type: 'run',
      request: {
        runId: 'invalid',
        prompt: 'edit',
        mode: 'tool-loop',
        context: { clips: [], assets: [] },
      },
    });
    await vi.waitFor(() =>
      expect(output.at(-1)).toEqual({ protocolVersion: 1, type: 'run-finished', runId: 'invalid' }),
    );
    expect(output).toContainEqual(
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({
          phase: 'failed',
          errorCode: 'JOY_AGENT_INVALID_PROPOSAL',
          message: 'Provider returned invalid proposal JSON',
        }),
      }),
    );
    expect(output.some((item) => item.type === 'event' && item.event.proposal !== undefined)).toBe(
      false,
    );
  });

  it('terminates a model that keeps reading instead of submitting a proposal', async () => {
    let calls = 0;
    const { output, send } = await mountedWorker(async () =>
      toolResponse(`read-${calls++}`, 'read_project_context'),
    );
    send({
      protocolVersion: 1,
      type: 'run',
      request: {
        runId: 'bounded',
        prompt: 'edit',
        mode: 'tool-loop',
        context: { clips: [], assets: [] },
      },
    });
    await vi.waitFor(() =>
      expect(output.at(-1)).toEqual({ protocolVersion: 1, type: 'run-finished', runId: 'bounded' }),
    );
    expect(calls).toBe(4);
    expect(output).toContainEqual(
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({
          phase: 'failed',
          errorCode: 'JOY_AGENT_INVALID_PROPOSAL',
        }),
      }),
    );
    expect(output.some((item) => item.type === 'event' && item.event.proposal !== undefined)).toBe(
      false,
    );
  });

  it('cancels between tool turns and closes the pending run', async () => {
    let calls = 0;
    const { output, send } = await mountedWorker(async (_input, init) => {
      if (calls++ === 0) return toolResponse('read', 'read_project_context');
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        ),
      );
    });
    send({
      protocolVersion: 1,
      type: 'run',
      request: {
        runId: 'cancel',
        prompt: 'edit',
        mode: 'tool-loop',
        context: { clips: [], assets: [] },
      },
    });
    await vi.waitFor(() => expect(calls).toBe(2));
    send({ protocolVersion: 1, type: 'cancel', runId: 'cancel' });
    await vi.waitFor(() =>
      expect(output.at(-1)).toEqual({ protocolVersion: 1, type: 'run-finished', runId: 'cancel' }),
    );
    expect(output).toContainEqual(
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({ phase: 'cancelled' }),
      }),
    );
    expect(output.some((item) => item.type === 'event' && item.event.proposal !== undefined)).toBe(
      false,
    );
  });
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
