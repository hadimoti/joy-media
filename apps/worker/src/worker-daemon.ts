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
    while (!options.stopped()) {
      try {
        const job = await this.client.lease();
        if (job === undefined) {
          await sleep(pollIntervalMs);
          continue;
        }
        let cancelRequested = false;
        const result = await this.runtime.run(job, {
          cancelled: () => options.stopped() || cancelRequested,
          progress: async (progress) => {
            const heartbeat = await this.client.heartbeat(job.id, progress);
            cancelRequested ||= heartbeat.cancelRequested;
          },
        });
        if (result.state === 'completed') {
          await this.client.uploadDerivative(
            job.id,
            result.result,
            this.runtime.readDerivative(result.result),
          );
          await this.client.complete(job.id, result.result);
        } else await this.client.fail(job.id, 'canceled');
      } catch (error) {
        this.runtime.log.write(`control-plane ${error instanceof Error ? error.message : 'error'}`);
        await sleep(pollIntervalMs);
      }
    }
  }
}
