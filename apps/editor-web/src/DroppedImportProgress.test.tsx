// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DroppedImportProgress } from './DroppedImportProgress.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('DroppedImportProgress', () => {
  it('shows the current file, batch count, percentage, and invokes Cancel', async () => {
    const onCancel = vi.fn();
    await act(async () => {
      root?.render(
        <DroppedImportProgress
          progress={{
            fileName: 'clip with spaces.mp4',
            current: 2,
            total: 4,
            percentage: 37,
            cancelling: false,
          }}
          onCancel={onCancel}
        />,
      );
    });

    expect(container?.textContent).toContain('clip with spaces.mp4');
    expect(container?.textContent).toContain('2 of 4');
    expect(container?.textContent).toContain('37%');
    const progress = container?.querySelector('progress');
    expect(progress?.value).toBe(37);
    const cancel = container?.querySelector('button');
    expect(cancel?.textContent).toBe('Cancel');
    await act(async () => cancel?.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('disables the button while cancellation is in progress', async () => {
    await act(async () => {
      root?.render(
        <DroppedImportProgress
          progress={{
            fileName: 'clip.mp4',
            current: 1,
            total: 1,
            percentage: 52,
            cancelling: true,
          }}
          onCancel={vi.fn()}
        />,
      );
    });

    expect(container?.querySelector('button')?.disabled).toBe(true);
    expect(container?.textContent).toContain('Cancelling');
  });
});
