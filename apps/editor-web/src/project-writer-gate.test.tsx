// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type {
  ProjectWriterAcquireResult,
  ProjectWriterHandle,
  ProjectWriterStorage,
} from './project-writer.js';
import { ProjectWriterGate } from './project-writer-gate.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function fakeWriter(fence: number): {
  readonly writer: ProjectWriterHandle;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn(async () => undefined);
  return {
    writer: {
      fence,
      assertActive: () => undefined,
      guardStorage: (storage: ProjectWriterStorage) => storage,
      release,
    } as unknown as ProjectWriterHandle,
    release,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ProjectWriterGate', () => {
  it('does not mount editor children before it owns a writer capability', async () => {
    const pending = deferred<ProjectWriterAcquireResult>();
    const acquire = vi.fn(() => pending.promise);
    const writer = fakeWriter(1);
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.append(container);

    try {
      await act(async () => {
        root.render(
          <ProjectWriterGate acquire={acquire}>
            {(ownedWriter) => <output>fence {ownedWriter.fence}</output>}
          </ProjectWriterGate>,
        );
      });

      expect(acquire).toHaveBeenCalledOnce();
      expect(container.textContent).toContain('Opening editor');
      expect(container.querySelector('output')).toBeNull();

      await act(async () => {
        pending.resolve({ kind: 'owned', fence: 1, writer: writer.writer });
        await Promise.resolve();
      });

      expect(container.textContent).toContain('fence 1');
      expect(container.querySelector('output')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      await settle();
      expect(writer.release).toHaveBeenCalledOnce();
      container.remove();
    }
  });

  it('shows a safe unavailable state and acquires again after Retry', async () => {
    const writer = fakeWriter(2);
    const acquire = vi
      .fn<() => Promise<ProjectWriterAcquireResult>>()
      .mockResolvedValueOnce({ kind: 'busy' })
      .mockResolvedValueOnce({ kind: 'owned', fence: 2, writer: writer.writer });
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.append(container);

    try {
      await act(async () => {
        root.render(
          <ProjectWriterGate acquire={acquire}>
            {(ownedWriter) => <output>fence {ownedWriter.fence}</output>}
          </ProjectWriterGate>,
        );
      });
      await settle();

      expect(container.textContent).toContain('already open in another tab');
      expect(container.querySelector('output')).toBeNull();
      const retry = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Retry editor access"]',
      );
      expect(retry?.textContent).toBe('Retry');

      await act(async () => {
        retry?.click();
      });
      await settle();

      expect(acquire).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('fence 2');
    } finally {
      await act(async () => root.unmount());
      await settle();
      expect(writer.release).toHaveBeenCalledOnce();
      container.remove();
    }
  });

  it('waits for StrictMode cleanup to release before it asks the origin lock a second time', async () => {
    const firstAttempt = deferred<ProjectWriterAcquireResult>();
    const secondAttempt = deferred<ProjectWriterAcquireResult>();
    const firstWriter = fakeWriter(3);
    const secondWriter = fakeWriter(4);
    const acquire = vi
      .fn<() => Promise<ProjectWriterAcquireResult>>()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => secondAttempt.promise);
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.append(container);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <ProjectWriterGate acquire={acquire}>
              {(ownedWriter) => <output>fence {ownedWriter.fence}</output>}
            </ProjectWriterGate>
          </StrictMode>,
        );
      });
      await settle();
      // The first generation is already disposed, but its Web Lock callback
      // may still be retained. Calling the second `ifAvailable` request now
      // would make one tab report itself as busy forever.
      expect(acquire).toHaveBeenCalledTimes(1);

      await act(async () => {
        firstAttempt.resolve({ kind: 'owned', fence: 3, writer: firstWriter.writer });
        await Promise.resolve();
      });
      await settle();
      expect(firstWriter.release).toHaveBeenCalledOnce();
      expect(container.querySelector('output')).toBeNull();
      expect(container.textContent).toContain('Opening editor');
      expect(acquire).toHaveBeenCalledTimes(2);

      await act(async () => {
        secondAttempt.resolve({ kind: 'owned', fence: 4, writer: secondWriter.writer });
        await Promise.resolve();
      });
      await settle();
      expect(container.textContent).toContain('fence 4');
    } finally {
      await act(async () => root.unmount());
      await settle();
      expect(secondWriter.release).toHaveBeenCalledOnce();
      container.remove();
    }
  });

  it('releases on pagehide and reacquires after a BFCache pageshow', async () => {
    const firstWriter = fakeWriter(5);
    const secondWriter = fakeWriter(6);
    const acquire = vi
      .fn<() => Promise<ProjectWriterAcquireResult>>()
      .mockResolvedValueOnce({ kind: 'owned', fence: 5, writer: firstWriter.writer })
      .mockResolvedValueOnce({ kind: 'owned', fence: 6, writer: secondWriter.writer });
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.append(container);

    try {
      await act(async () => {
        root.render(
          <ProjectWriterGate acquire={acquire}>
            {(ownedWriter) => <output>fence {ownedWriter.fence}</output>}
          </ProjectWriterGate>,
        );
      });
      await settle();
      expect(container.textContent).toContain('fence 5');

      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });
      await settle();
      expect(firstWriter.release).toHaveBeenCalledOnce();
      expect(container.querySelector('output')).toBeNull();

      await act(async () => {
        window.dispatchEvent(new Event('pageshow'));
      });
      await settle();

      expect(acquire).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('fence 6');
    } finally {
      await act(async () => root.unmount());
      await settle();
      expect(secondWriter.release).toHaveBeenCalledOnce();
      container.remove();
    }
  });
});
