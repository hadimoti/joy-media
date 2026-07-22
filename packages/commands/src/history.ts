/**
 * Transactions and undo/redo history (master plan §11.3–§11.5, ADR-0003).
 *
 * A transaction is an atomic ordered group of commands forming one undo step.
 * Because projects are immutable, rollback is free: any failure mid-transaction
 * simply discards the intermediate value. Undo applies recorded inverses (in
 * reverse order); redo re-applies the original commands.
 */

import type { SpikeProject } from '@joy-media/project-schema';
import type { SpikeCommand } from './commands.js';
import { applyCommand, CommandError } from './commands.js';

export interface CommandTransaction {
  readonly label: string;
  readonly commands: readonly SpikeCommand[];
  /** Continuous interactions with the same key collapse into one undo entry. */
  readonly coalesceKey?: string;
}

export interface TransactionRecord {
  readonly label: string;
  readonly commands: readonly SpikeCommand[];
  /** Inverses in application order for undo (i.e. already reversed). */
  readonly inverses: readonly SpikeCommand[];
  readonly coalesceKey?: string;
}

export interface TransactionResult {
  readonly project: SpikeProject;
  readonly record: TransactionRecord;
}

export interface HistoryMutation {
  readonly project: SpikeProject;
  readonly record: TransactionRecord;
}

/** Applies all commands atomically. Throws (leaving the input untouched) if any command fails. */
export function applyTransaction(
  project: SpikeProject,
  transaction: CommandTransaction,
): TransactionResult {
  if (transaction.commands.length === 0) {
    throw new CommandError('COMMAND_VALIDATION_EMPTY_TRANSACTION', 'a transaction needs commands');
  }
  let current = project;
  const inverses: SpikeCommand[] = [];
  for (const command of transaction.commands) {
    const result = applyCommand(current, command);
    current = result.project;
    inverses.unshift(result.inverse);
  }
  return {
    project: current,
    record: {
      label: transaction.label,
      commands: [...transaction.commands],
      inverses,
      ...(transaction.coalesceKey === undefined ? {} : { coalesceKey: transaction.coalesceKey }),
    },
  };
}

/** Single-user linear undo/redo (§11.5). A new transaction clears the redo stack. */
export class ProjectHistory {
  #present: SpikeProject;
  readonly #undo: TransactionRecord[] = [];
  readonly #redo: TransactionRecord[] = [];

  constructor(initial: SpikeProject) {
    this.#present = initial;
  }

  get present(): SpikeProject {
    return this.#present;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** Label of the transaction that undo would revert (§11.5 "explain what will be undone"). */
  get undoLabel(): string | undefined {
    return this.#undo[this.#undo.length - 1]?.label;
  }

  /** Label of the transaction that redo would re-apply. */
  get redoLabel(): string | undefined {
    return this.#redo[this.#redo.length - 1]?.label;
  }

  /** Returns a copy of the undo stack (newest first, most recent at index 0). */
  get undoRecords(): readonly TransactionRecord[] {
    return [...this.#undo].reverse();
  }

  /** Returns a copy of the redo stack (newest first, most recent at index 0). */
  get redoRecords(): readonly TransactionRecord[] {
    return [...this.#redo].reverse();
  }

  apply(transaction: CommandTransaction): SpikeProject {
    const result = applyTransaction(this.#present, transaction);
    this.#present = result.project;
    const previous = this.#undo[this.#undo.length - 1];
    if (
      result.record.coalesceKey !== undefined &&
      previous !== undefined &&
      previous.coalesceKey === result.record.coalesceKey
    ) {
      this.#undo[this.#undo.length - 1] = {
        label: result.record.label,
        commands: [...previous.commands, ...result.record.commands],
        inverses: [...result.record.inverses, ...previous.inverses],
        coalesceKey: result.record.coalesceKey,
      };
    } else {
      this.#undo.push(result.record);
    }
    this.#redo.length = 0;
    return this.#present;
  }

  undo(): SpikeProject {
    return this.undoWithRecord().project;
  }

  /** Exposes the applied inverses so a durable editor log can record an undo. */
  undoWithRecord(): HistoryMutation {
    const record = this.#undo.pop();
    if (record === undefined) {
      throw new CommandError('COMMAND_HISTORY_EMPTY', 'nothing to undo');
    }
    let current = this.#present;
    for (const inverse of record.inverses) {
      current = applyCommand(current, inverse).project;
    }
    this.#present = current;
    this.#redo.push(record);
    return { project: this.#present, record };
  }

  redo(): SpikeProject {
    return this.redoWithRecord().project;
  }

  /** Exposes the reapplied commands so a durable editor log can record a redo. */
  redoWithRecord(): HistoryMutation {
    const record = this.#redo.pop();
    if (record === undefined) {
      throw new CommandError('COMMAND_HISTORY_EMPTY', 'nothing to redo');
    }
    let current = this.#present;
    for (const command of record.commands) {
      current = applyCommand(current, command).project;
    }
    this.#present = current;
    this.#undo.push(record);
    return { project: this.#present, record };
  }
}
