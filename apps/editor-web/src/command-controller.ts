import { ProjectHistory } from '@joy-media/commands';
import type { CommandTransaction } from '@joy-media/commands';
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
  dispatch(transaction: CommandTransaction): SpikeProject {
    return this.#history.apply(transaction);
  }
  undo(): SpikeProject {
    return this.#history.undo();
  }
  redo(): SpikeProject {
    return this.#history.redo();
  }
}
