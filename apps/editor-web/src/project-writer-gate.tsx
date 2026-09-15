import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  acquireProjectWriter,
  type OriginWriterLockManager,
  type ProjectWriterAcquireResult,
  type ProjectWriterHandle,
  type ProjectWriterStorage,
} from './project-writer.js';

/** Injectable so the origin lock boundary remains testable without global browser state. */
export type ProjectWriterAcquirer = () => Promise<ProjectWriterAcquireResult>;

export interface ProjectWriterGateProps {
  /** The editor is deliberately not constructed until this capability is owned. */
  readonly children: (writer: ProjectWriterHandle) => ReactNode;
  /** Overrides browser acquisition for tests or an explicit host integration. */
  readonly acquire?: ProjectWriterAcquirer;
  /** Defaults to this page's localStorage when `acquire` is not supplied. */
  readonly storage?: ProjectWriterStorage;
  /** Defaults to the browser Web Locks API when `acquire` is not supplied. */
  readonly lockManager?: OriginWriterLockManager | null;
}

type UnavailableWriterResult = Exclude<ProjectWriterAcquireResult, { readonly kind: 'owned' }>;

type GateState =
  | { readonly kind: 'acquiring' }
  | { readonly kind: 'owned'; readonly writer: ProjectWriterHandle }
  | { readonly kind: 'unavailable'; readonly result: UnavailableWriterResult };

interface WriterAcquisitionLease {
  /** Safe to call more than once; resolves after a late owned writer is released. */
  dispose(): Promise<void>;
}

/**
 * Origin-wide write boundary for the editor root.
 *
 * It intentionally takes a render prop instead of publishing a mutable global
 * capability. That ensures nothing below the gate can initialize persistent
 * editor state before the browser has granted the exclusive writer lock.
 */
export function ProjectWriterGate({
  children,
  acquire,
  storage,
  lockManager,
}: ProjectWriterGateProps): ReactNode {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<GateState>({ kind: 'acquiring' });
  const activeLeaseRef = useRef<WriterAcquisitionLease | undefined>(undefined);
  // React StrictMode deliberately tears down and recreates effects. A new
  // `ifAvailable` request must wait until the disposed generation has actually
  // released its retained Web Lock, otherwise one physical tab can race itself
  // into a permanent misleading `busy` state.
  const releaseBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const pageWasHiddenRef = useRef(false);

  const acquireWriter = useCallback(async (): Promise<ProjectWriterAcquireResult> => {
    if (acquire !== undefined) return acquire();

    const browserStorage = storage ?? localBrowserStorage();
    if (browserStorage === undefined) {
      return { kind: 'storage-unavailable', reason: 'storage-read-failed' };
    }

    if (lockManager === undefined) return acquireProjectWriter({ storage: browserStorage });
    return acquireProjectWriter({ storage: browserStorage, lockManager });
  }, [acquire, lockManager, storage]);

  const retry = useCallback(() => {
    setAttempt((currentAttempt) => currentAttempt + 1);
  }, []);

  useEffect(() => {
    const previousRelease = releaseBarrierRef.current;
    const lease = beginWriterAcquisition(
      acquireWriter,
      (result) => {
        if (activeLeaseRef.current !== lease) return;
        if (result.kind === 'owned') {
          setState({ kind: 'owned', writer: result.writer });
          return;
        }
        setState({ kind: 'unavailable', result });
      },
      previousRelease,
    );

    activeLeaseRef.current = lease;
    setState({ kind: 'acquiring' });

    return () => {
      if (activeLeaseRef.current === lease) activeLeaseRef.current = undefined;
      releaseBarrierRef.current = lease.dispose();
    };
  }, [acquireWriter, attempt]);

  useEffect(() => {
    let mounted = true;

    const onPageHide = (): void => {
      pageWasHiddenRef.current = true;
      // Do not leave a released writer's children mounted when a BFCache page
      // resumes. `pageshow` will start a fresh acquisition after release.
      setState({ kind: 'acquiring' });
      releaseBarrierRef.current = activeLeaseRef.current?.dispose() ?? Promise.resolve();
    };

    const onPageShow = (): void => {
      if (!pageWasHiddenRef.current) return;
      pageWasHiddenRef.current = false;
      const release = activeLeaseRef.current?.dispose() ?? Promise.resolve();
      releaseBarrierRef.current = release;
      void release.then(() => {
        if (mounted) retry();
      });
    };

    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      mounted = false;
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [retry]);

  if (state.kind === 'owned') return children(state.writer);
  if (state.kind === 'acquiring') return <WriterAccessPending />;
  return <WriterAccessUnavailable result={state.result} onRetry={retry} />;
}

function WriterAccessPending(): ReactNode {
  return (
    <section
      className="project-writer-gate"
      aria-busy="true"
      aria-labelledby="project-writer-gate-title"
    >
      <h2 id="project-writer-gate-title">Opening editor</h2>
      <p>Checking exclusive edit access for this browser.</p>
    </section>
  );
}

function WriterAccessUnavailable({
  result,
  onRetry,
}: {
  readonly result: UnavailableWriterResult;
  readonly onRetry: () => void;
}): ReactNode {
  const message = unavailableWriterMessage(result);
  return (
    <section
      className="project-writer-gate project-writer-gate-unavailable"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-labelledby="project-writer-gate-title"
    >
      <h2 id="project-writer-gate-title">Editor access is unavailable</h2>
      <p>{message}</p>
      <button type="button" onClick={onRetry} aria-label="Retry editor access">
        Retry
      </button>
    </section>
  );
}

function unavailableWriterMessage(result: UnavailableWriterResult): string {
  switch (result.kind) {
    case 'busy':
      return 'This editor is already open in another tab. Return here after that tab closes.';
    case 'unsupported':
      return 'This browser cannot safely provide exclusive editing access.';
    case 'storage-unavailable':
      return 'Browser storage is unavailable, so this editor cannot safely save changes.';
  }
}

function localBrowserStorage(): ProjectWriterStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function beginWriterAcquisition(
  acquire: ProjectWriterAcquirer,
  onResult: (result: ProjectWriterAcquireResult) => void,
  afterRelease: Promise<void>,
): WriterAcquisitionLease {
  let disposed = false;
  let acquireSettled = false;
  let writer: ProjectWriterHandle | undefined;
  let releasePromise: Promise<void> | undefined;
  let finish!: () => void;
  const fullyDisposed = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const release = (): Promise<void> => {
    if (releasePromise !== undefined) return releasePromise;
    if (writer === undefined) {
      if (acquireSettled) finish();
      return fullyDisposed;
    }

    releasePromise = Promise.resolve()
      .then(() => writer!.release())
      // A broken adapter must not cause an unhandled rejection during browser
      // teardown. The real Web Lock remains the final authority on a retry.
      .catch(() => undefined)
      .then(() => {
        finish();
      });
    return releasePromise;
  };

  void afterRelease
    // A teardown adapter failure must not bypass origin ownership. The next
    // acquisition can still ask the browser lock manager, which remains the
    // actual authority.
    .catch(() => undefined)
    .then(acquire)
    .then(
      (result) => {
        acquireSettled = true;
        if (result.kind === 'owned') writer = result.writer;
        if (disposed) {
          void release();
          return;
        }
        onResult(result);
        if (result.kind !== 'owned') finish();
      },
      () => {
        acquireSettled = true;
        if (!disposed) onResult({ kind: 'unsupported' });
        finish();
      },
    );

  return {
    dispose: () => {
      disposed = true;
      return release();
    },
  };
}
