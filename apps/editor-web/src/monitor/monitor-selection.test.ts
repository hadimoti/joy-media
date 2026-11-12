import { describe, expect, it, vi } from 'vitest';
import type { JoyProjectV1, SpikeProject, VisualObjectV1 } from '@joy-media/project-schema';
import {
  nodeBoundsFromBox,
  type NodeBounds,
  type RenderFrameIR,
  type RenderNode,
} from '@joy-media/render-ir';
import { bindClipToObject } from '../sticker-bindings.js';
import { captionNodeId } from './monitor-ids.js';
import {
  applyMonitorSelection,
  buildMonitorElements,
  monitorClickAction,
  monitorHitClipIds,
  monitorMarqueeAction,
  monitorMarqueeClipIds,
  monitorSelectionOverlay,
  sameMonitorOverlay,
  type MonitorSelectionSetters,
} from './monitor-selection.js';

const objectTransform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

/** Visual objects: a title, a picture, a shape and the 3D element (an html scene). */
function visualProject(): JoyProjectV1 {
  const objects = {
    title: { id: 'title', kind: 'text', text: 'Hi', transform: objectTransform },
    picture: { id: 'picture', kind: 'image', assetId: 'img', transform: objectTransform },
    shape: { id: 'shape', kind: 'shape', transform: objectTransform },
    scene3d: { id: 'scene3d', kind: 'html-scene', transform: objectTransform },
  } as unknown as Record<string, VisualObjectV1>;
  const base: JoyProjectV1 = {
    schemaVersion: 1,
    id: 'p',
    title: 't',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 1080,
        height: 1920,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 1_000_000,
        background: '#000',
        tracks: [],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: objects,
    captionDocuments: {},
    pluginData: {},
  };
  let project = bindClipToObject(base, 'clip-title', 'title');
  project = bindClipToObject(project, 'clip-picture', 'picture');
  project = bindClipToObject(project, 'clip-shape', 'shape');
  return bindClipToObject(project, 'clip-3d', 'scene3d');
}

interface TrackSpec {
  readonly id: string;
  readonly clips: readonly string[];
  readonly locked?: boolean;
  readonly enabled?: boolean;
}

function timeline(tracks: readonly TrackSpec[]): SpikeProject {
  return {
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        tracks: tracks.map((track) => ({
          id: track.id,
          ...(track.locked === undefined ? {} : { locked: track.locked }),
          ...(track.enabled === undefined ? {} : { enabled: track.enabled }),
          clips: track.clips.map((id) => ({ id, kind: 'video' })),
        })),
      },
    },
  } as unknown as SpikeProject;
}

const ALL_TRACKS: readonly TrackSpec[] = [
  { id: 'v1', clips: ['clip-video'] },
  { id: 'v2', clips: ['clip-picture', 'clip-shape'] },
  { id: 'v3', clips: ['clip-title', 'clip-3d'] },
  { id: 'c1', clips: ['clip-captions'] },
];

function node(id: string, zIndex: number, translate = 0): RenderNode {
  return {
    id,
    kind: 'sprite',
    zIndex,
    opacity: 1,
    width: 100,
    height: 100,
    color: { r: 0, g: 0, b: 0, a: 255 },
    transform: { translateX: translate, translateY: translate, scaleX: 1, scaleY: 1 },
  } as unknown as RenderNode;
}

const CAPTION = captionNodeId('clip-captions', 'seg-1', 0);

/** Six kinds drawn on top of each other, bottom to top as listed. */
function frame(): RenderFrameIR {
  return {
    version: 1,
    compositionId: 'root',
    timeUs: 0,
    viewport: { width: 1080, height: 1920, dpr: 1 },
    background: { r: 0, g: 0, b: 0, a: 255 },
    nodes: [
      node('clip-video', 0),
      node('picture', 1),
      node('shape', 2),
      node('scene3d', 3),
      node('title', 4),
      node(CAPTION, 5),
      // Not on the timeline: never selectable.
      node('orphan', 9),
    ],
  };
}

function boundsOf(frameIR: RenderFrameIR): (id: string) => NodeBounds | undefined {
  const byId = new Map(
    frameIR.nodes.map((n) => [
      n.id,
      nodeBoundsFromBox(n.id, n.transform, { x: 0, y: 0, width: 100, height: 100 }),
    ]),
  );
  return (id) => byId.get(id);
}

function elements(tracks: readonly TrackSpec[] = ALL_TRACKS) {
  const f = frame();
  return buildMonitorElements({
    frame: f,
    nodeBounds: boundsOf(f),
    project: visualProject(),
    timeline: timeline(tracks),
  });
}

describe('buildMonitorElements', () => {
  it('lists every kind topmost first, each with its timeline clip', () => {
    expect(elements().map((element) => [element.id, element.clipId])).toEqual([
      [CAPTION, 'clip-captions'],
      ['title', 'clip-title'],
      ['scene3d', 'clip-3d'],
      ['shape', 'clip-shape'],
      ['picture', 'clip-picture'],
      ['clip-video', 'clip-video'],
    ]);
  });

  it('marks locked and hidden tracks', () => {
    const list = elements([
      { id: 'v1', clips: ['clip-video'], locked: true },
      { id: 'v2', clips: ['clip-picture', 'clip-shape'], enabled: false },
      { id: 'v3', clips: ['clip-title', 'clip-3d'] },
      { id: 'c1', clips: ['clip-captions'] },
    ]);
    expect(list.find((element) => element.id === 'clip-video')?.locked).toBe(true);
    expect(list.find((element) => element.id === 'picture')?.hidden).toBe(true);
    expect(list.find((element) => element.id === 'title')?.locked).toBeUndefined();
  });

  it('leaves out nodes the renderer did not draw', () => {
    const f = frame();
    const list = buildMonitorElements({
      frame: f,
      nodeBounds: (id) => (id === 'title' ? undefined : boundsOf(f)(id)),
      project: visualProject(),
      timeline: timeline(ALL_TRACKS),
    });
    expect(list.map((element) => element.id)).not.toContain('title');
  });

  it('orders by zIndex, not by list position', () => {
    const f: RenderFrameIR = { ...frame(), nodes: [node('title', 10), node('clip-video', 0)] };
    const list = buildMonitorElements({
      frame: f,
      nodeBounds: boundsOf(f),
      project: visualProject(),
      timeline: timeline(ALL_TRACKS),
    });
    expect(list.map((element) => element.id)).toEqual(['title', 'clip-video']);
  });
});

describe('monitor hit clip ids', () => {
  it('maps the hit nodes to clips, topmost first', () => {
    expect(monitorHitClipIds({ x: 50, y: 50 }, elements())).toEqual([
      'clip-captions',
      'clip-title',
      'clip-3d',
      'clip-shape',
      'clip-picture',
      'clip-video',
    ]);
  });

  it('skips locked and hidden tracks', () => {
    const list = elements([
      { id: 'v1', clips: ['clip-video'] },
      { id: 'v2', clips: ['clip-picture', 'clip-shape'], locked: true },
      { id: 'v3', clips: ['clip-title', 'clip-3d'], enabled: false },
      { id: 'c1', clips: ['clip-captions'], locked: true },
    ]);
    expect(monitorHitClipIds({ x: 50, y: 50 }, list)).toEqual(['clip-video']);
  });

  it('a marquee reports each clip once', () => {
    expect(monitorMarqueeClipIds({ x: 90, y: 90 }, { x: 200, y: 200 }, elements())).toHaveLength(6);
    expect(monitorMarqueeClipIds({ x: 150, y: 150 }, { x: 200, y: 200 }, elements())).toEqual([]);
  });
});

describe('monitorClickAction', () => {
  const hits = ['top', 'middle', 'bottom'];
  const none = { shift: false, alt: false };

  it('a click selects the topmost', () => {
    expect(monitorClickAction(hits, [], none)).toEqual({ kind: 'select', clipIds: ['top'] });
    expect(monitorClickAction(hits, ['other'], none)).toEqual({ kind: 'select', clipIds: ['top'] });
  });

  it('a click on empty canvas deselects; with Shift it keeps the selection', () => {
    expect(monitorClickAction([], ['top'], none)).toEqual({ kind: 'clear' });
    expect(monitorClickAction([], ['top'], { shift: true, alt: false })).toEqual({ kind: 'none' });
  });

  it('Alt+click walks down through the stack and wraps to the top', () => {
    const alt = { shift: false, alt: true };
    expect(monitorClickAction(hits, [], alt)).toEqual({ kind: 'select', clipIds: ['middle'] });
    expect(monitorClickAction(hits, ['top'], alt)).toEqual({ kind: 'select', clipIds: ['middle'] });
    expect(monitorClickAction(hits, ['middle'], alt)).toEqual({
      kind: 'select',
      clipIds: ['bottom'],
    });
    expect(monitorClickAction(hits, ['bottom'], alt)).toEqual({ kind: 'select', clipIds: ['top'] });
    expect(monitorClickAction(['only'], ['only'], alt)).toEqual({
      kind: 'select',
      clipIds: ['only'],
    });
  });

  it('Shift+click adds or removes the topmost', () => {
    const shift = { shift: true, alt: false };
    expect(monitorClickAction(hits, ['x'], shift)).toEqual({ kind: 'toggle', clipId: 'top' });
    expect(monitorClickAction(hits, ['top'], shift)).toEqual({ kind: 'toggle', clipId: 'top' });
    expect(monitorClickAction(hits, ['top'], { shift: true, alt: true })).toEqual({
      kind: 'toggle',
      clipId: 'middle',
    });
  });
});

describe('monitorMarqueeAction', () => {
  it('selects what the marquee touched; nothing touched deselects', () => {
    expect(monitorMarqueeAction(['a', 'b'], ['z'], false)).toEqual({
      kind: 'select',
      clipIds: ['a', 'b'],
    });
    expect(monitorMarqueeAction([], ['z'], false)).toEqual({ kind: 'clear' });
  });

  it('with Shift adds to the selection', () => {
    expect(monitorMarqueeAction(['a', 'b'], ['b', 'z'], true)).toEqual({
      kind: 'select',
      clipIds: ['b', 'z', 'a'],
    });
    expect(monitorMarqueeAction(['b'], ['b'], true)).toEqual({ kind: 'none' });
  });
});

function setters(): MonitorSelectionSetters & {
  selectClips: ReturnType<typeof vi.fn>;
  toggleSelection: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
} {
  return { selectClips: vi.fn(), toggleSelection: vi.fn(), clearSelection: vi.fn() };
}

describe('the selection is one shared state with the timeline', () => {
  it('a monitor click calls selectClips with the timeline clip id', () => {
    const shared = setters();
    const list = elements();
    applyMonitorSelection(
      monitorClickAction(monitorHitClipIds({ x: 50, y: 50 }, list), [], {
        shift: false,
        alt: false,
      }),
      shared,
    );
    expect(shared.selectClips).toHaveBeenCalledWith(['clip-captions']);
    applyMonitorSelection(
      monitorClickAction(monitorHitClipIds({ x: 50, y: 50 }, list), ['clip-captions'], {
        shift: true,
        alt: false,
      }),
      shared,
    );
    expect(shared.toggleSelection).toHaveBeenCalledWith('clip-captions');
    applyMonitorSelection(
      monitorClickAction(monitorHitClipIds({ x: 900, y: 900 }, list), ['clip-captions'], {
        shift: false,
        alt: false,
      }),
      shared,
    );
    expect(shared.clearSelection).toHaveBeenCalledTimes(1);
  });

  it('a "none" action writes nothing', () => {
    const shared = setters();
    applyMonitorSelection({ kind: 'none' }, shared);
    expect(shared.selectClips).not.toHaveBeenCalled();
    expect(shared.toggleSelection).not.toHaveBeenCalled();
    expect(shared.clearSelection).not.toHaveBeenCalled();
  });

  it('a timeline selection reaches the monitor as outlines, for every kind', () => {
    const list = elements();
    for (const [clipId, nodeId] of [
      ['clip-video', 'clip-video'],
      ['clip-picture', 'picture'],
      ['clip-title', 'title'],
      ['clip-captions', CAPTION],
      ['clip-shape', 'shape'],
      ['clip-3d', 'scene3d'],
    ] as const) {
      const overlay = monitorSelectionOverlay(list, [clipId]);
      expect(overlay.version).toBe(1);
      expect(overlay.selections.map((selection) => selection.nodeId)).toEqual([nodeId]);
      expect(overlay.selections[0]).toMatchObject({ x: 0, y: 0, width: 100, height: 100 });
      expect(overlay.selections[0]!.corners).toHaveLength(4);
    }
    expect(monitorSelectionOverlay(list, []).selections).toEqual([]);
  });

  it('hidden tracks are not outlined; locked ones still show their selection', () => {
    const list = elements([
      { id: 'v1', clips: ['clip-video'], locked: true },
      { id: 'v2', clips: ['clip-picture', 'clip-shape'], enabled: false },
      { id: 'v3', clips: ['clip-title', 'clip-3d'] },
      { id: 'c1', clips: ['clip-captions'] },
    ]);
    expect(
      monitorSelectionOverlay(list, ['clip-video', 'clip-picture']).selections.map((s) => s.nodeId),
    ).toEqual(['clip-video']);
  });

  it('sameMonitorOverlay compares outlines', () => {
    const list = elements();
    const a = monitorSelectionOverlay(list, ['clip-title']);
    expect(sameMonitorOverlay(a, monitorSelectionOverlay(list, ['clip-title']))).toBe(true);
    expect(sameMonitorOverlay(a, monitorSelectionOverlay(list, ['clip-shape']))).toBe(false);
  });
});
