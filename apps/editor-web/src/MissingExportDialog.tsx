import { useId, useRef } from 'react';
import { useModalKeys } from './AppDialogs.js';
import { formatMissingExportRange, type MissingExportClip } from './export-missing-media.js';

export interface MissingExportDialogProps {
  /** The timeline clips whose file is missing, in timeline order. */
  readonly clips: readonly MissingExportClip[];
  /** The project frame rate, for the time codes. */
  readonly fps: number;
  readonly onRelink: () => void;
  readonly onExportAnyway: () => void;
  readonly onCancel: () => void;
}

/**
 * Shown before an export starts when a clip uses a file that is not on this PC (T-R04). The owner
 * can relink the file, export with the missing parts drawn black and silent, or cancel. Enter is
 * Relink, so a stray Enter never starts an export with missing parts.
 */
export function MissingExportDialog({
  clips,
  fps,
  onRelink,
  onExportAnyway,
  onCancel,
}: MissingExportDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const relinkRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  const count = clips.length;

  useModalKeys({
    dialogRef,
    primaryRef: relinkRef,
    initialFocusRef: relinkRef,
    onConfirm: onRelink,
    onCancel,
  });

  return (
    <div className="app-dialog-backdrop">
      <div
        ref={dialogRef}
        className="app-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <h2 id={titleId} className="app-dialog-title">
          Missing media in this export
        </h2>
        <p id={messageId} className="app-dialog-message">
          {count === 1
            ? 'One clip uses a file that is not on this PC.'
            : `${count} clips use files that are not on this PC.`}{' '}
          Export anyway draws the missing parts black and silent. Relink first to keep them.
        </p>
        <ul className="app-dialog-message" aria-label="Clips with missing media">
          {clips.map((clip) => (
            <li key={clip.clipId}>
              {clip.name} at {formatMissingExportRange(clip, fps)}
            </li>
          ))}
        </ul>
        <div className="app-dialog-actions">
          <button type="button" className="app-dialog-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="app-dialog-button" onClick={onExportAnyway}>
            Export anyway
          </button>
          <button
            ref={relinkRef}
            type="button"
            className="app-dialog-button app-dialog-button-primary"
            onClick={onRelink}
          >
            Relink…
          </button>
        </div>
      </div>
    </div>
  );
}
