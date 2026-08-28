import type { ProjectDocumentV2 } from '@joy-media/project-schema';
import {
  type BrowserProjectDocumentSnapshot,
  type BrowserProjectRevision,
  type BrowserRecoveredCopyOperation,
} from './control-plane-client.js';
import { BrowserControlPlaneError } from './control-plane-errors.js';

const IDLE_SYNC_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_PENDING_OPERATIONS = 50;
const MAX_CHECKPOINT_AGE_MS = 30_000;

export type ProjectDocumentSyncState =
  'local' | 'syncing' | 'server-unavailable' | 'conflict-recovered';

export interface ProjectDocumentRecoveredCopy {
  readonly kind: 'recovered-copy';
  readonly projectId: string;
  readonly name: string;
  readonly document: ProjectDocumentV2;
  readonly basedOnRevision: number;
  readonly serverRevision: number;
  readonly createdAt: string;
  readonly provenance: {
    readonly sourceProjectId: string;
    readonly baseRevision: number;
    readonly sourceHeadRevision: number;
    readonly operation: BrowserRecoveredCopyOperation;
    readonly requestedDocumentHash: string;
  };
}

export interface ProjectDocumentStaleRevisionRecoveryInput {
  readonly projectId: string;
  readonly baseRevision: number;
  readonly serverSnapshot: BrowserProjectDocumentSnapshot;
  readonly idempotencyKey: string;
  readonly suggestedName: string;
  readonly operation:
    | {
        readonly kind: 'append';
        readonly document: ProjectDocumentV2;
        readonly label?: string;
      }
    | {
        readonly kind: 'restore';
        readonly targetRevision: number;
        readonly label?: string;
      };
}

export interface ProjectDocumentSyncRemote {
  loadDocument(projectId: string): Promise<BrowserProjectDocumentSnapshot>;
  appendRevision(
    projectId: string,
    input: {
      readonly baseRevision: number;
      readonly idempotencyKey: string;
      readonly document: ProjectDocumentV2;
      readonly label?: string;
    },
  ): Promise<BrowserProjectRevision>;
  restoreRevision(
    projectId: string,
    input: {
      readonly baseRevision: number;
      readonly revision: number;
      readonly idempotencyKey: string;
      readonly label?: string;
    },
  ): Promise<BrowserProjectRevision>;
  recoverStaleRevision(
    input: ProjectDocumentStaleRevisionRecoveryInput,
  ): Promise<ProjectDocumentRecoveredCopy>;
}

export interface ProjectDocumentSyncScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ProjectDocumentSyncSnapshot {
  readonly projectId: string;
  readonly document: ProjectDocumentV2;
  readonly remoteRevision: number;
  readonly state: ProjectDocumentSyncState;
  readonly pendingOperations: number;
  readonly lastCheckpointAtMs?: number;
  readonly lastRecoveredCopy?: ProjectDocumentRecoveredCopy;
}

export interface QueueLocalDocumentOptions {
  readonly label?: string;
  readonly operationCount?: number;
}

export interface RestoreProjectDocumentOptions {
  readonly label?: string;
}

export interface ProjectDocumentSyncCheckpoint {
  readonly baseRevision: number;
  readonly idempotencyKey: string;
  readonly operationCount: number;
  readonly queuedAtMs: number;
  readonly startedAtMs: number;
  readonly label?: string;
}

export type ProjectDocumentSyncResult =
  | {
      readonly kind: 'noop';
      readonly snapshot: ProjectDocumentSyncSnapshot;
    }
  | {
      readonly kind: 'synced';
      readonly checkpoint: ProjectDocumentSyncCheckpoint;
      readonly revision: BrowserProjectRevision;
      readonly snapshot: ProjectDocumentSyncSnapshot;
    }
  | {
      readonly kind: 'restored';
      readonly checkpoint: ProjectDocumentSyncCheckpoint;
      readonly revision: BrowserProjectRevision;
      readonly snapshot: ProjectDocumentSyncSnapshot;
    }
  | {
      readonly kind: 'server-unavailable';
      readonly checkpoint: ProjectDocumentSyncCheckpoint;
      readonly error: unknown;
      readonly snapshot: ProjectDocumentSyncSnapshot;
    }
  | {
      readonly kind: 'conflict-recovered';
      readonly checkpoint: ProjectDocumentSyncCheckpoint;
      readonly recoveredCopy: ProjectDocumentRecoveredCopy;
      readonly serverSnapshot: BrowserProjectDocumentSnapshot;
      readonly snapshot: ProjectDocumentSyncSnapshot;
    };

export interface ProjectDocumentSyncCoordinatorOptions {
  readonly initialSnapshot: BrowserProjectDocumentSnapshot;
  readonly remote: ProjectDocumentSyncRemote;
  readonly scheduler?: ProjectDocumentSyncScheduler;
  readonly createIdempotencyKey?: () => string;
  readonly createRecoveredName?: (input: {
    readonly projectId: string;
    readonly title?: string;
    readonly now: Date;
  }) => string;
}

interface PendingBatch {
  readonly generation: number;
  readonly operationCount: number;
  readonly queuedAtMs: number;
  readonly document: ProjectDocumentV2;
  readonly label?: string;
}

interface AppendAttempt {
  readonly checkpoint: ProjectDocumentSyncCheckpoint;
  readonly checkpointGeneration: number;
  readonly document: ProjectDocumentV2;
}

interface RestoreAttempt {
  readonly checkpoint: ProjectDocumentSyncCheckpoint;
  readonly targetRevision: number;
}

type Listener = (snapshot: ProjectDocumentSyncSnapshot) => void;

export class ProjectDocumentSyncCoordinator {
  readonly #projectId: string;
  readonly #remote: ProjectDocumentSyncRemote;
  readonly #scheduler: ProjectDocumentSyncScheduler;
  readonly #createIdempotencyKey: () => string;
  readonly #createRecoveredName: NonNullable<
    ProjectDocumentSyncCoordinatorOptions['createRecoveredName']
  >;
  readonly #listeners = new Set<Listener>();

  #document: ProjectDocumentV2;
  #remoteRevision: number;
  #state: ProjectDocumentSyncState = 'local';
  #pendingBatches: PendingBatch[] = [];
  #localGeneration = 0;
  #lastCheckpointAtMs: number | undefined;
  #lastRecoveredCopy: ProjectDocumentRecoveredCopy | undefined;
  #idleTimer: unknown;
  #deadlineTimer: unknown;
  #syncPromise: Promise<ProjectDocumentSyncResult> | undefined;
  #retryAppend: AppendAttempt | undefined;
  #retryRestore: RestoreAttempt | undefined;
  #consecutiveRemoteFailures = 0;

  constructor(options: ProjectDocumentSyncCoordinatorOptions) {
    this.#projectId = options.initialSnapshot.projectId;
    this.#document = cloneDocument(options.initialSnapshot.document);
    this.#remoteRevision = options.initialSnapshot.revision;
    this.#remote = options.remote;
    this.#scheduler = options.scheduler ?? browserProjectDocumentSyncScheduler;
    this.#createIdempotencyKey = options.createIdempotencyKey ?? defaultIdempotencyKey;
    this.#createRecoveredName = options.createRecoveredName ?? defaultRecoveredName;
  }

  getSnapshot(): ProjectDocumentSyncSnapshot {
    return {
      projectId: this.#projectId,
      document: cloneDocument(this.#document),
      remoteRevision: this.#remoteRevision,
      state: this.#state,
      pendingOperations: pendingOperationCount(this.#pendingBatches),
      ...(this.#lastCheckpointAtMs === undefined
        ? {}
        : { lastCheckpointAtMs: this.#lastCheckpointAtMs }),
      ...(this.#lastRecoveredCopy === undefined
        ? {}
        : { lastRecoveredCopy: this.#lastRecoveredCopy }),
    };
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.#listeners.delete(listener);
    };
  }

  queueLocalDocument(document: ProjectDocumentV2, options: QueueLocalDocumentOptions = {}): void {
    const operationCount = options.operationCount ?? 1;
    if (!Number.isSafeInteger(operationCount) || operationCount < 1) {
      throw new RangeError('operationCount must be a positive integer');
    }
    this.#localGeneration += 1;
    this.#document = cloneDocument(document);
    this.#pendingBatches = [
      ...this.#pendingBatches,
      {
        generation: this.#localGeneration,
        operationCount,
        queuedAtMs: this.#scheduler.now(),
        document: cloneDocument(document),
        ...(options.label === undefined ? {} : { label: options.label }),
      },
    ];
    if (this.#state !== 'syncing') this.#state = 'local';
    this.#lastRecoveredCopy = undefined;
    this.#notify();
    if (this.#syncPromise !== undefined) return;
    if (this.#mustFlushImmediately()) {
      void this.syncNow();
      return;
    }
    this.#schedulePendingSync();
  }

  async syncNow(): Promise<ProjectDocumentSyncResult> {
    if (this.#syncPromise !== undefined) return this.#syncPromise;
    if (this.#retryRestore !== undefined) {
      this.#clearTimers();
      this.#state = 'syncing';
      this.#notify();
      this.#syncPromise = this.#restoreCheckpoint(this.#retryRestore);
      return this.#syncPromise;
    }
    if (this.#retryAppend !== undefined) {
      this.#clearTimers();
      this.#state = 'syncing';
      this.#notify();
      this.#syncPromise = this.#appendCheckpoint(this.#retryAppend);
      return this.#syncPromise;
    }
    if (this.#pendingBatches.length === 0) {
      return { kind: 'noop', snapshot: this.getSnapshot() };
    }
    this.#clearTimers();
    const checkpointGeneration = this.#pendingBatches[this.#pendingBatches.length - 1]!.generation;
    const checkpointBatches = this.#pendingBatches.filter(
      (batch) => batch.generation <= checkpointGeneration,
    );
    const checkpoint: ProjectDocumentSyncCheckpoint = {
      baseRevision: this.#remoteRevision,
      idempotencyKey: this.#createIdempotencyKey(),
      operationCount: pendingOperationCount(checkpointBatches),
      queuedAtMs: checkpointBatches[0]!.queuedAtMs,
      startedAtMs: this.#scheduler.now(),
      ...latestLabel(checkpointBatches),
    };
    const attempt: AppendAttempt = {
      checkpoint,
      checkpointGeneration,
      document: cloneDocument(checkpointBatches[checkpointBatches.length - 1]!.document),
    };
    this.#state = 'syncing';
    this.#notify();
    this.#syncPromise = this.#appendCheckpoint(attempt);
    return this.#syncPromise;
  }

  async restoreRevision(
    targetRevision: number,
    options: RestoreProjectDocumentOptions = {},
  ): Promise<ProjectDocumentSyncResult> {
    if (!Number.isSafeInteger(targetRevision) || targetRevision < 1) {
      throw new RangeError('targetRevision must be a positive integer');
    }
    if (
      this.#syncPromise !== undefined ||
      this.#retryAppend !== undefined ||
      this.#pendingBatches.length > 0
    ) {
      const flushed = await this.syncNow();
      if (flushed.kind !== 'noop' && flushed.kind !== 'synced') return flushed;
    }
    this.#clearTimers();
    const attempt: RestoreAttempt = {
      checkpoint: {
        baseRevision: this.#remoteRevision,
        idempotencyKey: this.#createIdempotencyKey(),
        operationCount: 0,
        queuedAtMs: this.#scheduler.now(),
        startedAtMs: this.#scheduler.now(),
        ...(options.label === undefined ? {} : { label: options.label }),
      },
      targetRevision,
    };
    this.#state = 'syncing';
    this.#lastRecoveredCopy = undefined;
    this.#notify();
    this.#syncPromise = this.#restoreCheckpoint(attempt);
    return this.#syncPromise;
  }

  dispose(): void {
    this.#clearTimers();
    this.#listeners.clear();
  }

  async #restoreCheckpoint(attempt: RestoreAttempt): Promise<ProjectDocumentSyncResult> {
    const { checkpoint, targetRevision } = attempt;
    try {
      this.#retryRestore = undefined;
      const revision = await this.#remote.restoreRevision(this.#projectId, {
        baseRevision: checkpoint.baseRevision,
        revision: targetRevision,
        idempotencyKey: checkpoint.idempotencyKey,
        ...(checkpoint.label === undefined ? {} : { label: checkpoint.label }),
      });
      this.#document = cloneDocument(revision.document);
      this.#remoteRevision = revision.revision;
      this.#retryRestore = undefined;
      this.#retryAppend = undefined;
      this.#consecutiveRemoteFailures = 0;
      this.#state = 'local';
      this.#lastCheckpointAtMs = checkpoint.startedAtMs;
      this.#notify();
      return { kind: 'restored', checkpoint, revision, snapshot: this.getSnapshot() };
    } catch (error) {
      if (!isRevisionConflict(error)) {
        this.#consecutiveRemoteFailures += 1;
        this.#retryRestore = attempt;
        this.#state = 'server-unavailable';
        this.#notify();
        return { kind: 'server-unavailable', checkpoint, error, snapshot: this.getSnapshot() };
      }
      this.#retryRestore = undefined;
      return this.#recoverConflict({
        checkpoint,
        baseDocument: this.#document,
        operation: {
          kind: 'restore',
          targetRevision,
          ...(checkpoint.label === undefined ? {} : { label: checkpoint.label }),
        },
      });
    } finally {
      this.#syncPromise = undefined;
      if (
        this.#retryRestore !== undefined ||
        this.#retryAppend !== undefined ||
        this.#pendingBatches.length > 0
      ) {
        if (this.#mustFlushImmediately()) void this.syncNow();
        else this.#schedulePendingSync();
      }
    }
  }

  async #appendCheckpoint(attempt: AppendAttempt): Promise<ProjectDocumentSyncResult> {
    const { checkpoint, checkpointGeneration, document } = attempt;
    try {
      this.#retryAppend = undefined;
      const revision = await this.#remote.appendRevision(this.#projectId, {
        baseRevision: checkpoint.baseRevision,
        idempotencyKey: checkpoint.idempotencyKey,
        document,
        ...(checkpoint.label === undefined ? {} : { label: checkpoint.label }),
      });
      this.#remoteRevision = revision.revision;
      this.#lastCheckpointAtMs = checkpoint.startedAtMs;
      this.#pendingBatches = this.#pendingBatches.filter(
        (batch) => batch.generation > checkpointGeneration,
      );
      this.#retryAppend = undefined;
      this.#consecutiveRemoteFailures = 0;
      this.#state = 'local';
      this.#notify();
      return { kind: 'synced', checkpoint, revision, snapshot: this.getSnapshot() };
    } catch (error) {
      if (!isRevisionConflict(error)) {
        this.#consecutiveRemoteFailures += 1;
        this.#retryAppend = attempt;
        this.#state = 'server-unavailable';
        this.#notify();
        return { kind: 'server-unavailable', checkpoint, error, snapshot: this.getSnapshot() };
      }
      this.#retryAppend = undefined;
      return this.#recoverConflict({
        checkpoint,
        checkpointGeneration,
        baseDocument: document,
        operation: {
          kind: 'append',
          document,
          ...(checkpoint.label === undefined ? {} : { label: checkpoint.label }),
        },
      });
    } finally {
      this.#syncPromise = undefined;
      if (this.#retryAppend !== undefined || this.#pendingBatches.length > 0) {
        if (this.#mustFlushImmediately()) void this.syncNow();
        else this.#schedulePendingSync();
      }
    }
  }

  async #recoverConflict(input: {
    readonly checkpoint: ProjectDocumentSyncCheckpoint;
    readonly checkpointGeneration?: number;
    readonly baseDocument: ProjectDocumentV2;
    readonly operation: ProjectDocumentStaleRevisionRecoveryInput['operation'];
  }): Promise<ProjectDocumentSyncResult> {
    const { checkpoint, checkpointGeneration, baseDocument, operation } = input;
    try {
      const serverSnapshot = await this.#remote.loadDocument(this.#projectId);
      const recoveredCopy = await this.#remote.recoverStaleRevision({
        projectId: this.#projectId,
        baseRevision: checkpoint.baseRevision,
        serverSnapshot,
        idempotencyKey: checkpoint.idempotencyKey,
        suggestedName: this.#createRecoveredName({
          projectId: this.#projectId,
          now: new Date(this.#scheduler.now()),
          ...(baseDocument.title === undefined ? {} : { title: baseDocument.title }),
        }),
        operation,
      });
      this.#remoteRevision = serverSnapshot.revision;
      if (checkpointGeneration !== undefined) {
        this.#pendingBatches = this.#pendingBatches.filter(
          (batch) => batch.generation > checkpointGeneration,
        );
      }
      this.#state = 'conflict-recovered';
      this.#consecutiveRemoteFailures = 0;
      this.#lastRecoveredCopy = recoveredCopy;
      this.#notify();
      return {
        kind: 'conflict-recovered',
        checkpoint,
        recoveredCopy,
        serverSnapshot,
        snapshot: this.getSnapshot(),
      };
    } catch (recoveryError) {
      this.#consecutiveRemoteFailures += 1;
      this.#state = 'server-unavailable';
      this.#notify();
      return {
        kind: 'server-unavailable',
        checkpoint,
        error: recoveryError,
        snapshot: this.getSnapshot(),
      };
    }
  }

  #mustFlushImmediately(): boolean {
    const firstPending = this.#pendingBatches[0];
    if (firstPending === undefined) return false;
    return (
      pendingOperationCount(this.#pendingBatches) >= MAX_PENDING_OPERATIONS ||
      this.#scheduler.now() - firstPending.queuedAtMs >= MAX_CHECKPOINT_AGE_MS
    );
  }

  #schedulePendingSync(): void {
    if (this.#syncPromise !== undefined) return;
    if (
      this.#retryRestore === undefined &&
      this.#retryAppend === undefined &&
      this.#pendingBatches.length === 0
    ) {
      return;
    }
    this.#clearTimers();
    if (this.#retryRestore !== undefined) {
      this.#idleTimer = this.#scheduler.setTimeout(() => {
        this.#idleTimer = undefined;
        void this.syncNow();
      }, this.#retryDelayMs());
      return;
    }
    if (this.#retryAppend !== undefined) {
      this.#idleTimer = this.#scheduler.setTimeout(() => {
        this.#idleTimer = undefined;
        void this.syncNow();
      }, this.#retryDelayMs());
      return;
    }
    if (this.#consecutiveRemoteFailures > 0) {
      this.#idleTimer = this.#scheduler.setTimeout(() => {
        this.#idleTimer = undefined;
        void this.syncNow();
      }, this.#retryDelayMs());
      return;
    }
    const firstPending = this.#pendingBatches[0]!;
    this.#idleTimer = this.#scheduler.setTimeout(() => {
      this.#idleTimer = undefined;
      void this.syncNow();
    }, this.#retryDelayMs());
    const remainingDeadlineMs = Math.max(
      0,
      MAX_CHECKPOINT_AGE_MS - (this.#scheduler.now() - firstPending.queuedAtMs),
    );
    this.#deadlineTimer = this.#scheduler.setTimeout(() => {
      this.#deadlineTimer = undefined;
      void this.syncNow();
    }, remainingDeadlineMs);
  }

  #clearTimers(): void {
    if (this.#idleTimer !== undefined) {
      this.#scheduler.clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    if (this.#deadlineTimer !== undefined) {
      this.#scheduler.clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = undefined;
    }
  }

  #retryDelayMs(): number {
    if (this.#consecutiveRemoteFailures <= 1) return IDLE_SYNC_DELAY_MS;
    const exponent = Math.min(this.#consecutiveRemoteFailures - 1, 10);
    return Math.min(IDLE_SYNC_DELAY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
  }

  #notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

export const browserProjectDocumentSyncScheduler: ProjectDocumentSyncScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

function cloneDocument(document: ProjectDocumentV2): ProjectDocumentV2 {
  return JSON.parse(JSON.stringify(document)) as ProjectDocumentV2;
}

function pendingOperationCount(batches: readonly PendingBatch[]): number {
  return batches.reduce((count, batch) => count + batch.operationCount, 0);
}

function latestLabel(batches: readonly PendingBatch[]): { readonly label?: string } {
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    if (batches[index]!.label !== undefined) return { label: batches[index]!.label! };
  }
  return {};
}

function defaultIdempotencyKey(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('secure browser idempotency keys are unavailable');
  }
  return crypto.randomUUID();
}

function defaultRecoveredName(input: {
  readonly projectId: string;
  readonly title?: string;
  readonly now: Date;
}): string {
  // Never put an opaque project identifier into a user-visible recovery name.
  // A missing title is still recoverable and should remain truthful without
  // leaking transport identity into the editor UI.
  void input.projectId;
  const base = input.title?.trim() || 'Recovered project';
  return `${base} (Recovered copy ${input.now.toISOString()})`;
}

function isRevisionConflict(error: unknown): boolean {
  if (error instanceof BrowserControlPlaneError) return error.code === 'REVISION_CONFLICT';
  return isRecord(error) && error.code === 'REVISION_CONFLICT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
