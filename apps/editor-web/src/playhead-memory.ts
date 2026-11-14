/**
 * Where the playhead was when a project was last open, kept per project in the browser storage, so reopening a
 * project puts the playhead back. A blocked or full storage must never stop the editor, so every call is guarded.
 */
const PLAYHEAD_KEY_PREFIX = 'joy-media.playhead.v1.';

export interface PlayheadMemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function playheadMemoryKey(projectId: string): string {
  return `${PLAYHEAD_KEY_PREFIX}${projectId}`;
}

/** The remembered playhead in microseconds, or `undefined` when there is none or it is unusable. */
export function readPlayheadMemory(
  storage: Pick<PlayheadMemoryStorage, 'getItem'>,
  projectId: string,
): number | undefined {
  try {
    const raw = storage.getItem(playheadMemoryKey(projectId));
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writePlayheadMemory(
  storage: Pick<PlayheadMemoryStorage, 'setItem'>,
  projectId: string,
  playheadUs: number,
): void {
  try {
    storage.setItem(playheadMemoryKey(projectId), String(Math.max(0, Math.round(playheadUs))));
  } catch {
    // A blocked local preference must not stop an edit.
  }
}
