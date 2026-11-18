// @vitest-environment jsdom
import { createRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MonitorViewport,
  type MonitorViewController,
  type MonitorViewportProps,
} from './MonitorViewport.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(overrides: Partial<MonitorViewportProps>) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const controller = {
    view: { zoom: 1, panX: 0, panY: 0 },
    fit: false,
    viewportSize: { width: 300, height: 200 },
    viewportRef: createRef<HTMLDivElement>(),
    setFit: vi.fn(),
    setZoom: vi.fn(),
    stepZoom: vi.fn(),
    setView: vi.fn(),
    tool: 'select',
    setTool: vi.fn(),
    frame: { width: 100, height: 100 },
  } as unknown as MonitorViewController;
  const props: MonitorViewportProps = {
    controller,
    dragOver: false,
    onDragOver: () => undefined,
    onDragLeave: () => undefined,
    onDrop: () => undefined,
    selection: {
      isElementAt: () => true,
      click: () => undefined,
      marquee: () => undefined,
    },
    children: <div />,
    ...overrides,
  };
  act(() => {
    root?.render(<MonitorViewport {...props} />);
  });
  return { stage: container.querySelector<HTMLElement>('[data-monitor-stage]')!, controller };
}

describe('MonitorViewport interactions', () => {
  it('reports right-clicks as canvas points', () => {
    const onContextMenu = vi.fn();
    const { stage } = mount({ onContextMenu });
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 30,
    });

    act(() => stage.dispatchEvent(event));

    expect(onContextMenu).toHaveBeenCalledWith(expect.any(Object), { x: 40, y: 30 });
  });

  it('lets text editing handle a double-click before the fit gesture', () => {
    const onDoubleClick = vi.fn(() => true);
    const { stage, controller } = mount({
      selection: {
        isElementAt: () => true,
        click: () => undefined,
        marquee: () => undefined,
        doubleClick: onDoubleClick,
      },
    });

    act(() =>
      stage.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 24, clientY: 16 }),
      ),
    );

    expect(onDoubleClick).toHaveBeenCalledWith({ x: 24, y: 16 });
    expect(controller.setFit).not.toHaveBeenCalled();
  });
});
