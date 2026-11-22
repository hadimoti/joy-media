// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandTransaction } from '@joy-media/commands';
import { emptySpikeProject, makeVideoClip } from '@joy-media/test-fixtures';
import { TimelinePanel } from './TimelinePanel.js';
import { clearTimelineClipClipboard, copyTimelineClips } from './timeline-clip-clipboard.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SECOND_US = 1_000_000;

interface Mounted {
  readonly container: HTMLElement;
  readonly root: Root;
  readonly dispatch: ReturnType<typeof vi.fn<(transaction: CommandTransaction) => void>>;
  readonly callbacks: {
    readonly seek: ReturnType<typeof vi.fn>;
    readonly togglePlayback: ReturnType<typeof vi.fn>;
    readonly viewportChange: ReturnType<typeof vi.fn>;
    readonly autoFitChange: ReturnType<typeof vi.fn>;
    readonly addMarker: ReturnType<typeof vi.fn>;
    readonly paste: ReturnType<typeof vi.fn>;
    readonly openAssetLibrary: ReturnType<typeof vi.fn>;
    readonly clearSelection: ReturnType<typeof vi.fn>;
    readonly snappingChange: ReturnType<typeof vi.fn>;
    readonly toggleSelection: ReturnType<typeof vi.fn>;
    readonly removeMarker: ReturnType<typeof vi.fn>;
    readonly activeCompositionChange: ReturnType<typeof vi.fn>;
  };
}

interface MountOptions {
  readonly locked?: boolean;
  readonly playheadUs?: number;
  readonly selectedIds?: readonly string[];
  readonly playing?: boolean;
  readonly markers?: readonly {
    readonly id: string;
    readonly timeUs: number;
    readonly label: string;
  }[];
  readonly autoFit?: boolean;
  readonly snapping?: boolean;
  readonly muted?: boolean;
  readonly customProject?: ComponentProps<typeof TimelinePanel>['project'];
  readonly activeCompositionId?: string;
  readonly dataLanes?: ComponentProps<typeof TimelinePanel>['dataLanes'];
}

function project(
  locked = false,
  muted = false,
): ComponentProps<typeof TimelinePanel>['project'] {
  const base = emptySpikeProject({ trackCount: 1, durationUs: 10 * SECOND_US });
  const composition = base.compositions.root!;
  return {
    ...base,
    compositions: {
      ...base.compositions,
      root: {
        ...composition,
        tracks: composition.tracks.map((track) => ({
          ...track,
          locked,
          muted,
          clips: [makeVideoClip('clip-a', 2 * SECOND_US, 4 * SECOND_US)],
        })),
      },
    },
  };
}

async function mount(options: MountOptions = {}): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let currentProject: ComponentProps<typeof TimelinePanel>['project'] =
    options.customProject ?? project(options.locked, options.muted);
  const callbacks = {
    seek: vi.fn(),
    togglePlayback: vi.fn(),
    viewportChange: vi.fn(),
    autoFitChange: vi.fn(),
    addMarker: vi.fn(),
    paste: vi.fn(),
    openAssetLibrary: vi.fn(),
    clearSelection: vi.fn(),
    snappingChange: vi.fn(),
    toggleSelection: vi.fn(),
    removeMarker: vi.fn(),
    activeCompositionChange: vi.fn(),
  };
  const noop = vi.fn();
  const render = () =>
    root.render(
      <TimelinePanel
        project={currentProject}
        {...(options.activeCompositionId === undefined
          ? {}
          : { activeCompositionId: options.activeCompositionId })}
        onActiveCompositionChange={callbacks.activeCompositionChange}
        playheadUs={options.playheadUs ?? 3 * SECOND_US}
        playing={options.playing ?? false}
        selectedIds={options.selectedIds ?? ['clip-a']}
        {...(options.markers === undefined ? {} : { markers: options.markers })}
        {...(options.dataLanes === undefined ? {} : { dataLanes: options.dataLanes })}
        viewport={{ originUs: 0, pixelsPerSecond: 20 }}
        onViewportChange={callbacks.viewportChange}
        autoFit={options.autoFit ?? false}
        onAutoFitChange={callbacks.autoFitChange}
        {...(options.snapping === undefined ? {} : { snapping: options.snapping })}
        onSnappingChange={callbacks.snappingChange}
        onTogglePlayback={callbacks.togglePlayback}
        onSeek={callbacks.seek}
        onToggleSelection={callbacks.toggleSelection}
        onClearSelection={callbacks.clearSelection}
        onDispatch={dispatch}
        onAddMarker={callbacks.addMarker}
        onRemoveMarker={callbacks.removeMarker}
        onPasteClips={callbacks.paste}
        onOpenAssetLibrary={callbacks.openAssetLibrary}
      />,
    );
  const dispatch = vi.fn<(transaction: CommandTransaction) => void>((transaction) => {
    const composition = currentProject.compositions[currentProject.rootCompositionId];
    if (composition === undefined) return;
    const tracks = composition.tracks.map((track) => {
      let next = track;
      for (const command of transaction.commands) {
        if (command.type === 'property.setTrackEnabled' && command.payload.trackId === track.id)
          next = { ...next, enabled: command.payload.enabled };
        if (command.type === 'timeline.setTrackLocked' && command.payload.trackId === track.id)
          next = { ...next, locked: command.payload.locked };
        if (command.type === 'timeline.setTrackMuted' && command.payload.trackId === track.id)
          next = { ...next, muted: command.payload.muted };
      }
      return next;
    });
    currentProject = {
      ...currentProject,
      compositions: {
        ...currentProject.compositions,
        [composition.id]: { ...composition, tracks },
      },
    };
    render();
  });
  await act(async () => render());
  return { container, root, dispatch, callbacks };
}

async function unmount({ container, root }: Mounted): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => button.click());
}

let mounted: Mounted | undefined;

beforeEach(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(async () => {
  if (mounted !== undefined) await unmount(mounted);
  mounted = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearTimelineClipClipboard();
});

describe('TimelinePanel toolbar and track controls', () => {
  it('wires transport, marker, track-add, tool, and snapping toolbar actions', async () => {
    mounted = await mount({ markers: [] });
    const button = (label: string) =>
      mounted!.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

    await click(button('Play'));
    expect(mounted.callbacks.togglePlayback).toHaveBeenCalledOnce();
    await click(button('Back one second'));
    expect(mounted.callbacks.seek).toHaveBeenLastCalledWith(2 * SECOND_US);
    await click(button('Forward one second'));
    expect(mounted.callbacks.seek).toHaveBeenLastCalledWith(4 * SECOND_US);
    await click(button('Add marker at playhead'));
    expect(mounted.callbacks.addMarker).toHaveBeenCalledWith(3 * SECOND_US, expect.any(String));

    await click(button('Add video track'));
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]?.type).toBe('timeline.addTrack');
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]?.payload).toMatchObject({
      track: { family: 'visual' },
    });
    await click(button('Add audio track'));
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]?.payload).toMatchObject({
      track: { family: 'audio' },
    });

    await click(button('Split tool'));
    expect(button('Split tool').getAttribute('aria-pressed')).toBe('true');
    expect(button('Select tool').getAttribute('aria-pressed')).toBe('false');
    await click(button('Select tool'));
    expect(button('Select tool').getAttribute('aria-pressed')).toBe('true');
    expect(button('Split tool').getAttribute('aria-pressed')).toBe('false');
    expect(mounted.dispatch).toHaveBeenCalledTimes(2);

    await click(button('Snapping enabled'));
    expect(mounted.callbacks.snappingChange).toHaveBeenCalledWith(false);

    await unmount(mounted);
    mounted = await mount({ playing: true });
    await click(mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Pause"]')!);
    expect(mounted.callbacks.togglePlayback).toHaveBeenCalledOnce();
  });

  it('keeps clip copy and viewport controls outside project dispatch history', async () => {
    mounted = await mount();
    const button = (label: string) =>
      mounted!.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

    await click(button('Copy clip'));
    expect(mounted.dispatch).not.toHaveBeenCalled();
    await click(button('Zoom out'));
    expect(mounted.callbacks.viewportChange).toHaveBeenCalledOnce();
    expect(mounted.callbacks.autoFitChange).toHaveBeenCalledWith(false);
    await click(button('Zoom in'));
    expect(mounted.callbacks.viewportChange).toHaveBeenCalledTimes(2);
    const slider = mounted.container.querySelector<HTMLInputElement>(
      'input[aria-label="Timeline zoom"]',
    )!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, '35');
    await act(async () => slider.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => slider.dispatchEvent(new Event('change', { bubbles: true })));
    expect(mounted.callbacks.viewportChange).toHaveBeenLastCalledWith({
      originUs: 0,
      pixelsPerSecond: 35,
    });
    expect(mounted.dispatch).not.toHaveBeenCalled();
    await click(button('Fit timeline to width'));
    expect(mounted.callbacks.autoFitChange).toHaveBeenLastCalledWith(true);
    expect(mounted.dispatch).not.toHaveBeenCalled();
  });

  it('pastes the local timeline clipboard through the paste callback', async () => {
    const source = project();
    copyTimelineClips(source.compositions.root!, ['clip-a']);
    mounted = await mount();
    const paste = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Paste clip"]',
    )!;
    expect(paste.disabled).toBe(false);
    await click(paste);
    expect(mounted.callbacks.paste).toHaveBeenCalledOnce();
    expect(mounted.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches cut and duplicate actions for the selected unlocked clip', async () => {
    mounted = await mount();
    const button = (label: string) =>
      mounted!.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

    await click(button('Cut clip'));
    expect(mounted.dispatch.mock.calls[0]?.[0].commands[0]?.type).toBe('timeline.removeClip');
    await click(button('Duplicate clip'));
    expect(mounted.dispatch.mock.calls[1]?.[0].commands[0]?.type).toBe('timeline.duplicateClip');
  });

  it('ripple deletes the selected clip when no marker is selected', async () => {
    mounted = await mount();
    const remove = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Ripple delete"]',
    )!;
    await click(remove);
    expect(mounted.dispatch.mock.calls[0]?.[0].commands[0]?.type).toBe('timeline.removeClip');
  });

  it('wires track lock, visibility, mute, solo, color, and empty-track actions', async () => {
    mounted = await mount();
    const button = (label: string) =>
      document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

    await click(button('Lock V1'));
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]).toMatchObject({
      type: 'timeline.setTrackLocked',
      payload: { locked: true },
    });
    await click(button('Lock V1'));
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]).toMatchObject({
      type: 'timeline.setTrackLocked',
      payload: { locked: false },
    });
    await click(button('Hide V1'));
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]).toMatchObject({
      type: 'property.setTrackEnabled',
      payload: { enabled: false },
    });
    await click(button('Show V1'));
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]).toMatchObject({
      type: 'property.setTrackEnabled',
      payload: { enabled: true },
    });
    await click(button('Mute V1'));
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]).toMatchObject({
      type: 'timeline.setTrackMuted',
      payload: { muted: true },
    });

    await unmount(mounted);
    mounted = await mount({ muted: true });
    await click(
      mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Unmute V1"]')!,
    );
    expect(mounted.dispatch.mock.calls[0]?.[0].commands[0]).toMatchObject({
      type: 'timeline.setTrackMuted',
      payload: { muted: false },
    });

    await click(button('Solo V1'));
    expect(button('Solo V1').getAttribute('aria-pressed')).toBe('true');
    await click(button('Solo V1'));
    expect(button('Solo V1').getAttribute('aria-pressed')).toBe('false');
    await click(
      mounted.container.querySelector<HTMLButtonElement>(
        'button[aria-label^="Change label color for "]',
      )!,
    );
    expect(document.querySelector('[role="menu"][aria-label="Track color"]')).not.toBeNull();
    await click(button('Violet'));
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]).toMatchObject({
      type: 'timeline.setTrackLabelColor',
      payload: { labelColor: 'violet' },
    });

    await click(button('Add track'));
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]?.type).toBe('timeline.addTrack');
    await click(
      mounted.container.querySelector<HTMLButtonElement>(
        '.timeline-add-track-row button[aria-label="Add audio track"]',
      )!,
    );
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]?.payload).toMatchObject({
      track: { family: 'audio' },
    });
  });

  it('executes the disabled-snapping and Data Lanes toolbar states', async () => {
    mounted = await mount({ snapping: false, dataLanes: [] });
    const snapping = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Snapping disabled"]',
    )!;
    await click(snapping);
    expect(mounted.callbacks.snappingChange).toHaveBeenCalledWith(true);

    const lanes = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.includes('Data Lanes'),
    )!;
    expect(lanes.getAttribute('aria-expanded')).toBe('false');
    await click(lanes);
    expect(lanes.getAttribute('aria-expanded')).toBe('true');
    expect(mounted.dispatch).not.toHaveBeenCalled();
  });

  it('returns from a merged timeline through the Back toolbar action', async () => {
    const base = project();
    const rootComposition = base.compositions.root!;
    const rootTrack = rootComposition.tracks[0]!;
    const child = {
      ...rootComposition,
      id: 'compound-a',
      name: 'Merged intro',
      tracks: [
        {
          ...rootTrack,
          clips: [makeVideoClip('child-clip', 0, 2 * SECOND_US)],
        },
      ],
    };
    const parent = {
      ...rootComposition,
      tracks: [
        {
          ...rootTrack,
          clips: [
            {
              kind: 'composition' as const,
              id: 'compound-clip',
              startUs: 0,
              durationUs: 4 * SECOND_US,
              compositionId: 'compound-a',
              childOffsetUs: 0,
            },
          ],
        },
      ],
    };
    const compoundProject = {
      ...base,
      compositions: { ...base.compositions, root: parent, 'compound-a': child },
    };
    mounted = await mount({ customProject: compoundProject, activeCompositionId: 'compound-a' });
    const back = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Back to parent timeline"]',
    )!;
    await click(back);
    expect(mounted.callbacks.activeCompositionChange).toHaveBeenCalledWith('root');
    expect(mounted.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['Default', undefined],
    ['Violet', 'violet'],
    ['Iris', 'iris'],
    ['Caribbean', 'caribbean'],
    ['Lavender', 'lavender'],
    ['Cerulean', 'cerulean'],
    ['Forest', 'forest'],
    ['Rose', 'rose'],
    ['Mango', 'mango'],
  ] as const)('applies the %s track color choice', async (label, color) => {
    mounted = await mount();
    await click(
      mounted.container.querySelector<HTMLButtonElement>(
        'button[aria-label^="Change label color for "]',
      )!,
    );
    await click(
      document.querySelector<HTMLButtonElement>(`[role="menuitemradio"][aria-label="${label}"]`)!,
    );
    const command = mounted.dispatch.mock.calls[0]?.[0].commands[0];
    expect(command?.type).toBe('timeline.setTrackLabelColor');
    expect(command?.payload).toMatchObject({
      ...(color === undefined ? {} : { labelColor: color }),
    });
  });

  it('executes track context hide/show and empty-track removal', async () => {
    mounted = await mount();
    await act(async () =>
      mounted!.container
        .querySelector<HTMLElement>('.timeline-track-header[data-track-id]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
    );
    const menuItem = (label: string) =>
      [
        ...document.querySelectorAll<HTMLButtonElement>('.timeline-context-menu [role="menuitem"]'),
      ].find((item) => item.textContent?.includes(label));
    const hide = menuItem('Hide Track');
    expect(hide).toBeDefined();
    await click(hide!);
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]).toMatchObject({
      type: 'property.setTrackEnabled',
      payload: { enabled: false },
    });

    await act(async () =>
      mounted!.container
        .querySelector<HTMLElement>('.timeline-track-header[data-track-id]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
    );
    const show = menuItem('Show Track');
    expect(show).toBeDefined();
    await click(show!);
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]).toMatchObject({
      type: 'property.setTrackEnabled',
      payload: { enabled: true },
    });

    await unmount(mounted);
    const emptyProject = emptySpikeProject({ trackCount: 2, durationUs: 10 * SECOND_US });
    mounted = await mount({ selectedIds: [], customProject: emptyProject });
    const emptyHeader = mounted.container.querySelector<HTMLElement>(
      '.timeline-track-header[data-track-id]',
    )!;
    const rootTrackId = emptyHeader.dataset.trackId;
    await act(async () =>
      emptyHeader.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
    );
    const remove = menuItem('Remove Track');
    expect(remove?.disabled).toBe(false);
    await click(remove!);
    expect(mounted.dispatch.mock.calls.at(-1)?.[0].commands[0]).toMatchObject({
      type: 'timeline.removeTrack',
      payload: { trackId: rootTrackId },
    });
  });

  it('selects and removes a marker, with selected-marker removal taking toolbar priority', async () => {
    mounted = await mount({ markers: [{ id: 'marker-a', timeUs: SECOND_US, label: 'M1' }] });
    const marker = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="M1. Delete to remove."]',
    )!;
    await click(marker);
    expect(marker.getAttribute('aria-pressed')).toBe('true');
    expect(mounted.callbacks.seek).toHaveBeenCalledWith(SECOND_US);
    expect(mounted.callbacks.clearSelection).toHaveBeenCalledOnce();

    const remove = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove marker"]',
    )!;
    await click(remove);
    expect(mounted.callbacks.removeMarker).toHaveBeenCalledWith('marker-a');
    expect(mounted.dispatch).not.toHaveBeenCalled();

    await unmount(mounted);
    mounted = await mount({ markers: [{ id: 'marker-a', timeUs: SECOND_US, label: 'M1' }] });
    await click(
      mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Remove M1"]')!,
    );
    expect(mounted.callbacks.removeMarker).toHaveBeenCalledWith('marker-a');
  });

  it('selects a clip and opens its track library from the keyboard', async () => {
    mounted = await mount();
    const clip = mounted.container.querySelector<HTMLElement>('[data-clip-id="clip-a"]')!;
    await click(clip);
    expect(mounted.callbacks.toggleSelection).toHaveBeenCalledWith('clip-a');

    const lane = mounted.container.querySelector<HTMLElement>('.timeline-lane[role="button"]')!;
    await act(async () =>
      lane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(mounted.callbacks.openAssetLibrary).toHaveBeenCalledOnce();
  });

  it.each([
    ['Visual runway. Open media library to add a layer.', 'Enter'],
    ['Audio runway. Open media library to add a layer.', ' '],
  ])('opens the library from the %s', async (label, key) => {
    const noTracks = emptySpikeProject({ trackCount: 0, durationUs: 10 * SECOND_US });
    mounted = await mount({ customProject: noTracks, selectedIds: [] });
    const runway = mounted.container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    await act(async () =>
      runway.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })),
    );
    expect(mounted.callbacks.openAssetLibrary).toHaveBeenCalledOnce();
  });

  it('trims both edges from their accessible keyboard controls', async () => {
    mounted = await mount();
    const start = mounted.container.querySelector<HTMLButtonElement>(
      'button[data-trim-edge="start"]',
    )!;
    await act(async () =>
      start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    expect(mounted.dispatch.mock.calls[0]?.[0].commands[0]).toMatchObject({
      type: 'timeline.trimClipStart',
      payload: { clipId: 'clip-a', newStartUs: 2 * SECOND_US + 100_000 },
    });

    const end = mounted.container.querySelector<HTMLButtonElement>('button[data-trim-edge="end"]')!;
    await act(async () =>
      end.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
    );
    expect(mounted.dispatch.mock.calls[1]?.[0].commands[0]).toMatchObject({
      type: 'timeline.trimClipEnd',
      payload: { clipId: 'clip-a', newEndUs: 6 * SECOND_US - 100_000 },
    });
  });

  it('splits the selected unlocked clip at an interior playhead without activating Split tool', async () => {
    mounted = await mount();
    const split = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Split at playhead"]',
    );

    expect(split).not.toBeNull();
    expect(split?.disabled).toBe(false);
    expect(
      mounted.container.querySelector('[aria-label="Split tool"]')?.getAttribute('aria-pressed'),
    ).toBe('false');

    await click(split!);

    expect(mounted.dispatch).toHaveBeenCalledTimes(1);
    expect(mounted.dispatch.mock.calls[0]?.[0].commands[0]).toMatchObject({
      type: 'timeline.splitClip',
      payload: {
        compositionId: 'root',
        trackId: expect.any(String),
        clipId: 'clip-a',
        atUs: 3 * SECOND_US,
        newClipId: `clip-a-split-${3 * SECOND_US}`,
      },
    });
    expect(
      mounted.container.querySelector('[aria-label="Split tool"]')?.getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it.each([2 * SECOND_US, 6 * SECOND_US])('does not split at clip edge %s', async (playheadUs) => {
    mounted = await mount({ playheadUs });
    const split = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Split at playhead"]',
    );

    expect(split?.disabled).toBe(true);
    await click(split!);
    expect(mounted.dispatch).not.toHaveBeenCalled();
  });

  it('does not split a selected clip on a locked track', async () => {
    mounted = await mount({ locked: true });
    const split = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Split at playhead"]',
    );

    expect(split?.disabled).toBe(true);
    await click(split!);
    expect(mounted.dispatch).not.toHaveBeenCalled();
  });

  it('keeps Split tool as a separate mode and prevents a split without a selection', async () => {
    mounted = await mount();
    await click(
      mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Split tool"]')!,
    );

    expect(
      mounted.container.querySelector('[aria-label="Split tool"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(mounted.dispatch).not.toHaveBeenCalled();
    await unmount(mounted);
    mounted = undefined;

    mounted = await mount({ selectedIds: [] });
    const split = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Split at playhead"]',
    )!;
    expect(split.disabled).toBe(true);
    await click(split);
    expect(mounted.dispatch).not.toHaveBeenCalled();
  });
});
