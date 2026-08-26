import type { ProjectDocumentRecoveredCopy } from './project-document-sync-coordinator.js';

/** Truthful, actionable status for a stale-revision recovery. */
export function RecoveredCopyStatus({
  copy,
  onOpen,
}: {
  readonly copy: ProjectDocumentRecoveredCopy;
  readonly onOpen: () => void;
}) {
  return (
    <div className="export-toast recovered-copy-status" role="status" aria-live="polite">
      <span>
        Saved recovered copy “<bdi dir="auto">{copy.name}</bdi>” from revision{' '}
        {copy.provenance.baseRevision} (source now at revision {copy.provenance.sourceHeadRevision}
        ); the source project was not overwritten.
      </span>{' '}
      <button type="button" onClick={onOpen}>
        Open recovered copy
      </button>
    </div>
  );
}
