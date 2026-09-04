export interface JoyAgentPreviewBundle<T = unknown> {
  readonly runId: string;
  readonly seq: number;
  readonly baseRevision: string;
  readonly proposalHash: string;
  readonly value: T;
  readonly summary: string;
}

export interface JoyAgentPreviewController<T = unknown> {
  current(): JoyAgentPreviewBundle<T> | undefined;
  update(bundle: JoyAgentPreviewBundle<T>): boolean;
  clear(reason?: string): void;
  subscribe(listener: (bundle: JoyAgentPreviewBundle<T> | undefined) => void): () => void;
}

/**
 * In-memory, revision-bound preview branch. It never calls an editor command
 * bus and ignores stale runs/sequences, so a provider cannot overwrite a
 * newer human edit or another run's preview.
 */
export function createJoyAgentPreviewController<T = unknown>(): JoyAgentPreviewController<T> {
  let current: JoyAgentPreviewBundle<T> | undefined;
  const listeners = new Set<(bundle: JoyAgentPreviewBundle<T> | undefined) => void>();
  const notify = () => listeners.forEach((listener) => listener(current));
  return {
    current: () => current,
    update: (bundle) => {
      if (bundle.seq < 0 || bundle.runId.trim() === '' || bundle.baseRevision.trim() === '')
        return false;
      if (current !== undefined && (current.runId !== bundle.runId || bundle.seq <= current.seq))
        return false;
      current = Object.freeze({ ...bundle });
      notify();
      return true;
    },
    clear: () => {
      if (current === undefined) return;
      current = undefined;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
