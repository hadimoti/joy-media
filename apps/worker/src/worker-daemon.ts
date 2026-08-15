import { setTimeout as sleep } from 'node:timers/promises';
import type { WorkerControlPlaneClient } from './control-plane-client.js';
import type { WorkerRuntime } from './runtime.js';

export class WorkerDaemon {
  constructor(
    private readonly client: WorkerControlPlaneClient,
    private readonly runtime: WorkerRuntime,
  ) {}

  /** Polls from the local machine; the VPS never opens a connection to it. */
  async run(options: {
    readonly pollIntervalMs?: number;
    readonly stopped: () => boolean;
  }): Promise<void> {
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    await this.client.hello(
      this.runtime.hello(process.platform, process.arch).capabilities,
      this.runtime.localAssetIds(),
    );
    let lastHelloAt = Date.now();
    let leasedJobId: string | undefined;
    while (!options.stopped()) {
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
        let cancelRequested = false;
        let currentProgress = 0;
        let heartbeatInFlight = false;
        const sendHeartbeat = async (): Promise<void> => {
          if (heartbeatInFlight) return;
          heartbeatInFlight = true;
          try {
            const heartbeat = await this.client.heartbeat(job.id, currentProgress);
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
            );
          }
          await this.client.complete(job.id, result.result);
        } else await this.client.fail(job.id, 'canceled');
        leasedJobId = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown Worker failure';
        this.runtime.log.write(`Worker job failed: ${message.slice(0, 240)}`);
        if (leasedJobId !== undefined) {
          try {
            await this.client.fail(leasedJobId, message.slice(0, 240));
          } catch (failError) {
            this.runtime.log.write(
              `Unable to mark ${leasedJobId} failed: ${
                failError instanceof Error ? failError.message : 'unknown error'
              }`,
            );
          }
          leasedJobId = undefined;
        }
        await sleep(pollIntervalMs);
      }
    }
  }
}
