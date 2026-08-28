// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import { TimelinePanel } from './TimelinePanel.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('TimelinePanel virtualization focus behavior', () => {
  it('keeps a focused track action mounted after its row scrolls out of the window', async () => {
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const project = emptySpikeProject({ trackCount: 20, durationUs: 30_000_000 });
    const composition = project.compositions[project.rootCompositionId]!;
    const root: Root = createRoot(container);
    const noop = vi.fn();

    await act(async () => {
      root.render(
        <TimelinePanel
          project={project}
          playheadUs={0}
          playing={false}
          selectedIds={[]}
          viewport={{ originUs: 0, pixelsPerSecond: 20 }}
          onViewportChange={noop}
          autoFit={false}
          onAutoFitChange={noop}
          onTogglePlayback={noop}
          onSeek={noop}
          onToggleSelection={noop}
          onClearSelection={noop}
          onDispatch={noop}
        />,
      );
    });

    const scrollRoot = container.querySelector<HTMLElement>('.timeline-tracks');
    const lockButton = container.querySelector<HTMLButtonElement>('[aria-label="Lock track-0"]');
    expect(scrollRoot).not.toBeNull();
    expect(lockButton).not.toBeNull();
    Object.defineProperties(scrollRoot!, {
      clientHeight: { configurable: true, value: 180 },
      scrollHeight: { configurable: true, value: 20 * 44 },
    });
    expect(scrollRoot!.scrollHeight).toBeGreaterThan(scrollRoot!.clientHeight);
    await act(async () => lockButton!.focus());
    expect(document.activeElement).toBe(lockButton);

    await act(async () => {
      scrollRoot!.scrollTop = 400;
      scrollRoot!.dispatchEvent(new Event('scroll'));
    });

    expect(scrollRoot!.scrollTop).toBe(400);
    expect(scrollRoot!.scrollTop).toBeLessThanOrEqual(
      scrollRoot!.scrollHeight - scrollRoot!.clientHeight,
    );
    expect(container.querySelector('[aria-label="Lock track-0"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Lock track-0');
    expect(composition.tracks).toHaveLength(20);

    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('disables empty playback and exposes keyboard-operable insertion lanes', async () => {
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const project = emptySpikeProject({ trackCount: 1, durationUs: 30_000_000 });
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <TimelinePanel
          project={project}
          playheadUs={0}
          playing={false}
          selectedIds={[]}
          viewport={{ originUs: 0, pixelsPerSecond: 20 }}
          onViewportChange={vi.fn()}
          autoFit={false}
          onAutoFitChange={vi.fn()}
          onTogglePlayback={vi.fn()}
          onSeek={vi.fn()}
          onToggleSelection={vi.fn()}
          onClearSelection={vi.fn()}
          onDispatch={vi.fn()}
        />,
      );
    });

    expect(container.querySelector<HTMLButtonElement>('[aria-label="Play"]')?.disabled).toBe(true);
    const lane = container.querySelector<HTMLElement>('[aria-label^="Empty timeline"]');
    expect(lane).not.toBeNull();
    expect(lane?.getAttribute('role')).toBe('region');
    expect(lane?.getAttribute('tabindex')).toBe('0');
    await act(async () => {
      lane!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
});
