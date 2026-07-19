import { ProjectHistory } from '@joy-media/commands';
import type { CommandTransaction, HistoryMutation } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
export class EditorCommandController {
  readonly #history: ProjectHistory;
  constructor(project: SpikeProject) {
    this.#history = new ProjectHistory(project);
  }
  get project(): SpikeProject {
    return this.#history.present;
  }
  get undoLabel(): string | undefined {
    return this.#history.undoLabel;
  }
  get canUndo(): boolean {
    return this.#history.canUndo;
  }
  get canRedo(): boolean {
    return this.#history.canRedo;
  }
  dispatch(transaction: CommandTransaction): SpikeProject {
    return this.#history.apply(transaction);
  }
  undo(): SpikeProject {
    return this.#history.undo();
  }
  undoWithRecord(): HistoryMutation {
    return this.#history.undoWithRecord();
  }
  redo(): SpikeProject {
    return this.#history.redo();
  }
  redoWithRecord(): HistoryMutation {
    return this.#history.redoWithRecord();
  }
}
