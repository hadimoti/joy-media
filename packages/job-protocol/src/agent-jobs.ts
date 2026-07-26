import type { GenerationProvenanceV1, JsonValue } from '@joy-media/project-schema';

export type AgentJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/**
 * Durable, transport-neutral job envelope emitted from an AgentEditPlan job
 * step. The control plane may route it to a local Worker or a remote provider.
 */
export interface AgentJobRequest {
  readonly protocolVersion: 1;
  readonly jobId: string;
  readonly projectId: string;
  readonly planId: string;
  readonly stepId: string;
  readonly jobType: string;
  readonly arguments: JsonValue;
  readonly baseRevision: string;
  readonly idempotencyKey: string;
  readonly generation: Omit<GenerationProvenanceV1, 'generatedAssetId' | 'createdAt'>;
  /** Opaque input ID for Worker jobs; never a local path or URL. */
  readonly inputAssetId?: string;
}

export interface AgentJobResult {
  readonly generatedAssetId: string;
  readonly provenance: GenerationProvenanceV1;
}

export interface AgentJobSnapshot {
  readonly jobId: string;
  readonly state: AgentJobState;
  readonly progress: number;
  readonly attempt: number;
  readonly result?: AgentJobResult;
  readonly failureCode?: string;
}

/**
 * Existing control-plane/Worker lifecycle as consumed by agent plans. Provider
 * adapters can implement the same contract without entering command staging.
 */
export interface AgentJobClient {
  start(request: AgentJobRequest): Promise<AgentJobSnapshot>;
  waitForTerminal(
    jobId: string,
    onProgress?: (snapshot: AgentJobSnapshot) => void,
  ): Promise<AgentJobSnapshot>;
  cancel(jobId: string): Promise<AgentJobSnapshot>;
  retry(jobId: string): Promise<AgentJobSnapshot>;
}
