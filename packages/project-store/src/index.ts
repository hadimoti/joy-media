/**
 * The project-folder store: the gate that settles a project folder, and the worker that runs it off the main thread. The
 * desktop app imports only what this file exports. The store's files, its database handles and its claim functions stay
 * inside this package.
 */
export { runProjectFolderWorker } from './worker-runner.js';
export type {
  ProjectFolderRequestOp,
  ProjectFolderRequestPort,
  ProjectFolderWorkerReply,
} from './project-folder-protocol.js';
