import { useEffect, type DependencyList } from 'react';

/**
 * Run an asynchronous monitor-cache sync when its real inputs change.
 *
 * Completion may request one repaint, but the repaint signal is deliberately
 * not part of `dependencies`: adding it would make an immediately-resolving
 * no-target sync retrigger itself forever.
 */
export function useMonitorSceneSyncEffect(args: {
  readonly dependencies: DependencyList;
  readonly sync: () => Promise<boolean> | boolean | undefined;
  readonly onComplete: () => void;
  readonly onError?: ((error: unknown) => void) | undefined;
}): void {
  useEffect(() => {
    let cancelled = false;
    let result: Promise<boolean | undefined>;
    try {
      result = Promise.resolve(args.sync());
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.then(
      (didSync) => {
        if (!cancelled && didSync !== false) args.onComplete();
      },
      (error: unknown) => {
        if (!cancelled) args.onError?.(error);
      },
    );
    return () => {
      cancelled = true;
    };
    // The caller owns this dependency list. It intentionally excludes the
    // repaint state updated by onComplete to avoid an async feedback loop.
  }, args.dependencies);
}
