// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreativeBriefPanel } from './CreativeBriefPanel.js';
import { briefFixture } from './joy-agent/creative-brief.test-fixture.js';
import { JoyAgentTaskError, type CreativeBriefRunOptions } from './joy-agent/entry-points.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function renderPanel(props: React.ComponentProps<typeof CreativeBriefPanel>): void {
  if (container === undefined) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root!.render(<CreativeBriefPanel {...props} embedded />));
}

async function enterRequest(value: string): Promise<void> {
  const input = container?.querySelector<HTMLTextAreaElement>(
    '[aria-label="Describe creative improvement"]',
  );
  if (input === undefined || input === null)
    throw new Error('Creative Brief input was not rendered');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('Creative Brief invocation ownership', () => {
  it('does not save or hand off a result from a superseded project revision', async () => {
    let resolveBrief: ((brief: ReturnType<typeof briefFixture>) => void) | undefined;
    let options: CreativeBriefRunOptions | undefined;
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    };
    const onBriefReady = vi.fn();
    const onRunTerminal = vi.fn();
    const runBrief = vi.fn((_request: string, runOptions?: CreativeBriefRunOptions) => {
      options = runOptions;
      return new Promise<ReturnType<typeof briefFixture>>((resolve) => {
        resolveBrief = resolve;
      });
    });

    renderPanel({
      projectId: 'project-1',
      revisionId: 'rev-1',
      optedIn: true,
      runBrief,
      storage,
      onBriefReady,
      onRunTerminal,
    });
    await enterRequest('Improve pacing');
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="Improve project"]')?.click();
    });
    act(() => options?.onRunStart?.('brief-old'));
    renderPanel({
      projectId: 'project-1',
      revisionId: 'rev-2',
      optedIn: true,
      runBrief,
      storage,
      onBriefReady,
      onRunTerminal,
    });
    expect(options?.signal?.aborted).toBe(true);

    await act(async () => {
      resolveBrief?.(briefFixture('project-1', 'rev-1', 'Improve pacing'));
    });

    expect(saved.size).toBe(0);
    expect(onBriefReady).not.toHaveBeenCalled();
    expect(onRunTerminal).toHaveBeenCalledExactlyOnceWith('brief-old', 'cancelled');
  });

  it('releases the exact Brief run when the panel unmounts', async () => {
    let options: CreativeBriefRunOptions | undefined;
    const onRunTerminal = vi.fn();
    const runBrief = vi.fn((_request: string, runOptions?: CreativeBriefRunOptions) => {
      options = runOptions;
      runOptions?.onRunStart?.('brief-unmount');
      return new Promise<ReturnType<typeof briefFixture>>(() => {});
    });
    renderPanel({
      projectId: 'project-1',
      revisionId: 'rev-1',
      optedIn: true,
      runBrief,
      onRunTerminal,
    });
    await enterRequest('Improve pacing');
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="Improve project"]')?.click();
    });

    act(() => root?.unmount());

    expect(options?.signal?.aborted).toBe(true);
    expect(onRunTerminal).toHaveBeenCalledExactlyOnceWith('brief-unmount', 'cancelled');
  });

  it('offers Stop as soon as the pre-event run ID exists and sends that exact ID', async () => {
    let rejectCancelled: (() => void) | undefined;
    let runOptions: CreativeBriefRunOptions | undefined;
    const onStop = vi.fn((_runId: string) => rejectCancelled?.());
    const runBrief = vi.fn((_request: string, options?: CreativeBriefRunOptions) => {
      runOptions = options;
      options?.onRunStart?.('brief-warmup');
      return new Promise<ReturnType<typeof briefFixture>>((_resolve, reject) => {
        rejectCancelled = () => reject(new JoyAgentTaskError('cancelled', 'cancelled'));
      });
    });

    renderPanel({
      projectId: 'project-1',
      revisionId: 'rev-1',
      optedIn: true,
      runBrief,
      onStop,
    });
    await enterRequest('Improve pacing');
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="Improve project"]')?.click();
    });

    const stop = container?.querySelector<HTMLButtonElement>('[aria-label="Stop Creative Brief"]');
    expect(stop).toBeDefined();
    await act(async () => stop?.click());

    expect(onStop).toHaveBeenCalledWith('brief-warmup');
    expect(runOptions?.signal?.aborted).toBe(false);
  });
});
