import type { ExportPresetId } from '@joy-media/project-schema';
import { EXPORT_PRESETS, reconcileExportPresetOnLoad, type CanvasSize } from './export-presets.js';

export type CanvasShapeGroup = 'Landscape' | 'Square' | 'Portrait';

/**
 * One canvas shape the project can be set to. The canvas size is the authored
 * size; the label is the ratio shown to people. Fit is not a shape: it was a
 * monitor-only view and has no place in the Format control.
 */
export interface CanvasShape {
  readonly label: string;
  readonly group: CanvasShapeGroup;
  readonly width: number;
  readonly height: number;
}

export const CANVAS_SHAPES: readonly CanvasShape[] = [
  { label: '16:9', group: 'Landscape', width: 1920, height: 1080 },
  { label: '4:3', group: 'Landscape', width: 1440, height: 1080 },
  { label: '3:2', group: 'Landscape', width: 1620, height: 1080 },
  { label: '21:9', group: 'Landscape', width: 2520, height: 1080 },
  { label: '1:1', group: 'Square', width: 1080, height: 1080 },
  { label: '9:16', group: 'Portrait', width: 1080, height: 1920 },
  { label: '4:5', group: 'Portrait', width: 1080, height: 1350 },
  { label: '3:4', group: 'Portrait', width: 1080, height: 1440 },
  { label: '2:3', group: 'Portrait', width: 1080, height: 1620 },
];

/** The shape whose authored size is exactly this canvas, or undefined for a custom size. */
export function canvasShapeForSize(width: number, height: number): CanvasShape | undefined {
  return CANVAS_SHAPES.find((shape) => shape.width === width && shape.height === height);
}

/** The short read-out of the shape: its ratio, or "Custom" when the canvas matches no shape. */
export function canvasShapeLabel(width: number, height: number): string {
  return canvasShapeForSize(width, height)?.label ?? 'Custom';
}

/**
 * The export preset to show for a canvas. Uses the same rule as the editor's
 * load-time reconcile, so the read-out and the export agree.
 */
export function canvasFormatPresetId(
  storedPresetId: ExportPresetId | undefined,
  canvas: CanvasSize,
): ExportPresetId {
  return reconcileExportPresetOnLoad(storedPresetId, canvas).presetId;
}

/** Example: "16:9 · 1920×1080 · YouTube · 1080p". */
export function canvasFormatReadout(canvas: CanvasSize, presetId: ExportPresetId): string {
  return `${canvasShapeLabel(canvas.width, canvas.height)} · ${canvas.width}×${canvas.height} · ${EXPORT_PRESETS[presetId].label}`;
}
