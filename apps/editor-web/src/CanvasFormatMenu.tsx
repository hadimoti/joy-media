import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ExportPresetId } from '@joy-media/project-schema';
import { validateH264ExportDimensions } from '@joy-media/job-protocol';
import {
  CANVAS_SHAPES,
  canvasFormatReadout,
  canvasShapeForSize,
  type CanvasShape,
} from './canvas-format.js';
import { EXPORT_PRESETS, EXPORT_PRESET_MENU_IDS } from './export-presets.js';
import { CloseIcon, HighBitrateIcon, ReelsIcon, YoutubeIcon } from './icons.js';
import type { PopupControl } from './popup-manager.js';

export const CANVAS_FORMAT_POPOVER_ID = 'canvas-format-popover';
const CANVAS_HEADING_ID = 'canvas-format-heading-canvas';
const PRESET_HEADING_ID = 'canvas-format-heading-preset';

export interface CanvasFormatPopoverProps {
  /** The `canvas-format` popup. Escape, an outside click and a choice close it. */
  readonly popup: PopupControl;
  readonly width: number;
  readonly height: number;
  /** The export preset in effect for this canvas (already reconciled on load). */
  readonly presetId: ExportPresetId;
  readonly onApplyCanvas: (width: number, height: number, label: string) => void;
  readonly onApplyPreset: (presetId: ExportPresetId) => void;
}

/**
 * The Format popover: one place for the canvas (shape, width, height) and the
 * export preset. It is rendered only while its popup is open. The header button
 * and the monitor read-out both open it through the same popup id.
 */
export function CanvasFormatPopover({
  popup,
  width,
  height,
  presetId,
  onApplyCanvas,
  onApplyPreset,
}: CanvasFormatPopoverProps) {
  const readout = canvasFormatReadout({ width, height }, presetId);
  const currentShape = canvasShapeForSize(width, height);
  const [widthText, setWidthText] = useState(String(width));
  const [heightText, setHeightText] = useState(String(height));
  const [sizeError, setSizeError] = useState<string | undefined>(undefined);
  // The popover mounts only while open. Focus moves to its first control, so keyboard users
  // reach it from the monitor read-out or the header; closing returns focus to the opener.
  const firstControlRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    firstControlRef.current?.focus();
  }, []);
  // Shape choices and the preset list change the canvas while the popover is open,
  // so the typed sizes follow the document again.
  useEffect(() => {
    setWidthText(String(width));
    setHeightText(String(height));
    setSizeError(undefined);
  }, [width, height]);

  const commitSize = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextWidth = Number(widthText);
    const nextHeight = Number(heightText);
    if (!Number.isInteger(nextWidth) || !Number.isInteger(nextHeight)) {
      setSizeError('Width and height must be whole numbers of pixels.');
      return;
    }
    const check = validateH264ExportDimensions(nextWidth, nextHeight);
    if (!check.ok) {
      setSizeError(check.reason);
      return;
    }
    setSizeError(undefined);
    if (nextWidth === width && nextHeight === height) return;
    onApplyCanvas(nextWidth, nextHeight, `Change canvas to ${nextWidth}×${nextHeight}`);
  };

  // A shape or preset choice is one step, so the popover closes after it (typed sizes stay open).
  const chooseShape = (shape: CanvasShape) => {
    onApplyCanvas(shape.width, shape.height, `Change canvas aspect ratio to ${shape.label}`);
    popup.close();
  };
  const choosePreset = (id: ExportPresetId) => {
    onApplyPreset(id);
    popup.close();
  };

  return (
    <section
      className="header-dropdown canvas-format-popover"
      id={CANVAS_FORMAT_POPOVER_ID}
      role="dialog"
      aria-label="Format"
    >
      <div className="canvas-format-head">
        <div>
          <strong>Format</strong>
          <span className="canvas-format-readout">{readout}</span>
        </div>
        <button
          ref={firstControlRef}
          type="button"
          className="icon-button"
          aria-label="Close format options"
          title="Close"
          onClick={() => popup.close()}
        >
          <CloseIcon />
        </button>
      </div>

      <section className="canvas-format-section" aria-labelledby={CANVAS_HEADING_ID}>
        <h3 id={CANVAS_HEADING_ID}>Canvas</h3>
        <div className="canvas-format-shapes" role="group" aria-label="Canvas shape">
          {CANVAS_SHAPES.map((shape) => {
            const landscape = shape.width >= shape.height;
            return (
              <button
                key={shape.label}
                type="button"
                className="canvas-format-shape"
                aria-pressed={currentShape?.label === shape.label}
                title={`${shape.label} · ${shape.width}×${shape.height}`}
                onClick={() => chooseShape(shape)}
              >
                <span
                  className="canvas-format-shape-picture"
                  aria-hidden="true"
                  style={{
                    aspectRatio: `${shape.width} / ${shape.height}`,
                    ...(landscape ? { width: '1.6rem' } : { height: '1.6rem' }),
                  }}
                />
                <span className="canvas-format-shape-label">{shape.label}</span>
              </button>
            );
          })}
        </div>
        <form className="canvas-format-size" onSubmit={commitSize} aria-label="Canvas size">
          <label>
            <span>Width</span>
            <input
              type="number"
              inputMode="numeric"
              min={2}
              step={2}
              value={widthText}
              onChange={(event) => setWidthText(event.target.value)}
            />
          </label>
          <label>
            <span>Height</span>
            <input
              type="number"
              inputMode="numeric"
              min={2}
              step={2}
              value={heightText}
              onChange={(event) => setHeightText(event.target.value)}
            />
          </label>
          <button type="submit" className="canvas-format-apply">
            Apply size
          </button>
          {sizeError !== undefined && (
            <p className="canvas-format-error" role="alert">
              {sizeError}
            </p>
          )}
        </form>
      </section>

      <section className="canvas-format-section" aria-labelledby={PRESET_HEADING_ID}>
        <h3 id={PRESET_HEADING_ID}>Export preset</h3>
        <ul className="export-preset-list" role="menu" aria-label="Export preset">
          {EXPORT_PRESET_MENU_IDS.map((id) => (
            <li key={id} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={presetId === id}
                onClick={() => choosePreset(id)}
              >
                <span className="preset-icon-group" aria-hidden="true">
                  {id === 'youtube-1080' ? (
                    <YoutubeIcon />
                  ) : id === 'high-bitrate' ? (
                    <HighBitrateIcon />
                  ) : (
                    <ReelsIcon />
                  )}
                </span>
                <span className="export-preset-option-label">{EXPORT_PRESETS[id].label}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
