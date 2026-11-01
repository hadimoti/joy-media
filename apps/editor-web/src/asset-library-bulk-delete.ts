export type BulkDeleteOutcome =
  | { readonly assetId: string; readonly outcome: 'removed' }
  | { readonly assetId: string; readonly outcome: 'absent' }
  | { readonly assetId: string; readonly outcome: 'failed'; readonly message: string };

export interface BulkDeleteSummary {
  readonly removedCount: number;
  readonly absentCount: number;
  readonly failedCount: number;
  readonly firstErrorMessage: string | undefined;
  readonly failedIds: readonly string[];
  readonly status: string;
}

export function summarizeBulkDeleteOutcomes(
  outcomes: readonly BulkDeleteOutcome[],
): BulkDeleteSummary {
  const removedCount = outcomes.filter((outcome) => outcome.outcome === 'removed').length;
  const absentCount = outcomes.filter((outcome) => outcome.outcome === 'absent').length;
  const failures = outcomes.filter(
    (outcome): outcome is Extract<BulkDeleteOutcome, { outcome: 'failed' }> =>
      outcome.outcome === 'failed',
  );
  const firstErrorMessage = failures[0]?.message;
  const summary = `Deleted ${removedCount} of ${outcomes.length} selected media items.`;

  return {
    removedCount,
    absentCount,
    failedCount: failures.length,
    firstErrorMessage,
    failedIds: failures.map(({ assetId }) => assetId),
    status:
      failures.length === 0
        ? summary
        : `${summary} ${failures.length} failed: ${firstErrorMessage ?? 'Unknown error'}.`,
  };
}
