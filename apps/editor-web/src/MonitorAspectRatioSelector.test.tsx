// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSession } from './editor-session.js';
import { createBlankProjectDocuments } from './project-factory.js';
import {
  MONITOR_ASPECT_RATIO_PRESETS,
  MonitorAspectRatioControl,
  monitorAspectRatioDimensions,
  monitorAspectRatioForDimensions,
} from './MonitorAspectRatioSelector.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(async () => {
  const entries = mounted.splice(0);
  await act(async () => {
    for (const { root } of entries) root.unmount();
  });
  for (const { container } of entries) container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('MonitorAspectRatioControl', () => {
  it('maps every authored preset to stable dimensions', () => {
    expect(MONITOR_ASPECT_RATIO_PRESETS.map((preset) => preset.id)).toEqual([
      'fit',
      '16:9',
      '4:3',
      '3:2',
      '21:9',
      '1:1',
      '9:16',
      '4:5',
      '3:4',
      '2:3',
    ]);
    expect(monitorAspectRatioDimensions('21:9')).toEqual({ width: 2520, height: 1080 });
    expect(monitorAspectRatioDimensions('fit')).toBeUndefined();
    expect(monitorAspectRatioForDimensions(1080, 1920)).toBe('9:16');
    expect(monitorAspectRatioForDimensions(1234, 567)).toBe('fit');
  });

  it('mounts the selector and applies one compound, undoable canvas change', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const seeds = createBlankProjectDocuments('aspect-project', 'Aspect project');
    const session = new EditorSession(window.localStorage, seeds.timeline, seeds.visual);
    const toast = vi.fn();
    const view = await mountControl(session, toast, 0);

    expect(trigger(view.container).getAttribute('aria-label')).toBe('Canvas aspect ratio (9:16)');

    await choose(view.container, 'fit');
    expect(session.canUndo).toBe(false);
    expect(rootDimensions(session)).toEqual({ visual: [1080, 1920], timeline: [1080, 1920] });

    await choose(view.container, '1:1');
    expect(session.canUndo).toBe(true);
    expect(rootDimensions(session)).toEqual({ visual: [1080, 1080], timeline: [1080, 1080] });
    expect(trigger(view.container).getAttribute('aria-label')).toBe('Canvas aspect ratio (1:1)');
    expect(toast).toHaveBeenLastCalledWith('Canvas changed to 1:1.', 'success');

    await act(async () => {
      session.undo();
      view.root.render(control(session, toast, 1));
    });
    expect(rootDimensions(session)).toEqual({ visual: [1080, 1920], timeline: [1080, 1920] });
    expect(trigger(view.container).getAttribute('aria-label')).toBe('Canvas aspect ratio (9:16)');

    await act(async () => {
      session.redo();
      view.root.render(control(session, toast, 2));
    });
    expect(rootDimensions(session)).toEqual({ visual: [1080, 1080], timeline: [1080, 1080] });
    expect(trigger(view.container).getAttribute('aria-label')).toBe('Canvas aspect ratio (1:1)');

    await act(async () => view.root.unmount());
    mounted.splice(mounted.indexOf(view), 1);
    const reloaded = await mountControl(session, toast, 3);
    expect(trigger(reloaded.container).getAttribute('aria-label')).toBe(
      'Canvas aspect ratio (1:1)',
    );
  });

  it('supports keyboard opening and returns focus after Escape', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const seeds = createBlankProjectDocuments('keyboard-project', 'Keyboard project');
    const session = new EditorSession(window.localStorage, seeds.timeline, seeds.visual);
    const view = await mountControl(session, vi.fn(), 0);
    const button = trigger(view.container);

    await act(async () => {
      button.focus();
      button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.getAttribute('data-monitor-aspect-ratio-option')).toBe('9:16');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });
});

function ControlHarness({
  session,
  toast,
  externalRevision,
}: {
  readonly session: EditorSession;
  readonly toast: (message: string, kind: 'success' | 'error') => void;
  readonly externalRevision: number;
}) {
  const [, setMutationRevision] = useState(0);
  void externalRevision;
  return (
    <MonitorAspectRatioControl
      session={session}
      visualProject={session.visualProject}
      timelineProject={session.timelineProject}
      bumpProjectRevision={() => setMutationRevision((revision) => revision + 1)}
      showToast={toast}
    />
  );
}

function control(
  session: EditorSession,
  toast: (message: string, kind: 'success' | 'error') => void,
  externalRevision: number,
) {
  return <ControlHarness session={session} toast={toast} externalRevision={externalRevision} />;
}

async function mountControl(
  session: EditorSession,
  toast: (message: string, kind: 'success' | 'error') => void,
  externalRevision: number,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const view = { root, container };
  mounted.push(view);
  await act(async () => root.render(control(session, toast, externalRevision)));
  return view;
}

async function choose(container: HTMLElement, ratio: string): Promise<void> {
  await act(async () => trigger(container).click());
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>(`[data-monitor-aspect-ratio-option="${ratio}"]`)!
      .click();
  });
}

function trigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
}

function rootDimensions(session: EditorSession) {
  const visual = session.visualProject.compositions[session.visualProject.rootCompositionId]!;
  const timeline = session.timelineProject.compositions[session.timelineProject.rootCompositionId]!;
  return {
    visual: [visual.width, visual.height],
    timeline: [timeline.width, timeline.height],
  };
}
