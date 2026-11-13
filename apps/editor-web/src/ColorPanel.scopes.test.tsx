// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createIdentityColorGrade,
  IDENTITY_COLOR_ADJUSTMENTS,
  type JoyProjectV1,
} from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { ColorPanel } from './ColorPanel.js';
import {
  EditorPanelContext,
  type EditorPanelContextValue,
  type ToastAction,
} from './editor-panel-context.js';
import { COLOR_SCOPES_WINDOW_KEY, type WindowGeometryStorage } from './color-scopes-window.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TABS = ['adjust', 'wheels', 'curves', 'hsl', 'looks', 'scopes'] as const;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeAll(() => {
  // jsdom has no 2D canvas context. The scope canvas draws nothing here and
  // the panel still behaves, so the missing context is simply reported.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  });
});

/** jsdom keeps the viewport at a fixed size, so the tests set it themselves. */
function resizeViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  document.body.innerHTML = '';
  resizeViewport(1024, 768);
  vi.restoreAllMocks();
});

async function mountPanel(
  options: {
    readonly project?: JoyProjectV1;
    readonly onChange?: (next: JoyProjectV1) => void;
    readonly showToast?: (
      message: string,
      kind?: 'info' | 'success' | 'error',
      action?: ToastAction,
    ) => void;
    readonly storage?: WindowGeometryStorage;
  } = {},
) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const showToast = options.showToast ?? vi.fn();
  // The panel only reads the toast and the storage from the context.
  const context = {
    showToast,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  } as unknown as EditorPanelContextValue;
  await act(async () => {
    root?.render(
      <EditorPanelContext.Provider value={context}>
        <ColorPanel
          project={options.project ?? INITIAL_EDITOR_PROJECT}
          onChange={options.onChange ?? vi.fn()}
        />
      </EditorPanelContext.Provider>,
    );
  });
  return { container, showToast };
}

function tabButton(id: (typeof TABS)[number]): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>(`[data-panel-tab-id="${id}"]`);
  if (button === undefined || button === null) throw new Error(`missing ${id} tab`);
  return button;
}

describe('Color panel scopes', () => {
  it('keeps the scopes in the Scopes tab and nowhere else', async () => {
    const { container: panel } = await mountPanel();

    for (const tab of TABS) {
      await act(async () => {
        tabButton(tab).click();
      });
      const scopes = panel.querySelectorAll('.scope-canvas');
      expect(scopes.length).toBe(tab === 'scopes' ? 1 : 0);
      // The shared footer's mini scope and its button row are gone.
      expect(panel.querySelector('.color-mini-scope')).toBeNull();
      expect(panel.querySelector('.color-utility-row')).toBeNull();
    }
  });

  it('opens a floating scopes window that stays open across the sub-tabs', async () => {
    const { container: panel } = await mountPanel();
    const openScopes = panel.querySelector<HTMLButtonElement>(
      'button[title*="scopes in a window"]',
    );
    expect(openScopes).not.toBeNull();

    await act(async () => {
      openScopes?.click();
    });
    const floating = document.body.querySelector('.scope-window');
    expect(floating).not.toBeNull();
    expect(floating?.querySelectorAll('.scope-canvas').length).toBe(1);

    // It follows the colourist onto the wheels.
    await act(async () => {
      tabButton('wheels').click();
    });
    expect(document.body.querySelector('.scope-window')).not.toBeNull();

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Close scopes window"]')?.click();
    });
    expect(document.body.querySelector('.scope-window')).toBeNull();
  });

  it('fits a remembered position from a bigger screen back into the viewport', async () => {
    resizeViewport(480, 360);
    const store: WindowGeometryStorage = {
      getItem: (key) =>
        key === COLOR_SCOPES_WINDOW_KEY
          ? JSON.stringify({ x: 5000, y: 4000, width: 900, height: 700 })
          : null,
      setItem: () => undefined,
    };
    const { container: panel } = await mountPanel({ storage: store });

    await act(async () => {
      panel.querySelector<HTMLButtonElement>('button[title*="scopes in a window"]')?.click();
    });
    const floating = document.body.querySelector<HTMLElement>('.scope-window');
    expect(floating).not.toBeNull();
    const left = Number.parseFloat(floating!.style.left);
    const top = Number.parseFloat(floating!.style.top);
    const width = Number.parseFloat(floating!.style.width);
    const height = Number.parseFloat(floating!.style.height);
    expect(left + width).toBeLessThanOrEqual(480);
    expect(top + height).toBeLessThanOrEqual(360);
  });

  it('pulls the window back inside when the viewport shrinks', async () => {
    const { container: panel } = await mountPanel();
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('button[title*="scopes in a window"]')?.click();
    });
    expect(document.body.querySelector('.scope-window')).not.toBeNull();

    resizeViewport(520, 400);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    const floating = document.body.querySelector<HTMLElement>('.scope-window');
    const left = Number.parseFloat(floating!.style.left);
    const top = Number.parseFloat(floating!.style.top);
    const width = Number.parseFloat(floating!.style.width);
    const height = Number.parseFloat(floating!.style.height);
    expect(left + width).toBeLessThanOrEqual(520);
    expect(top + height).toBeLessThanOrEqual(400);
    expect(width).toBeGreaterThanOrEqual(300);
  });

  it('offers an Undo toast when the grade is reset', async () => {
    const grade = createIdentityColorGrade();
    const project: JoyProjectV1 = {
      ...INITIAL_EDITOR_PROJECT,
      colorGrade: {
        ...grade,
        adjust: { ...IDENTITY_COLOR_ADJUSTMENTS, saturation: 1.4 },
      },
    };
    const onChange = vi.fn();
    const showToast = vi.fn();
    const { container: panel } = await mountPanel({ project, onChange, showToast });

    const reset = panel.querySelector<HTMLButtonElement>(
      'button[aria-label="Reset all color controls"]',
    );
    expect(reset?.disabled).toBe(false);
    await act(async () => {
      reset?.click();
    });

    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, kind, action] = showToast.mock.calls[0] as [
      string,
      string | undefined,
      ToastAction | undefined,
    ];
    expect(message).toBe('Colour grade reset.');
    expect(kind).toBe('info');
    expect(action?.label).toBe('Undo');

    // The Undo puts the grade the colourist had back.
    await act(async () => {
      action?.run();
    });
    const last = onChange.mock.calls.at(-1)?.[0] as
      { colorGrade?: { adjust?: { saturation?: number } } } | undefined;
    expect(last?.colorGrade?.adjust?.saturation).toBe(1.4);
  });

  it('names the colour target buttons', async () => {
    const { container: panel } = await mountPanel();

    const clip = panel.querySelector<HTMLButtonElement>('.color-target-bar button');
    expect(clip?.title).toBe('Grade only the selected clip');
    expect(panel.querySelectorAll<HTMLButtonElement>('.color-target-bar button')[1]?.title).toBe(
      'Grade the whole program output',
    );
    expect(panel.querySelector<HTMLButtonElement>('.color-target-bar .color-bypass')?.title).toBe(
      'Turn the grade off without losing it',
    );
  });
});
