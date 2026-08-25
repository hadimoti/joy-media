import type { AgentJobClient, AgentJobRequest, AgentJobSnapshot } from '@joy-media/job-protocol';
import type { BrowserControlPlaneClient, BrowserJob } from './control-plane-client.js';

type WorkerGenerationType =
  | 'image.comfy'
  | 'audio.ml-denoise'
  | 'text.lm-studio'
  | 'text.openrouter'
  | 'video.runway'
  | 'edit.higgsfield';

/**
 * Adapts the existing browser -> control plane -> outbound Worker lifecycle to
 * agent plan jobs. Approved generation metadata stays client-side until a
 * verified Worker result supplies the opaque generated asset reference.
 */
export class AgentWorkerJobClient implements AgentJobClient {
  readonly #requests = new Map<string, AgentJobRequest>();

  constructor(
    private readonly controlPlane: BrowserControlPlaneClient,
    private readonly projectId: string,
    private readonly pollIntervalMs = 500,
  ) {}

  async start(request: AgentJobRequest): Promise<AgentJobSnapshot> {
    if (request.projectId !== this.projectId) throw new Error('Agent job project mismatch');
    if (!isWorkerGenerationType(request.jobType)) {
      throw new Error(`Unsupported Worker generation job: ${request.jobType}`);
    }
    if (request.inputAssetId === undefined) {
      throw new Error('Worker generation requires an opaque input asset ID');
    }
    this.#requests.set(request.jobId, request);
    let job: BrowserJob;
    try {
      job = await this.controlPlane.enqueueWorkerGeneration(
        this.projectId,
        request.jobId,
        request.jobType,
        request.inputAssetId,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('JOB_EXISTS')) throw error;
      const existing = (await this.controlPlane.jobs(this.projectId)).find(
        (candidate) => candidate.id === request.jobId,
      );
      if (existing === undefined) throw error;
      job = existing;
    }
    return this.snapshot(job);
  }

  async waitForTerminal(
    jobId: string,
    onProgress?: (snapshot: AgentJobSnapshot) => void,
  ): Promise<AgentJobSnapshot> {
    for (;;) {
      const job = (await this.controlPlane.jobs(this.projectId)).find((item) => item.id === jobId);
      if (job === undefined) throw new Error(`Agent job not found: ${jobId}`);
      const snapshot = this.snapshot(job);
      onProgress?.(snapshot);
      if (snapshot.state !== 'queued' && snapshot.state !== 'running') return snapshot;
      await delay(this.pollIntervalMs);
    }
  }

  async cancel(jobId: string): Promise<AgentJobSnapshot> {
    return this.snapshot(await this.controlPlane.cancel(this.projectId, jobId));
  }

  async retry(jobId: string): Promise<AgentJobSnapshot> {
    return this.snapshot(await this.controlPlane.retry(this.projectId, jobId));
  }

  private snapshot(job: BrowserJob): AgentJobSnapshot {
    const request = this.#requests.get(job.id);
    const state =
      job.state === 'leased' ? 'running' : job.state === 'completed' ? 'succeeded' : job.state;
    if (state === 'succeeded' && (request === undefined || job.derivative === undefined)) {
      return {
        jobId: job.id,
        state: 'failed',
        progress: job.progress,
        attempt: 1,
        failureCode: 'JOB_RESULT_MISSING',
      };
    }
    return {
      jobId: job.id,
      state,
      progress: job.progress,
      attempt: state === 'queued' ? 0 : 1,
      ...(state === 'failed' ? { failureCode: job.error ?? 'WORKER_JOB_FAILED' } : {}),
      ...(state === 'succeeded' && request !== undefined && job.derivative !== undefined
        ? {
            result: {
              generatedAssetId: job.derivative.resultRef,
              provenance: {
                ...request.generation,
                generatedAssetId: job.derivative.resultRef,
                createdAt: new Date(job.derivative.verifiedAt).toISOString(),
              },
            },
          }
        : {}),
    };
  }
}

function isWorkerGenerationType(value: string): value is WorkerGenerationType {
  return (
    value === 'image.comfy' ||
    value === 'audio.ml-denoise' ||
    value === 'text.lm-studio' ||
    value === 'text.openrouter' ||
    value === 'video.runway' ||
    value === 'edit.higgsfield'
  );
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
