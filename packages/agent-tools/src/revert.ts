import type { ProjectHistory, TransactionRecord } from '@joy-media/commands';

export interface RevertResult {
  readonly success: boolean;
  readonly planId: string;
  readonly transactionLabel: string;
  readonly revertedSteps: number;
  readonly error?: string;
}

export function revertAgentRun(
  planId: string,
  history: ProjectHistory,
  transactionLabel: string,
): RevertResult {
  const transactions = findAgentTransactions(planId, history);

  if (transactions.length === 0) {
    return {
      success: false,
      planId,
      transactionLabel,
      revertedSteps: 0,
      error: `No transactions found for plan ${planId}`,
    };
  }

  let revertedSteps = 0;

  try {
    for (let i = 0; i < transactions.length; i++) {
      if (!history.canUndo) {
        break;
      }
      const currentLabel = history.undoLabel;
      if (currentLabel === transactionLabel || currentLabel?.includes(planId)) {
        history.undo();
        const transaction = transactions[transactions.length - 1 - i];
        revertedSteps += transaction?.commands.length ?? 0;
      } else {
        break;
      }
    }

    if (revertedSteps === 0) {
      return {
        success: false,
        planId,
        transactionLabel,
        revertedSteps: 0,
        error: `Transaction ${transactionLabel} not found in undo history`,
      };
    }

    return {
      success: true,
      planId,
      transactionLabel,
      revertedSteps,
    };
  } catch (error) {
    return {
      success: false,
      planId,
      transactionLabel,
      revertedSteps,
      error: error instanceof Error ? error.message : 'Unknown error during revert',
    };
  }
}

export function findAgentTransactions(
  planId: string,
  history: ProjectHistory,
): readonly TransactionRecord[] {
  const records: TransactionRecord[] = [];
  const tempHistory = history;

  while (tempHistory.canUndo) {
    const label = tempHistory.undoLabel;
    if (label?.includes(planId)) {
      const { record } = tempHistory.undoWithRecord();
      records.push(record);
    } else {
      break;
    }
  }

  for (let i = records.length - 1; i >= 0; i--) {
    tempHistory.redo();
  }

  return records.reverse();
}

export function canRevertAgentRun(
  planId: string,
  history: ProjectHistory,
): { canRevert: boolean; reason?: string } {
  const transactions = findAgentTransactions(planId, history);

  if (transactions.length === 0) {
    return {
      canRevert: false,
      reason: `No transactions found for plan ${planId}`,
    };
  }

  if (!history.canUndo) {
    return {
      canRevert: false,
      reason: 'No undo history available',
    };
  }

  const lastLabel = history.undoLabel;
  if (!lastLabel?.includes(planId)) {
    return {
      canRevert: false,
      reason: `Plan ${planId} transactions are not at the top of the undo stack`,
    };
  }

  return { canRevert: true };
}
