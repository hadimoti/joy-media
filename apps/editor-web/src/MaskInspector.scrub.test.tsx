// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { BrowserControlPlaneClient, type BrowserWorker } from './control-plane-client.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession, type EditorSessionWriter } from './editor-session.js';
import { MaskInspector } from './MaskInspector.js';
import {
  defaultMaskSettings,
  readMaskSettings,
  writeMaskSettings,
  type MaskSettings,
  type MaskTarget,
} from './masking.js';

const mounted: { root: Root; container: HTMLElement }[] = [];
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('Mask Inspector coordinate scrubbing', () => {
  it.each([
    { mode: 'points' as const, label: 'X' },
    { mode: 'points' as const, label: 'Y' },
    { mode: 'box' as const, label: 'X' },
    { mode: 'box' as const, label: 'Y' },
    { mode: 'box' as const, label: 'W' },
    { mode: 'box' as const, label: 'H' },
  ])('scrubs the $mode $label coordinate and commits a box once', async ({ mode, label }) => {
    const settings = withSelection(mode);
    const onChange = vi.fn<(next: MaskSettings) => void>();
    const client = createClient();
    const rendered = await renderInspector(settings, onChange, client);

    const input = coordinate(rendered.container, label);
    const initialValue = Number(input.value);
    const setPointerCapture = vi.fn();
    input.setPointerCapture = setPointerCapture;
    pointer(input, 'pointerdown', { button: 0, isPrimary: true, pointerId: 1, clientX: 0 });
    pointer(input, 'pointermove', { pointerId: 1, clientX: 8 });
    expect(input.value).toBe((initialValue + 0.02).toFixed(2));
    expect(onChange).not.toHaveBeenCalled();
    pointer(input, 'pointerup', { pointerId: 1, clientX: 8 });

    expect(rendered.container.querySelector('.mask-primary-action')?.hasAttribute('disabled')).toBe(
      false,
    );
    if (mode === 'box') expect(onChange).toHaveBeenCalledTimes(1);
    else expect(onChange).not.toHaveBeenCalled();
    expect(client.enqueueMask).not.toHaveBeenCalled();
    expect(setPointerCapture).toHaveBeenCalledWith(1);
  });

  it.each([
    { label: 'W', x: 0.8, y: 0.2, width: 0.2, height: 0.6 },
    { label: 'H', x: 0.2, y: 0.9, width: 0.6, height: 0.1 },
  ])('keeps $label inside the coupled box edge', async ({ label, x, y, width, height }) => {
    const settings = withSelection('box', { x, y, width, height });
    const onChange = vi.fn<(next: MaskSettings) => void>();
    const rendered = await renderInspector(settings, onChange, createClient());

    const input = coordinate(rendered.container, label);
    input.setPointerCapture = vi.fn();
    pointer(input, 'pointerdown', { button: 0, isPrimary: true, pointerId: 2, clientX: 0 });
    pointer(input, 'pointermove', { pointerId: 2, clientX: 8 });
    pointer(input, 'pointerup', { pointerId: 2, clientX: 8 });

    expect(onChange).toHaveBeenCalledTimes(1);
    const committed = onChange.mock.calls[0]![0].selection.box!;
    expect(committed.width).toBeLessThanOrEqual(1 - committed.x);
    expect(committed.height).toBeLessThanOrEqual(1 - committed.y);
    expect(committed.width).toBeCloseTo(width, 5);
    expect(committed.height).toBeCloseTo(height, 5);
  });

  it('supports dragging left and cancels a draft without committing it', async () => {
    const settings = withSelection('box');
    const onChange = vi.fn<(next: MaskSettings) => void>();
    const rendered = await renderInspector(settings, onChange, createClient());
    const input = coordinate(rendered.container, 'X');
    input.setPointerCapture = vi.fn();

    pointer(input, 'pointerdown', { button: 0, isPrimary: true, pointerId: 3, clientX: 8 });
    pointer(input, 'pointermove', { pointerId: 3, clientX: 0 });
    expect(input.value).toBe('0.18');
    pointer(input, 'pointercancel', { pointerId: 3, clientX: 0 });

    expect(input.value).toBe('0.2');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits a durable setting once so one Undo restores the prior project', async () => {
    const writer: EditorSessionWriter = { fence: 1, assertActive: vi.fn() };
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
      {},
      writer,
    );
    const before = session.visualProject;
    const targetId = 'image-1';
    const onChange = vi.fn((next: MaskSettings) =>
      session.replaceVisualProject(writeMaskSettings(session.visualProject, targetId, next)),
    );
    const rendered = await renderInspector(withSelection('box'), onChange, createClient());
    const input = coordinate(rendered.container, 'X');
    input.setPointerCapture = vi.fn();

    pointer(input, 'pointerdown', { button: 0, isPrimary: true, pointerId: 4, clientX: 0 });
    pointer(input, 'pointermove', { pointerId: 4, clientX: 8 });
    expect(onChange).not.toHaveBeenCalled();
    pointer(input, 'pointerup', { pointerId: 4, clientX: 8 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(readMaskSettings(session.visualProject, targetId, 'image').selection.box?.x).toBe(0.22);
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(session.visualProject).toEqual(before);
    expect(session.canUndo).toBe(false);
  });

  it('keeps the existing edge range change and output synchronized', async () => {
    const settings = withSelection('box');
    const onChange = vi.fn<(next: MaskSettings) => void>();
    const rendered = await renderInspector(settings, onChange, createClient());
    const range = rendered.container.querySelector('label.mask-range input') as HTMLInputElement;

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '30');
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].edge.featherPx).toBe(30);
    rendered.updateSettings(onChange.mock.calls[0]![0]);
    expect(rendered.container.querySelector('label.mask-range output')?.textContent).toBe('30px');
  });
});

function withSelection(
  mode: 'points' | 'box',
  box = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
): MaskSettings {
  return {
    ...defaultMaskSettings('image'),
    selection: { mode, ...(mode === 'box' ? { box } : {}) },
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function createClient() {
  const worker: BrowserWorker = {
    id: 'stub-worker',
    paired: true,
    revoked: false,
    lastSeenAt: Date.now(),
    capabilities: ['mask.image'],
    holdsAllLocalAssets: true,
  } as BrowserWorker;
  return {
    workers: vi.fn().mockResolvedValue([worker]),
    enqueueMask: vi.fn(),
  } as unknown as BrowserControlPlaneClient & { enqueueMask: ReturnType<typeof vi.fn> };
}

async function renderInspector(
  settings: MaskSettings,
  onChange: (next: MaskSettings) => void,
  client: BrowserControlPlaneClient & { enqueueMask: ReturnType<typeof vi.fn> },
) {
  const target: MaskTarget = { kind: 'image', targetId: 'image-1', assetId: 'asset-1' };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const props = {
    projectId: 'project-1',
    projectTitle: 'Mask test',
    target,
    settings,
    onChange,
    onApplyResult: async () => 'result-asset',
    onClear: vi.fn(),
    client,
  };
  act(() => root.render(createElement(MaskInspector, props)));
  await refreshWorkers();
  return {
    container,
    updateSettings(next: MaskSettings) {
      act(() => root.render(createElement(MaskInspector, { ...props, settings: next })));
    },
  };
}

function coordinate(container: HTMLElement, label: string): HTMLInputElement {
  const item = [...container.querySelectorAll('label.mask-coordinate')].find(
    (candidate) => candidate.querySelector('span')?.textContent === label,
  );
  return item!.querySelector('input')!;
}

function pointer(
  input: HTMLInputElement,
  type: string,
  properties: Record<string, number | boolean>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(properties))
    Object.defineProperty(event, key, { value });
  act(() => input.dispatchEvent(event));
}

async function refreshWorkers() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}
