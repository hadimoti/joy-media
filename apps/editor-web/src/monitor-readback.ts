import type { ScopePixels } from './ColorPanel.js';

let reader: (() => ScopePixels | undefined) | undefined;

export function setMonitorPixelReader(next: (() => ScopePixels | undefined) | undefined): void {
  reader = next;
}

export function readMonitorPixels(): ScopePixels | undefined {
  return reader?.();
}
