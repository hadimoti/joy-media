// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandTransaction } from '@joy-media/commands';
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
  // jsdom has no pointer capture and no hit testing: the lane under the pointer is the first one.
  // A roomy box everywhere, so the pointer is never 'near an edge' and the drag does not auto-scroll.
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
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  document.elementsFromPoint = () => [document.querySelector<HTMLElement>('[data-track-id]')!];
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function project() {
  const base = emptySpikeProject({ trackCount: 1, durationUs: 30 * SECOND_US });
  const composition = base.compositions.root!;
  return {
    ...base,
    compositions: {
      root: {
        ...composition,
        tracks: [
          {
            ...composition.tracks[0]!,
            clips: [
              makeVideoClip('a', 0, 2 * SECOND_US),
              makeVideoClip('b', 3 * SECOND_US, 2 * SECOND_US),
              makeVideoClip('wall', 8 * SECOND_US, 2 * SECOND_US),
            ],
          },
        ],
      },
    },
  };
}

async function mountPanel(
  selectedIds: readonly string[],
  onDispatch: (t: CommandTransaction) => void,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const noop = vi.fn();
  await act(async () => {
    root?.render(
      <TimelinePanel
        project={project()}
        playheadUs={0}
        playing={false}
        selectedIds={selectedIds}
        viewport={{ originUs: 0, pixelsPerSecond: PX_PER_SECOND }}
        onViewportChange={noop}
        autoFit={false}
        onAutoFitChange={noop}
        onTogglePlayback={noop}
        onSeek={noop}
        onToggleSelection={noop}
        onClearSelection={noop}
        onDispatch={onDispatch}
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

describe('a clip move that cannot fit lands at the nearest free spot', () => {
  it('shows a ghost while dragging and moves the whole selection together on drop', async () => {
    const dispatched: CommandTransaction[] = [];
    const host = await mountPanel(['a', 'b'], (transaction) => dispatched.push(transaction));
    const clipA = host.querySelector<HTMLElement>('[data-clip-id="a"]')!;

    await act(async () => clipA.dispatchEvent(pointer('pointerdown', 0)));
    // Five seconds to the right: b would land on the wall at 8 s.
    await act(async () => clipA.dispatchEvent(pointer('pointermove', 5 * PX_PER_SECOND)));
    const ghosts = [...host.querySelectorAll<HTMLElement>('.timeline-move-ghost')];
    expect(ghosts.map((ghost) => ghost.dataset.moveGhost)).toEqual(['a', 'b']);
    expect(ghosts.map((ghost) => Number(ghost.dataset.startUs))).toEqual([
      3 * SECOND_US,
      6 * SECOND_US,
    ]);
    expect(ghosts.some((ghost) => ghost.classList.contains('is-refused'))).toBe(false);

    await act(async () => clipA.dispatchEvent(pointer('pointerup', 5 * PX_PER_SECOND)));
    expect(host.querySelectorAll('.timeline-move-ghost')).toHaveLength(0);
    expect(dispatched).toHaveLength(1);
    const command = dispatched[0]!.commands[0]!;
    expect(command.type).toBe('timeline.moveElements');
    const moves = (
      command.payload as unknown as { moves: { clipId: string; newStartUs: number }[] }
    ).moves;
    expect(moves.map((move) => [move.clipId, move.newStartUs])).toEqual([
      ['a', 3 * SECOND_US],
      ['b', 6 * SECOND_US],
    ]);
  });

  it('lands a single clip on the nearest free spot instead of refusing', async () => {
    const dispatched: CommandTransaction[] = [];
    const host = await mountPanel([], (transaction) => dispatched.push(transaction));
    const clipA = host.querySelector<HTMLElement>('[data-clip-id="a"]')!;

    await act(async () => clipA.dispatchEvent(pointer('pointerdown', 0)));
    await act(async () => clipA.dispatchEvent(pointer('pointermove', 9 * PX_PER_SECOND)));
    const ghost = host.querySelector<HTMLElement>('.timeline-move-ghost')!;
    expect(Number(ghost.dataset.startUs)).toBe(10 * SECOND_US);
    await act(async () => clipA.dispatchEvent(pointer('pointerup', 9 * PX_PER_SECOND)));
    const payload = dispatched[0]!.commands[0]!.payload as unknown as { newStartUs: number };
    expect(payload.newStartUs).toBe(10 * SECOND_US);
  });
});
