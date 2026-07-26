import { applyTransaction } from '@joy-media/commands';
import type { CommandTransaction } from '@joy-media/commands';
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
import { validateJoyProjectV1, validateSpikeProject } from '@joy-media/project-schema';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { ProjectRevisionId } from '@joy-media/agent-tools';
import { EditorCommandController } from './command-controller.js';
import { withDefaultPortraitComposition } from './editor-project.js';
import { BrowserAgentIdempotencyStore } from './agent-idempotency-store.js';

export interface HistoryEntry {
  readonly id: string;
  readonly source: 'timeline' | 'visual-object' | 'document';
  readonly label: string;
  /** Present when this entry is past (`undo`) or future (`redo`) relative to the cursor. */
  readonly direction: 'undo' | 'redo' | 'current';
  readonly commandCount: number;
  readonly sequence: number;
}

type EditorOperation = 'timeline' | 'visual-object';

interface HistoryStackEntry {
  readonly operation: EditorOperation;
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

/**
 * Keeps the creative documents out of React state while still notifying the UI
 * after every durable local transaction. The two current schema slices retain
 * separate logs until timeline commands graduate to the v1 project document.
 */
export class EditorSession {
  readonly #timelinePersistence: LocalProjectPersistence<SpikeProject, CommandTransaction>;
  readonly #visualObjectPersistence: LocalProjectPersistence<JoyProjectV1, VisualObjectTransaction>;
  readonly #timeline: EditorCommandController;
  readonly #visualObjects: VisualObjectProjectHistory;
  readonly #undo: HistoryStackEntry[] = [];
  readonly #redo: HistoryStackEntry[] = [];
  readonly agentIdempotency: BrowserAgentIdempotencyStore;
  #timelineRevision: number;
  #visualObjectRevision: number;
  #sequence = 0;

  constructor(
    storage: BrowserKeyValueStore,
    initialTimeline: SpikeProject,
    initialVisualProject: JoyProjectV1,
  ) {
    this.#timelinePersistence = new LocalProjectPersistence(
      new BrowserProjectStore(storage, 'joy-media.timeline-project-log.v1'),
      timelineAdapter,
    );
    this.#visualObjectPersistence = new LocalProjectPersistence(
      new BrowserProjectStore(storage, 'joy-media.visual-object-project-log.v1'),
      visualObjectAdapter,
    );
    const timeline = recoverOrInitialize(this.#timelinePersistence, initialTimeline);
    // Stored projects may still carry the pre-v7 1920×1080 default; normalize on open.
    const visualObjects = recoverOrInitialize(
      this.#visualObjectPersistence,
      initialVisualProject,
    );
    this.#timelineRevision = timeline.revision;
    this.#visualObjectRevision = visualObjects.revision;
    this.#timeline = new EditorCommandController(timeline.project);
    this.#visualObjects = new VisualObjectProjectHistory(
      withDefaultPortraitComposition(visualObjects.project),
    );
    this.agentIdempotency = new BrowserAgentIdempotencyStore(storage, initialTimeline.id);
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
    );
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
    const futureRows = [...this.#redo]
      .reverse()
      .map((e) => this.#toEntry(e, 'redo'));
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

  #toEntry(
    entry: HistoryStackEntry,
    direction: 'undo' | 'redo' | 'current',
  ): HistoryEntry {
    return {
      id: `history-${entry.sequence}`,
      source: entry.operation,
      label: entry.label,
      direction,
      commandCount: entry.commandCount,
      sequence: entry.sequence,
    };
  }

  dispatchTimeline(transaction: CommandTransaction): SpikeProject {
    const before = this.#timeline.project;
    const project = this.#timeline.dispatch(transaction);
    this.#timelinePersistence.saveTransaction(before, transaction, false);
    this.#timelineRevision += 1;
    this.#record('timeline', transaction.label, transaction.commands.length);
    return project;
  }

  dispatchVisualObjects(transaction: VisualObjectTransaction): JoyProjectV1 {
    const before = this.#visualObjects.present;
    const project = this.#visualObjects.apply(transaction);
    this.#visualObjectPersistence.saveTransaction(before, transaction, false);
    this.#visualObjectRevision += 1;
    this.#record('visual-object', transaction.label, transaction.commands.length);
    return project;
  }

  replaceVisualProject(next: JoyProjectV1): JoyProjectV1 {
    const before = this.#visualObjects.present;
    const project = this.#visualObjects.replacePresent(next);
    this.#visualObjectPersistence.saveTransaction(
      before,
      { label: 'Replace project document', commands: [] },
      false,
    );
    this.#visualObjectRevision += 1;
    this.#record('visual-object', 'Replace project document', 0);
    return project;
  }

  undo(): void {
    const entry = this.#undo.pop();
    if (entry === undefined) return;
    if (entry.operation === 'timeline') {
      const before = this.#timeline.project;
      const mutation = this.#timeline.undoWithRecord();
      this.#timelinePersistence.saveTransaction(
        before,
        { label: `Undo ${mutation.record.label}`, commands: mutation.record.inverses },
        false,
      );
      this.#timelineRevision += 1;
    } else {
      const before = this.#visualObjects.present;
      const mutation = this.#visualObjects.undo();
      this.#visualObjectPersistence.saveTransaction(before, mutation.transaction, false);
      this.#visualObjectRevision += 1;
    }
    this.#redo.push(entry);
  }

  redo(): void {
    const entry = this.#redo.pop();
    if (entry === undefined) return;
    if (entry.operation === 'timeline') {
      const before = this.#timeline.project;
      const mutation = this.#timeline.redoWithRecord();
      this.#timelinePersistence.saveTransaction(
        before,
        { label: `Redo ${mutation.record.label}`, commands: mutation.record.commands },
        false,
      );
      this.#timelineRevision += 1;
    } else {
      const before = this.#visualObjects.present;
      const mutation = this.#visualObjects.redo();
      this.#visualObjectPersistence.saveTransaction(before, mutation.transaction, false);
      this.#visualObjectRevision += 1;
    }
    this.#undo.push(entry);
  }

  #record(operation: EditorOperation, label: string, commandCount: number): void {
    this.#undo.push({ operation, label, commandCount, sequence: ++this.#sequence });
    this.#redo.length = 0;
  }
}

function recoverOrInitialize<P, T>(
  persistence: LocalProjectPersistence<P, T>,
  initial: P,
): { readonly project: P; readonly revision: number } {
  try {
    const recovered = persistence.recover(persistenceProjectId(initial));
    return { project: recovered.project, revision: recovered.revision };
  } catch (error) {
    if (!(error instanceof PersistenceError) || error.code !== 'PERSISTENCE_NOT_FOUND') throw error;
    persistence.initialize(initial);
    return { project: initial, revision: 0 };
  }
}

function encodeProjectRevision(
  projectId: string,
  timelineRevision: number,
  visualObjectRevision: number,
): ProjectRevisionId {
  return `local-revision:v1:${encodeURIComponent(projectId)}:timeline=${timelineRevision}:document=${visualObjectRevision}`;
}

function persistenceProjectId(project: unknown): string {
  if (project === null || typeof project !== 'object' || !('id' in project))
    throw new TypeError('project id is required');
  const id = (project as { id: unknown }).id;
  if (typeof id !== 'string') throw new TypeError('project id is required');
  return id;
}
