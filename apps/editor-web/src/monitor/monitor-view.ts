/**
 * Monitor view settings that belong to the screen, not to the project: today
 * only the preview scale preset. Moved out of App.tsx without behaviour change
 * (T-M02a); zoom and pan (T-M02b) will grow from here.
 */

/** The preview scale presets the monitor offers today. */
export type MonitorViewerZoom = 'fit' | '50' | '100' | '200';

/** Which renderer the monitor preview asks for. */
export type MonitorPreviewRenderer = 'auto' | 'gpu-worker' | 'local';

/** What the GPU Worker preview is doing right now. */
export type MonitorGpuPreviewStatus = 'local' | 'connecting' | 'hardware-gpu' | 'fallback';

/** The scale presets in the order the scale drawer shows them. */
export const MONITOR_ZOOM_PRESETS = [
  ['fit', 'Fit'],
  ['50', '50%'],
  ['100', '100%'],
  ['200', '200%'],
] as const;

/** CSS scale applied to the monitor canvas for a preset (Fit uses no scale). */
export function monitorZoomScale(viewerZoom: MonitorViewerZoom): number {
  return viewerZoom === 'fit' ? 1 : viewerZoom === '50' ? 0.5 : viewerZoom === '200' ? 2 : 1;
}

/** The label shown on the scale button for a preset. */
export function monitorZoomLabel(viewerZoom: MonitorViewerZoom): string {
  return viewerZoom === 'fit'
    ? 'Fit'
    : viewerZoom === '50'
      ? '50%'
      : viewerZoom === '200'
        ? '200%'
        : '100%';
}
