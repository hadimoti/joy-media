// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineCanvas } from './TimelineCanvas.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const track = (id: string, locked = false) => ({
  id,
  label: id,
  items: [],
  controls: { trackId: id, locked, visible: true, solo: false, onToggle: () => undefined },
});

async function mount(onFilesDrop: (...args: never[]) => void) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TimelineCanvas
        durationUs={10_000_000}
        playheadUs={0}
        viewport={{ originUs: 0, pixelsPerSecond: 20 }}
        onViewportChange={() => undefined}
        autoFit={false}
        tracks={[track('v1'), track('v2', true)]}
        selectedClipIds={new Set()}
        onSeek={() => undefined}
        onSelectClips={() => undefined}
        onFilesDrop={onFilesDrop as never}
      />,
    );
  });
  return container;
}

function dropEvent(type: string, files: File[], clientX = 100) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    clientX,
    clientY: 10,
    dataTransfer: { types: ['Files'], files, dropEffect: 'none' },
  });
  return event;
}

describe('TimelineCanvas files dropped from the desktop', () => {
  it('delivers the files with the track and the time under the pointer', async () => {
    const onFilesDrop = vi.fn();
    const host = await mount(onFilesDrop);
    const lanes = host.querySelectorAll('.timeline-lane');
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    await act(async () => {
      lanes[0]!.dispatchEvent(dropEvent('drop', [file], 120));
    });
    expect(onFilesDrop).toHaveBeenCalledTimes(1);
    const [files, target] = onFilesDrop.mock.calls[0]!;
    expect(files).toEqual([file]);
    expect(target).toMatchObject({ trackId: 'v1', newTrack: false });
    expect(target.timeUs).toBeGreaterThanOrEqual(0);
  });

  it('accepts the drag over a lane and shows where it will land', async () => {
    const host = await mount(vi.fn());
    const lane = host.querySelector('.timeline-lane')!;
    const over = dropEvent('dragover', []);
    await act(async () => {
      lane.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    expect(lane.classList.contains('is-file-drop')).toBe(true);
  });

  it('does not drop on a locked track', async () => {
    const onFilesDrop = vi.fn();
    const host = await mount(onFilesDrop);
    const lanes = host.querySelectorAll('.timeline-lane');
    await act(async () => {
      lanes[1]!.dispatchEvent(dropEvent('drop', [new File(['x'], 'a.png', { type: 'image/png' })]));
    });
    expect(onFilesDrop).not.toHaveBeenCalled();
  });
});
