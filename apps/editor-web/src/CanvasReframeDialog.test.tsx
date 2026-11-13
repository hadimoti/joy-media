// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasReframeDialog } from './CanvasReframeDialog.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function renderDialog(defaultMode: 'fit' | 'fill' | 'keep' = 'fit', onApply = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <CanvasReframeDialog
        defaultMode={defaultMode}
        onApply={onApply}
        onCancel={vi.fn()}
        source={{ width: 1920, height: 1080 }}
        target={{ width: 1080, height: 1920 }}
      />,
    );
  });
  return onApply;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

describe('CanvasReframeDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('preselects the last answer and explains how hand-set transforms move', async () => {
    await renderDialog('fill');

    expect(document.querySelector<HTMLInputElement>('input[value="fill"]')?.checked).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Hand-set transforms scale by the same rule around the canvas centre.',
    );
  });

  it('applies the selected mode', async () => {
    const onApply = await renderDialog();
    const fill = document.querySelector<HTMLInputElement>('input[value="fill"]');
    if (fill === null) throw new Error('Fill choice is missing');
    await click(fill);
    const apply = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Apply',
    );
    if (apply === undefined) throw new Error('Apply button is missing');
    await click(apply);

    expect(onApply).toHaveBeenCalledWith('fill');
  });
});
