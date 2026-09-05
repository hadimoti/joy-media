import {
  applyTransaction,
  applyGraphTransaction,
  revertGraphTransaction,
  applyArtifactTransaction,
  revertArtifactTransaction,
  EMPTY_ARTIFACT_STORE,
} from '@joy-media/commands';
import type {
  CommandTransaction,
  GraphTransaction,
  GraphTransactionRecord,
  ArtifactStore,
  ArtifactTransaction,
  ArtifactTransactionRecord,
} from '@joy-media/commands';
import {
  applyVisualObjectProjectTransaction,
  VisualObjectProjectHistory,
} from '@joy-media/property-system';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import {
  BrowserProjectStore,
  LocalProjectPersistence,
  PersistenceError,
} from '@joy-media/project-persistence';
import type { BrowserKeyValueStore, PersistenceAdapter } from '@joy-media/project-persistence';
import {
  validateJoyProjectV1,
  validateSpikeProject,
  validateWorkflowGraph,
  readDualLensFlags,
  EMPTY_WORKFLOW_GRAPH,
} from '@joy-media/project-schema';
import type { JoyProjectV1, SpikeProject, WorkflowGraphV2 } from '@joy-media/project-schema';
import type { ProjectRevisionId } from '@joy-media/agent-tools';
import { EditorCommandController } from './command-controller.js';
import {
  agentIdempotencyStorageKey,
  BrowserAgentIdempotencyStore,
  type StagedExecutionReceiptWrite,
} from './agent-idempotency-store.js';
import { createExecutionReceipt, type ExecutionReceipt } from './execution-receipt.js';

export interface HistoryEntry {
  readonly id: string;
  readonly source: 'timeline' | 'visual-object' | 'graph' | 'artifact' | 'compound' | 'document';
  readonly label: string;
  /** Present when this entry is past (`undo`) or future (`redo`) relative to the cursor. */
  readonly direction: 'undo' | 'redo' | 'current';
  readonly commandCount: number;
  readonly sequence: number;
}

/**
 * `document-snapshot` exists because a whole-document replacement has no
 * command form and therefore no inverse the object history can compute. The
 * session keeps the before/after pair itself so it can still be undone.
 */
type EditorOperation = 'timeline' | 'visual-object' | 'document-snapshot' | 'graph' | 'artifact';

/**
 * The graph needs an id to share the persistence adapter shape, and the adapter
 * needs a schema version; wrapping it keeps both without inventing an id field
 * on `WorkflowGraphV2`, which is a value, not a document.
 */
interface PersistedGraphDocument {
  readonly id: string;
  readonly graph: WorkflowGraphV2;
}

interface PersistedArtifactDocument {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly store: ArtifactStore;
}

export const WORKFLOW_GRAPH_LOG_KEY = 'joy-media.workflow-graph-log.v1';
export const CREATIVE_ARTIFACT_LOG_KEY = 'joy-media.creative-artifact-log.v1';
const TIMELINE_PROJECT_LOG_KEY = 'joy-media.timeline-project-log.v1';
const VISUAL_OBJECT_PROJECT_LOG_KEY = 'joy-media.visual-object-project-log.v1';
const COMPOUND_WRITE_JOURNAL_PREFIX = 'joy-media.editor-compound-write.v1';

type CompoundPersistenceStorageKind = 'project-log' | 'agent-idempotency';

interface CompoundPersistencePlan {
  readonly storageKey: string;
  readonly projectId: string;
  /** Omitted for the established project-log participants. */
  readonly storageKind?: CompoundPersistenceStorageKind;
  readonly persist: () => void;
  /** In-memory commits are deliberately deferred until every durable write succeeds. */
  readonly commit: () => void;
}

interface CompoundWriteJournalEntry {
  readonly storageKey: string;
  readonly projectId: string;
  readonly storageKind: CompoundPersistenceStorageKind;
  readonly serialized: string | null;
}

interface CompoundWriteJournal {
  /** Version 1 journal entries had only project-log targets. */
  readonly version: 1 | 2;
  readonly state: 'prepared' | 'committed';
  readonly projectId: string;
  readonly previous: readonly CompoundWriteJournalEntry[];
}

interface PreparedCompoundDispatch {
  readonly operations: readonly EditorOperation[];
  readonly persistencePlans: readonly CompoundPersistencePlan[];
  readonly commandCount: number;
}

/** Inputs the editor binds into the durable receipt it commits with an edit. */
export interface AgentCompoundExecution {
  readonly executionId: string;
  readonly operationDigest: string;
  readonly baseRevision: string;
  readonly changedEntityIds: readonly string[];
}

/** Optional current-state seeds used when materializing a duplicated project. */
export interface EditorSessionSeed {
  readonly graph?: WorkflowGraphV2;
  readonly artifacts?: ArtifactStore;
}

/**
 * One user-visible history step.
 *
 * `operations` is a list because an approved specialist change set touches more
 * than one bus at once — it changes the creative document *and* records the
 * change set as an artifact. Those have to undo together or the project is left
 * holding a record of a change that is no longer applied.
 */
interface HistoryStackEntry {
  readonly operations: readonly EditorOperation[];
  readonly label: string;
  readonly commandCount: number;
  readonly sequence: number;
}

const timelineAdapter: PersistenceAdapter<SpikeProject, CommandTransaction> = {
  projectId: (project) => project.id,
  schemaVersion: (project) => project.schemaVersion,
  validate: validateSpikeProject,
  apply: (project, transaction) => applyTransaction(project, transaction).project,
};

const visualObjectAdapter: PersistenceAdapter<JoyProjectV1, VisualObjectTransaction> = {
  projectId: (project) => project.id,
  schemaVersion: (project) => project.schemaVersion,
  validate: validateJoyProjectV1,
  apply: applyVisualObjectProjectTransaction,
};

const artifactAdapter: PersistenceAdapter<PersistedArtifactDocument, ArtifactTransaction> = {
  projectId: (document) => document.id,
  schemaVersion: (document) => document.schemaVersion,
  // Commands already validate each artifact as they apply; the store as a whole
  // has no extra invariant, so re-walking it here would only duplicate work.
  validate: () => [],
  apply: (document, transaction) => ({
    ...document,
    store: applyArtifactTransaction(document.store, transaction).store,
  }),
};

const graphAdapter: PersistenceAdapter<PersistedGraphDocument, GraphTransaction> = {
  projectId: (document) => document.id,
  schemaVersion: (document) => document.graph.schemaVersion,
  validate: (document) => validateWorkflowGraph(document.graph, 'workflow'),
  apply: (document, transaction) => ({
    ...document,
    graph: applyGraphTransaction(document.graph, transaction).graph,
  }),
};

/**
 * Keeps the creative documents out of React state while still notifying the UI
 * after every durable local transaction. The two current schema slices retain
 * separate logs until timeline commands graduate to the v1 project document.
 */
export class EditorSession {
  readonly #storage: BrowserKeyValueStore;
  readonly #compoundJournalKey: string;
  readonly #timelinePersistence: LocalProjectPersistence<SpikeProject, CommandTransaction>;
  readonly #visualObjectPersistence: LocalProjectPersistence<JoyProjectV1, VisualObjectTransaction>;
  readonly #timeline: EditorCommandController;
  readonly #visualObjects: VisualObjectProjectHistory;
  readonly #undo: HistoryStackEntry[] = [];
  readonly #redo: HistoryStackEntry[] = [];
  readonly agentIdempotency: BrowserAgentIdempotencyStore;
  /** Recovery diagnostics surfaced to the workspace instead of discarded. */
  readonly recoveryWarnings: readonly string[];
  /** Dual Lens graph editing (ADR-0023). Off unless the flag says otherwise. */
  readonly graphEnabled: boolean;
  readonly #graphPersistence?: LocalProjectPersistence<PersistedGraphDocument, GraphTransaction>;
  /**
   * Per-family record stacks, like `EditorCommandController` and
   * `VisualObjectProjectHistory` keep. The user-visible stack is still the one
   * below; these only say *how* to reverse an entry it has already ordered.
   */
  readonly #graphUndo: GraphTransactionRecord[] = [];
  readonly #graphRedo: GraphTransactionRecord[] = [];
  readonly #artifactPersistence?: LocalProjectPersistence<
    PersistedArtifactDocument,
    ArtifactTransaction
  >;
  readonly #artifactUndo: ArtifactTransactionRecord[] = [];
  readonly #artifactRedo: ArtifactTransactionRecord[] = [];
  readonly #snapshotUndo: { before: JoyProjectV1; after: JoyProjectV1 }[] = [];
  readonly #snapshotRedo: { before: JoyProjectV1; after: JoyProjectV1 }[] = [];
  #artifactDocument: PersistedArtifactDocument;
  #artifactRevision: number;
  #graphDocument: PersistedGraphDocument;
  #timelineRevision: number;
  #visualObjectRevision: number;
  #graphRevision: number;
  #sequence = 0;
  /** A failed rollback leaves the journal as the only recovery authority. */
  #persistenceRecoveryRequired = false;

  constructor(
    storage: BrowserKeyValueStore,
    initialTimeline: SpikeProject,
    initialVisualProject: JoyProjectV1,
    initialSeed: EditorSessionSeed = {},
  ) {
    this.#storage = storage;
    this.#compoundJournalKey = compoundWriteJournalKey(initialTimeline.id);
    recoverPreparedCompoundWrite(storage, initialTimeline.id);
    this.#timelinePersistence = new LocalProjectPersistence(
      new BrowserProjectStore(storage, TIMELINE_PROJECT_LOG_KEY),
      timelineAdapter,
    );
    this.#visualObjectPersistence = new LocalProjectPersistence(
      new BrowserProjectStore(storage, VISUAL_OBJECT_PROJECT_LOG_KEY),
      visualObjectAdapter,
    );
    const timeline = recoverOrInitialize(this.#timelinePersistence, initialTimeline);
    // Never normalize persisted canvas dimensions on open. A 1920×1080 canvas
    // may be an intentional user-selected 16:9 aspect ratio; rewriting it to
    // portrait here would make aspect-ratio changes disappear after refresh.
    const visualObjects = recoverOrInitialize(this.#visualObjectPersistence, initialVisualProject);
    const recoveryWarnings = [...timeline.warnings, ...visualObjects.warnings];
    this.#timelineRevision = timeline.revision;
    this.#visualObjectRevision = visualObjects.revision;
    this.#timeline = new EditorCommandController(timeline.project);
    this.#visualObjects = new VisualObjectProjectHistory(visualObjects.project);
    this.agentIdempotency = new BrowserAgentIdempotencyStore(storage, initialTimeline.id);

    this.graphEnabled = readDualLensFlags(storage).graphEnabled;
    const emptyGraphDocument: PersistedGraphDocument = {
      id: initialTimeline.id,
      graph: initialSeed.graph ?? EMPTY_WORKFLOW_GRAPH,
    };
    if (this.graphEnabled) {
      this.#graphPersistence = new LocalProjectPersistence(
        new BrowserProjectStore(storage, WORKFLOW_GRAPH_LOG_KEY),
        graphAdapter,
      );
      const recovered = recoverOrInitialize(this.#graphPersistence, emptyGraphDocument);
      this.#graphDocument = recovered.project;
      this.#graphRevision = recovered.revision;
      recoveryWarnings.push(...recovered.warnings);
    } else {
      // No log is opened when the feature is off, so a disabled Dual Lens adds
      // no storage key and no recovery path — the flag's off state stays a
      // property of what is stored, not only of what is drawn.
      this.#graphDocument = emptyGraphDocument;
      this.#graphRevision = 0;
    }

    const emptyArtifactDocument: PersistedArtifactDocument = {
      id: initialTimeline.id,
      schemaVersion: 1,
      store: initialSeed.artifacts ?? EMPTY_ARTIFACT_STORE,
    };
    if (this.graphEnabled) {
      this.#artifactPersistence = new LocalProjectPersistence(
        new BrowserProjectStore(storage, CREATIVE_ARTIFACT_LOG_KEY),
        artifactAdapter,
      );
      const recovered = recoverOrInitialize(this.#artifactPersistence, emptyArtifactDocument);
      this.#artifactDocument = recovered.project;
      this.#artifactRevision = recovered.revision;
      recoveryWarnings.push(...recovered.warnings);
    } else {
      this.#artifactDocument = emptyArtifactDocument;
      this.#artifactRevision = 0;
    }
    this.recoveryWarnings = recoveryWarnings;
  }

  get timelineProject(): SpikeProject {
    return this.#timeline.project;
  }

  get visualProject(): JoyProjectV1 {
    return this.#visualObjects.present;
  }

  /**
   * Durable, opaque revision id for the complete local creative document.
   *
   * Both component revisions come from the verified persistence logs and are
   * recovered on reopen. The string shape is intentionally an implementation
   * detail; agent envelopes compare it as an opaque ADR-0012-compatible id.
   */
  get projectRevisionId(): ProjectRevisionId {
    return encodeProjectRevision(
      this.timelineProject.id,
      this.#timelineRevision,
      this.#visualObjectRevision,
      this.#graphRevision,
      this.#artifactRevision,
    );
  }

  get workflowGraph(): WorkflowGraphV2 {
    return this.#graphDocument.graph;
  }

  get artifacts(): ArtifactStore {
    return this.#artifactDocument.store;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get historyEntries(): readonly HistoryEntry[] {
    const cursorSequence = this.historyCursorSequence;
    // Photoshop-style linear strip: Document → past → current tip → future redo states.
    const document: HistoryEntry = {
      id: 'history-document',
      source: 'document',
      label: 'Document',
      direction: cursorSequence === 0 ? 'current' : 'undo',
      commandCount: 0,
      sequence: 0,
    };
    const pastRows: HistoryEntry[] = this.#undo.map((e, index) => {
      const isTip = index === this.#undo.length - 1;
      return this.#toEntry(e, isTip ? 'current' : 'undo');
    });
    const futureRows = [...this.#redo].reverse().map((e) => this.#toEntry(e, 'redo'));
    if (cursorSequence === 0) {
      return [document, ...futureRows];
    }
    return [document, ...pastRows, ...futureRows];
  }

  /** Sequence of the present state (0 = empty document / no commits). */
  get historyCursorSequence(): number {
    const tip = this.#undo[this.#undo.length - 1];
    return tip?.sequence ?? 0;
  }

  /**
   * Jump to a history restore point (Photoshop-style). Undoes or redoes until
   * `historyCursorSequence === sequence`.
   */
  jumpToHistory(sequence: number): void {
    if (!Number.isFinite(sequence) || sequence < 0) return;
    const known =
      sequence === 0 ||
      this.#undo.some((e) => e.sequence === sequence) ||
      this.#redo.some((e) => e.sequence === sequence);
    if (!known) return;
    let guard = this.#undo.length + this.#redo.length + 2;
    while (this.historyCursorSequence > sequence && this.canUndo && guard-- > 0) {
      this.undo();
    }
    guard = this.#undo.length + this.#redo.length + 2;
    while (this.historyCursorSequence < sequence && this.canRedo && guard-- > 0) {
      this.redo();
    }
  }

  #toEntry(entry: HistoryStackEntry, direction: 'undo' | 'redo' | 'current'): HistoryEntry {
    return {
      id: `history-${entry.sequence}`,
      source:
        entry.operations.length > 1
          ? 'compound'
          : entry.operations[0] === 'document-snapshot'
            ? 'visual-object'
            : (entry.operations[0] ?? 'timeline'),
      label: entry.label,
      direction,
      commandCount: entry.commandCount,
      sequence: entry.sequence,
    };
  }

  dispatchTimeline(transaction: CommandTransaction): SpikeProject {
    this.#assertPersistenceReady();
    const before = this.#timeline.project;
    // Validate and persist before advancing the live history cursor. A failed
    // localStorage write must leave both the document and Undo stack intact.
    applyTransaction(before, transaction);
    this.#timelinePersistence.saveTransaction(before, transaction, false);
    const project = this.#timeline.dispatch(transaction);
    this.#timelineRevision += 1;
    this.#record('timeline', transaction.label, transaction.commands.length);
    return project;
  }

  dispatchVisualObjects(transaction: VisualObjectTransaction): JoyProjectV1 {
    this.#assertPersistenceReady();
    const before = this.#visualObjects.present;
    applyVisualObjectProjectTransaction(before, transaction);
    this.#visualObjectPersistence.saveTransaction(before, transaction, false);
    const project = this.#visualObjects.apply(transaction);
    this.#visualObjectRevision += 1;
    this.#record('visual-object', transaction.label, transaction.commands.length);
    return project;
  }

  /**
   * Applies a graph transaction and records it on the same history as timeline
   * and document edits, so one Undo steps back through interleaved work in the
   * order it was done rather than per-lens.
   */
  dispatchGraph(transaction: GraphTransaction): WorkflowGraphV2 {
    this.#assertPersistenceReady();
    if (!this.graphEnabled) {
      throw new Error('workflow graph editing is disabled; enable the Dual Lens graph flag');
    }
    const before = this.#graphDocument;
    const result = applyGraphTransaction(before.graph, transaction);
    this.#graphPersistence?.saveTransaction(before, transaction, false);
    this.#graphDocument = { ...before, graph: result.graph };
    this.#graphRevision += 1;
    this.#graphUndo.push(result.record);
    this.#graphRedo.length = 0;
    this.#record('graph', transaction.label, transaction.commands.length);
    return result.graph;
  }

  /** Same history as every other family, so data-lane edits are one Undo too. */
  dispatchArtifacts(transaction: ArtifactTransaction): ArtifactStore {
    this.#assertPersistenceReady();
    if (!this.graphEnabled) {
      throw new Error('creative artifacts are disabled; enable the Dual Lens graph flag');
    }
    const before = this.#artifactDocument;
    const result = applyArtifactTransaction(before.store, transaction);
    this.#artifactPersistence?.saveTransaction(before, transaction, false);
    this.#artifactDocument = { ...before, store: result.store };
    this.#artifactRevision += 1;
    this.#artifactUndo.push(result.record);
    this.#artifactRedo.length = 0;
    this.#record('artifact', transaction.label, transaction.commands.length);
    return result.store;
  }

  /**
   * Applies changes across buses as one history step.
   *
   * An approved specialist change set both alters the creative document and
   * records itself as an artifact. Dispatching those separately would put two
   * entries on the stack, so undoing once would leave the project holding a
   * record of a change that is no longer applied — the halves must move
   * together or not at all.
   *
   * Each bus keeps its own inverse record, exactly as it does for a single
   * dispatch; the only thing that changes is that one history entry now names
   * several of them.
   */
  dispatchCompound(
    label: string,
    parts: {
      readonly document?: JoyProjectV1;
      readonly artifacts?: ArtifactTransaction;
      readonly timeline?: CommandTransaction;
    },
  ): void {
    this.#assertPersistenceReady();
    const prepared = this.#prepareCompound(parts);
    if (prepared.operations.length === 0) return;
    this.#commitPersistencePlans(prepared.persistencePlans);
    this.#recordCompound(prepared.operations, label, prepared.commandCount);
  }

  /**
   * Atomically binds one approved agent change set to its replay receipt.
   *
   * The receipt is deliberately another journal participant, rather than a
   * best-effort write after the edit. A storage failure therefore leaves both
   * the creative document and in-memory idempotency authority untouched.
   */
  commitAgentCompound(
    label: string,
    parts: {
      readonly document?: JoyProjectV1;
      readonly artifacts?: ArtifactTransaction;
      readonly timeline?: CommandTransaction;
    },
    execution: AgentCompoundExecution,
  ): ExecutionReceipt {
    this.#assertPersistenceReady();
    if (execution.baseRevision !== this.projectRevisionId)
      throw new Error(
        `JOY_CODE_STALE_REVISION: expected ${execution.baseRevision}, got ${this.projectRevisionId}`,
      );
    if (this.agentIdempotency.getExecutionReceipt(execution.executionId) !== undefined)
      throw new Error(`JOY_CODE_EXECUTION_EXISTS: ${execution.executionId}`);

    const prepared = this.#prepareCompound(parts);
    if (prepared.operations.length === 0)
      throw new Error(
        'JOY_CODE_EMPTY_COMMIT: an execution receipt requires a durable editor change',
      );

    // A history sequence is the only single-session writer ordering available
    // at this seam. It binds the receipt to the exact local undo entry, but it
    // is not presented as cross-tab authority; Web Locks and a durable writer
    // fence remain a later F2 slice.
    const sequence = this.#sequence + 1;
    const receipt = createExecutionReceipt({
      executionId: execution.executionId,
      projectId: this.timelineProject.id,
      operationDigest: execution.operationDigest,
      baseRevision: execution.baseRevision,
      resultRevision: this.#projectRevisionAfter(prepared.operations),
      writerFence: sequence,
      changedEntityIds: execution.changedEntityIds,
      undoEntryId: `history-${sequence}`,
    });
    const stagedReceipt = this.agentIdempotency.stageExecutionReceipt(receipt);
    this.#commitPersistencePlans([
      ...prepared.persistencePlans,
      agentIdempotencyPersistencePlan(this.timelineProject.id, stagedReceipt),
    ]);
    this.#recordCompound(prepared.operations, label, prepared.commandCount);
    return receipt;
  }

  #prepareCompound(parts: {
    readonly document?: JoyProjectV1;
    readonly artifacts?: ArtifactTransaction;
    readonly timeline?: CommandTransaction;
  }): PreparedCompoundDispatch {
    const operations: EditorOperation[] = [];
    const persistencePlans: CompoundPersistencePlan[] = [];
    let commandCount = 0;

    // Everything that can fail is checked before anything is written. Applying
    // the document and then throwing on the artifacts would leave a change that
    // is persisted, unrecorded, and therefore impossible to undo — the exact
    // split this method exists to prevent.
    if (parts.artifacts !== undefined && !this.graphEnabled) {
      throw new Error('creative artifacts are disabled; enable the Dual Lens graph flag');
    }
    const artifactResult =
      parts.artifacts === undefined
        ? undefined
        : applyArtifactTransaction(this.#artifactDocument.store, parts.artifacts);
    if (parts.timeline !== undefined) {
      // Pure: throws on an invalid command without touching the live project.
      applyTransaction(this.#timeline.project, parts.timeline);
      const before = this.#timeline.project;
      const transaction = parts.timeline;
      persistencePlans.push({
        storageKey: TIMELINE_PROJECT_LOG_KEY,
        projectId: before.id,
        persist: () => {
          this.#timelinePersistence.saveTransaction(before, transaction, false);
        },
        commit: () => {
          this.#timeline.dispatch(transaction);
          this.#timelineRevision += 1;
        },
      });
      operations.push('timeline');
      commandCount += parts.timeline.commands.length;
    }

    if (parts.document !== undefined) {
      const before = this.#visualObjects.present;
      const document = parts.document;
      // A replacement has no command form, so it persists as a snapshot; an
      // empty transaction would replay to the old document on reload.
      persistencePlans.push({
        storageKey: VISUAL_OBJECT_PROJECT_LOG_KEY,
        projectId: before.id,
        persist: () => {
          this.#visualObjectPersistence.saveSnapshot(document, false);
        },
        commit: () => {
          this.#visualObjects.replacePresent(document);
          this.#visualObjectRevision += 1;
          this.#snapshotUndo.push({ before, after: document });
          this.#snapshotRedo.length = 0;
        },
      });
      operations.push('document-snapshot');
    }

    if (parts.artifacts !== undefined && artifactResult !== undefined) {
      const before = this.#artifactDocument;
      const transaction = parts.artifacts;
      const next = { ...before, store: artifactResult.store };
      persistencePlans.push({
        storageKey: CREATIVE_ARTIFACT_LOG_KEY,
        projectId: before.id,
        persist: () => {
          this.#artifactPersistence?.saveTransaction(before, transaction, false);
        },
        commit: () => {
          this.#artifactDocument = next;
          this.#artifactRevision += 1;
          this.#artifactUndo.push(artifactResult.record);
          this.#artifactRedo.length = 0;
        },
      });
      operations.push('artifact');
      commandCount += parts.artifacts.commands.length;
    }

    return { operations, persistencePlans, commandCount };
  }

  replaceVisualProject(next: JoyProjectV1): JoyProjectV1 {
    this.#assertPersistenceReady();
    const before = this.#visualObjects.present;
    // Was persisting an empty transaction, which the object adapter rejects and
    // which would have replayed to the previous document even if it did not.
    const project = this.#visualObjectPersistence.saveSnapshot(next, false);
    this.#visualObjects.replacePresent(project);
    this.#visualObjectRevision += 1;
    // Whole-document replacement is not represented by a visual-object command.
    // Keep its before/after pair on the snapshot stack so History → Document
    // can undo it without asking object history to undo a record it never saw.
    this.#snapshotUndo.push({ before, after: project });
    this.#snapshotRedo.length = 0;
    this.#record('document-snapshot', 'Replace project document', 0);
    return project;
  }

  /**
   * Persists derived/runtime metadata without inserting a second creative
   * history entry. This is used for canonical bookkeeping that follows an
   * already-recorded edit (for example creating default audio rows for newly
   * inserted timeline clips) so one Undo still reverses the user's action.
   */
  synchronizeVisualProject(next: JoyProjectV1): JoyProjectV1 {
    this.#assertPersistenceReady();
    // Persist and validate before swapping the live document. Quota or schema
    // failures must leave the in-memory session on the last durable revision.
    const project = this.#visualObjectPersistence.saveSnapshot(next, false);
    this.#visualObjects.replacePresent(project);
    this.#visualObjectRevision += 1;
    return project;
  }

  /** Persist project metadata without adding a creative undo entry. */
  renameProjectTitle(title: string): JoyProjectV1 {
    this.#assertPersistenceReady();
    const next = { ...this.#visualObjects.present, title, updatedAt: new Date().toISOString() };
    this.#visualObjectPersistence.saveSnapshot(next, false);
    this.#visualObjects.replacePresent(next);
    this.#visualObjectRevision += 1;
    return next;
  }

  undo(): void {
    const entry = this.#undo.at(-1);
    if (entry === undefined) return;
    // Reverse order: a compound applied document-then-artifact must undo
    // artifact-then-document, or the halves come apart.
    const plans = [...entry.operations].reverse().map((operation) => this.#undoPlan(operation));
    this.#commitPersistencePlans(plans);
    this.#undo.pop();
    this.#redo.push(entry);
  }

  #undoPlan(operation: EditorOperation): CompoundPersistencePlan {
    if (operation === 'document-snapshot') {
      const record = this.#snapshotUndo.at(-1);
      if (record === undefined) throw missingHistoryRecord('Undo', operation);
      return {
        storageKey: VISUAL_OBJECT_PROJECT_LOG_KEY,
        projectId: record.before.id,
        persist: () => {
          this.#visualObjectPersistence.saveSnapshot(record.before, false);
        },
        commit: () => {
          this.#visualObjects.replacePresent(record.before);
          this.#snapshotUndo.pop();
          this.#visualObjectRevision += 1;
          this.#snapshotRedo.push(record);
        },
      };
    }
    if (operation === 'timeline') {
      const before = this.#timeline.project;
      const record = this.#timeline.undoRecords[0];
      if (record === undefined) throw missingHistoryRecord('Undo', operation);
      const transaction = { label: `Undo ${record.label}`, commands: record.inverses };
      return {
        storageKey: TIMELINE_PROJECT_LOG_KEY,
        projectId: before.id,
        persist: () => {
          this.#timelinePersistence.saveTransaction(before, transaction, false);
        },
        commit: () => {
          this.#timeline.undoWithRecord();
          this.#timelineRevision += 1;
        },
      };
    }
    if (operation === 'graph') {
      const record = this.#graphUndo.at(-1);
      if (record === undefined) throw missingHistoryRecord('Undo', operation);
      const before = this.#graphDocument;
      const next = { ...before, graph: revertGraphTransaction(before.graph, record) };
      const transaction = { label: `Undo ${record.label}`, commands: record.inverses };
      return {
        storageKey: WORKFLOW_GRAPH_LOG_KEY,
        projectId: before.id,
        persist: () => {
          this.#graphPersistence?.saveTransaction(before, transaction, false);
        },
        commit: () => {
          this.#graphDocument = next;
          this.#graphUndo.pop();
          this.#graphRevision += 1;
          this.#graphRedo.push(record);
        },
      };
    }
    if (operation === 'artifact') {
      const record = this.#artifactUndo.at(-1);
      if (record === undefined) throw missingHistoryRecord('Undo', operation);
      const before = this.#artifactDocument;
      const next = {
        ...before,
        store: revertArtifactTransaction(before.store, record),
      };
      const transaction = { label: `Undo ${record.label}`, commands: record.inverses };
      return {
        storageKey: CREATIVE_ARTIFACT_LOG_KEY,
        projectId: before.id,
        persist: () => {
          this.#artifactPersistence?.saveTransaction(before, transaction, false);
        },
        commit: () => {
          this.#artifactDocument = next;
          this.#artifactUndo.pop();
          this.#artifactRevision += 1;
          this.#artifactRedo.push(record);
        },
      };
    }
    const before = this.#visualObjects.present;
    const record = this.#visualObjects.undoRecords[0];
    if (record === undefined) throw missingHistoryRecord('Undo', operation);
    return {
      storageKey: VISUAL_OBJECT_PROJECT_LOG_KEY,
      projectId: before.id,
      persist: () => {
        this.#visualObjectPersistence.saveTransaction(before, record.inverses, false);
      },
      commit: () => {
        this.#visualObjects.undo();
        this.#visualObjectRevision += 1;
      },
    };
  }

  redo(): void {
    const entry = this.#redo.at(-1);
    if (entry === undefined) return;
    const plans = entry.operations.map((operation) => this.#redoPlan(operation));
    this.#commitPersistencePlans(plans);
    this.#redo.pop();
    this.#undo.push(entry);
  }

  #redoPlan(operation: EditorOperation): CompoundPersistencePlan {
    if (operation === 'document-snapshot') {
      const record = this.#snapshotRedo.at(-1);
      if (record === undefined) throw missingHistoryRecord('Redo', operation);
      return {
        storageKey: VISUAL_OBJECT_PROJECT_LOG_KEY,
        projectId: record.after.id,
        persist: () => {
          this.#visualObjectPersistence.saveSnapshot(record.after, false);
        },
        commit: () => {
          this.#visualObjects.replacePresent(record.after);
          this.#snapshotRedo.pop();
          this.#visualObjectRevision += 1;
          this.#snapshotUndo.push(record);
        },
      };
    }
    if (operation === 'timeline') {
      const before = this.#timeline.project;
      const record = this.#timeline.redoRecords[0];
      if (record === undefined) throw missingHistoryRecord('Redo', operation);
      const transaction = { label: `Redo ${record.label}`, commands: record.commands };
      return {
        storageKey: TIMELINE_PROJECT_LOG_KEY,
        projectId: before.id,
        persist: () => {
          this.#timelinePersistence.saveTransaction(before, transaction, false);
        },
        commit: () => {
          this.#timeline.redoWithRecord();
          this.#timelineRevision += 1;
        },
      };
    }
    if (operation === 'graph') {
      const record = this.#graphRedo.at(-1);
      if (record === undefined) throw missingHistoryRecord('Redo', operation);
      const before = this.#graphDocument;
      const next = {
        ...before,
        graph: applyGraphTransaction(before.graph, {
          label: record.label,
          commands: record.commands,
        }).graph,
      };
      const transaction = { label: `Redo ${record.label}`, commands: record.commands };
      return {
        storageKey: WORKFLOW_GRAPH_LOG_KEY,
        projectId: before.id,
        persist: () => {
          this.#graphPersistence?.saveTransaction(before, transaction, false);
        },
        commit: () => {
          this.#graphDocument = next;
          this.#graphRedo.pop();
          this.#graphRevision += 1;
          this.#graphUndo.push(record);
        },
      };
    }
    if (operation === 'artifact') {
      const record = this.#artifactRedo.at(-1);
      if (record === undefined) throw missingHistoryRecord('Redo', operation);
      const before = this.#artifactDocument;
      const next = {
        ...before,
        store: applyArtifactTransaction(before.store, {
          label: record.label,
          commands: record.commands,
        }).store,
      };
      const transaction = { label: `Redo ${record.label}`, commands: record.commands };
      return {
        storageKey: CREATIVE_ARTIFACT_LOG_KEY,
        projectId: before.id,
        persist: () => {
          this.#artifactPersistence?.saveTransaction(before, transaction, false);
        },
        commit: () => {
          this.#artifactDocument = next;
          this.#artifactRedo.pop();
          this.#artifactRevision += 1;
          this.#artifactUndo.push(record);
        },
      };
    }
    const before = this.#visualObjects.present;
    const record = this.#visualObjects.redoRecords[0];
    if (record === undefined) throw missingHistoryRecord('Redo', operation);
    return {
      storageKey: VISUAL_OBJECT_PROJECT_LOG_KEY,
      projectId: before.id,
      persist: () => {
        this.#visualObjectPersistence.saveTransaction(before, record.transaction, false);
      },
      commit: () => {
        this.#visualObjects.redo();
        this.#visualObjectRevision += 1;
      },
    };
  }

  #projectRevisionAfter(operations: readonly EditorOperation[]): ProjectRevisionId {
    return encodeProjectRevision(
      this.timelineProject.id,
      this.#timelineRevision + Number(operations.includes('timeline')),
      this.#visualObjectRevision + Number(operations.includes('document-snapshot')),
      this.#graphRevision + Number(operations.includes('graph')),
      this.#artifactRevision + Number(operations.includes('artifact')),
    );
  }

  #assertPersistenceReady(): void {
    if (!this.#persistenceRecoveryRequired) return;
    throw new PersistenceError(
      'PERSISTENCE_RECOVERY_REQUIRED',
      'a previous compound write requires recovery; reopen the project before making another change',
    );
  }

  /**
   * localStorage updates one key at a time, while an approved change can span
   * several project logs. The prepared journal makes those writes recoverable:
   * live histories advance only after every append succeeds, and a crash or a
   * later write failure restores the exact pre-commit bytes before recovery.
   */
  #commitPersistencePlans(plans: readonly CompoundPersistencePlan[]): void {
    if (plans.length === 0) return;
    this.#assertPersistenceReady();
    if (plans.length === 1) {
      plans[0]!.persist();
      plans[0]!.commit();
      return;
    }

    const persistenceTargets = [
      ...new Map(
        plans.map((plan) => [
          `${plan.storageKind ?? 'project-log'}\0${plan.storageKey}\0${plan.projectId}`,
          plan,
        ]),
      ).values(),
    ];
    const prepared: CompoundWriteJournal = {
      version: 2,
      state: 'prepared',
      projectId: this.timelineProject.id,
      previous: persistenceTargets.map((plan) => {
        const storageKind = plan.storageKind ?? 'project-log';
        return {
          storageKey: plan.storageKey,
          projectId: plan.projectId,
          storageKind,
          serialized: storedPersistenceBytes(
            this.#storage,
            plan.storageKey,
            plan.projectId,
            storageKind,
          ),
        };
      }),
    };
    this.#storage.setItem(this.#compoundJournalKey, JSON.stringify(prepared));
    try {
      for (const plan of plans) plan.persist();
      this.#storage.setItem(
        this.#compoundJournalKey,
        JSON.stringify({ ...prepared, state: 'committed' as const }),
      );
    } catch (error) {
      try {
        restoreCompoundWrite(this.#storage, prepared);
        resolveCompoundWriteJournal(this.#storage, this.#compoundJournalKey, prepared);
      } catch (rollbackError) {
        this.#persistenceRecoveryRequired = true;
        throw new PersistenceError(
          'PERSISTENCE_ATOMIC_ROLLBACK_PENDING',
          `compound write failed and requires reload recovery: ${errorMessage(error)}; rollback: ${errorMessage(rollbackError)}`,
        );
      }
      throw error;
    }

    for (const plan of plans) plan.commit();
    bestEffortRemove(this.#storage, this.#compoundJournalKey);
  }

  #record(operation: EditorOperation, label: string, commandCount: number): void {
    this.#recordCompound([operation], label, commandCount);
  }

  #recordCompound(
    operations: readonly EditorOperation[],
    label: string,
    commandCount: number,
  ): void {
    this.#undo.push({ operations, label, commandCount, sequence: ++this.#sequence });
    // Every per-bus redo stack is cleared, not just the one that was dispatched.
    // Clearing only the unified stack leaves the others holding records no
    // history entry refers to any more — harmless today because they sit below
    // the top, but they would surface the moment the stacks fall out of step.
    this.#redo.length = 0;
    this.#graphRedo.length = 0;
    this.#artifactRedo.length = 0;
    this.#snapshotRedo.length = 0;
  }
}

function agentIdempotencyPersistencePlan(
  projectId: string,
  stagedReceipt: StagedExecutionReceiptWrite,
): CompoundPersistencePlan {
  const storageKey = agentIdempotencyStorageKey(projectId);
  if (stagedReceipt.storageKey !== storageKey || stagedReceipt.receipt.projectId !== projectId)
    throw new RangeError('agent receipt sidecar is not bound to this editor project');
  return {
    storageKey,
    projectId,
    storageKind: 'agent-idempotency',
    persist: stagedReceipt.persist,
    commit: stagedReceipt.commit,
  };
}

function compoundWriteJournalKey(projectId: string): string {
  return `${COMPOUND_WRITE_JOURNAL_PREFIX}:${encodeURIComponent(projectId)}`;
}

function recoverPreparedCompoundWrite(storage: BrowserKeyValueStore, projectId: string): void {
  const journalKey = compoundWriteJournalKey(projectId);
  const serialized = storage.getItem(journalKey);
  if (serialized === null) return;
  const journal = parseCompoundWriteJournal(serialized, projectId);
  if (journal === undefined) {
    bestEffortRemove(storage, journalKey);
    return;
  }
  if (journal.state === 'prepared') {
    restoreCompoundWrite(storage, journal);
    resolveCompoundWriteJournal(storage, journalKey, journal);
    return;
  }
  bestEffortRemove(storage, journalKey);
}

function restoreCompoundWrite(storage: BrowserKeyValueStore, journal: CompoundWriteJournal): void {
  for (const previous of journal.previous) {
    if (previous.storageKind === 'agent-idempotency') {
      restoreRawPersistenceBytes(storage, previous.storageKey, previous.serialized);
      continue;
    }
    const database = projectDatabase(storage.getItem(previous.storageKey));
    const projects = { ...database.projects };
    if (previous.serialized === null) delete projects[previous.projectId];
    else projects[previous.projectId] = JSON.parse(previous.serialized) as unknown;
    storage.setItem(previous.storageKey, JSON.stringify({ projects }));
  }
}

/** Mark rollback resolved before removal, so a failed remove can never replay it. */
function resolveCompoundWriteJournal(
  storage: BrowserKeyValueStore,
  journalKey: string,
  journal: CompoundWriteJournal,
): void {
  storage.setItem(journalKey, JSON.stringify({ ...journal, state: 'committed' as const }));
  bestEffortRemove(storage, journalKey);
}

function bestEffortRemove(storage: BrowserKeyValueStore, key: string): void {
  try {
    storage.removeItem?.(key);
  } catch {
    // A committed marker is harmless and will be removed on the next open.
  }
}

function storedPersistenceBytes(
  storage: BrowserKeyValueStore,
  storageKey: string,
  projectId: string,
  storageKind: CompoundPersistenceStorageKind,
): string | null {
  if (storageKind === 'agent-idempotency') return storage.getItem(storageKey);
  const project = projectDatabase(storage.getItem(storageKey)).projects[projectId];
  return project === undefined ? null : JSON.stringify(project);
}

/**
 * BrowserKeyValueStore historically allowed a set/get-only shim. When it has
 * no removeItem capability, the legacy empty-array payload is the exact empty
 * idempotency state and keeps a rolled-back receipt logically absent.
 */
function restoreRawPersistenceBytes(
  storage: BrowserKeyValueStore,
  storageKey: string,
  serialized: string | null,
): void {
  if (serialized !== null) {
    storage.setItem(storageKey, serialized);
    return;
  }
  if (storage.removeItem !== undefined) {
    try {
      storage.removeItem(storageKey);
      return;
    } catch {
      // Use the valid legacy empty representation as the set/get-only fallback.
    }
  }
  storage.setItem(storageKey, '[]');
}

function projectDatabase(serialized: string | null): { projects: Record<string, unknown> } {
  if (serialized === null) return { projects: {} };
  try {
    const parsed = JSON.parse(serialized) as { readonly projects?: unknown };
    if (
      parsed.projects === null ||
      typeof parsed.projects !== 'object' ||
      Array.isArray(parsed.projects)
    )
      throw new Error('project log has no projects object');
    return { projects: parsed.projects as Record<string, unknown> };
  } catch (error) {
    throw new PersistenceError(
      'PERSISTENCE_ATOMIC_LOG_CORRUPT',
      `cannot protect a corrupt project log: ${errorMessage(error)}`,
    );
  }
}

function parseCompoundWriteJournal(
  serialized: string,
  projectId: string,
): CompoundWriteJournal | undefined {
  try {
    const value = JSON.parse(serialized) as unknown;
    if (
      !isRecord(value) ||
      (value.version !== 1 && value.version !== 2) ||
      value.projectId !== projectId ||
      (value.state !== 'prepared' && value.state !== 'committed') ||
      !Array.isArray(value.previous)
    )
      return undefined;
    const version: 1 | 2 = value.version === 1 ? 1 : 2;
    const previous = value.previous.map((entry) =>
      parseCompoundWriteJournalEntry(entry, projectId, version),
    );
    if (previous.some((entry) => entry === undefined)) return undefined;
    return {
      version,
      state: value.state,
      projectId,
      previous: previous as readonly CompoundWriteJournalEntry[],
    };
  } catch {
    return undefined;
  }
}

function parseCompoundWriteJournalEntry(
  value: unknown,
  journalProjectId: string,
  journalVersion: 1 | 2,
): CompoundWriteJournalEntry | undefined {
  if (!isRecord(value)) return undefined;
  const storageKind =
    value.storageKind === undefined && journalVersion === 1 ? 'project-log' : value.storageKind;
  if (
    (storageKind !== 'project-log' && storageKind !== 'agent-idempotency') ||
    typeof value.storageKey !== 'string' ||
    typeof value.projectId !== 'string' ||
    value.projectId.length === 0 ||
    value.projectId.length > 256 ||
    (typeof value.serialized !== 'string' && value.serialized !== null)
  )
    return undefined;
  if (storageKind === 'project-log') {
    if (!PROJECT_LOG_STORAGE_KEYS.has(value.storageKey)) return undefined;
  } else if (
    value.projectId !== journalProjectId ||
    value.storageKey !== agentIdempotencyStorageKey(journalProjectId)
  ) {
    return undefined;
  }
  return {
    storageKey: value.storageKey,
    projectId: value.projectId,
    storageKind,
    serialized: value.serialized,
  };
}

const PROJECT_LOG_STORAGE_KEYS = new Set([
  TIMELINE_PROJECT_LOG_KEY,
  VISUAL_OBJECT_PROJECT_LOG_KEY,
  WORKFLOW_GRAPH_LOG_KEY,
  CREATIVE_ARTIFACT_LOG_KEY,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function missingHistoryRecord(direction: 'Undo' | 'Redo', operation: EditorOperation): Error {
  return new Error(`${direction} history is inconsistent for ${operation}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoverOrInitialize<P, T>(
  persistence: LocalProjectPersistence<P, T>,
  initial: P,
): { readonly project: P; readonly revision: number; readonly warnings: readonly string[] } {
  try {
    const recovered = persistence.recover(persistenceProjectId(initial));
    return {
      project: recovered.project,
      revision: recovered.revision,
      warnings: recovered.warnings,
    };
  } catch (error) {
    if (!(error instanceof PersistenceError) || error.code !== 'PERSISTENCE_NOT_FOUND') throw error;
    persistence.initialize(initial);
    return { project: initial, revision: 0, warnings: [] };
  }
}

function encodeProjectRevision(
  projectId: string,
  timelineRevision: number,
  visualObjectRevision: number,
  graphRevision: number,
  artifactRevision: number,
): ProjectRevisionId {
  // Graph and artifacts are part of the creative document, so editing either has
  // to move the revision an agent plan was built against — otherwise a plan made
  // before a node or a script changed would still look current and commit
  // against stale structure.
  return `local-revision:v1:${encodeURIComponent(projectId)}:timeline=${timelineRevision}:document=${visualObjectRevision}:graph=${graphRevision}:artifacts=${artifactRevision}`;
}

function persistenceProjectId(project: unknown): string {
  if (project === null || typeof project !== 'object' || !('id' in project))
    throw new TypeError('project id is required');
  const id = (project as { id: unknown }).id;
  if (typeof id !== 'string') throw new TypeError('project id is required');
  return id;
}
