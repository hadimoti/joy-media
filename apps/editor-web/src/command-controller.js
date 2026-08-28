import { ProjectHistory } from '@joy-media/commands';
export class EditorCommandController {
    #history;
    constructor(project) {
        this.#history = new ProjectHistory(project);
    }
    get project() {
        return this.#history.present;
    }
    get undoLabel() {
        return this.#history.undoLabel;
    }
    get redoLabel() {
        return this.#history.redoLabel;
    }
    get undoRecords() {
        return this.#history.undoRecords;
    }
    get redoRecords() {
        return this.#history.redoRecords;
    }
    get canUndo() {
        return this.#history.canUndo;
    }
    get canRedo() {
        return this.#history.canRedo;
    }
    dispatch(transaction) {
        return this.#history.apply(transaction);
    }
    undo() {
        return this.#history.undo();
    }
    undoWithRecord() {
        return this.#history.undoWithRecord();
    }
    redo() {
        return this.#history.redo();
    }
    redoWithRecord() {
        return this.#history.redoWithRecord();
    }
}
//# sourceMappingURL=command-controller.js.map