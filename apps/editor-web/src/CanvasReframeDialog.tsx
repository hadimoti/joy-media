import { useId, useRef, useState } from 'react';
import type { CanvasReframeMode, CanvasSize } from './canvas-reframe.js';
import { useModalKeys } from './AppDialogs.js';

export interface CanvasReframeDialogProps {
  readonly defaultMode: CanvasReframeMode;
  readonly source: CanvasSize;
  readonly target: CanvasSize;
  readonly skippedObjectCount: number;
  readonly cameraFramed: boolean;
  readonly onApply: (mode: CanvasReframeMode) => void;
  readonly onCancel: () => void;
}

const choices: readonly {
  readonly mode: CanvasReframeMode;
  readonly label: string;
  readonly description: string;
}[] = [
  { mode: 'fit', label: 'Fit', description: 'Keep the whole picture visible, with bars.' },
  { mode: 'fill', label: 'Fill', description: 'Crop the picture to cover the new canvas.' },
  { mode: 'keep', label: 'Keep positions', description: 'Leave clips where they are.' },
];

export function CanvasReframeDialog({
  defaultMode,
  source,
  target,
  skippedObjectCount,
  cameraFramed,
  onApply,
  onCancel,
}: CanvasReframeDialogProps) {
  const [mode, setMode] = useState(defaultMode);
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useModalKeys({
    dialogRef,
    primaryRef: applyRef,
    initialFocusRef,
    onConfirm: () => onApply(mode),
    onCancel,
  });

  return (
    <div className="app-dialog-backdrop">
      <div
        ref={dialogRef}
        className="app-dialog canvas-reframe-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <h2 id={titleId} className="app-dialog-title">
          Reframe clips for the new canvas?
        </h2>
        <p id={descriptionId} className="app-dialog-message">
          {source.width}×{source.height} → {target.width}×{target.height}. Choose one option for
          every clip.
        </p>
        <fieldset className="canvas-reframe-options">
          <legend className="sr-only">How to reframe the clips</legend>
          {choices.map((choice) => (
            <label className="canvas-reframe-option" key={choice.mode}>
              <input
                ref={choice.mode === defaultMode ? initialFocusRef : undefined}
                type="radio"
                name="canvas-reframe-mode"
                value={choice.mode}
                checked={mode === choice.mode}
                onChange={() => setMode(choice.mode)}
              />
              <span>
                <strong>{choice.label}</strong>
                <span>{choice.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {!cameraFramed && (
          <p className="app-dialog-message">
            Hand-set transforms scale by the same rule around the canvas centre.
          </p>
        )}
        {cameraFramed && (
          <p className="app-dialog-message">
            This project is framed by a camera, so Fit and Fill do not change any clip.
            {skippedObjectCount > 0 &&
              ` ${skippedObjectCount} clip object${skippedObjectCount === 1 ? ' is' : 's are'} left as ${
                skippedObjectCount === 1 ? 'it is' : 'they are'
              }, because the camera frames ${skippedObjectCount === 1 ? 'it' : 'them'}.`}
          </p>
        )}
        {skippedObjectCount > 0 && !cameraFramed && (
          <p className="app-dialog-message">
            Fit and Fill will leave {skippedObjectCount} object
            {skippedObjectCount === 1 ? '' : 's'} alone because expressions or unsupported animation
            prevent safe remapping.
          </p>
        )}
        <div className="app-dialog-actions">
          <button type="button" className="app-dialog-button" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={applyRef}
            type="button"
            className="app-dialog-button app-dialog-button-primary"
            onClick={() => onApply(mode)}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
