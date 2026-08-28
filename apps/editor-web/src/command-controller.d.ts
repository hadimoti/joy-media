import type { CommandTransaction, HistoryMutation, TransactionRecord } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
export declare class EditorCommandController {
    #private;
    constructor(project: SpikeProject);
    get project(): SpikeProject;
    get undoLabel(): string | undefined;
    get redoLabel(): string | undefined;
    get undoRecords(): readonly TransactionRecord[];
    get redoRecords(): readonly TransactionRecord[];
    get canUndo(): boolean;
    get canRedo(): boolean;
    dispatch(transaction: CommandTransaction): SpikeProject;
    undo(): SpikeProject;
    undoWithRecord(): HistoryMutation;
    redo(): SpikeProject;
    redoWithRecord(): HistoryMutation;
}
//# sourceMappingURL=command-controller.d.ts.map