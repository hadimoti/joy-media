import type { MessagePort } from 'node:worker_threads';
import { openProjectClaimRegistry } from './project-claim-registry.js';
import {
  createProjectFolderService,
  handleProjectFolderMessage,
} from './project-folder-service.js';

/**
 * The worker thread behind the project-folder rules (project-folder-service.ts). The desktop app starts the worker with
 * the claim registry's file and the default folder (its project-folder-client.ts), and its worker file calls this with
 * the port and that data. Claims and listings run off the main thread. Requests run one at a time, in the order they
 * arrived, and each reply is posted back as it is ready.
 */

interface ProjectFolderWorkerData {
  readonly registryPath: string;
  readonly directory: string;
}

export function runProjectFolderWorker(port: MessagePort | null, workerData: unknown): void {
  if (port === null) throw new Error('The project folder worker must run as a worker thread');
  // A constant, so the port stays non-null inside the closures below.
  const messages: MessagePort = port;

  const data = workerData as Partial<ProjectFolderWorkerData> | null;
  if (typeof data?.registryPath !== 'string' || typeof data.directory !== 'string') {
    throw new Error('The project folder worker was started without its registry and folder');
  }

  const service = createProjectFolderService({
    registry: openProjectClaimRegistry(data.registryPath),
    directory: data.directory,
  });

  let queue: Promise<void> = Promise.resolve();

  messages.on('message', (message: unknown) => {
    queue = queue
      .then(async () => {
        messages.postMessage(await handleProjectFolderMessage(service, message));
        if (isShutdown(message)) messages.close();
      })
      .catch((error: unknown) => {
        console.error('[joy-desktop] project folder worker stopped a request', error);
        replyFailed(message);
        // A shutdown whose reply could not be sent still stops the worker, so the client does not wait out its timeout.
        if (isShutdown(message)) messages.close();
      });
  });

  /**
   * Answers a request whose reply could not be sent or built, so the caller gets a failure now and not a timeout. The
   * claim has run by then, so the editor says the change may be partly saved (see its transport words).
   */
  function replyFailed(message: unknown): void {
    const id =
      typeof message === 'object' && message !== null
        ? (message as { readonly id?: unknown }).id
        : undefined;
    if (typeof id !== 'number') return;
    try {
      messages.postMessage({ id, ok: false, error: 'The project folder check failed.' });
    } catch {
      // The port is closed, so there is no one left to tell.
    }
  }
}

function isShutdown(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { readonly op?: unknown }).op === 'shutdown'
  );
}
