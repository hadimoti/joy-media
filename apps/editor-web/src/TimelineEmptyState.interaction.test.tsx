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
});
