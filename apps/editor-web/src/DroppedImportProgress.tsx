export interface DroppedImportProgressState {
  readonly fileName: string;
  readonly current: number;
  readonly total: number;
  readonly percentage: number;
  readonly cancelling: boolean;
}

export function DroppedImportProgress({
  progress,
  onCancel,
}: {
  readonly progress: DroppedImportProgressState;
  readonly onCancel: () => void;
}) {
  const percentage = Math.min(100, Math.max(0, progress.percentage));
  return (
    <div className="dropped-import-progress" role="status" aria-live="polite">
      <span className="dropped-import-progress-name" title={progress.fileName}>
        {progress.fileName}
      </span>
      <span className="dropped-import-progress-count">
        {progress.current} of {progress.total} · {percentage}%
      </span>
      <progress
        aria-label={`Import progress for ${progress.fileName}`}
        max={100}
        value={percentage}
      />
      <button type="button" onClick={onCancel} disabled={progress.cancelling}>
        {progress.cancelling ? 'Cancelling…' : 'Cancel'}
      </button>
    </div>
  );
}
