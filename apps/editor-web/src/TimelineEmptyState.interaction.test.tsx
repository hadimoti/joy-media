// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import { TimelineEmptyState } from './TimelineEmptyState.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('TimelineEmptyState interactions', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('opens import when the Persian empty-state copy itself is clicked', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onImportClick = vi.fn();
    const onAddFromLibrary = vi.fn();
    await act(async () => {
      root!.render(
        <TimelineEmptyState
          project={emptySpikeProject({ trackCount: 0 })}
          _playheadUs={0}
          compositionDurationUs={30_000_000}
          viewportPixelsPerSecond={20}
          onSeek={vi.fn()}
          onImportClick={onImportClick}
          onAddFromLibrary={onAddFromLibrary}
          onContextMenu={vi.fn()}
        />,
      );
    });

    await act(async () => {
      container!.querySelector<HTMLElement>('.timeline-empty-text')!.click();
    });
    expect(onImportClick).toHaveBeenCalledTimes(1);

    await act(async () => {
      container!.querySelector<HTMLElement>('.timeline-empty-strip-icon')!.click();
      container!.querySelector<HTMLButtonElement>('.timeline-empty-action')!.click();
      container!.querySelectorAll<HTMLButtonElement>('.timeline-empty-action')[1]!.click();
    });
    expect(onImportClick).toHaveBeenCalledTimes(3);
    expect(onAddFromLibrary).toHaveBeenCalledTimes(1);
  });

  it('passes the drop point from an OS file drop to timeline placement', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const file = new File(['media'], 'clip.mp4', { type: 'video/mp4' });
    const onFilesDrop = vi.fn();
    await act(async () => {
      root!.render(
        <TimelineEmptyState
          project={emptySpikeProject({ trackCount: 0 })}
          _playheadUs={0}
          compositionDurationUs={30_000_000}
          viewportPixelsPerSecond={20}
          onSeek={vi.fn()}
          onImportClick={vi.fn()}
          onAddFromLibrary={vi.fn()}
          onFilesDrop={onFilesDrop}
          onContextMenu={vi.fn()}
        />,
      );
    });
    const target = container.querySelector<HTMLElement>('.timeline-empty-state')!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      left: 40,
      right: 240,
      top: 0,
      bottom: 50,
      width: 200,
      height: 50,
      x: 40,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: 140 },
      dataTransfer: { value: { types: ['Files'], files: [file], getData: () => '' } },
    });

    await act(async () => {
      target.dispatchEvent(event);
    });

    expect(onFilesDrop).toHaveBeenCalledWith(
      [file],
      expect.objectContaining({ clientX: 140, rect: expect.objectContaining({ left: 40 }) }),
    );
  });
});
