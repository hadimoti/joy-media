// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySpikeProject, makeVideoClip } from '@joy-media/test-fixtures';
import { TimelinePanel } from './TimelinePanel.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SECOND_US = 1_000_000;
const PX_PER_SECOND = 20;

let root: Root | undefined;
let container: HTMLElement | undefined;

beforeEach(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.getBoundingClientRect = () =>
    ({
      left: -1000,
      right: 3000,
      top: -1000,
      bottom: 3000,
      width: 4000,
      height: 4000,
      x: -1000,
      y: -1000,
      toJSON: () => ({}),
    }) as DOMRect;
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
  document.elementsFromPoint = () => [document.querySelector<HTMLElement>('[data-track-id]')!];
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function mountPanel() {
  const base = emptySpikeProject({ trackCount: 1, durationUs: 30 * SECOND_US });
  const composition = base.compositions.root!;
  const project = {
    ...base,
    compositions: {
      root: {
        ...composition,
        tracks: [{ ...composition.tracks[0]!, clips: [makeVideoClip('a', 0, 2 * SECOND_US)] }],
      },
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const noop = vi.fn();
  await act(async () => {
    root?.render(
      <TimelinePanel
        project={project}
        playheadUs={0}
        playing={false}
        selectedIds={[]}
        viewport={{ originUs: 0, pixelsPerSecond: PX_PER_SECOND }}
        onViewportChange={noop}
        autoFit={false}
        onAutoFitChange={noop}
        onTogglePlayback={noop}
        onSeek={noop}
        onToggleSelection={noop}
        onClearSelection={noop}
        onDispatch={noop}
      />,
    );
  });
  return container;
}

function pointer(type: string, clientX: number): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 0,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 7 });
  return event;
}

describe('defect 209: a timeline clip never starts a native browser drag', () => {
  it('is not draggable and cancels a native dragstart (also from its text)', async () => {
    const host = await mountPanel();
    const clip = host.querySelector<HTMLElement>('[data-clip-id="a"]')!;
    expect(clip.getAttribute('draggable')).toBe('false');

    const fromClip = new Event('dragstart', { bubbles: true, cancelable: true });
    clip.dispatchEvent(fromClip);
    expect(fromClip.defaultPrevented).toBe(true);

    const label = clip.querySelector<HTMLElement>('.timeline-clip-label');
    if (label !== null) {
      const fromLabel = new Event('dragstart', { bubbles: true, cancelable: true });
      label.dispatchEvent(fromLabel);
      expect(fromLabel.defaultPrevented).toBe(true);
    }
  });

  it('resets the drag and releases pointer capture on pointercancel', async () => {
    const host = await mountPanel();
    const clip = host.querySelector<HTMLElement>('[data-clip-id="a"]')!;
    await act(async () => clip.dispatchEvent(pointer('pointerdown', 0)));
    await act(async () => clip.dispatchEvent(pointer('pointermove', 5 * PX_PER_SECOND)));
    expect(host.querySelector('.timeline-move-ghost')).not.toBeNull();

    await act(async () => clip.dispatchEvent(pointer('pointercancel', 5 * PX_PER_SECOND)));
    expect(host.querySelector('.timeline-move-ghost')).toBeNull();
    expect(clip.classList.contains('dragging')).toBe(false);
    expect(Element.prototype.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it('turns text selection off on clips, lanes and the track area', () => {
    // A variable, not a literal: Vite turns `new URL('./x', import.meta.url)` into an asset URL.
    const appCssName = './app.css';
    const css = readFileSync(fileURLToPath(new URL(appCssName, import.meta.url)), 'utf8');
    const rules = (selector: string): string => {
      const escaped = selector.replace('.', '\\.');
      const pattern = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g');
      return [...css.matchAll(pattern)].map((match) => match[1] ?? '').join('\n');
    };
    for (const selector of ['.timeline-clip', '.timeline-lane', '.timeline-tracks']) {
      expect(rules(selector), selector).toMatch(/user-select:\s*none/);
    }
  });
});
