import type { CanvasReframeMode } from './canvas-reframe.js';

export const CANVAS_REFRAME_PREFERENCE_KEY = 'joy-media.canvas-reframe-mode.v1';

export interface CanvasReframePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readCanvasReframePreference(
  storage: Pick<CanvasReframePreferenceStorage, 'getItem'>,
): CanvasReframeMode {
  try {
    const value = storage.getItem(CANVAS_REFRAME_PREFERENCE_KEY);
    return value === 'fill' || value === 'keep' ? value : 'fit';
  } catch {
    return 'fit';
  }
}

export function writeCanvasReframePreference(
  storage: Pick<CanvasReframePreferenceStorage, 'setItem'>,
  mode: CanvasReframeMode,
): void {
  try {
    storage.setItem(CANVAS_REFRAME_PREFERENCE_KEY, mode);
  } catch {
    // A blocked local preference must not stop a canvas edit.
  }
}
