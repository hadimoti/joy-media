import { applyTransaction, applyGraphTransaction, revertGraphTransaction, applyArtifactTransaction, revertArtifactTransaction, EMPTY_ARTIFACT_STORE, } from '@joy-media/commands';
import { applyVisualObjectProjectTransaction, VisualObjectProjectHistory, } from './editor-visual-kernel.js';
import { BrowserProjectStore, LocalProjectPersistence, PersistenceError, } from '@joy-media/project-persistence';
import { validateJoyProjectV1, validateSpikeProject, validateWorkflowGraph, validateCreativeArtifact, readDualLensFlags, EMPTY_WORKFLOW_GRAPH, } from '@joy-media/project-schema';
import { EditorCommandController } from './command-controller.js';
import { withDefaultPortraitComposition } from './editor-project.js';
import { BrowserAgentIdempotencyStore } from './agent-idempotency-store.js';
const timelineAdapter = {
    projectId: (project) => project.id,
    schemaVersion: (project) => project.schemaVersion,
    validate: validateSpikeProject,
    apply: (project, transaction) => applyTransaction(project, transaction).project,
};
const visualObjectAdapter = {
    projectId: (project) => project.id,
    schemaVersion: (project) => project.schemaVersion,
    validate: validateJoyProjectV1,
    apply: applyVisualObjectProjectTransaction,
};
const artifactAdapter = {
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
const graphAdapter = {
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
    #timelinePersistence;
    #visualObjectPersistence;
    #timeline;
    #visualObjects;
    #undo = [];
    #redo = [];
    agentIdempotency;
    /** Dual Lens graph editing (ADR-0023). Off unless the flag says otherwise. */
    graphEnabled;
    #graphPersistence;
    /**
     * Per-family record stacks, like `EditorCommandController` and
     * `VisualObjectProjectHistory` keep. The user-visible stack is still the one
     * below; these only say *how* to reverse an entry it has already ordered.
     */
    #graphUndo = [];
    #graphRedo = [];
    #artifactPersistence;
    #artifactUndo = [];
    #artifactRedo = [];
    #snapshotUndo = [];
    #snapshotRedo = [];
    #durableChangeListeners = new Set();
    #artifactDocument;
    #artifactRevision;
    #graphDocument;
    #timelineRevision;
    #visualObjectRevision;
    #graphRevision;
    #sequence = 0;
    constructor(storage, initialTimeline, initialVisualProject) {
        this.#timelinePersistence = new LocalProjectPersistence(new BrowserProjectStore(storage, 'joy-media.timeline-project-log.v1'), timelineAdapter);
        this.#visualObjectPersistence = new LocalProjectPersistence(new BrowserProjectStore(storage, 'joy-media.visual-object-project-log.v1'), visualObjectAdapter);
        const timeline = recoverOrInitialize(this.#timelinePersistence, initialTimeline);
        // Stored projects may still carry the pre-v7 1920×1080 default; normalize on open.
        const visualObjects = recoverOrInitialize(this.#visualObjectPersistence, initialVisualProject);
        this.#timelineRevision = timeline.revision;
        this.#visualObjectRevision = visualObjects.revision;
        this.#timeline = new EditorCommandController(timeline.project);
        this.#visualObjects = new VisualObjectProjectHistory(withDefaultPortraitComposition(visualObjects.project));
        this.agentIdempotency = new BrowserAgentIdempotencyStore(storage, initialTimeline.id);
        this.graphEnabled = readDualLensFlags(storage).graphEnabled;
        const emptyGraphDocument = {
            id: initialTimeline.id,
            graph: EMPTY_WORKFLOW_GRAPH,
        };
        if (this.graphEnabled) {
            this.#graphPersistence = new LocalProjectPersistence(new BrowserProjectStore(storage, 'joy-media.workflow-graph-log.v1'), graphAdapter);
            const recovered = recoverOrInitialize(this.#graphPersistence, emptyGraphDocument);
            this.#graphDocument = recovered.project;
            this.#graphRevision = recovered.revision;
        }
        else {
            // No log is opened when the feature is off, so a disabled Dual Lens adds
            // no storage key and no recovery path — the flag's off state stays a
            // property of what is stored, not only of what is drawn.
            this.#graphDocument = emptyGraphDocument;
            this.#graphRevision = 0;
        }
        const emptyArtifactDocument = {
            id: initialTimeline.id,
            schemaVersion: 1,
            store: EMPTY_ARTIFACT_STORE,
        };
        if (this.graphEnabled) {
            this.#artifactPersistence = new LocalProjectPersistence(new BrowserProjectStore(storage, 'joy-media.creative-artifact-log.v1'), artifactAdapter);
            const recovered = recoverOrInitialize(this.#artifactPersistence, emptyArtifactDocument);
            this.#artifactDocument = recovered.project;
            this.#artifactRevision = recovered.revision;
        }
        else {
            this.#artifactDocument = emptyArtifactDocument;
            this.#artifactRevision = 0;
        }
    }
    get timelineProject() {
        return this.#timeline.project;
    }
    get visualProject() {
        return this.#visualObjects.present;
    }
    /**
     * Durable, opaque revision id for the complete local creative document.
     *
     * Both component revisions come from the verified persistence logs and are
     * recovered on reopen. The string shape is intentionally an implementation
     * detail; agent envelopes compare it as an opaque ADR-0012-compatible id.
     */
    get projectRevisionId() {
        return encodeProjectRevision(this.timelineProject.id, this.#timelineRevision, this.#visualObjectRevision, this.#graphRevision, this.#artifactRevision);
    }
    get workflowGraph() {
        return this.#graphDocument.graph;
    }
    get artifacts() {
        return this.#artifactDocument.store;
    }
    get canUndo() {
        return this.#undo.length > 0;
    }
    get canRedo() {
        return this.#redo.length > 0;
    }
    /** Subscribe to durable mutations; ephemeral selection/playhead changes do not use this seam. */
    subscribeDurableChanges(listener) {
        this.#durableChangeListeners.add(listener);
        return () => {
            this.#durableChangeListeners.delete(listener);
        };
    }
    get historyEntries() {
        const cursorSequence = this.historyCursorSequence;
        // Photoshop-style linear strip: Document → past → current tip → future redo states.
        const document = {
            id: 'history-document',
            source: 'document',
            label: 'Document',
            direction: cursorSequence === 0 ? 'current' : 'undo',
            commandCount: 0,
            sequence: 0,
        };
        const pastRows = this.#undo.map((e, index) => {
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
    get historyCursorSequence() {
        const tip = this.#undo[this.#undo.length - 1];
        return tip?.sequence ?? 0;
    }
    /**
     * Jump to a history restore point (Photoshop-style). Undoes or redoes until
     * `historyCursorSequence === sequence`.
     */
    jumpToHistory(sequence) {
        if (!Number.isFinite(sequence) || sequence < 0)
            return;
        const known = sequence === 0 ||
            this.#undo.some((e) => e.sequence === sequence) ||
            this.#redo.some((e) => e.sequence === sequence);
        if (!known)
            return;
        let guard = this.#undo.length + this.#redo.length + 2;
        let operationCount = 0;
        while (this.historyCursorSequence > sequence && this.canUndo && guard-- > 0) {
            const entry = this.#undoInternal();
            operationCount += positiveOperationCount(entry?.commandCount);
        }
        guard = this.#undo.length + this.#redo.length + 2;
        while (this.historyCursorSequence < sequence && this.canRedo && guard-- > 0) {
            const entry = this.#redoInternal();
            operationCount += positiveOperationCount(entry?.commandCount);
        }
        if (operationCount > 0)
            this.#emitDurableChange(`Jump to history ${String(sequence)}`, operationCount);
    }
    #toEntry(entry, direction) {
        return {
            id: `history-${entry.sequence}`,
            source: entry.operations.length > 1
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
    dispatchTimeline(transaction) {
        const before = this.#timeline.project;
        const project = this.#timeline.dispatch(transaction);
        this.#timelinePersistence.saveTransaction(before, transaction, false);
        this.#timelineRevision += 1;
        this.#record('timeline', transaction.label, transaction.commands.length);
        this.#emitDurableChange(transaction.label, transaction.commands.length);
        return project;
    }
    dispatchVisualObjects(transaction) {
        const before = this.#visualObjects.present;
        const project = this.#visualObjects.apply(transaction);
        this.#visualObjectPersistence.saveTransaction(before, transaction, false);
        this.#visualObjectRevision += 1;
        this.#record('visual-object', transaction.label, transaction.commands.length);
        this.#emitDurableChange(transaction.label, transaction.commands.length);
        return project;
    }
    /**
     * Applies a graph transaction and records it on the same history as timeline
     * and document edits, so one Undo steps back through interleaved work in the
     * order it was done rather than per-lens.
     */
    dispatchGraph(transaction) {
        if (!this.graphEnabled) {
            throw new Error('workflow graph editing is disabled; enable the Dual Lens graph flag');
        }
        const before = this.#graphDocument;
        const result = applyGraphTransaction(before.graph, transaction);
        this.#graphDocument = { ...before, graph: result.graph };
        this.#graphPersistence?.saveTransaction(before, transaction, false);
        this.#graphRevision += 1;
        this.#graphUndo.push(result.record);
        this.#graphRedo.length = 0;
        this.#record('graph', transaction.label, transaction.commands.length);
        this.#emitDurableChange(transaction.label, transaction.commands.length);
        return result.graph;
    }
    /** Same history as every other family, so data-lane edits are one Undo too. */
    dispatchArtifacts(transaction) {
        if (!this.graphEnabled) {
            throw new Error('creative artifacts are disabled; enable the Dual Lens graph flag');
        }
        const before = this.#artifactDocument;
        const result = applyArtifactTransaction(before.store, transaction);
        this.#artifactDocument = { ...before, store: result.store };
        this.#artifactPersistence?.saveTransaction(before, transaction, false);
        this.#artifactRevision += 1;
        this.#artifactUndo.push(result.record);
        this.#artifactRedo.length = 0;
        this.#record('artifact', transaction.label, transaction.commands.length);
        this.#emitDurableChange(transaction.label, transaction.commands.length);
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
    dispatchCompound(label, parts) {
        const operations = [];
        let commandCount = 0;
        // Everything that can fail is checked before anything is written. Applying
        // the document and then throwing on the artifacts would leave a change that
        // is persisted, unrecorded, and therefore impossible to undo — the exact
        // split this method exists to prevent.
        if (parts.artifacts !== undefined && !this.graphEnabled) {
            throw new Error('creative artifacts are disabled; enable the Dual Lens graph flag');
        }
        const beforeDocument = this.#visualObjects.present;
        const beforeTimeline = this.#timeline.project;
        const beforeArtifacts = this.#artifactDocument;
        if (parts.document !== undefined) {
            const documentErrors = validateJoyProjectV1(parts.document);
            if (documentErrors.length > 0) {
                throw new RangeError(`compound document is invalid: ${documentErrors.map((error) => error.message).join('; ')}`);
            }
        }
        const artifactResult = parts.artifacts === undefined
            ? undefined
            : applyArtifactTransaction(this.#artifactDocument.store, parts.artifacts);
        const timelineResult = parts.timeline === undefined
            ? undefined
            : applyTransaction(this.#timeline.project, parts.timeline);
        // Persist each prepared result before mutating any live history object. If a
        // later bus rejects its write, the already-written buses are restored from
        // their pre-state snapshots and the caller sees no compound history entry.
        let documentPersisted = false;
        let timelinePersisted = false;
        let artifactPersisted = false;
        try {
            if (parts.document !== undefined) {
                this.#visualObjectPersistence.saveSnapshot(parts.document, false);
                documentPersisted = true;
            }
            if (parts.timeline !== undefined) {
                this.#timelinePersistence.saveTransaction(beforeTimeline, parts.timeline, false);
                timelinePersisted = true;
            }
            if (parts.artifacts !== undefined && artifactResult !== undefined) {
                this.#artifactPersistence?.saveTransaction(beforeArtifacts, parts.artifacts, false);
                artifactPersisted = true;
            }
        }
        catch (error) {
            const rollbackErrors = [];
            if (artifactPersisted) {
                try {
                    this.#artifactPersistence?.saveSnapshot(beforeArtifacts, false);
                    this.#artifactRevision += 1;
                }
                catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            if (timelinePersisted) {
                try {
                    this.#timelinePersistence.saveSnapshot(beforeTimeline, false);
                    this.#timelineRevision += 1;
                }
                catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            if (documentPersisted) {
                try {
                    this.#visualObjectPersistence.saveSnapshot(beforeDocument, false);
                    this.#visualObjectRevision += 1;
                }
                catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            if (rollbackErrors.length > 0) {
                throw new AggregateError([error, ...rollbackErrors], 'compound transaction failed and durable rollback was incomplete');
            }
            throw error;
        }
        if (timelineResult !== undefined && parts.timeline !== undefined) {
            this.#timeline.dispatch(parts.timeline);
            this.#timelineRevision += 1;
            operations.push('timeline');
            commandCount += parts.timeline.commands.length;
        }
        if (parts.document !== undefined) {
            this.#visualObjects.replacePresent(parts.document);
            this.#visualObjectRevision += 1;
            this.#snapshotUndo.push({ before: beforeDocument, after: parts.document });
            this.#snapshotRedo.length = 0;
            operations.push('document-snapshot');
        }
        if (parts.artifacts !== undefined && artifactResult !== undefined) {
            this.#artifactDocument = { ...beforeArtifacts, store: artifactResult.store };
            this.#artifactRevision += 1;
            this.#artifactUndo.push(artifactResult.record);
            this.#artifactRedo.length = 0;
            operations.push('artifact');
            commandCount += parts.artifacts.commands.length;
        }
        if (operations.length === 0)
            return;
        this.#recordCompound(operations, label, commandCount);
        this.#emitDurableChange(label, commandCount);
    }
    replaceVisualProject(next) {
        const project = this.#visualObjects.replacePresent(next);
        // Was persisting an empty transaction, which the object adapter rejects and
        // which would have replayed to the previous document even if it did not.
        this.#visualObjectPersistence.saveSnapshot(project, false);
        this.#visualObjectRevision += 1;
        this.#record('visual-object', 'Replace project document', 0);
        this.#emitDurableChange('Replace project document', 1);
        return project;
    }
    /**
     * Replace every durable slice from a validated V2 hydration plan. The plan
     * is prepared at the untrusted journal/remote boundary; this method still
     * rechecks its typed values before writing anything and resets edit history
     * because a recovered document is the new opening baseline.
     */
    hydrateProjectDocument(plan, label = 'Project document hydrated') {
        const visualDiagnostics = validateJoyProjectV1(plan.visualProject);
        const timelineDiagnostics = validateSpikeProject(plan.timelineProject);
        if (visualDiagnostics.length > 0 || timelineDiagnostics.length > 0)
            throw new RangeError('hydration plan contains an invalid visual or timeline project');
        if (plan.visualProject.id !== plan.timelineProject.id)
            throw new RangeError('hydration plan project ids do not match');
        if (plan.workflowGraph !== undefined) {
            if (!this.graphEnabled)
                throw new RangeError('hydration includes a disabled workflow graph');
            if (validateWorkflowGraph(plan.workflowGraph, 'workflow').length > 0)
                throw new RangeError('hydration plan contains an invalid workflow graph');
        }
        if (plan.artifacts !== undefined) {
            if (!this.graphEnabled)
                throw new RangeError('hydration includes disabled artifacts');
            for (const [id, artifact] of Object.entries(plan.artifacts.artifacts)) {
                if (artifact.id !== id || validateCreativeArtifact(artifact, `artifacts.${id}`).length > 0)
                    throw new RangeError(`hydration plan contains an invalid artifact "${id}"`);
            }
        }
        const beforeVisual = this.#visualObjects.present;
        const beforeTimeline = this.#timeline.project;
        const beforeGraph = this.#graphDocument;
        const beforeArtifacts = this.#artifactDocument;
        const nextGraph = !this.graphEnabled
            ? beforeGraph
            : { ...beforeGraph, graph: plan.workflowGraph ?? EMPTY_WORKFLOW_GRAPH };
        const nextArtifacts = !this.graphEnabled
            ? beforeArtifacts
            : { ...beforeArtifacts, store: plan.artifacts ?? EMPTY_ARTIFACT_STORE };
        let visualWritten = false;
        let timelineWritten = false;
        let graphWritten = false;
        let artifactsWritten = false;
        try {
            this.#visualObjectPersistence.saveSnapshot(plan.visualProject, false);
            visualWritten = true;
            this.#timelinePersistence.saveSnapshot(plan.timelineProject, false);
            timelineWritten = true;
            if (this.graphEnabled) {
                this.#graphPersistence?.saveSnapshot(nextGraph, false);
                graphWritten = true;
            }
            if (this.graphEnabled) {
                this.#artifactPersistence?.saveSnapshot(nextArtifacts, false);
                artifactsWritten = true;
            }
        }
        catch (error) {
            // Restore every snapshot already written. This mirrors dispatchCompound's
            // write-ahead behavior and leaves the live objects untouched on failure.
            try {
                if (artifactsWritten)
                    this.#artifactPersistence?.saveSnapshot(beforeArtifacts, false);
                if (graphWritten)
                    this.#graphPersistence?.saveSnapshot(beforeGraph, false);
                if (timelineWritten)
                    this.#timelinePersistence.saveSnapshot(beforeTimeline, false);
                if (visualWritten)
                    this.#visualObjectPersistence.saveSnapshot(beforeVisual, false);
            }
            catch (rollbackError) {
                throw new AggregateError([error, rollbackError], 'hydration rollback was incomplete');
            }
            throw error;
        }
        this.#timeline = new EditorCommandController(plan.timelineProject);
        this.#visualObjects.replacePresent(plan.visualProject);
        if (this.graphEnabled) {
            this.#graphDocument = nextGraph;
            this.#artifactDocument = nextArtifacts;
        }
        this.#timelineRevision += 1;
        this.#visualObjectRevision += 1;
        if (this.graphEnabled)
            this.#graphRevision += 1;
        if (this.graphEnabled)
            this.#artifactRevision += 1;
        this.#undo.length = 0;
        this.#redo.length = 0;
        this.#graphUndo.length = 0;
        this.#graphRedo.length = 0;
        this.#artifactUndo.length = 0;
        this.#artifactRedo.length = 0;
        this.#snapshotUndo.length = 0;
        this.#snapshotRedo.length = 0;
        this.#sequence = 0;
        this.#emitDurableChange(label, 1);
    }
    undo() {
        const entry = this.#undoInternal();
        if (entry !== undefined)
            this.#emitDurableChange(`Undo ${entry.label}`, entry.commandCount);
    }
    #undoInternal() {
        const entry = this.#undo.pop();
        if (entry === undefined)
            return undefined;
        // Reverse order: a compound applied document-then-artifact must undo
        // artifact-then-document, or the halves come apart.
        for (const operation of [...entry.operations].reverse()) {
            this.#undoOne(operation);
        }
        this.#redo.push(entry);
        return entry;
    }
    #undoOne(operation) {
        if (operation === 'document-snapshot') {
            const record = this.#snapshotUndo.pop();
            if (record !== undefined) {
                this.#visualObjects.replacePresent(record.before);
                this.#visualObjectPersistence.saveSnapshot(record.before, false);
                this.#visualObjectRevision += 1;
                this.#snapshotRedo.push(record);
            }
            return;
        }
        if (operation === 'timeline') {
            const before = this.#timeline.project;
            const mutation = this.#timeline.undoWithRecord();
            this.#timelinePersistence.saveTransaction(before, { label: `Undo ${mutation.record.label}`, commands: mutation.record.inverses }, false);
            this.#timelineRevision += 1;
        }
        else if (operation === 'graph') {
            const record = this.#graphUndo.pop();
            if (record !== undefined) {
                const before = this.#graphDocument;
                this.#graphDocument = { ...before, graph: revertGraphTransaction(before.graph, record) };
                this.#graphPersistence?.saveTransaction(before, { label: `Undo ${record.label}`, commands: record.inverses }, false);
                this.#graphRevision += 1;
                this.#graphRedo.push(record);
            }
        }
        else if (operation === 'artifact') {
            const record = this.#artifactUndo.pop();
            if (record !== undefined) {
                const before = this.#artifactDocument;
                this.#artifactDocument = {
                    ...before,
                    store: revertArtifactTransaction(before.store, record),
                };
                this.#artifactPersistence?.saveTransaction(before, { label: `Undo ${record.label}`, commands: record.inverses }, false);
                this.#artifactRevision += 1;
                this.#artifactRedo.push(record);
            }
        }
        else {
            const before = this.#visualObjects.present;
            const mutation = this.#visualObjects.undo();
            this.#visualObjectPersistence.saveTransaction(before, mutation.transaction, false);
            this.#visualObjectRevision += 1;
        }
    }
    redo() {
        const entry = this.#redoInternal();
        if (entry !== undefined)
            this.#emitDurableChange(`Redo ${entry.label}`, entry.commandCount);
    }
    #redoInternal() {
        const entry = this.#redo.pop();
        if (entry === undefined)
            return undefined;
        for (const operation of entry.operations) {
            this.#redoOne(operation);
        }
        this.#undo.push(entry);
        return entry;
    }
    #redoOne(operation) {
        if (operation === 'document-snapshot') {
            const record = this.#snapshotRedo.pop();
            if (record !== undefined) {
                this.#visualObjects.replacePresent(record.after);
                this.#visualObjectPersistence.saveSnapshot(record.after, false);
                this.#visualObjectRevision += 1;
                this.#snapshotUndo.push(record);
            }
            return;
        }
        if (operation === 'timeline') {
            const before = this.#timeline.project;
            const mutation = this.#timeline.redoWithRecord();
            this.#timelinePersistence.saveTransaction(before, { label: `Redo ${mutation.record.label}`, commands: mutation.record.commands }, false);
            this.#timelineRevision += 1;
        }
        else if (operation === 'graph') {
            const record = this.#graphRedo.pop();
            if (record !== undefined) {
                const before = this.#graphDocument;
                this.#graphDocument = {
                    ...before,
                    graph: applyGraphTransaction(before.graph, {
                        label: record.label,
                        commands: record.commands,
                    }).graph,
                };
                this.#graphPersistence?.saveTransaction(before, { label: `Redo ${record.label}`, commands: record.commands }, false);
                this.#graphRevision += 1;
                this.#graphUndo.push(record);
            }
        }
        else if (operation === 'artifact') {
            const record = this.#artifactRedo.pop();
            if (record !== undefined) {
                const before = this.#artifactDocument;
                this.#artifactDocument = {
                    ...before,
                    store: applyArtifactTransaction(before.store, {
                        label: record.label,
                        commands: record.commands,
                    }).store,
                };
                this.#artifactPersistence?.saveTransaction(before, { label: `Redo ${record.label}`, commands: record.commands }, false);
                this.#artifactRevision += 1;
                this.#artifactUndo.push(record);
            }
        }
        else {
            const before = this.#visualObjects.present;
            const mutation = this.#visualObjects.redo();
            this.#visualObjectPersistence.saveTransaction(before, mutation.transaction, false);
            this.#visualObjectRevision += 1;
        }
    }
    #record(operation, label, commandCount) {
        this.#recordCompound([operation], label, commandCount);
    }
    #recordCompound(operations, label, commandCount) {
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
    #emitDurableChange(label, operationCount) {
        const change = {
            label: safeLabel(label),
            operationCount: positiveOperationCount(operationCount),
        };
        for (const listener of [...this.#durableChangeListeners]) {
            // A notification observer must never turn an already-persisted edit into
            // a failed edit. The observer can report its own failure through its
            // controller's status channel instead.
            try {
                listener(change);
            }
            catch {
                // Intentionally isolated from the editor mutation.
            }
        }
    }
}
function positiveOperationCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 1;
}
function safeLabel(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : 'Editor change';
}
function recoverOrInitialize(persistence, initial) {
    try {
        const recovered = persistence.recover(persistenceProjectId(initial));
        return { project: recovered.project, revision: recovered.revision };
    }
    catch (error) {
        if (!(error instanceof PersistenceError) || error.code !== 'PERSISTENCE_NOT_FOUND')
            throw error;
        persistence.initialize(initial);
        return { project: initial, revision: 0 };
    }
}
function encodeProjectRevision(projectId, timelineRevision, visualObjectRevision, graphRevision, artifactRevision) {
    // Graph and artifacts are part of the creative document, so editing either has
    // to move the revision an agent plan was built against — otherwise a plan made
    // before a node or a script changed would still look current and commit
    // against stale structure.
    return `local-revision:v1:${encodeURIComponent(projectId)}:timeline=${timelineRevision}:document=${visualObjectRevision}:graph=${graphRevision}:artifacts=${artifactRevision}`;
}
function persistenceProjectId(project) {
    if (project === null || typeof project !== 'object' || !('id' in project))
        throw new TypeError('project id is required');
    const id = project.id;
    if (typeof id !== 'string')
        throw new TypeError('project id is required');
    return id;
}
//# sourceMappingURL=editor-session.js.map