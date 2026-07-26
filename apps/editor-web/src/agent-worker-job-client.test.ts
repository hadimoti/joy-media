import { describe, expect, it, vi } from 'vitest';
import type { AgentJobRequest } from '@joy-media/job-protocol';
import type { BrowserControlPlaneClient, BrowserJob } from './control-plane-client.js';
import { AgentWorkerJobClient } from './agent-worker-job-client.js';

const request: AgentJobRequest = {
  protocolVersion: 1,
  jobId: 'agent-plan-step',
  projectId: 'project-1',
  planId: 'plan',
  stepId: 'step',
  jobType: 'image.comfy',
  arguments: { assetId: 'source-image' },
  inputAssetId: 'source-image',
  baseRevision: 'revision-1',
  idempotencyKey: 'plan:step',
  generation: {
    providerId: 'local-comfy',
    modelId: 'background-removal',
    modelVersion: 'v1',
    prompt: 'Remove background',
    inputAssetHashes: ['a'.repeat(64)],
    parameters: { matte: 'transparent' },
    cost: { amount: '0.00', currency: 'USD' },
  },
};

function job(state: BrowserJob['state'], progress: number): BrowserJob {
  return {
    id: request.jobId,
    projectId: request.projectId,
    type: request.jobType,
    state,
    progress,
    cancelRequested: false,
    ...(state === 'completed'
      ? {
          derivative: {
            jobId: request.jobId,
            kind: request.jobType,
            sha256: 'b'.repeat(64),
            bytes: 100,
            workerRef: 'worker-1',
            resultRef: 'generated-image-1',
            verifiedAt: Date.parse('2026-07-26T12:00:00.000Z'),
          },
        }
      : {}),
  };
}

describe('AgentWorkerJobClient', () => {
  it('maps the existing Worker queue/progress/result lifecycle into an agent job', async () => {
    const states = [job('leased', 50), job('completed', 100)];
    const controlPlane = {
      enqueueWorkerGeneration: vi.fn(async () => job('queued', 0)),
      jobs: vi.fn(async () => [states.shift()!]),
      cancel: vi.fn(),
      retry: vi.fn(),
    } as unknown as BrowserControlPlaneClient;
    const client = new AgentWorkerJobClient(controlPlane, 'project-1', 0);
    const progress: number[] = [];

    expect(await client.start(request)).toMatchObject({ state: 'queued', progress: 0 });
    const completed = await client.waitForTerminal(request.jobId, (snapshot) => {
      progress.push(snapshot.progress);
    });

    expect(progress).toEqual([50, 100]);
    expect(completed).toMatchObject({
      state: 'succeeded',
      result: {
        generatedAssetId: 'generated-image-1',
        provenance: {
          providerId: 'local-comfy',
          modelId: 'background-removal',
          modelVersion: 'v1',
          prompt: 'Remove background',
          generatedAssetId: 'generated-image-1',
          createdAt: '2026-07-26T12:00:00.000Z',
        },
      },
    });
    expect(controlPlane.enqueueWorkerGeneration).toHaveBeenCalledWith(
      'project-1',
      request.jobId,
      'image.comfy',
      'source-image',
    );
  });

  it('never reports completed when the Worker omitted a verified result receipt', async () => {
    const controlPlane = {
      enqueueWorkerGeneration: vi.fn(async () => job('queued', 0)),
      jobs: vi.fn(async () => [{ ...job('completed', 100), derivative: undefined }]),
      cancel: vi.fn(),
      retry: vi.fn(),
    } as unknown as BrowserControlPlaneClient;
    const client = new AgentWorkerJobClient(controlPlane, 'project-1', 0);

    await client.start(request);
    await expect(client.waitForTerminal(request.jobId)).resolves.toMatchObject({
      state: 'failed',
      failureCode: 'JOB_RESULT_MISSING',
    });
  });

  it('reattaches to the stable existing job instead of enqueueing duplicate work', async () => {
    const controlPlane = {
      enqueueWorkerGeneration: vi.fn(async () => {
        throw new Error('JOB_EXISTS: duplicate');
      }),
      jobs: vi.fn(async () => [job('leased', 25)]),
      cancel: vi.fn(),
      retry: vi.fn(),
    } as unknown as BrowserControlPlaneClient;
    const client = new AgentWorkerJobClient(controlPlane, 'project-1', 0);

    await expect(client.start(request)).resolves.toMatchObject({
      jobId: request.jobId,
      state: 'running',
      progress: 25,
    });
    expect(controlPlane.jobs).toHaveBeenCalledWith('project-1');
  });
});
