import { parentPort, workerData } from 'node:worker_threads';
import { runProjectFolderWorker } from '@joy-media/project-store';

/**
 * The project-folder worker thread. The rules run in the project-store package (runProjectFolderWorker), which settles
 * claims and listings off the main thread. This file only starts them with the port and the data the main process gave
 * the worker (project-folder-client.ts).
 */
runProjectFolderWorker(parentPort, workerData);
