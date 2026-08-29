import { setTimeout as sleep } from 'node:timers/promises';
import {
  WorkerSessionExpiredError,
  type WorkerControlPlaneClient,
} from './control-plane-client.js';
import type { WorkerRuntime } from './runtime.js';
import type { GpuPreviewHost } from './gpu-preview-host.js';

export class WorkerDaemon {
  constructor(
    private readonly client: WorkerControlPlaneClient,
    private readonly runtime: WorkerRuntime,
    private readonly gpuPreviewHost?: GpuPreviewHost,
  ) {}

  /** Polls from the local machine; the VPS never opens a connection to it. */
  async run(options: {
    readonly pollIntervalMs?: number;
    readonly stopped: () => boolean;
  }): Promise<void> {
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    let gpuPreviewError: WorkerSessionExpiredError | undefined;
    if (this.gpuPreviewHost !== undefined)
      void this.runGpuPreviewLoop(options.stopped).catch((error: unknown) => {
        if (error instanceof WorkerSessionExpiredError) {
          gpuPreviewError = error;
          return;
        }
        this.runtime.log.write(
          `GPU preview loop stopped: ${error instanceof Error ? error.message.slice(0, 180) : 'unknown error'}`,
        );
      });
    await this.client.hello(
      this.runtime.hello(process.platform, process.arch).capabilities,
      this.runtime.localAssetIds(),
    );
    if (gpuPreviewError !== undefined) throw gpuPreviewError;
    let lastHelloAt = Date.now();
    let leasedJobId: string | undefined;
    let leasedJobToken: string | undefined;
    while (!options.stopped()) {
      if (gpuPreviewError !== undefined) throw gpuPreviewError;
      try {
        if (Date.now() - lastHelloAt >= 15_000) {
          await this.client.hello(
            this.runtime.hello(process.platform, process.arch).capabilities,
            this.runtime.localAssetIds(),
          );
          lastHelloAt = Date.now();
        }
        const job = await this.client.lease();
        if (job === undefined) {
          await sleep(pollIntervalMs);
          continue;
        }
        leasedJobId = job.id;
        leasedJobToken = job.leaseToken;
        let cancelRequested = false;
        let currentProgress = 0;
        let heartbeatInFlight = false;
        const sendHeartbeat = async (): Promise<void> => {
          if (heartbeatInFlight) return;
          heartbeatInFlight = true;
          try {
            const heartbeat = await this.client.heartbeat(job.id, currentProgress, job.leaseToken);
            cancelRequested ||= heartbeat.cancelRequested;
          } finally {
            heartbeatInFlight = false;
          }
        };
        const heartbeatTimer = setInterval(() => {
          void sendHeartbeat().catch((error: unknown) => {
            this.runtime.log.write(
              `heartbeat failed: ${error instanceof Error ? error.message.slice(0, 180) : 'unknown error'}`,
            );
          });
        }, 10_000);
        let result: Awaited<ReturnType<WorkerRuntime['run']>>;
        try {
          result = await this.runtime.run(job, {
            cancelled: () => options.stopped() || cancelRequested,
            progress: async (progress) => {
              currentProgress = progress;
              await sendHeartbeat();
            },
          });
        } finally {
          clearInterval(heartbeatTimer);
        }
        if (result.state === 'completed') {
          // Upload verified bytes for browser-consumable derivatives. Fixture and
          // provider receipts remain Worker-local until their own contracts land.
          if (
            result.result.kind === 'asset.thumbnail' ||
            result.result.kind === 'audio.ml-denoise' ||
            result.result.kind === 'mask.image' ||
            result.result.kind === 'mask.video' ||
            result.result.kind === 'upscale.image' ||
            result.result.kind === 'upscale.video'
          ) {
            await this.client.uploadDerivative(
              job.id,
              result.result,
              this.runtime.readDerivative(result.result),
              job.leaseToken,
            );
          }
          await this.client.complete(job.id, result.result, job.leaseToken);
        } else await this.client.fail(job.id, 'canceled', job.leaseToken);
        leasedJobId = undefined;
        leasedJobToken = undefined;
      } catch (error) {
        // A revoked/expired session cannot recover through the current loop:
        // the session store has already been cleared by the client, so keep
        // polling would only produce an endless "not paired" loop. Exit and
        // let the service supervisor restart through the pairing flow.
        if (error instanceof WorkerSessionExpiredError) throw error;
        const message = error instanceof Error ? error.message : 'unknown Worker failure';
        this.runtime.log.write(`Worker job failed: ${message.slice(0, 240)}`);
        if (leasedJobId !== undefined) {
          try {
            await this.client.fail(leasedJobId, message.slice(0, 240), leasedJobToken);
          } catch (failError) {
            this.runtime.log.write(
              `Unable to mark ${leasedJobId} failed: ${
                failError instanceof Error ? failError.message : 'unknown error'
              }`,
            );
          }
          leasedJobId = undefined;
          leasedJobToken = undefined;
        }
        await sleep(pollIntervalMs);
      }
    }
  }

  private async runGpuPreviewLoop(stopped: () => boolean): Promise<void> {
    const host = this.gpuPreviewHost;
    if (host === undefined) return;
    while (!stopped()) {
      try {
        const request = await this.client.nextGpuPreview();
        if (request === undefined) {
          await sleep(40);
          continue;
        }
        const startedAt = Date.now();
        const response = await host.render(request);
        await this.client.completeGpuPreview(response);
        this.runtime.log.write(
          `GPU preview ${request.requestId} rendered ${response.width}x${response.height} in ${Date.now() - startedAt}ms`,
        );
      } catch (error) {
        if (error instanceof WorkerSessionExpiredError) throw error;
        this.runtime.log.write(
          `GPU preview failed: ${error instanceof Error ? error.message.slice(0, 180) : 'unknown error'}`,
        );
        await sleep(500);
      }
    }
  }
}
