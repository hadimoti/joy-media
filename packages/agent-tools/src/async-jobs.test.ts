import { describe, expect, it, vi } from 'vitest';
import type {
  AgentJobClient,
  AgentJobRequest,
  AgentJobResult,
  AgentJobSnapshot,
} from '@joy-media/job-protocol';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import {
  ApprovalEngine,
  buildEditorContext,
  createPermissiveApprovalPolicy,
  createPlan,
  runPlanWithAsyncJobs,
} from './index.js';

const generation = {
  providerId: 'local-comfy',
  modelId: 'background-removal',
  modelVersion: 'v1',
  prompt: 'Remove the background',
  seed: 42,
  inputAssetHashes: ['a'.repeat(64)],
  parameters: { matte: 'transparent' },
  cost: { amount: '0.00', currency: 'USD' },
} as const;

const result: AgentJobResult = {
  generatedAssetId: 'generated-image-1',
  provenance: {
    ...generation,
    generatedAssetId: 'generated-image-1',
    createdAt: '2026-07-26T12:00:00.000Z',
  },
};

function plan() {
  return createPlan(
    'Remove the background',
    [
      {
        id: 'generate',
        description: 'Run background removal',
        mode: 'job',
        tool: 'image.comfy',
        arguments: { assetId: 'source-image' },
        dependsOn: [],
        expectedChange: 'Create a transparent image asset',
        preconditions: [],
        estimatedCost: { workerTimeMs: 500, localOnly: true },
        requiresConfirmation: false,
      },
      {
        id: 'commit',
        description: 'Register the generated asset',
        mode: 'command',
        tool: 'asset.registerGenerated',
        arguments: {},
        dependsOn: ['generate'],
        expectedChange: 'Add the generated asset to the project',
        preconditions: [],
        requiresConfirmation: false,
      },
    ],
    { planId: 'plan-generation' },
  );
}

class FakeJobClient implements AgentJobClient {
  readonly requests: AgentJobRequest[] = [];
  readonly updates: AgentJobSnapshot[] = [];
  retries = 0;

  constructor(
    private terminal: AgentJobSnapshot = {
      jobId: 'agent-plan-generation-generate',
      state: 'succeeded',
      progress: 100,
      attempt: 1,
      result,
    },
  ) {}

  async start(request: AgentJobRequest): Promise<AgentJobSnapshot> {
    this.requests.push(request);
    return { jobId: request.jobId, state: 'queued', progress: 0, attempt: 0 };
  }

  async waitForTerminal(
    _jobId: string,
    onProgress?: (snapshot: AgentJobSnapshot) => void,
  ): Promise<AgentJobSnapshot> {
    const running = {
      jobId: this.terminal.jobId,
      state: 'running' as const,
      progress: 50,
      attempt: Math.max(1, this.retries + 1),
    };
    this.updates.push(running);
    onProgress?.(running);
    return this.terminal;
  }

  async cancel(jobId: string): Promise<AgentJobSnapshot> {
    return { jobId, state: 'canceled', progress: 0, attempt: 1 };
  }

  async retry(jobId: string): Promise<AgentJobSnapshot> {
    this.retries += 1;
    this.terminal = {
      jobId,
      state: 'succeeded',
      progress: 100,
      attempt: this.retries + 1,
      result,
    };
    return { jobId, state: 'queued', progress: 0, attempt: this.retries };
  }
}

function options(client: AgentJobClient, commit = vi.fn(() => ({ success: true }))) {
  return {
    projectId: 'project-1',
    baseRevision: 'revision-1',
    currentRevision: () => 'revision-1',
    context: buildEditorContext(buildReferenceSpikeProject()),
    approvalEngine: new ApprovalEngine(createPermissiveApprovalPolicy()),
    jobClient: client,
    requestForStep: () => ({
      jobType: 'image.comfy',
      arguments: { assetId: 'source-image' },
      inputAssetId: 'source-image',
      generation,
    }),
    commit,
    onJobProgress: vi.fn(),
  };
}

describe('asynchronous agent plan jobs', () => {
  it('waits for a real result, reports progress, then commits its asset reference once', async () => {
    const client = new FakeJobClient();
    const commit = vi.fn(
      (_plan: ReturnType<typeof plan>, _results: ReadonlyMap<string, AgentJobResult>) => ({
        success: true,
      }),
    );
    const runOptions = options(client, commit);

    const run = await runPlanWithAsyncJobs(plan(), runOptions);

    expect(run).toMatchObject({ committed: true, replayed: false, errors: [] });
    expect(client.requests[0]).toMatchObject({
      protocolVersion: 1,
      projectId: 'project-1',
      planId: 'plan-generation',
      stepId: 'generate',
      baseRevision: 'revision-1',
      idempotencyKey: 'agent-async-plan:plan-generation:generate',
    });
    expect(runOptions.onJobProgress).toHaveBeenCalledWith(
      'generate',
      expect.objectContaining({ state: 'running', progress: 50 }),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[1].get('generate')).toEqual(result);
  });

  it('does not commit a successful generation result over a newer project revision', async () => {
    const commit = vi.fn(() => ({ success: true }));
    const runOptions = {
      ...options(new FakeJobClient(), commit),
      currentRevision: () => 'revision-2',
    };

    const run = await runPlanWithAsyncJobs(plan(), runOptions);

    expect(run.committed).toBe(false);
    expect(run.errors.join(' ')).toContain('revision');
    expect(commit).not.toHaveBeenCalled();
  });

  it('leaves the project untouched when the job fails or is canceled', async () => {
    for (const state of ['failed', 'canceled'] as const) {
      const commit = vi.fn(() => ({ success: true }));
      const client = new FakeJobClient({
        jobId: 'agent-plan-generation-generate',
        state,
        progress: 40,
        attempt: 1,
        ...(state === 'failed' ? { failureCode: 'GENERATION_FAILED' } : {}),
      });

      const run = await runPlanWithAsyncJobs(plan(), options(client, commit));

      expect(run.committed).toBe(false);
      expect(commit).not.toHaveBeenCalled();
    }
  });

  it('retries through the same job identity and idempotency key before committing', async () => {
    const client = new FakeJobClient({
      jobId: 'agent-plan-generation-generate',
      state: 'failed',
      progress: 30,
      attempt: 1,
      failureCode: 'TEMPORARY_GPU_FAILURE',
    });
    const commit = vi.fn(() => ({ success: true }));

    const run = await runPlanWithAsyncJobs(plan(), {
      ...options(client, commit),
      maxJobRetries: 1,
    });

    expect(run.committed).toBe(true);
    expect(client.retries).toBe(1);
    expect(run.jobs[0]?.attempts).toBe(2);
    expect(client.requests).toHaveLength(1);
  });

  it('rejects a result whose provenance differs from the approved request', async () => {
    const client = new FakeJobClient({
      jobId: 'agent-plan-generation-generate',
      state: 'succeeded',
      progress: 100,
      attempt: 1,
      result: {
        ...result,
        provenance: { ...result.provenance, prompt: 'A different prompt' },
      },
    });
    const commit = vi.fn(() => ({ success: true }));

    const run = await runPlanWithAsyncJobs(plan(), options(client, commit));

    expect(run.committed).toBe(false);
    expect(run.errors.join(' ')).toContain('provenance');
    expect(commit).not.toHaveBeenCalled();
  });
});
