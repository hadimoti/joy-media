import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';
import {
  hydrateProjectDocument,
  type LoadProjectDocument,
  type ProjectHydrationResult,
  type ProjectHydrationSession,
} from './project-document-hydration.js';
import {
  type ControlPlaneProjectBinding,
  upsertControlPlaneProjectBinding,
} from './project-control-plane.js';
import {
  syncProjectDocumentBinding,
  type DocumentSyncResult,
  type SyncProjectDocument,
} from './project-document-sync.js';

export const DOCUMENT_AUTOSYNC_DEBOUNCE_MS = 800;
export const DOCUMENT_AUTOSYNC_RETRY_INITIAL_MS = 2_000;
export const DOCUMENT_AUTOSYNC_RETRY_MAX_MS = 60_000;

export interface ProjectDocumentAutosyncOptions {
  readonly storage: BrowserKeyValueStore;
  readonly syncProjectDocument: SyncProjectDocument;
  /** Classifies the control-plane's explicit missing-document response. */
  readonly isDocumentMissing?: (error: unknown) => boolean;
  readonly onResult?: (result: ProjectDocumentAutosyncOutcome) => void;
}

export type ProjectDocumentBootstrapResult = ProjectHydrationResult | { readonly kind: 'missing' };

export type ProjectDocumentAutosyncOutcome =
  | {
      readonly kind: 'saved';
      readonly ownerKey: string;
      readonly controlPlaneProjectId: string;
      readonly revisionId: ProjectRevisionId;
    }
  | {
      readonly kind: 'conflict';
      readonly ownerKey: string;
      readonly controlPlaneProjectId: string;
      readonly message: string;
    }
  | {
      readonly kind: 'request-failure';
      readonly ownerKey: string;
      readonly controlPlaneProjectId: string;
      readonly error: unknown;
      readonly retryDelayMs: number;
    };

interface QueuedDocument {
  readonly document: JoyProjectV1;
  readonly revisionId: ProjectRevisionId;
}

interface ProjectAutosyncEntry {
  binding: ControlPlaneProjectBinding;
  readonly ownerKey: string;
  confirmedRevisionId?: ProjectRevisionId;
  queued: QueuedDocument | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  failures: number;
  conflicted: boolean;
}

/**
 * Owns ordinary editor document persistence after a remote head has been
 * read. The coordinator intentionally never treats a local initial document
 * as authoritative until bootstrap has either hydrated an existing server
 * head or proven that the document is absent.
 */
export class ProjectDocumentAutosync {
  private readonly entries = new Map<string, ProjectAutosyncEntry>();
  private stopped = false;

  constructor(private readonly options: ProjectDocumentAutosyncOptions) {}

  /**
   * Reads and applies the remote head before writes are eligible. A valid
   * remote head records its CAS revision and marks the resulting local
   * session revision as confirmed, preventing an immediate echo write.
   */
  async bootstrap(
    session: ProjectHydrationSession,
    binding: ControlPlaneProjectBinding,
    load: LoadProjectDocument,
    ownerKey: string,
  ): Promise<ProjectDocumentBootstrapResult> {
    let result: ProjectHydrationResult;
    try {
      result = await hydrateProjectDocument(session, binding, load);
    } catch (error: unknown) {
      if (this.options.isDocumentMissing?.(error) === true) return { kind: 'missing' };
      throw error;
    }

    if (result.kind === 'local-changed') return result;

    const entry = this.entryFor(binding, ownerKey);
    this.clearTimer(entry);
    entry.queued = undefined;
    entry.failures = 0;
    entry.conflicted = false;
    entry.binding = { ...binding, documentRevisionId: result.revisionId };
    // `synchronizeVisualProject` may have advanced this ID. Capturing it only
    // after hydration means the remote document cannot be written back as a
    // fresh local revision on the next render.
    entry.confirmedRevisionId = session.projectRevisionId;
    upsertControlPlaneProjectBinding(this.options.storage, entry.binding, ownerKey);
    return result;
  }

  /**
   * Coalesces the newest immutable revision separately for each owner/project.
   * A conflict blocks further automatic writes for that project; the browser's
   * local document is deliberately left untouched for user recovery.
   */
  schedule(
    binding: ControlPlaneProjectBinding,
    document: JoyProjectV1,
    revisionId: ProjectRevisionId,
    ownerKey: string,
  ): void {
    if (this.stopped) return;
    const entry = this.entryFor(binding, ownerKey);
    if (entry.conflicted || entry.confirmedRevisionId === revisionId) return;
    if (entry.queued?.revisionId === revisionId) return;

    entry.queued = { document, revisionId };
    this.arm(entry, DOCUMENT_AUTOSYNC_DEBOUNCE_MS);
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) this.clearTimer(entry);
    this.entries.clear();
  }

  private entryFor(binding: ControlPlaneProjectBinding, ownerKey: string): ProjectAutosyncEntry {
    const key = entryKey(ownerKey, binding);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.binding = binding;
      return existing;
    }
    const entry: ProjectAutosyncEntry = {
      binding,
      ownerKey,
      queued: undefined,
      timer: undefined,
      failures: 0,
      conflicted: false,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private arm(entry: ProjectAutosyncEntry, delayMs: number): void {
    this.clearTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.flush(entry);
    }, delayMs);
  }

  private clearTimer(entry: ProjectAutosyncEntry): void {
    if (entry.timer === undefined) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private async flush(entry: ProjectAutosyncEntry): Promise<void> {
    if (this.stopped || entry.conflicted || entry.queued === undefined) return;
    const queued = entry.queued;
    const result = await syncProjectDocumentBinding(
      entry.binding,
      queued.document,
      queued.revisionId,
      this.options.storage,
      this.options.syncProjectDocument,
      { ownerKey: entry.ownerKey },
    );
    if (this.stopped) return;
    this.applyResult(entry, queued, result);
  }

  private applyResult(
    entry: ProjectAutosyncEntry,
    queued: QueuedDocument,
    result: DocumentSyncResult,
  ): void {
    if (result.kind === 'success') {
      entry.confirmedRevisionId = result.revisionId;
      entry.failures = 0;
      if (entry.queued?.revisionId === queued.revisionId) entry.queued = undefined;
      this.options.onResult?.({
        kind: 'saved',
        ownerKey: entry.ownerKey,
        controlPlaneProjectId: entry.binding.controlPlaneProjectId,
        revisionId: result.revisionId,
      });
      return;
    }
    if (result.kind === 'conflict') {
      entry.conflicted = true;
      this.clearTimer(entry);
      entry.queued = undefined;
      this.options.onResult?.({
        kind: 'conflict',
        ownerKey: entry.ownerKey,
        controlPlaneProjectId: entry.binding.controlPlaneProjectId,
        message: result.message,
      });
      return;
    }

    entry.failures += 1;
    const retryDelayMs = retryDelay(entry.failures);
    this.options.onResult?.({
      kind: 'request-failure',
      ownerKey: entry.ownerKey,
      controlPlaneProjectId: entry.binding.controlPlaneProjectId,
      error: result.error,
      retryDelayMs,
    });
    // Keep the most recent local snapshot queued; no failed save can erase it.
    this.arm(entry, retryDelayMs);
  }
}

function entryKey(ownerKey: string, binding: ControlPlaneProjectBinding): string {
  return `${ownerKey}:${binding.editorProjectId}:${binding.controlPlaneProjectId}`;
}

function retryDelay(failures: number): number {
  return Math.min(
    DOCUMENT_AUTOSYNC_RETRY_INITIAL_MS * 2 ** Math.max(0, failures - 1),
    DOCUMENT_AUTOSYNC_RETRY_MAX_MS,
  );
}
