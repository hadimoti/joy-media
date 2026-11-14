// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaOfflineNote } from './MediaOfflineNote.js';

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

function render(element: ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

describe('MediaOfflineNote (T-R03)', () => {
  it('names the missing file in a status region and holds no interactive control', () => {
    const host = render(<MediaOfflineNote name="take-2.mov" />);
    const note = host.querySelector<HTMLElement>('[data-monitor-media-offline]');
    expect(note?.getAttribute('role')).toBe('status');
    expect(note?.textContent).toContain('Media offline');
    expect(note?.textContent).toContain('take-2.mov');
    expect(note?.querySelector('button, [role="button"], a, input')).toBeNull();
  });
});
