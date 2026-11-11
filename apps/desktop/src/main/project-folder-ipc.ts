import type { IpcResult } from './ipc-handlers.js';
import type { ProjectFolderRequestOp, ProjectFolderRequestPort } from '@joy-media/project-store';

/**
 * The `desktop.project-folder.*` channels. Each payload is checked here, before anything reaches the worker, and the
 * worker's plain reply is returned as data. The handlers live apart from ipc-handlers.ts, so they can be tested
 * without the provider modules that file imports.
 */

export const PROJECT_FOLDER_CHANNELS = [
  'desktop.project-folder.list',
  'desktop.project-folder.create',
  'desktop.project-folder.open',
  'desktop.project-folder.answer',
  'desktop.project-folder.restore',
] as const;

export type ProjectFolderChannel = (typeof PROJECT_FOLDER_CHANNELS)[number];

export type ProjectFolderHandler = (payload: unknown) => Promise<IpcResult> | IpcResult;

const KEY_LIMIT = 80;
const TITLE_LIMIT = 200;

export function createProjectFolderHandlers(
  port: ProjectFolderRequestPort | undefined,
): Record<ProjectFolderChannel, ProjectFolderHandler> {
  return {
    'desktop.project-folder.list': () => callWorker(port, 'list', {}),
    'desktop.project-folder.create': (payload) => {
      const title = titleField(payload);
      return title === undefined ? invalidRequest() : callWorker(port, 'create', { title });
    },
    'desktop.project-folder.open': (payload) => {
      const key = keyField(payload);
      return key === undefined ? invalidRequest() : callWorker(port, 'open', { key });
    },
    'desktop.project-folder.answer': (payload) => {
      const key = keyField(payload);
      const answer = answerField(payload);
      return key === undefined || answer === undefined
        ? invalidRequest()
        : callWorker(port, 'answer', { key, answer });
    },
    'desktop.project-folder.restore': (payload) => {
      const key = keyField(payload);
      const title = titleField(payload);
      return key === undefined || title === undefined
        ? invalidRequest()
        : callWorker(port, 'restore', { key, title });
    },
  };
}

async function callWorker(
  port: ProjectFolderRequestPort | undefined,
  op: ProjectFolderRequestOp,
  payload: unknown,
): Promise<IpcResult> {
  if (port === undefined) {
    return { ok: false, error: 'Project folders are not available in this build' };
  }
  return { ok: true, data: await port.request(op, payload) };
}

function invalidRequest(): IpcResult {
  return { ok: false, error: 'Invalid project folder request' };
}

function field(payload: unknown, name: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function keyField(payload: unknown): string | undefined {
  const key = field(payload, 'key');
  return key !== undefined && key.length > 0 && key.length <= KEY_LIMIT ? key : undefined;
}

function titleField(payload: unknown): string | undefined {
  const title = field(payload, 'title')?.trim();
  return title !== undefined && title.length > 0 && title.length <= TITLE_LIMIT ? title : undefined;
}

function answerField(payload: unknown): 'original' | 'copy' | undefined {
  const answer = field(payload, 'answer');
  return answer === 'original' || answer === 'copy' ? answer : undefined;
}
