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
  'desktop.project-folder.load',
  'desktop.project-folder.save',
  'desktop.project-folder.media',
  'desktop.project-folder.close',
] as const;

export type ProjectFolderChannel = (typeof PROJECT_FOLDER_CHANNELS)[number];

export type ProjectFolderHandler = (payload: unknown) => Promise<IpcResult> | IpcResult;

const KEY_LIMIT = 80;
const TITLE_LIMIT = 200;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const REVISION_LIMIT = 256;
const DISPLAY_NAME_LIMIT = 255;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** The most media files one save or one media check may name. */
const MEDIA_LIMIT = 10_000;
/** The largest saved document, as JSON. The same limit as `desktop.media.project.document.put`. */
const DOCUMENT_JSON_LIMIT = 32 * 1024 * 1024;

export interface ProjectFolderHandlerOptions {
  /**
   * Where the desktop keeps an original it stored for an asset id (local-originals.ts), so a save can copy it into the
   * folder. The renderer never sends a path: the main process looks it up here, by id.
   */
  readonly originalPath?: (assetId: string) => string | undefined;
}

export function createProjectFolderHandlers(
  port: ProjectFolderRequestPort | undefined,
  options: ProjectFolderHandlerOptions = {},
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
    'desktop.project-folder.load': (payload) => {
      const key = keyField(payload);
      return key === undefined ? invalidRequest() : callWorker(port, 'load', { key });
    },
    'desktop.project-folder.save': (payload) => {
      const key = keyField(payload);
      const save = saveFields(payload, options.originalPath);
      return key === undefined || save === undefined
        ? invalidRequest()
        : callWorker(port, 'save', { key, ...save });
    },
    'desktop.project-folder.media': (payload) => {
      const key = keyField(payload);
      if (key === undefined) return invalidRequest();
      const ids = (payload as Record<string, unknown>)['assetIds'];
      if (ids !== undefined) {
        const assetIds = assetIdList(ids);
        return assetIds === undefined
          ? invalidRequest()
          : callWorker(port, 'media', { key, assetIds });
      }
      const assetId = field(payload, 'assetId');
      const offset = (payload as Record<string, unknown>)['offset'];
      if (assetId === undefined || !ID_PATTERN.test(assetId)) return invalidRequest();
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
        return invalidRequest();
      }
      return callWorker(port, 'media', { key, assetId, offset });
    },
    'desktop.project-folder.close': (payload) => {
      const key = keyField(payload);
      return key === undefined ? invalidRequest() : callWorker(port, 'close', { key });
    },
  };
}

interface SaveMedia {
  readonly assetId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly sha256?: string;
  readonly sourcePath?: string;
}

/**
 * A save from the renderer, rebuilt from checked fields only. A media item's place comes from `originalPath`, never from
 * the payload, so a renderer cannot make the worker copy a file of its choosing into a folder.
 */
function saveFields(
  payload: unknown,
  originalPath: ((assetId: string) => string | undefined) | undefined,
):
  | {
      readonly projectId: string;
      readonly baseRevisionId: string;
      readonly revisionId: string;
      readonly title: string;
      readonly document: unknown;
      readonly media: readonly SaveMedia[];
    }
  | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const projectId = field(payload, 'projectId');
  const baseRevisionId = field(payload, 'baseRevisionId');
  const revisionId = field(payload, 'revisionId');
  const title = titleField(payload);
  if (projectId === undefined || !ID_PATTERN.test(projectId)) return undefined;
  if (baseRevisionId === undefined || baseRevisionId.length > REVISION_LIMIT) return undefined;
  if (revisionId === undefined || revisionId.length === 0 || revisionId.length > REVISION_LIMIT) {
    return undefined;
  }
  if (title === undefined) return undefined;
  const document = record['document'];
  if (typeof document !== 'object' || document === null || Array.isArray(document))
    return undefined;
  let documentJson: string;
  try {
    documentJson = JSON.stringify(document);
  } catch {
    return undefined;
  }
  if (documentJson.length > DOCUMENT_JSON_LIMIT) return undefined;
  const rawMedia = record['media'];
  if (!Array.isArray(rawMedia) || rawMedia.length > MEDIA_LIMIT) return undefined;
  const media: SaveMedia[] = [];
  for (const item of rawMedia) {
    const assetId = field(item, 'assetId');
    const kind = field(item, 'kind');
    const displayName = field(item, 'displayName');
    const sha256 = field(item, 'sha256');
    if (assetId === undefined || !ID_PATTERN.test(assetId)) return undefined;
    if (kind === undefined || !KIND_PATTERN.test(kind)) return undefined;
    if (displayName === undefined || displayName.length > DISPLAY_NAME_LIMIT) return undefined;
    const rawSha = (item as Record<string, unknown>)['sha256'];
    if (rawSha !== undefined && (sha256 === undefined || !SHA256_PATTERN.test(sha256))) {
      return undefined;
    }
    const sourcePath = originalPath?.(assetId);
    media.push({
      assetId,
      kind,
      displayName,
      ...(sha256 === undefined ? {} : { sha256 }),
      ...(sourcePath === undefined ? {} : { sourcePath }),
    });
  }
  return {
    projectId,
    baseRevisionId,
    revisionId,
    title,
    document: JSON.parse(documentJson) as unknown,
    media,
  };
}

function assetIdList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MEDIA_LIMIT) return undefined;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return undefined;
    ids.push(id);
  }
  return ids;
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
