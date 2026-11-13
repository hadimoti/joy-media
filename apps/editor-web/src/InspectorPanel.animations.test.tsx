// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import { InspectorPanel } from './InspectorPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

const OBJECT: VisualObjectV1 = {
  id: 'clip-1',
  kind: 'text',
  text: 'Title',
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
  animations: {
    x: {
      keyframes: [
        { timeUs: 0, value: 0, interpolation: 'linear' },
        { timeUs: 1_000_000, value: 100, interpolation: 'linear' },
      ],
    },
    opacity: { keyframes: [{ timeUs: 0, value: 0, interpolation: 'linear' }] },
  },
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function mount(
  overrides: {
    readonly onDispatch?: (transaction: unknown) => void;
    readonly onOpenAnimationGraph?: (objectId: string, channel: string) => void;
  } = {},
) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <InspectorPanel
        object={OBJECT}
        allObjects={{ [OBJECT.id]: OBJECT }}
        playheadUs={0}
        onSetStatic={() => undefined}
        onDispatch={overrides.onDispatch ?? (() => undefined)}
        onOpenAnimationGraph={overrides.onOpenAnimationGraph}
      />,
    );
  });
  return container;
}

describe('Inspector animations section', () => {
  it('lists each animated property with keyframe counts and Edit and Remove actions', async () => {
    const view = await mount();

    expect(view.querySelector('[aria-label="Animations"]')).not.toBeNull();
    expect(view.querySelector('[data-animation-property="x"]')?.textContent).toContain(
      'Position X',
    );
    expect(view.querySelector('[data-animation-property="x"]')?.textContent).toContain(
      '2 keyframes',
    );
    expect(view.querySelector('[data-animation-property="opacity"]')?.textContent).toContain(
      'Opacity',
    );
    expect(view.querySelector('button[aria-label="Edit Position X animation"]')).not.toBeNull();
    expect(view.querySelector('button[aria-label="Remove Position X animation"]')).not.toBeNull();
  });

  it('opens the selected animated property in Animate when Edit is pressed', async () => {
    const onOpenAnimationGraph = vi.fn();
    const view = await mount({ onOpenAnimationGraph });

    await act(async () => {
      view
        .querySelector<HTMLButtonElement>('button[aria-label="Edit Position X animation"]')
        ?.click();
    });

    expect(onOpenAnimationGraph).toHaveBeenCalledWith('clip-1', 'x');
  });

  it('removes the selected animation channel through a project transaction', async () => {
    const onDispatch = vi.fn();
    const view = await mount({ onDispatch });

    await act(async () => {
      view
        .querySelector<HTMLButtonElement>('button[aria-label="Remove Position X animation"]')
        ?.click();
    });

    expect(onDispatch).toHaveBeenCalledWith({
      label: 'Remove Position X animation',
      commands: [
        {
          type: 'object.replaceAnimation',
          payload: { objectId: 'clip-1', property: 'x' },
        },
      ],
    });
  });
});
