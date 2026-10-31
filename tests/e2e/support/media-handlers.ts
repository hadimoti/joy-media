import {
  startDesktopJobHarness,
  type DesktopJobHarness,
  type DesktopJobHarnessOptions,
} from './desktop-job-harness.js';
import type { ChannelHandler } from './joy-desktop-bridge.js';

export type { DesktopJobHarness, DesktopJobHarnessOptions };

/**
 * A started desktop host: the channel handler the bridge takes, and the teardown that closes
 * the job API, kills the Worker and removes the temporary user-data directory.
 */
export interface MediaHandlers {
  readonly handler: ChannelHandler;
  stop(): Promise<void>;
}

/**
 * Thin adapter over the real desktop job harness.
 *
 * There is no in-memory media state any more: the channels are answered by the desktop's own
 * media channel, job orchestrator, SQLite stores and Worker process. See
 * `tests/e2e/support/desktop-job-harness.ts`.
 */
export async function createMediaHandlers(
  options: DesktopJobHarnessOptions = {},
): Promise<MediaHandlers> {
  const harness = await startDesktopJobHarness(options);
  return {
    handler: harness.handler,
    stop: () => harness.stop(),
  };
}
