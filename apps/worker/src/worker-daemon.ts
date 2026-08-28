import { setTimeout as sleep } from 'node:timers/promises';
import type { WorkerControlPlaneClient } from './control-plane-client.js';
import type { WorkerRuntime } from './runtime.js';
import { renderExportCompletionReceipt } from './export-job.js';

const DEFAULT_PRESENCE_INTERVAL_MS = 15_000;

type JobFailurePhase = 'runtime' | 'control-plane' | 'upload' | 'completion';

class WorkerJobPhaseError extends Error {
  constructor(
    readonly phase: JobFailurePhase,
    readonly originalError: unknown,
  ) {
    super(`Worker job failed during ${phase}`);
  }
}

export class WorkerDaemon {
  constructor(
    private readonly client: WorkerControlPlaneClient,
    private readonly runtime: WorkerRuntime,
  ) {}

  /** Polls from the local machine; the VPS never opens a connection to it. */
  async run(options: {
    readonly pollIntervalMs?: number;
    readonly presenceIntervalMs?: number;
    readonly stopped: () => boolean;
  }): Promise<void> {
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const presenceIntervalMs = options.presenceIntervalMs ?? DEFAULT_PRESENCE_INTERVAL_MS;
    const announcePresence = async (): Promise<void> => {
      await this.client.hello(
        this.runtime.hello(process.platform, process.arch).capabilities,
        this.runtime.localAssetIds(),
      );
    };
    await announcePresence();
    let lastPresenceAt = Date.now();
    while (!options.stopped()) {
      try {
        const job = await this.client.lease();
        if (job === undefined) {
          if (Date.now() - lastPresenceAt >= presenceIntervalMs) {
            await announcePresence();
            lastPresenceAt = Date.now();
          }
          if (!options.stopped()) await sleep(pollIntervalMs);
          continue;
        }
        let cancelRequested = false;
        let failurePhase: JobFailurePhase = 'runtime';
        let failureReported = false;
        const failOnce = async (error: string): Promise<void> => {
          if (failureReported) return;
          failureReported = true;
          try {
            await this.client.fail(job.id, error);
          } catch (failureError) {
            this.runtime.log.write(
              `job ${job.id} failure report failed: ${sanitizedDiagnostic(failureError)}`,
            );
          }
        };
        try {
          const result = await this.runtime.run(job, {
            cancelled: () => options.stopped() || cancelRequested,
            readRenderArtifact: async ({ jobId, outputRef }) => {
              try {
                return await this.client.downloadRenderArtifact(jobId, outputRef);
              } catch (error) {
                throw new WorkerJobPhaseError('control-plane', error);
              }
            },
            progress: async (progress) => {
              try {
                const heartbeat = await this.client.heartbeat(job.id, progress);
                cancelRequested ||= heartbeat.cancelRequested;
              } catch (error) {
                throw new WorkerJobPhaseError('control-plane', error);
              }
            },
          });
          if (result.state === 'completed') {
            if (result.result.kind === 'asset.thumbnail') {
              failurePhase = 'upload';
              await this.client.uploadDerivative(
                job.id,
                result.result,
                this.runtime.readDerivative(result.result),
              );
            }
            if (result.result.kind === 'render.export') {
              failurePhase = 'upload';
              await this.client.uploadRenderArtifact(
                job.id,
                result.result,
                this.runtime.readRenderArtifact(job.id, result.result),
              );
            }
            failurePhase = 'completion';
            const completionResult =
              result.result.kind === 'render.export'
                ? renderExportCompletionReceipt(result.result)
                : result.result;
            await this.client.complete(job.id, completionResult);
          } else await failOnce('canceled');
        } catch (error) {
          const phase = error instanceof WorkerJobPhaseError ? error.phase : failurePhase;
          const originalError = error instanceof WorkerJobPhaseError ? error.originalError : error;
          this.runtime.log.write(
            `job ${job.id} failed during ${phase}: ${sanitizedDiagnostic(originalError)}`,
          );
          await failOnce(actionableFailure(phase));
          if (!options.stopped()) await sleep(pollIntervalMs);
        }
      } catch (error) {
        this.runtime.log.write(`control-plane ${sanitizedDiagnostic(error)}`);
        if (!options.stopped()) await sleep(pollIntervalMs);
      }
    }
  }
}

function actionableFailure(phase: JobFailurePhase): string {
  switch (phase) {
    case 'runtime':
      return 'Worker execution failed; inspect local Worker logs and retry the job';
    case 'control-plane':
      return 'Worker control-plane communication failed; check API connectivity and retry the job';
    case 'upload':
      return 'Worker artifact upload failed; check storage connectivity and retry the job';
    case 'completion':
      return 'Worker completion reporting failed; reconcile the job state before retrying';
  }
}

function sanitizedDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return 'unexpected error';
  const normalized = [...error.message]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f ? character : ' ';
    })
    .join('')
    .trim();
  if (normalized.length === 0) return 'unexpected error';
  return normalized
    .replace(/\b(bearer|basic)\s+\S+/giu, '$1 [redacted]')
    .replace(/\b(token|password|secret|api[-_ ]?key)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, '[redacted-url]')
    .replace(/[a-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/giu, '[redacted-path]')
    .slice(0, 240);
}
