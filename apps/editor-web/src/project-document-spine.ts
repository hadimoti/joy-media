import {
  validateProjectDocumentV2,
  type JsonValue,
  type ProjectDocumentV2,
} from '@joy-media/project-schema';
import type { EditorSession, EditorSessionDurableChange } from './editor-session.js';

/** Structural journal contract so browser, OPFS, and test journals can be injected. */
export interface ProjectDocumentSpineJournal {
  readonly append?: (
    document: ProjectDocumentV2,
    options?: ProjectDocumentSpineJournalWriteOptions,
  ) => void | Promise<unknown>;
  readonly saveSnapshot?: (
    document: ProjectDocumentV2,
    options?: ProjectDocumentSpineJournalWriteOptions,
  ) => void | Promise<unknown>;
}

export interface ProjectDocumentSpineJournalWriteOptions {
  readonly operationKind?: string;
  readonly operationMetadata?: JsonValue;
}

/** Structural subset of ProjectDocumentSyncCoordinator used by the attachment seam. */
export interface ProjectDocumentSpineSyncCoordinator {
  readonly queueLocalDocument: (
    document: ProjectDocumentV2,
    options?: { readonly label?: string; readonly operationCount?: number },
  ) => void | Promise<void>;
}

export interface ProjectDocumentSpineOptions {
  readonly session: EditorSession;
  readonly journal: ProjectDocumentSpineJournal;
  readonly coordinator: ProjectDocumentSpineSyncCoordinator;
  /** A JSON-only audio sidecar takes precedence over the visual project's audio domain. */
  readonly audioSidecar?: JsonValue | (() => JsonValue | undefined);
  readonly onFailure?: (failure: ProjectDocumentSpineFailure) => void;
}

export interface ProjectDocumentSpineFailure {
  readonly stage: 'projection' | 'local-journal' | 'remote-queue';
  readonly error: unknown;
  readonly document?: ProjectDocumentV2;
  /** True because the live EditorSession remains intact and can be retried. */
  readonly recoverable: true;
}

export type ProjectDocumentSpineSaveResult =
  | {
      readonly ok: true;
      readonly document: ProjectDocumentV2;
    }
  | {
      readonly ok: false;
      readonly failure: ProjectDocumentSpineFailure;
    };

export class ProjectDocumentSpineError extends Error {
  readonly stage: ProjectDocumentSpineFailure['stage'];
  readonly recoverable = true;

  constructor(
    stage: ProjectDocumentSpineFailure['stage'],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProjectDocumentSpineError';
    this.stage = stage;
  }
}

/**
 * Projects the two live editor lenses into a bounded V2 envelope and attaches
 * that projection to the editor's durable-change seam. Persistence is ordered
 * deliberately: local journal first, remote queue second. A failed local save
 * therefore never presents an unjournaled document to the sync coordinator.
 */
export class ProjectDocumentSpine {
  readonly #session: EditorSession;
  readonly #journal: ProjectDocumentSpineJournal;
  readonly #coordinator: ProjectDocumentSpineSyncCoordinator;
  readonly #audioSidecar: ProjectDocumentSpineOptions['audioSidecar'];
  readonly #onFailure: ProjectDocumentSpineOptions['onFailure'];
  #unsubscribe: (() => void) | undefined;
  #disposed = false;
  #tail: Promise<void> = Promise.resolve();
  #lastFailure: ProjectDocumentSpineFailure | undefined;

  constructor(options: ProjectDocumentSpineOptions) {
    this.#session = options.session;
    this.#journal = options.journal;
    this.#coordinator = options.coordinator;
    this.#audioSidecar = options.audioSidecar;
    this.#onFailure = options.onFailure;
  }

  get attached(): boolean {
    return this.#unsubscribe !== undefined;
  }

  get lastFailure(): ProjectDocumentSpineFailure | undefined {
    return this.#lastFailure;
  }

  /** Attach once; repeated calls are harmless and return the active detach function. */
  attach(): () => void {
    if (this.#disposed) throw new ProjectDocumentSpineError('projection', 'spine is disposed');
    if (this.#unsubscribe !== undefined) return this.#unsubscribe;
    const sessionUnsubscribe = this.#session.subscribeDurableChanges((change) => {
      void this.#enqueue(change);
    });
    let active = true;
    const detach = (): void => {
      if (!active) return;
      active = false;
      sessionUnsubscribe();
      // A stale handle from an earlier attach must not detach a newer one.
      if (this.#unsubscribe === detach) this.#unsubscribe = undefined;
    };
    this.#unsubscribe = detach;
    return detach;
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  dispose(): void {
    this.detach();
    this.#disposed = true;
  }

  projectDocument(): ProjectDocumentV2 {
    return projectDocumentFromSession(this.#session, this.#audioSidecar);
  }

  /** Persist the current session state, useful for the initial attachment snapshot. */
  saveCurrent(
    change: EditorSessionDurableChange = { label: 'Project snapshot', operationCount: 1 },
  ): Promise<ProjectDocumentSpineSaveResult> {
    return this.#enqueue(change);
  }

  /** Wait until all queued local-save/remote-queue work has settled. */
  async flush(): Promise<void> {
    await this.#tail;
  }

  #enqueue(change: EditorSessionDurableChange): Promise<ProjectDocumentSpineSaveResult> {
    let resolveResult!: (result: ProjectDocumentSpineSaveResult) => void;
    const result = new Promise<ProjectDocumentSpineSaveResult>((resolve) => {
      resolveResult = resolve;
    });
    const documentResult = safeProjectDocument(this.#session, this.#audioSidecar);
    if (!documentResult.ok) {
      this.#report(documentResult.failure);
      resolveResult(documentResult);
      return result;
    }
    const document = documentResult.document;
    const work = this.#tail.then(async () => {
      const outcome = await this.#saveAndQueue(document, change);
      resolveResult(outcome);
    });
    // A failed operation is reported in its result and must not poison later
    // edits; the live session remains available for a later retry.
    this.#tail = work.then(
      () => undefined,
      (error: unknown) => {
        const failure = this.#failure('remote-queue', error, document);
        this.#report(failure);
        resolveResult({ ok: false, failure });
      },
    );
    return result;
  }

  async #saveAndQueue(
    document: ProjectDocumentV2,
    change: EditorSessionDurableChange,
  ): Promise<ProjectDocumentSpineSaveResult> {
    const options = {
      operationKind: 'editor-session.change',
      operationMetadata: {
        label: change.label,
        operationCount: positiveOperationCount(change.operationCount),
      },
    };
    try {
      if (this.#journal.saveSnapshot !== undefined)
        await this.#journal.saveSnapshot(document, options);
      else if (this.#journal.append !== undefined) await this.#journal.append(document, options);
      else throw new Error('a project document journal must expose append or saveSnapshot');
    } catch (error) {
      const failure = this.#failure('local-journal', error, document);
      this.#report(failure);
      return { ok: false, failure };
    }
    try {
      await this.#coordinator.queueLocalDocument(document, {
        label: change.label,
        operationCount: positiveOperationCount(change.operationCount),
      });
    } catch (error) {
      const failure = this.#failure('remote-queue', error, document);
      this.#report(failure);
      return { ok: false, failure };
    }
    this.#lastFailure = undefined;
    return { ok: true, document };
  }

  #failure(
    stage: ProjectDocumentSpineFailure['stage'],
    error: unknown,
    document?: ProjectDocumentV2,
  ): ProjectDocumentSpineFailure {
    return { stage, error, ...(document === undefined ? {} : { document }), recoverable: true };
  }

  #report(failure: ProjectDocumentSpineFailure): void {
    this.#lastFailure = failure;
    try {
      this.#onFailure?.(failure);
    } catch {
      // Failure observers are diagnostics, not part of the persistence commit.
    }
  }
}

export function createProjectDocumentSpine(
  options: ProjectDocumentSpineOptions,
): ProjectDocumentSpine {
  return new ProjectDocumentSpine(options);
}

/** Pure projection helper for callers that do not need an attachment controller. */
export function projectDocumentFromSession(
  session: Pick<
    EditorSession,
    'timelineProject' | 'visualProject' | 'graphEnabled' | 'workflowGraph' | 'artifacts'
  >,
  audioSidecar?: JsonValue | (() => JsonValue | undefined),
): ProjectDocumentV2 {
  const visualProject = toBoundedJson(session.visualProject, 'visual project');
  const timeline = toBoundedJson(session.timelineProject, 'timeline');
  const projectId = session.visualProject.id || session.timelineProject.id;
  if (!isProjectId(projectId)) {
    throw new ProjectDocumentSpineError('projection', 'live session has no valid project id');
  }
  const title =
    typeof session.visualProject.title === 'string' ? session.visualProject.title : undefined;
  const sidecar = typeof audioSidecar === 'function' ? audioSidecar() : audioSidecar;
  const visualRecord = asRecord(visualProject);
  const audio =
    sidecar !== undefined ? toBoundedJson(sidecar, 'audio sidecar') : visualRecord?.audio;
  const document: ProjectDocumentV2 = {
    schemaVersion: 2,
    projectId,
    ...(title === undefined ? {} : { title }),
    project: visualProject,
    timeline,
    ...(audio === undefined ? {} : { audio }),
    ...(session.graphEnabled
      ? {
          workflow: toBoundedJson(session.workflowGraph, 'workflow graph'),
          artifacts: toBoundedJson(session.artifacts, 'creative artifacts'),
        }
      : {}),
  };
  const diagnostics = validateProjectDocumentV2(document);
  if (diagnostics.length > 0) {
    throw new ProjectDocumentSpineError(
      'projection',
      `project document projection is invalid: ${diagnostics[0]?.message ?? 'unknown diagnostic'}`,
    );
  }
  return document;
}

export const projectDocumentV2FromSession = projectDocumentFromSession;

function safeProjectDocument(
  session: Pick<
    EditorSession,
    'timelineProject' | 'visualProject' | 'graphEnabled' | 'workflowGraph' | 'artifacts'
  >,
  audioSidecar?: JsonValue | (() => JsonValue | undefined),
): ProjectDocumentSpineSaveResult {
  try {
    return { ok: true, document: projectDocumentFromSession(session, audioSidecar) };
  } catch (error) {
    const failure: ProjectDocumentSpineFailure = { stage: 'projection', error, recoverable: true };
    return { ok: false, failure };
  }
}

const FORBIDDEN_KEYS =
  /^(?:raw(?:Media|Bytes)?|media|bytes|base64|buffer|blob|path|url|uri|.*(?:Path|Url|Uri|Bytes|Base64|Buffer|Blob|MediaData))$/i;
const MAX_DEPTH = 32;
const MAX_NODES = 50_000;
const MAX_STRING_LENGTH = 16_384;

function toBoundedJson(value: unknown, label: string): JsonValue {
  const state = { nodes: 0, active: new Set<object>() };
  const result = sanitizeJson(value, 0, state);
  if (result === undefined)
    throw new ProjectDocumentSpineError('projection', `${label} is not JSON data`);
  return result;
}

function sanitizeJson(
  value: unknown,
  depth: number,
  state: { nodes: number; active: Set<object> },
): JsonValue | undefined {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' && value.length > MAX_STRING_LENGTH ? undefined : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object') return undefined;
  if (
    typeof ArrayBuffer !== 'undefined' &&
    (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
  ) {
    return undefined;
  }
  if (state.active.has(value)) return undefined;
  state.active.add(value);
  let result: JsonValue;
  if (Array.isArray(value)) {
    result = value
      .map((child) => sanitizeJson(child, depth + 1, state))
      .filter((child): child is JsonValue => child !== undefined);
  } else {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(key)) continue;
      const safeChild = sanitizeJson(child, depth + 1, state);
      if (safeChild !== undefined) output[key] = safeChild;
    }
    result = output;
  }
  state.active.delete(value);
  return result;
}

function asRecord(value: JsonValue): { readonly [key: string]: JsonValue } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as { readonly [key: string]: JsonValue })
    : undefined;
}

function positiveOperationCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function isProjectId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

/** Compatibility name for hosts that refer to the attachment as a controller. */
export const ProjectDocumentSpineController = ProjectDocumentSpine;
