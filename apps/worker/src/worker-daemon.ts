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
    while (!options.stopped()) {
      try {
        const job = await this.client.lease();
        if (job === undefined) {
          await sleep(pollIntervalMs);
          continue;
        }
        const result = this.runtime.run(job.id, () => options.stopped());
        if (result.state === 'completed') await this.client.complete(job.id);
      } catch (error) {
        this.runtime.log.write(`control-plane ${error instanceof Error ? error.message : 'error'}`);
        await sleep(pollIntervalMs);
      }
    }
  }
}
