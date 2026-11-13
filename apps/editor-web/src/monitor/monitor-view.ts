/**
 * Small Monitor view helpers that belong to the screen, not to the project.
 * The zoom and pan state itself lives in `monitor-view-state.ts` (T-M02b).
 */

import { formatZoomPercent } from './monitor-view-state.js';

/** The label shown on the zoom button: "Fit" or a percentage such as "150%". */
export function monitorZoomLabel(fit: boolean, zoom: number): string {
  return fit ? 'Fit' : formatZoomPercent(zoom);
}
