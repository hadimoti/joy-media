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

async function renderDialog(
  defaultMode: 'fit' | 'fill' | 'keep' = 'fit',
  skippedObjectCount = 0,
  cameraFramed = false,
) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <CanvasReframeDialog
        defaultMode={defaultMode}
        skippedObjectCount={skippedObjectCount}
        cameraFramed={cameraFramed}
        onApply={onApply}
        onCancel={onCancel}
        source={{ width: 1920, height: 1080 }}
        target={{ width: 1080, height: 1920 }}
      />,
    );
  });
  return { onApply, onCancel };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

describe('CanvasReframeDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('preselects the last answer and explains which objects Fit and Fill leave alone', async () => {
    await renderDialog('fill', 2);

    expect(document.querySelector<HTMLInputElement>('input[value="fill"]')?.checked).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Hand-set transforms scale by the same rule around the canvas centre.',
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Fit and Fill will leave 2 objects alone because expressions or unsupported animation prevent safe remapping.',
    );
  });

  it('says plainly that camera-framed clips are left as they are', async () => {
    await renderDialog('fit', 2, true);

    const text = document.querySelector('[role="dialog"]')?.textContent ?? '';
    expect(text).toContain(
      'This project is framed by a camera, so Fit and Fill do not change any clip.',
    );
    expect(text).toContain('2 clip objects are left as they are, because the camera frames them.');
    expect(text).not.toContain('Hand-set transforms scale by the same rule');
    expect(text).not.toContain('expressions or unsupported animation');
  });

  it('applies the selected mode', async () => {
    const { onApply } = await renderDialog();
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

  it('cancels when Escape is pressed', async () => {
    const { onCancel } = await renderDialog();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onCancel).toHaveBeenCalledOnce();
  });
});
