import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserAgentToolCatalog,
  runBoundedToolExchange,
  type BrowserAgentHostCall,
  type JoyAgentHostToolName,
} from './bounded-tool-loop.js';
import type { HostRpcHandlerContext, HostRpcJson, HostRpcMethod } from './host-rpc.js';
import {
  createJoyAgentHostRpcMethodsForSnapshot,
  type JoyAgentGenerationToolAdapter,
} from './tool-bridge.js';
import * as agentTools from '@joy-media/agent-tools';

// ---------------------------------------------------------------------------
// Stub model helpers (same shape as bounded-tool-loop.test.ts)
// ---------------------------------------------------------------------------

type Batch = readonly (readonly [id: string, name: string, args: unknown])[];

const response = (message: unknown): string => JSON.stringify({ choices: [{ message }] });

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const picture = { kind: 'image', prompt: 'A red kettle on a white table', aspect: '1:1' };
const video = { kind: 'video', prompt: 'A slow pan across the kettle', aspect: '16:9', seconds: 4 };

const contextBatch: Batch = [['context', 'read_project_context', { domain: 'overview' }]];

/** Runs a scripted stub model. Each batch is one provider reply with tool calls. */
async function runScenario(batches: readonly Batch[], callHost: BrowserAgentHostCall) {
  const requests: (readonly unknown[])[] = [];
  let step = 0;
  const outcome = await runBoundedToolExchange(
    [],
    async (messages) => {
      requests.push(structuredClone(messages));
      const batch = batches[step];
      step += 1;
      if (batch === undefined) return response({ role: 'assistant', content: 'Finished.' });
      return response({ tool_calls: batch.map(([id, name, args]) => call(id, name, args)) });
    },
    callHost,
    {
      allowedToolNames: ['read_project_context', 'generate_media', 'attach_generated_media'],
    },
  );
  return { outcome, requests };
}

/** Every tool message the model has seen by the final request, parsed. */
function toolResults(messages: readonly unknown[] | undefined): Record<string, unknown>[] {
  return (messages ?? [])
    .filter(
      (item): item is { readonly role: string; readonly content: string } =>
        item !== null &&
        typeof item === 'object' &&
        (item as { readonly role?: unknown }).role === 'tool',
    )
    .map((item) => JSON.parse(item.content) as Record<string, unknown>);
}

function generationHost(
  generate: (args: HostRpcJson) => HostRpcJson = (args) => {
    const kind = (args as { readonly kind?: unknown }).kind === 'video' ? 'video' : 'image';
    return { ok: true, jobId: `job-${kind}`, kind, status: 'completed' };
  },
) {
  return vi.fn(async (method: JoyAgentHostToolName, args: HostRpcJson) => {
    if (method === 'read_project_context') return { domain: 'overview', records: [] };
    if (method === 'generate_media') return generate(args);
    throw new Error(`unexpected host call ${method}`);
  });
}

// ---------------------------------------------------------------------------
// Loop: schema, budget and refusals
// ---------------------------------------------------------------------------

describe('generate_media in the bounded tool loop', () => {
  it('is absent from the default catalog and strict about its fields when allowed', () => {
    const defaultCatalog = createBrowserAgentToolCatalog(
      agentTools.createModelVisibleJoyCodeProposalParameters(),
    );
    expect(defaultCatalog.allowedToolNames).not.toContain('generate_media');
    expect(defaultCatalog.allowedToolNames).not.toContain('attach_generated_media');

    const catalog = createBrowserAgentToolCatalog(undefined, [
      'read_project_context',
      'generate_media',
      'attach_generated_media',
    ]);
    const generate = catalog.tools.find((tool) => tool.function.name === 'generate_media');
    expect(generate?.function.parameters).toMatchObject({
      additionalProperties: false,
      required: ['kind', 'prompt', 'aspect'],
      properties: {
        kind: { enum: ['image', 'video'] },
        aspect: { enum: ['1:1', '4:3', '3:4', '16:9', '9:16'] },
        seconds: { minimum: 1, maximum: 15 },
      },
    });
    expect(Object.keys((generate?.function.parameters.properties ?? {}) as object)).not.toContain(
      'provider',
    );
  });

  it('refuses pictures past the per-run cap of 4 without calling the host', async () => {
    const host = generationHost();
    const { requests } = await runScenario(
      [
        contextBatch,
        [
          ['p1', 'generate_media', picture],
          ['p2', 'generate_media', picture],
          ['p3', 'generate_media', picture],
          ['p4', 'generate_media', picture],
          ['p5', 'generate_media', picture],
        ],
      ],
      host,
    );

    expect(host.mock.calls.filter(([method]) => method === 'generate_media')).toHaveLength(4);
    const results = toolResults(requests.at(-1));
    expect(results.slice(1, 5).every((result) => result.ok === true)).toBe(true);
    // results[0] is the context read; results[5] is the fifth picture.
    expect(results[5]).toMatchObject({
      ok: false,
      code: 'JOY_AGENT_GENERATION_BUDGET_EXCEEDED',
      message: expect.stringContaining('4 image allowances'),
    });
  });

  it('allows one video per run, counted separately from pictures', async () => {
    const host = generationHost();
    const { requests } = await runScenario(
      [
        contextBatch,
        [
          ['v1', 'generate_media', video],
          ['v2', 'generate_media', video],
        ],
      ],
      host,
    );

    expect(host.mock.calls.filter(([method]) => method === 'generate_media')).toHaveLength(1);
    expect(toolResults(requests.at(-1))[2]).toMatchObject({
      ok: false,
      code: 'JOY_AGENT_GENERATION_BUDGET_EXCEEDED',
      message: expect.stringContaining('1 video allowance'),
    });
  });

  it('refuses malformed requests before any card is raised and does not charge them', async () => {
    const host = generationHost();
    const { requests } = await runScenario(
      [
        contextBatch,
        [
          ['bad-seconds', 'generate_media', { ...picture, seconds: 3 }],
          ['empty-prompt', 'generate_media', { ...picture, prompt: '   ' }],
          ['too-long-video', 'generate_media', { ...video, seconds: 16 }],
          ['bad-aspect', 'generate_media', { ...picture, aspect: '2:1' }],
          ['good', 'generate_media', picture],
        ],
      ],
      host,
    );

    expect(host.mock.calls.filter(([method]) => method === 'generate_media')).toHaveLength(1);
    const results = toolResults(requests.at(-1));
    expect(results.slice(1, 5).map((result) => result.code)).toEqual([
      'JOY_AGENT_INVALID_GENERATION_REQUEST',
      'JOY_AGENT_INVALID_GENERATION_REQUEST',
      'JOY_AGENT_INVALID_GENERATION_REQUEST',
      'JOY_AGENT_INVALID_GENERATION_REQUEST',
    ]);
    expect(results[5]).toMatchObject({ ok: true, jobId: 'job-image' });
  });

  it('passes a readable decline back verbatim and counts each declined card against the run', async () => {
    const declined = {
      ok: false,
      code: 'JOY_AGENT_GENERATION_DECLINED',
      message: 'The user declined the cost card. JOY made no provider request and created nothing.',
    };
    const host = generationHost(() => declined);
    const { outcome, requests } = await runScenario(
      [
        contextBatch,
        [
          ['p1', 'generate_media', picture],
          ['p2', 'generate_media', picture],
          ['p3', 'generate_media', picture],
          ['p4', 'generate_media', picture],
          ['p5', 'generate_media', picture],
        ],
      ],
      host,
    );

    expect(outcome).toEqual({ kind: 'answer', text: 'Finished.' });
    expect(toolResults(requests.at(-1))[1]).toEqual(declined);
    // Four declined cards used the allowance; the fifth request was refused without a card.
    expect(host.mock.calls.filter(([method]) => method === 'generate_media')).toHaveLength(4);
    expect(toolResults(requests.at(-1))[5]).toMatchObject({
      code: 'JOY_AGENT_GENERATION_BUDGET_EXCEEDED',
    });
  });
});

// ---------------------------------------------------------------------------
// Host bridge: approval order, job result and attach gating
// ---------------------------------------------------------------------------

function handlerContext(): HostRpcHandlerContext {
  return {
    run: { runId: 'run-1', epoch: 1 },
    requestId: 'request-1',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1_000,
  };
}

const prepared = () => ({
  summary: 'unused',
  baseRevision: 'revision-1',
  changeSetId: 'change-set-1',
  operationDigest: 'a'.repeat(64),
  bindingDigest: 'b'.repeat(64),
  operationCount: 1,
});

function bridgeMethods(generation: JoyAgentGenerationToolAdapter) {
  return createJoyAgentHostRpcMethodsForSnapshot(
    { projectId: 'project-1', revision: 'revision-1' },
    () => prepared(),
    undefined,
    undefined,
    undefined,
    undefined,
    generation,
  );
}

type Method = HostRpcMethod<HostRpcJson, HostRpcJson>;

function methodFor(
  generation: JoyAgentGenerationToolAdapter,
  name: 'generate_media' | 'attach_generated_media',
): Method {
  return bridgeMethods(generation)[name] as unknown as Method;
}

async function invoke(method: Method, args: HostRpcJson, context = handlerContext()) {
  return method.parseResult(await method.execute(method.parseArgs(args), context));
}

describe('generate_media host bridge', () => {
  it('does not start a provider job unless the cost card is allowed', async () => {
    const requestApproval = vi.fn(async () => false);
    const start = vi.fn(() => 'job-1');
    const awaitJob = vi.fn(async () => ({
      jobId: 'job-1',
      kind: 'image' as const,
      status: 'completed' as const,
    }));
    const attach = vi.fn(() => ({ assetId: 'generated-a', placed: false }));
    const method = methodFor({ requestApproval, start, awaitJob, attach }, 'generate_media');

    const result = await invoke(method, picture);

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image' }),
      expect.anything(),
    );
    expect(start).not.toHaveBeenCalled();
    expect(awaitJob).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      code: 'JOY_AGENT_GENERATION_DECLINED',
      message: expect.stringContaining('declined the cost card'),
    });
  });

  it('shows the card for every request, starts only after Allow, and returns the job result', async () => {
    const order: string[] = [];
    const requestApproval = vi.fn(async () => {
      order.push('approve');
      return true;
    });
    const start = vi.fn(() => {
      order.push('start');
      return 'job-1';
    });
    const awaitJob = vi.fn(async () => {
      order.push('await');
      return { jobId: 'job-1', kind: 'image' as const, status: 'completed' as const };
    });
    const method = methodFor(
      { requestApproval, start, awaitJob, attach: vi.fn(() => ({ assetId: 'a', placed: false })) },
      'generate_media',
    );

    const result = await invoke(method, picture);

    expect(order).toEqual(['approve', 'start', 'await']);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: picture.prompt }),
      expect.anything(),
    );
    expect(result).toEqual({ ok: true, jobId: 'job-1', kind: 'image', status: 'completed' });
  });

  it('reports a failed job as a readable refusal and never lets it be attached', async () => {
    const attach = vi.fn(() => ({ assetId: 'a', placed: true }));
    const methods = bridgeMethods({
      requestApproval: async () => true,
      start: () => 'job-1',
      awaitJob: async () => ({ jobId: 'job-1', kind: 'image', status: 'failed' }),
      attach,
    });

    const result = await invoke(methods.generate_media as unknown as Method, picture);
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      code: 'JOY_AGENT_GENERATION_FAILED',
    });

    expect(
      await invoke(methods.attach_generated_media as unknown as Method, {
        jobId: 'job-1',
        target: 'library',
      }),
    ).toMatchObject({ ok: false, code: 'JOY_AGENT_GENERATION_JOB_UNAVAILABLE' });
    expect(attach).not.toHaveBeenCalled();
  });

  it('turns a start failure into a readable refusal, not a crash', async () => {
    const method = methodFor(
      {
        requestApproval: async () => true,
        start: () => {
          throw new Error('provider unreachable');
        },
        awaitJob: vi.fn(),
        attach: vi.fn(),
      },
      'generate_media',
    );

    expect(await invoke(method, picture)).toEqual({
      ok: false,
      code: 'JOY_AGENT_GENERATION_FAILED',
      message: 'The generation job could not be completed. Nothing was attached.',
    });
  });

  it('attaches only a job this run completed, through the adapter', async () => {
    const attach = vi.fn(() => ({ assetId: 'generated-abc', placed: true }));
    const generation: JoyAgentGenerationToolAdapter = {
      requestApproval: async () => true,
      start: () => 'job-7',
      awaitJob: async () => ({ jobId: 'job-7', kind: 'image', status: 'completed' }),
      attach,
    };
    const methods = bridgeMethods(generation);
    const generate = methods.generate_media as unknown as Method;
    const attachMethod = methods.attach_generated_media as unknown as Method;

    // Not produced by this run yet: refused without touching the library.
    expect(await invoke(attachMethod, { jobId: 'job-7', target: 'library' })).toMatchObject({
      ok: false,
      code: 'JOY_AGENT_GENERATION_JOB_UNAVAILABLE',
    });
    expect(attach).not.toHaveBeenCalled();

    await invoke(generate, picture);
    expect(
      await invoke(attachMethod, { jobId: 'job-7', target: 'timeline', atSeconds: 2, track: 'V2' }),
    ).toEqual({ ok: true, assetId: 'generated-abc', placed: true });
    expect(attach).toHaveBeenCalledWith(
      { jobId: 'job-7', target: 'timeline', atSeconds: 2, track: 'V2' },
      expect.anything(),
    );

    // An id the run never saw is refused even after a completed job.
    expect(await invoke(attachMethod, { jobId: 'job-99', target: 'library' })).toMatchObject({
      ok: false,
      code: 'JOY_AGENT_GENERATION_JOB_UNAVAILABLE',
    });
  });

  it('rejects malformed arguments in the host parser before the adapter runs', () => {
    const requestApproval = vi.fn(async () => true);
    const method = methodFor(
      { requestApproval, start: vi.fn(), awaitJob: vi.fn(), attach: vi.fn() },
      'generate_media',
    );
    const attachMethod = methodFor(
      { requestApproval, start: vi.fn(), awaitJob: vi.fn(), attach: vi.fn() },
      'attach_generated_media',
    );

    expect(() => method.parseArgs({ ...picture, seconds: 3 })).toThrow();
    expect(() => method.parseArgs({ ...picture, prompt: 'x'.repeat(2_001) })).toThrow();
    expect(() => method.parseArgs({ ...picture, extra: true })).toThrow();
    expect(() =>
      attachMethod.parseArgs({ jobId: 'job-1', target: 'library', track: 'V1' }),
    ).toThrow();
    expect(() =>
      attachMethod.parseArgs({ jobId: 'job-1', target: 'timeline', atSeconds: -1 }),
    ).toThrow();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('does not turn a cancelled wait into a result', async () => {
    const controller = new AbortController();
    const method = methodFor(
      {
        requestApproval: async () => true,
        start: () => 'job-1',
        awaitJob: async () => {
          controller.abort();
          throw new Error('aborted');
        },
        attach: vi.fn(),
      },
      'generate_media',
    );

    await expect(
      method.execute(method.parseArgs(picture), { ...handlerContext(), signal: controller.signal }),
    ).rejects.toThrow();
  });
});
