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
  validateCreativeArtifact,
  validateArtifactContentRef,
  validateArtifactProvenance,
  readDualLensFlags,
  EMPTY_WORKFLOW_GRAPH,
  emptyLookInstancesDocument,
  validateLookInstancesDocument,
} from '@joy-media/project-schema';
import type {
  JoyProjectV1,
  LookInstancesDocument,
  SpikeProject,
  WorkflowGraphV2,
} from '@joy-media/project-schema';
import type { ProjectRevisionId } from '@joy-media/agent-tools';
import { EditorCommandController } from './command-controller.js';
import {
  agentIdempotencyStorageKey,
  BrowserAgentIdempotencyStore,
  isStrictAgentIdempotencyStorageState,
  type StagedExecutionReceiptWrite,
} from './agent-idempotency-store.js';
import { createExecutionReceipt, type ExecutionReceipt } from './execution-receipt.js';

export interface HistoryEntry {
  readonly id: string;
  readonly source:
    'timeline' | 'visual-object' | 'graph' | 'artifact' | 'look-instance' | 'compound' | 'document';
  readonly label: string;
  /** Present when this entry is past (`undo`) or future (`redo`) relative to the cursor. */
  readonly direction: 'undo' | 'redo' | 'current';
  readonly commandCount: number;
  readonly sequence: number;
}

/**
 * `document-snapshot` and `look-instance` exist because a whole-document
 * replacement has no command form and therefore no inverse the object history
 * can compute. The session keeps the before/after pair itself so it can still
 * be undone.
 */
type EditorOperation =
  'timeline' | 'visual-object' | 'document-snapshot' | 'graph' | 'artifact' | 'look-instance';

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
export const LOOK_INSTANCES_LOG_KEY = 'joy-media.look-instances-log.v1';
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

/**
 * The editor currently persists its timeline and visual document under
 * different durable document ids. This scope binds each journal participant to
 * the one id it is allowed to restore; a journal for one open editor session
 * can never redirect a project-log write to another project's record.
 */
interface CompoundJournalScope {
  readonly timelineProjectId: string;
  readonly visualProjectId: string;
}

/** One prevalidated durable replacement used while restoring a prepared journal. */
interface CompoundRollbackWrite {
  readonly storageKey: string;
  readonly serialized: string | null;
  readonly raw: boolean;
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
  readonly lookInstances?: LookInstancesDocument;
}

/**
 * Optional capability supplied by the origin-wide writer gate.
 *
 * EditorSession deliberately depends on this narrow structural contract rather
 * than the browser lock implementation. That keeps the durable session
 * boundary testable while allowing the production ProjectWriterHandle to pass
 * through unchanged.
 */
export interface EditorSessionWriter {
  /** Strictly increasing durable fence allocated by the origin writer. */
  readonly fence: number;
  /** Throws once the originating writer lock has been released. */
  assertActive(): void;
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
  validate: (document) => validateArtifactStore(document.store),
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
 * Look Instances are persisted whole (snapshot only) — a Look apply / update /
 * detach always replaces the document as one value, so there is no transaction
 * algebra and `apply` is never reached. The before/after pair the compound
 * journal needs is kept on `#lookInstancesSnapshotUndo`, exactly like
 * `document-snapshot`.
 */
const lookInstancesAdapter: PersistenceAdapter<LookInstancesDocument, never> = {
  projectId: (document) => document.id,
  schemaVersion: (document) => document.schemaVersion,
  validate: (document) => validateLookInstancesDocument(document),
  apply: (document) => document,
};

/**
 * Keeps the creative documents out of React state while still notifying the UI
 * after every durable local transaction. The two current schema slices retain
 * separate logs until timeline commands graduate to the v1 project document.
 */
export class EditorSession {
  readonly #storage: BrowserKeyValueStore;
  readonly #writer: EditorSessionWriter | undefined;
  readonly #compoundJournalKey: string;
  readonly #compoundJournalScope: CompoundJournalScope;
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
  // Look Instances are not behind the Dual Lens flag — every project has this
  // log, empty until the first Look apply. Snapshot-only, like the visual
  // document replacement above.
  readonly #lookInstancesPersistence: LocalProjectPersistence<LookInstancesDocument, never>;
  readonly #lookInstancesSnapshotUndo: {
    before: LookInstancesDocument;
    after: LookInstancesDocument;
  }[] = [];
  readonly #lookInstancesSnapshotRedo: {
    before: LookInstancesDocument;
    after: LookInstancesDocument;
  }[] = [];
  #lookInstancesDocument: LookInstancesDocument;
  #lookInstancesRevision: number;
  /** False until the first Look write creates the log on disk (lazy init). */
  #lookInstancesLogInitialized: boolean;
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
    writer?: EditorSessionWriter,
  ) {
    this.#writer = writer;
    // Recovery can initialize a missing log or resolve a prepared compound
    // journal. It is therefore a write boundary, not an innocuous read-only
    // constructor step.
    this.#assertWriterActive();
    this.#storage = storage;
    this.#compoundJournalKey = compoundWriteJournalKey(initialTimeline.id);
    this.#compoundJournalScope = {
      timelineProjectId: initialTimeline.id,
      visualProjectId: initialVisualProject.id,
    };
    recoverPreparedCompoundWrite(storage, this.#compoundJournalScope);
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
    this.#lookInstancesPersistence = new LocalProjectPersistence(
      new BrowserProjectStore(storage, LOOK_INSTANCES_LOG_KEY),
      lookInstancesAdapter,
    );
    // A project that predates Look Instances has no log key. It loads as the
    // empty document held only in memory — the log is NOT created on open, so an
    // existing project is never rewritten just because this document was added.
    // The log is initialized lazily inside the first Look write's compound plan.
    // Keyed on the timeline project id, like the graph and artifact documents —
    // every per-project secondary document shares that id. (`entityBindings`
    // still resolve against the visual document's objects, see
    // `#assertLookInstanceReferencesResolve`.)
    const lookInstances = recoverLookInstancesOrEmpty(
      this.#lookInstancesPersistence,
      initialSeed.lookInstances ?? emptyLookInstancesDocument(initialTimeline.id),
    );
    this.#lookInstancesLogInitialized = lookInstances.persisted;
    // A materialized duplicate / import carries a populated seed — persist it
    // now (like the graph and artifact seeds) rather than leaving it lazy, so
    // the new project keeps its Looks on the next reopen.
    if (
      !lookInstances.persisted &&
      initialSeed.lookInstances !== undefined &&
      Object.keys(initialSeed.lookInstances.instances).length > 0
    ) {
      this.#lookInstancesPersistence.initialize(initialSeed.lookInstances);
      this.#lookInstancesLogInitialized = true;
    }
    const recoveryWarnings = [
      ...timeline.warnings,
      ...visualObjects.warnings,
      ...lookInstances.warnings,
    ];
    this.#timelineRevision = timeline.revision;
    this.#visualObjectRevision = visualObjects.revision;
    this.#lookInstancesDocument = lookInstances.document;
    this.#lookInstancesRevision = lookInstances.revision;
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
   * The canonical Look Instances document. A project that has never applied a
   * Look returns the empty document; the log itself is not created until the
   * first Look write.
   */
  get lookInstances(): LookInstancesDocument {
    return this.#lookInstancesDocument;
  }

  /**
   * Instance ids whose `entityBindings` no longer all resolve to a live visual
   * object — a bound object was deleted after the Look was applied. The
   * document still loads (a dangling reference is content, not corruption); the
   * L2 compiler skips an unresolved binding and the panel surfaces it as
   * "target removed — rebind or remove". A write that *introduces* a dangling
   * binding is rejected up front (see `#assertLookInstanceReferencesResolve`),
   * so this can only ever be the result of a later deletion, never a silent
   * apply-to-missing-object.
   */
  get orphanedLookInstanceIds(): readonly string[] {
    const live = this.#visualObjects.present.visualObjects;
    return Object.values(this.#lookInstancesDocument.instances)
      .filter((instance) =>
        Object.values(instance.entityBindings).some((target) => live[target] === undefined),
      )
      .map((instance) => instance.id);
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
      this.#lookInstancesRevision,
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
    this.#assertPersistenceReady();
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
    this.#requireGraphPersistence().saveTransaction(before, transaction, false);
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
    this.#requireArtifactPersistence().saveTransaction(before, transaction, false);
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
      readonly graph?: GraphTransaction;
      readonly artifacts?: ArtifactTransaction;
      readonly timeline?: CommandTransaction;
      readonly lookInstances?: LookInstancesDocument;
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
      readonly graph?: GraphTransaction;
      readonly artifacts?: ArtifactTransaction;
      readonly timeline?: CommandTransaction;
      readonly lookInstances?: LookInstancesDocument;
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

    // The origin writer fence survives this EditorSession's lifetime and is
    // the cross-tab ordering authority when the browser writer gate supplied
    // one. Keep the local history sequence for the undo entry identifier and
    // as the legacy no-writer fallback used by existing session-only callers.
    const sequence = this.#sequence + 1;
    const receipt = createExecutionReceipt({
      executionId: execution.executionId,
      projectId: this.timelineProject.id,
      operationDigest: execution.operationDigest,
      baseRevision: execution.baseRevision,
      resultRevision: this.#projectRevisionAfter(prepared.operations),
      writerFence: this.#writer?.fence ?? sequence,
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

  /**
   * Rejects a Look Instances write that would leave a NEW or CHANGED instance
   * pointing at a visual object (`entityBindings` target or `createdEntityId`)
   * that is not present in `visual`. This is the "never silently apply a Look
   * Instance to a missing object" guarantee, enforced at the one chokepoint
   * every Look apply / update / detach passes through.
   */
  #assertLookInstanceReferencesResolve(
    nextDocument: LookInstancesDocument,
    visual: JoyProjectV1,
  ): void {
    const current = this.#lookInstancesDocument.instances;
    for (const [id, instance] of Object.entries(nextDocument.instances)) {
      if (JSON.stringify(current[id]) === JSON.stringify(instance)) continue;
      const stored = current[id];
      // Only entity references this write ADDS or RETARGETS are checked. A
      // binding whose target is unchanged was already validated when it was
      // set, so an override-mark or a control-value update on an instance that
      // already dangles from an earlier deletion is not rejected — it stays
      // visible via `orphanedLookInstanceIds`.
      const isNewOrRetargeted = (entityId: string, key?: string): boolean =>
        stored === undefined || key === undefined || stored.entityBindings[key] !== entityId;
      const missing = [
        ...Object.entries(instance.entityBindings)
          .filter(([key, entityId]) => isNewOrRetargeted(entityId, key))
          .map(([, entityId]) => entityId),
        ...instance.createdEntityIds.filter((entityId) =>
          stored === undefined ? true : !stored.createdEntityIds.includes(entityId),
        ),
      ].filter((entityId) => visual.visualObjects[entityId] === undefined);
      if (missing.length > 0) {
        throw new PersistenceError(
          'PERSISTENCE_COMPOUND_LOOK_INSTANCE_DANGLING',
          `look instance "${id}" references visual object(s) that do not exist: ${[...new Set(missing)].join(', ')}`,
        );
      }
    }
  }

  #prepareCompound(parts: {
    readonly document?: JoyProjectV1;
    readonly graph?: GraphTransaction;
    readonly artifacts?: ArtifactTransaction;
    readonly timeline?: CommandTransaction;
    readonly lookInstances?: LookInstancesDocument;
  }): PreparedCompoundDispatch {
    const operations: EditorOperation[] = [];
    const persistencePlans: CompoundPersistencePlan[] = [];
    let commandCount = 0;

    // Everything that can fail is checked before anything is written. Applying
    // one domain and then throwing on another would leave a change that is
    // persisted, unrecorded, and therefore impossible to undo — the exact
    // split this method exists to prevent.
    if (parts.graph !== undefined && !this.graphEnabled) {
      throw new Error('workflow graph editing is disabled; enable the Dual Lens graph flag');
    }
    if (parts.artifacts !== undefined && !this.graphEnabled) {
      throw new Error('creative artifacts are disabled; enable the Dual Lens graph flag');
    }
    if (parts.document !== undefined) {
      const diagnostics = validateJoyProjectV1(parts.document);
      if (diagnostics.length > 0) {
        const first = diagnostics[0]!;
        throw new PersistenceError(
          'PERSISTENCE_COMPOUND_DOCUMENT_INVALID',
          `compound document is invalid: [${first.code}] ${first.message}`,
        );
      }
    }
    if (parts.lookInstances !== undefined) {
      const diagnostics = validateLookInstancesDocument(parts.lookInstances);
      if (diagnostics.length > 0) {
        const first = diagnostics[0]!;
        throw new PersistenceError(
          'PERSISTENCE_COMPOUND_LOOK_INSTANCES_INVALID',
          `compound look instances document is invalid: [${first.code}] ${first.message}`,
        );
      }
      // A Look Instance may never be created or changed to point at a visual
      // object that isn't in the document this same compound is writing (or the
      // current one if the compound leaves the visual document untouched).
      // Pre-existing instances that already dangle from an earlier deletion are
      // left alone — they surface via `orphanedLookInstanceIds`, they are not a
      // reason to reject an unrelated write.
      this.#assertLookInstanceReferencesResolve(
        parts.lookInstances,
        parts.document ?? this.#visualObjects.present,
      );
    }
    const graphResult =
      parts.graph === undefined
        ? undefined
        : applyGraphTransaction(this.#graphDocument.graph, parts.graph);
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

    if (parts.lookInstances !== undefined) {
      const before = this.#lookInstancesDocument;
      const nextDocument = parts.lookInstances;
      const initializeLog = !this.#lookInstancesLogInitialized;
      persistencePlans.push({
        storageKey: LOOK_INSTANCES_LOG_KEY,
        projectId: before.id,
        persist: () => {
          // Lazy creation: a legacy project's log is written for the first time
          // here, inside the prepared journal, so a crash rolls the log away
          // entirely (its pre-image was captured as absent).
          if (initializeLog) this.#lookInstancesPersistence.initialize(before);
          this.#lookInstancesPersistence.saveSnapshot(nextDocument, false);
        },
        commit: () => {
          this.#lookInstancesDocument = nextDocument;
          this.#lookInstancesRevision += 1;
          this.#lookInstancesLogInitialized = true;
          this.#lookInstancesSnapshotUndo.push({ before, after: nextDocument });
          this.#lookInstancesSnapshotRedo.length = 0;
        },
      });
      operations.push('look-instance');
    }

    if (parts.graph !== undefined && graphResult !== undefined) {
      const before = this.#graphDocument;
      const transaction = parts.graph;
      const next = { ...before, graph: graphResult.graph };
      const persistence = this.#requireGraphPersistence();
      persistencePlans.push({
        storageKey: WORKFLOW_GRAPH_LOG_KEY,
        projectId: before.id,
        persist: () => {
          persistence.saveTransaction(before, transaction, false);
        },
        commit: () => {
          this.#graphDocument = next;
          this.#graphRevision += 1;
          this.#graphUndo.push(graphResult.record);
          this.#graphRedo.length = 0;
        },
      });
      operations.push('graph');
      commandCount += parts.graph.commands.length;
    }

    if (parts.artifacts !== undefined && artifactResult !== undefined) {
      const before = this.#artifactDocument;
      const transaction = parts.artifacts;
      const next = { ...before, store: artifactResult.store };
      const persistence = this.#requireArtifactPersistence();
      persistencePlans.push({
        storageKey: CREATIVE_ARTIFACT_LOG_KEY,
        projectId: before.id,
        persist: () => {
          persistence.saveTransaction(before, transaction, false);
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
   * Replace the visual document AND write a Look Instances document that a
   * caller has already updated (e.g. marking `overriddenBindingIds` for a
   * manual or user-directed-agent edit that touched a Look-linked binding).
   * When the Look document is unchanged this is exactly `replaceVisualProject`;
   * otherwise both commit through one prepared-journal compound and one Undo
   * reverts them together (R2 / GAP 1b — override marking).
   */
  replaceVisualProjectWithLookOverrides(
    next: JoyProjectV1,
    nextLookInstances: LookInstancesDocument,
    label = 'Edit with Look override',
  ): JoyProjectV1 {
    this.#assertPersistenceReady();
    if (JSON.stringify(nextLookInstances) === JSON.stringify(this.#lookInstancesDocument)) {
      return this.replaceVisualProject(next);
    }
    const prepared = this.#prepareCompound({ document: next, lookInstances: nextLookInstances });
    this.#commitPersistencePlans(prepared.persistencePlans);
    this.#recordCompound(prepared.operations, label, prepared.commandCount);
    return this.#visualObjects.present;
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

  /**
   * Apply a server Look Instances document (R2 / GAP 1a) as a snapshot — no
   * history entry, exactly like `synchronizeVisualProject`. The hydration layer
   * only calls this when the local session is still at the observed revision and
   * the server actually carried a Look document, so it never silently drops a
   * populated local document from an absent remote value. An explicit empty
   * `{ instances: {} }` is a real state and legitimately clears the local one.
   */
  synchronizeLookInstances(next: LookInstancesDocument): void {
    this.#assertPersistenceReady();
    const diagnostics = validateLookInstancesDocument(next);
    if (diagnostics.length > 0) {
      throw new PersistenceError(
        'PERSISTENCE_LOOK_INSTANCES_SYNC_INVALID',
        `server Look Instances document is invalid: ${diagnostics[0]!.message}`,
      );
    }
    if (JSON.stringify(next) === JSON.stringify(this.#lookInstancesDocument)) return;
    if (!this.#lookInstancesLogInitialized) {
      this.#lookInstancesPersistence.initialize(this.#lookInstancesDocument);
      this.#lookInstancesLogInitialized = true;
    }
    this.#lookInstancesPersistence.saveSnapshot(next, false);
    this.#lookInstancesDocument = next;
    this.#lookInstancesRevision += 1;
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
    this.#assertPersistenceReady();
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
    if (operation === 'look-instance') {
      const record = this.#lookInstancesSnapshotUndo.at(-1);
      if (record === undefined) throw missingHistoryRecord('Undo', operation);
      return {
        storageKey: LOOK_INSTANCES_LOG_KEY,
        projectId: record.before.id,
        persist: () => {
          this.#lookInstancesPersistence.saveSnapshot(record.before, false);
        },
        commit: () => {
          this.#lookInstancesDocument = record.before;
          this.#lookInstancesSnapshotUndo.pop();
          this.#lookInstancesRevision += 1;
          this.#lookInstancesSnapshotRedo.push(record);
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
          this.#requireGraphPersistence().saveTransaction(before, transaction, false);
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
          this.#requireArtifactPersistence().saveTransaction(before, transaction, false);
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
    this.#assertPersistenceReady();
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
    if (operation === 'look-instance') {
      const record = this.#lookInstancesSnapshotRedo.at(-1);
      if (record === undefined) throw missingHistoryRecord('Redo', operation);
      return {
        storageKey: LOOK_INSTANCES_LOG_KEY,
        projectId: record.after.id,
        persist: () => {
          this.#lookInstancesPersistence.saveSnapshot(record.after, false);
        },
        commit: () => {
          this.#lookInstancesDocument = record.after;
          this.#lookInstancesSnapshotRedo.pop();
          this.#lookInstancesRevision += 1;
          this.#lookInstancesSnapshotUndo.push(record);
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
          this.#requireGraphPersistence().saveTransaction(before, transaction, false);
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
          this.#requireArtifactPersistence().saveTransaction(before, transaction, false);
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
      this.#lookInstancesRevision + Number(operations.includes('look-instance')),
    );
  }

  #assertPersistenceReady(): void {
    this.#assertWriterActive();
    if (!this.#persistenceRecoveryRequired) return;
    throw new PersistenceError(
      'PERSISTENCE_RECOVERY_REQUIRED',
      'a previous compound write requires recovery; reopen the project before making another change',
    );
  }

  #assertWriterActive(): void {
    this.#writer?.assertActive();
  }

  #requireGraphPersistence(): LocalProjectPersistence<PersistedGraphDocument, GraphTransaction> {
    if (this.#graphPersistence === undefined)
      throw new PersistenceError(
        'PERSISTENCE_GRAPH_UNAVAILABLE',
        'workflow graph persistence is unavailable while graph editing is enabled',
      );
    return this.#graphPersistence;
  }

  #requireArtifactPersistence(): LocalProjectPersistence<
    PersistedArtifactDocument,
    ArtifactTransaction
  > {
    if (this.#artifactPersistence === undefined)
      throw new PersistenceError(
        'PERSISTENCE_ARTIFACT_UNAVAILABLE',
        'creative artifact persistence is unavailable while artifact editing is enabled',
      );
    return this.#artifactPersistence;
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
        restoreCompoundWrite(this.#storage, prepared, this.#compoundJournalScope);
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
    this.#lookInstancesSnapshotRedo.length = 0;
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

function recoverPreparedCompoundWrite(
  storage: BrowserKeyValueStore,
  scope: CompoundJournalScope,
): void {
  const journalKey = compoundWriteJournalKey(scope.timelineProjectId);
  const serialized = storage.getItem(journalKey);
  if (serialized === null) return;
  const journal = parseCompoundWriteJournal(serialized, scope);
  if (journal === undefined) {
    // A journal exists precisely when one multi-store edit may be between its
    // old and new states. Deleting an unknown journal would turn that ambiguity
    // into a silent mixed-state acceptance. Preserve it for support/recovery
    // and refuse to open a writable session until the bytes are understood.
    throw new PersistenceError(
      'PERSISTENCE_ATOMIC_JOURNAL_CORRUPT',
      'cannot safely recover an unparseable compound write journal',
    );
  }
  if (journal.state === 'prepared') {
    restoreCompoundWrite(storage, journal, scope);
    resolveCompoundWriteJournal(storage, journalKey, journal);
    return;
  }
  bestEffortRemove(storage, journalKey);
}

function restoreCompoundWrite(
  storage: BrowserKeyValueStore,
  journal: CompoundWriteJournal,
  scope: CompoundJournalScope,
): void {
  // Do not start restoring before every rollback byte and every current target
  // has been checked. A prepared journal is our only recovery authority; a
  // lazy parse halfway through it could otherwise leave a permanently mixed
  // project even though we correctly preserved the journal.
  const writes = prepareCompoundRollbackWrites(storage, journal, scope);
  for (const write of writes) {
    if (write.raw) restoreRawPersistenceBytes(storage, write.storageKey, write.serialized);
    else storage.setItem(write.storageKey, write.serialized!);
  }
}

function prepareCompoundRollbackWrites(
  storage: BrowserKeyValueStore,
  journal: CompoundWriteJournal,
  scope: CompoundJournalScope,
): readonly CompoundRollbackWrite[] {
  const targets = new Set<string>();
  const writes: CompoundRollbackWrite[] = [];

  for (const previous of journal.previous) {
    if (!isJournalEntryInScope(previous, scope))
      throw compoundJournalCorrupt('rollback entry is not bound to this editor project');

    const target = `${previous.storageKind}\u0000${previous.storageKey}\u0000${previous.projectId}`;
    if (targets.has(target))
      throw compoundJournalCorrupt('journal contains a duplicate rollback target');
    targets.add(target);

    if (previous.storageKind === 'agent-idempotency') {
      if (
        previous.serialized !== null &&
        !isStrictAgentIdempotencyStorageState(previous.serialized, journal.projectId)
      )
        throw compoundJournalCorrupt('journal contains malformed agent idempotency bytes');
      writes.push({
        storageKey: previous.storageKey,
        serialized: previous.serialized,
        raw: true,
      });
      continue;
    }

    // Parse both the old project record and the current database before any
    // storage mutation. BrowserProjectStore relies on this record shape when
    // it appends later snapshots or transactions.
    const restoredProject =
      previous.serialized === null
        ? undefined
        : parseProjectRollbackRecord(previous.serialized, previous.storageKey, previous.projectId);
    let database: { projects: Record<string, unknown> };
    try {
      database = projectDatabase(storage.getItem(previous.storageKey));
    } catch (error) {
      throw compoundJournalCorrupt(`cannot read rollback target: ${errorMessage(error)}`);
    }
    const projects = { ...database.projects };
    if (restoredProject === undefined) delete projects[previous.projectId];
    else projects[previous.projectId] = restoredProject;
    writes.push({
      storageKey: previous.storageKey,
      serialized: JSON.stringify({ projects }),
      raw: false,
    });
  }

  return writes;
}

function parseProjectRollbackRecord(
  serialized: string,
  storageKey: string,
  projectId: string,
): Record<string, unknown> {
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value) || !Array.isArray(value.snapshots) || !Array.isArray(value.transactions))
      throw new Error('project record must contain snapshots and transactions arrays');
    assertRecoverableRollbackProjectRecord(value, storageKey, projectId);
    return value;
  } catch (error) {
    throw compoundJournalCorrupt(
      `journal contains malformed rollback bytes for ${storageKey}: ${errorMessage(error)}`,
    );
  }
}

/**
 * A project-log journal does not store arbitrary JSON: its preimage must be a
 * fully recoverable BrowserProjectStore record for the matching domain. This
 * dry run shares the exact persistence adapters used at open, including
 * snapshot checksums and schema validation, but uses an isolated in-memory
 * reader so it cannot mutate the real storage while preflighting recovery.
 */
function assertRecoverableRollbackProjectRecord(
  record: Record<string, unknown>,
  storageKey: string,
  projectId: string,
): void {
  switch (storageKey) {
    case TIMELINE_PROJECT_LOG_KEY:
      assertRecordRecoversWithAdapter(record, storageKey, projectId, timelineAdapter);
      return;
    case VISUAL_OBJECT_PROJECT_LOG_KEY:
      assertRecordRecoversWithAdapter(record, storageKey, projectId, visualObjectAdapter);
      return;
    case WORKFLOW_GRAPH_LOG_KEY:
      assertRecordRecoversWithAdapter(record, storageKey, projectId, graphAdapter);
      return;
    case CREATIVE_ARTIFACT_LOG_KEY:
      assertRecordRecoversWithAdapter(record, storageKey, projectId, artifactAdapter);
      return;
    case LOOK_INSTANCES_LOG_KEY:
      assertRecordRecoversWithAdapter(record, storageKey, projectId, lookInstancesAdapter);
      return;
    default:
      throw new Error(`unsupported project-log storage key ${storageKey}`);
  }
}

function assertRecordRecoversWithAdapter<P, T>(
  record: Record<string, unknown>,
  storageKey: string,
  projectId: string,
  adapter: PersistenceAdapter<P, T>,
): void {
  const candidate = JSON.stringify({ projects: { [projectId]: record } });
  const isolatedStorage: BrowserKeyValueStore = {
    getItem: (key) => (key === storageKey ? candidate : null),
    setItem: () => {
      throw new Error('rollback preflight must not write');
    },
  };
  const recovered = new LocalProjectPersistence(
    new BrowserProjectStore<P, T>(isolatedStorage, storageKey),
    adapter,
  ).recover(projectId);
  if (recovered.recoveredWithWarnings)
    throw new Error(`rollback record has recovery warnings: ${recovered.warnings.join('; ')}`);
  if (adapter.projectId(recovered.project) !== projectId)
    throw new Error('rollback record recovered a different project id');
}

function validateArtifactStore(store: ArtifactStore): readonly { code: string; message: string }[] {
  const value = store as unknown;
  if (!isRecord(value) || !isRecord(value.artifacts) || !isRecord(value.versions))
    return [{ code: 'ARTIFACT_STORE_INVALID', message: 'artifact store has invalid maps' }];
  const diagnostics: { code: string; message: string }[] = [];
  for (const [id, artifact] of Object.entries(value.artifacts)) {
    if (!isRecord(artifact) || artifact.id !== id) {
      diagnostics.push({
        code: 'ARTIFACT_STORE_ID',
        message: `artifact map key ${id} does not match its durable artifact id`,
      });
      continue;
    }
    for (const diagnostic of validateCreativeArtifact(artifact, `artifacts.${id}`)) {
      diagnostics.push({ code: diagnostic.code, message: diagnostic.message });
    }
  }
  for (const [artifactId, versions] of Object.entries(value.versions)) {
    if (value.artifacts[artifactId] === undefined) {
      diagnostics.push({
        code: 'ARTIFACT_VERSIONS_ORPHANED',
        message: `versions exist for missing artifact ${artifactId}`,
      });
      continue;
    }
    if (!Array.isArray(versions)) {
      diagnostics.push({
        code: 'ARTIFACT_VERSIONS_INVALID',
        message: `versions for artifact ${artifactId} are not an array`,
      });
      continue;
    }
    for (const [index, version] of versions.entries()) {
      if (!isValidArtifactVersion(version, artifactId)) {
        diagnostics.push({
          code: 'ARTIFACT_VERSION_INVALID',
          message: `version ${index} for artifact ${artifactId} is invalid`,
        });
      }
    }
  }
  return diagnostics;
}

function isValidArtifactVersion(value: unknown, artifactId: string): boolean {
  if (!isRecord(value)) return false;
  const revision = value.revision;
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.artifactId !== artifactId ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof value.createdAt !== 'string' ||
    value.createdAt.length === 0 ||
    (value.pinned !== undefined && typeof value.pinned !== 'boolean')
  )
    return false;
  return (
    validateArtifactContentRef(value.contentRef, 'version.contentRef').length === 0 &&
    validateArtifactProvenance(value.provenance, 'version.provenance').length === 0
  );
}

function compoundJournalCorrupt(message: string): PersistenceError {
  return new PersistenceError('PERSISTENCE_ATOMIC_JOURNAL_CORRUPT', message);
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
  scope: CompoundJournalScope,
): CompoundWriteJournal | undefined {
  try {
    const value = JSON.parse(serialized) as unknown;
    if (
      !isRecord(value) ||
      (value.version !== 1 && value.version !== 2) ||
      value.projectId !== scope.timelineProjectId ||
      (value.state !== 'prepared' && value.state !== 'committed') ||
      !Array.isArray(value.previous)
    )
      return undefined;
    const version: 1 | 2 = value.version === 1 ? 1 : 2;
    const previous = value.previous.map((entry) =>
      parseCompoundWriteJournalEntry(entry, scope, version),
    );
    if (previous.some((entry) => entry === undefined)) return undefined;
    return {
      version,
      state: value.state,
      projectId: scope.timelineProjectId,
      previous: previous as readonly CompoundWriteJournalEntry[],
    };
  } catch {
    return undefined;
  }
}

function parseCompoundWriteJournalEntry(
  value: unknown,
  scope: CompoundJournalScope,
  journalVersion: 1 | 2,
): CompoundWriteJournalEntry | undefined {
  if (!isRecord(value)) return undefined;
  const rawStorageKind =
    value.storageKind === undefined && journalVersion === 1 ? 'project-log' : value.storageKind;
  if (
    (rawStorageKind !== 'project-log' && rawStorageKind !== 'agent-idempotency') ||
    typeof value.storageKey !== 'string' ||
    typeof value.projectId !== 'string' ||
    value.projectId.length === 0 ||
    value.projectId.length > 256 ||
    (typeof value.serialized !== 'string' && value.serialized !== null)
  )
    return undefined;
  const storageKind: CompoundPersistenceStorageKind = rawStorageKind;
  if (storageKind === 'project-log') {
    if (!PROJECT_LOG_STORAGE_KEYS.has(value.storageKey)) return undefined;
  } else if (
    value.projectId !== scope.timelineProjectId ||
    value.storageKey !== agentIdempotencyStorageKey(scope.timelineProjectId)
  ) {
    return undefined;
  }
  const entry = {
    storageKey: value.storageKey,
    projectId: value.projectId,
    storageKind,
    serialized: value.serialized,
  };
  return isJournalEntryInScope(entry, scope) ? entry : undefined;
}

function isJournalEntryInScope(
  entry: Pick<CompoundWriteJournalEntry, 'storageKey' | 'storageKind' | 'projectId'>,
  scope: CompoundJournalScope,
): boolean {
  if (entry.storageKind === 'agent-idempotency')
    return (
      entry.projectId === scope.timelineProjectId &&
      entry.storageKey === agentIdempotencyStorageKey(scope.timelineProjectId)
    );
  const expectedProjectId =
    entry.storageKey === VISUAL_OBJECT_PROJECT_LOG_KEY
      ? scope.visualProjectId
      : scope.timelineProjectId;
  return PROJECT_LOG_STORAGE_KEYS.has(entry.storageKey) && entry.projectId === expectedProjectId;
}

const PROJECT_LOG_STORAGE_KEYS = new Set([
  TIMELINE_PROJECT_LOG_KEY,
  VISUAL_OBJECT_PROJECT_LOG_KEY,
  WORKFLOW_GRAPH_LOG_KEY,
  CREATIVE_ARTIFACT_LOG_KEY,
  LOOK_INSTANCES_LOG_KEY,
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

/**
 * Like `recoverOrInitialize` but never writes on a missing log: a project that
 * predates the Look Instances document loads as the empty document in memory,
 * `persisted: false`. The log is created lazily by the first Look write.
 */
function recoverLookInstancesOrEmpty(
  persistence: LocalProjectPersistence<LookInstancesDocument, never>,
  empty: LookInstancesDocument,
): {
  readonly document: LookInstancesDocument;
  readonly revision: number;
  readonly warnings: readonly string[];
  readonly persisted: boolean;
} {
  try {
    const recovered = persistence.recover(empty.id);
    return {
      document: recovered.project,
      revision: recovered.revision,
      warnings: recovered.warnings,
      persisted: true,
    };
  } catch (error) {
    if (!(error instanceof PersistenceError) || error.code !== 'PERSISTENCE_NOT_FOUND') throw error;
    return { document: empty, revision: 0, warnings: [], persisted: false };
  }
}

function encodeProjectRevision(
  projectId: string,
  timelineRevision: number,
  visualObjectRevision: number,
  graphRevision: number,
  artifactRevision: number,
  lookInstancesRevision: number,
): ProjectRevisionId {
  // Graph, artifacts and Look Instances are all part of the creative document,
  // so editing any of them has to move the revision an agent plan was built
  // against — otherwise a plan made before a node, a script or a Look changed
  // would still look current and commit against stale structure.
  return `local-revision:v1:${encodeURIComponent(projectId)}:timeline=${timelineRevision}:document=${visualObjectRevision}:graph=${graphRevision}:artifacts=${artifactRevision}:looks=${lookInstancesRevision}`;
}

function persistenceProjectId(project: unknown): string {
  if (project === null || typeof project !== 'object' || !('id' in project))
    throw new TypeError('project id is required');
  const id = (project as { id: unknown }).id;
  if (typeof id !== 'string') throw new TypeError('project id is required');
  return id;
}
