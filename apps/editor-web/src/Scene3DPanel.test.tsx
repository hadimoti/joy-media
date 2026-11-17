// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorSession } from './editor-session.js';
import { Scene3DPanel } from './Scene3DPanel.js';

vi.mock('./JoyCode3DViewer.js', async () => {
  const { useEffect } = await import('react');
  return {
    JoyCode3DViewer: () => {
      useEffect(() => {
        throw new Error('WebGL is unavailable');
      }, []);
      return null;
    },
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('Scene3DPanel', () => {
  it('keeps the panel mounted and reports a local fallback when the viewer fails', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <Scene3DPanel
          session={{ visualProject: { pluginData: {} } } as EditorSession}
          onAdd3DRender={vi.fn(async () => undefined)}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('.scene3d-panel[aria-label="3D Scene"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('3D preview unavailable.');
  });
});
