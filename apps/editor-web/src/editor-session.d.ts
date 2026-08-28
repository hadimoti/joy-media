import type { CommandTransaction, GraphTransaction, ArtifactStore, ArtifactTransaction } from '@joy-media/commands';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, SpikeProject, WorkflowGraphV2 } from '@joy-media/project-schema';
import type { ProjectDocumentHydrationPlan } from './project-document-hydration.js';
import type { ProjectRevisionId } from '@joy-media/agent-tools';
import { BrowserAgentIdempotencyStore } from './agent-idempotency-store.js';
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
 * Notification emitted after a durable editor mutation has been committed to
 * the session's local persistence.  This deliberately excludes selection,
 * playhead, and other ephemeral editor state.
 */
export interface EditorSessionDurableChange {
    readonly label: string;
    readonly operationCount: number;
}
export type EditorSessionDurableChangeListener = (change: EditorSessionDurableChange) => void;
/**
 * Keeps the creative documents out of React state while still notifying the UI
 * after every durable local transaction. The two current schema slices retain
 * separate logs until timeline commands graduate to the v1 project document.
 */
export declare class EditorSession {
    #private;
    readonly agentIdempotency: BrowserAgentIdempotencyStore;
    /** Dual Lens graph editing (ADR-0023). Off unless the flag says otherwise. */
    readonly graphEnabled: boolean;
    constructor(storage: BrowserKeyValueStore, initialTimeline: SpikeProject, initialVisualProject: JoyProjectV1);
    get timelineProject(): SpikeProject;
    get visualProject(): JoyProjectV1;
    /**
     * Durable, opaque revision id for the complete local creative document.
     *
     * Both component revisions come from the verified persistence logs and are
     * recovered on reopen. The string shape is intentionally an implementation
     * detail; agent envelopes compare it as an opaque ADR-0012-compatible id.
     */
    get projectRevisionId(): ProjectRevisionId;
    get workflowGraph(): WorkflowGraphV2;
    get artifacts(): ArtifactStore;
    get canUndo(): boolean;
    get canRedo(): boolean;
    /** Subscribe to durable mutations; ephemeral selection/playhead changes do not use this seam. */
    subscribeDurableChanges(listener: EditorSessionDurableChangeListener): () => void;
    get historyEntries(): readonly HistoryEntry[];
    /** Sequence of the present state (0 = empty document / no commits). */
    get historyCursorSequence(): number;
    /**
     * Jump to a history restore point (Photoshop-style). Undoes or redoes until
     * `historyCursorSequence === sequence`.
     */
    jumpToHistory(sequence: number): void;
    dispatchTimeline(transaction: CommandTransaction): SpikeProject;
    dispatchVisualObjects(transaction: VisualObjectTransaction): JoyProjectV1;
    /**
     * Applies a graph transaction and records it on the same history as timeline
     * and document edits, so one Undo steps back through interleaved work in the
     * order it was done rather than per-lens.
     */
    dispatchGraph(transaction: GraphTransaction): WorkflowGraphV2;
    /** Same history as every other family, so data-lane edits are one Undo too. */
    dispatchArtifacts(transaction: ArtifactTransaction): ArtifactStore;
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
    dispatchCompound(label: string, parts: {
        readonly document?: JoyProjectV1;
        readonly artifacts?: ArtifactTransaction;
        readonly timeline?: CommandTransaction;
    }): void;
    replaceVisualProject(next: JoyProjectV1): JoyProjectV1;
    /**
     * Replace every durable slice from a validated V2 hydration plan. The plan
     * is prepared at the untrusted journal/remote boundary; this method still
     * rechecks its typed values before writing anything and resets edit history
     * because a recovered document is the new opening baseline.
     */
    hydrateProjectDocument(plan: ProjectDocumentHydrationPlan, label?: string): void;
    undo(): void;
    redo(): void;
}
//# sourceMappingURL=editor-session.d.ts.map