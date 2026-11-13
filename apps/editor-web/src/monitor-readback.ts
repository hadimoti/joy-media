import type { ScopePixels } from './ColorPanel.js';

let reader: (() => ScopePixels | undefined) | undefined;

export function setMonitorPixelReader(next: (() => ScopePixels | undefined) | undefined): void {
  reader = next;
}

export function readMonitorPixels(): ScopePixels | undefined {
  return reader?.();
}

/**
 * The Monitor's picture BEFORE the colour grade (T-K04 eyedropper).
 *
 * `readMonitorPixels` gives the graded picture the scopes show. The
 * eyedropper needs the colour the grade starts from, so a pick stays the same
 * while the grade changes: the Monitor draws the frame once without any grade,
 * copies it and draws it again with the grade (`MonitorPanel`).
 */
let ungradedReader: ((maxWidth: number, maxHeight: number) => ScopePixels | undefined) | undefined;

export function setMonitorUngradedPixelReader(
  next: ((maxWidth: number, maxHeight: number) => ScopePixels | undefined) | undefined,
): void {
  ungradedReader = next;
}

export function readUngradedMonitorPixels(
  maxWidth: number,
  maxHeight: number,
): ScopePixels | undefined {
  return ungradedReader?.(maxWidth, maxHeight);
}
