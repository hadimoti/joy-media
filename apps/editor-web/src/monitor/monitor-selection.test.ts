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
import * as monitorSelectionExports from './monitor-selection.js';
import {
  applyMonitorSelection,
  buildMonitorElements,
  monitorCropAvailable,
  monitorClickAction,
  monitorHitClipIds,
  monitorMarqueeAction,
  monitorMarqueeClipIds,
  monitorSelectionOverlay,
  sameMonitorOverlay,
  currentMissingAssetIds,
  monitorCropOverlayNodeId,
  type MonitorSelectionSetters,
} from './monitor-selection.js';

const resolveMonitorOverlayObject = (
  monitorSelectionExports as unknown as {
    resolveMonitorOverlayObject?: (
      project: JoyProjectV1,
      nodeId: string,
      targets: readonly { readonly nodeId: string; readonly objectId?: string }[],
    ) => { readonly objectId: string; readonly object: VisualObjectV1 } | undefined;
  }
).resolveMonitorOverlayObject;

type ContextMenuAction = 'fit' | 'fill' | 'crop' | 'relink' | 'centre' | 'reset';
type MonitorContextMenuBuilder = (input: {
  readonly objectId: string;
  readonly clipId: string;
  readonly canFit: boolean;
  readonly canCrop: boolean;
  readonly missing: boolean;
  readonly showTransformActions?: boolean;
  readonly transformDisabledReason?: string;
  readonly centreDisabledReason?: string;
  readonly resetDisabledReason?: string;
  readonly alreadyCentred?: boolean;
  readonly alreadyReset?: boolean;
  readonly onAction: (action: ContextMenuAction, targetId: string) => void;
}) => readonly {
  readonly label: string;
  readonly action: () => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}[];

const buildMonitorContextMenuItems = (
  monitorSelectionExports as unknown as { buildMonitorContextMenuItems?: MonitorContextMenuBuilder }
).buildMonitorContextMenuItems;

const objectTransform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

describe('Monitor context menu actions', () => {
  it('resolves a video overlay node to its object and keeps the overlay node id', () => {
    expect(resolveMonitorOverlayObject).toBeTypeOf('function');
    const project = visualProject();
    const videoObject = {
      id: 'media-controller-video',
      kind: 'null',
      transform: objectTransform,
    } as unknown as VisualObjectV1;
    const videoProject = {
      ...project,
      visualObjects: { ...project.visualObjects, [videoObject.id]: videoObject },
    };
    const targets = [{ nodeId: 'clip-video', objectId: 'media-controller-video' }];
    const resolved = resolveMonitorOverlayObject!(videoProject, 'clip-video', targets);

    expect(resolved).toEqual({ objectId: 'media-controller-video', object: videoObject });
    expect(monitorCropOverlayNodeId(resolved?.objectId, targets)).toBe('clip-video');
  });

  it('uses the current panel context missing-media set instead of a cached panel closure', () => {
    const cached = new Set<string>();
    const current = new Set(['asset-missing']);
    expect(currentMissingAssetIds(current, cached)).toBe(current);
  });

  it('maps a video document object to the video clip node drawn by the Monitor', () => {
    expect(
      monitorCropOverlayNodeId('media-controller-video', [
        { objectId: 'media-controller-video', nodeId: 'clip-video' },
      ]),
    ).toBe('clip-video');
  });

  it('offers Crop for image and video clip children that have media assets', () => {
    expect(monitorCropAvailable({ kind: 'image' }, 'image')).toBe(true);
    expect(monitorCropAvailable({ kind: 'null' }, 'video')).toBe(true);
    expect(monitorCropAvailable({ kind: 'null' }, 'image')).toBe(true);
    expect(monitorCropAvailable({ kind: 'null' }, 'audio')).toBe(false);
    expect(monitorCropAvailable({ kind: 'text' }, 'video')).toBe(false);
  });

  it('routes each available action to the object or clip under the pointer', () => {
    expect(buildMonitorContextMenuItems).toBeTypeOf('function');
    const onAction = vi.fn();
    const items = buildMonitorContextMenuItems!({
      objectId: 'picture-7',
      clipId: 'clip-4',
      canFit: true,
      canCrop: true,
      missing: true,
      onAction,
    });

    for (const item of items) item.action();

    expect(items.map((item) => item.label)).toEqual([
      'Fit to frame',
      'Fill frame',
      'Crop',
      'Relink',
    ]);
    expect(onAction.mock.calls).toEqual([
      ['fit', 'picture-7'],
      ['fill', 'picture-7'],
      ['crop', 'picture-7'],
      ['relink', 'clip-4'],
    ]);
  });

  it('hides actions that do not apply to the clicked element', () => {
    expect(buildMonitorContextMenuItems).toBeTypeOf('function');
    const onAction = vi.fn();
    const items = buildMonitorContextMenuItems!({
      objectId: 'shape-2',
      clipId: 'clip-8',
      canFit: false,
      canCrop: false,
      missing: false,
      onAction,
    });

    expect(items).toEqual([]);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('routes Centre and Reset transform to the visual object', () => {
    const onAction = vi.fn();
    const items = buildMonitorContextMenuItems!({
      objectId: 'title-1',
      clipId: 'clip-1',
      canFit: false,
      canCrop: false,
      missing: false,
      showTransformActions: true,
      onAction,
    });

    expect(items.map((item) => item.label)).toEqual(['Centre', 'Reset transform']);
    for (const item of items) item.action();
    expect(onAction.mock.calls).toEqual([
      ['centre', 'title-1'],
      ['reset', 'title-1'],
    ]);
  });

  it('disables Centre and Reset transform when they are already in that state', () => {
    const items = buildMonitorContextMenuItems!({
      objectId: 'shape-1',
      clipId: 'clip-1',
      canFit: false,
      canCrop: false,
      missing: false,
      showTransformActions: true,
      alreadyCentred: true,
      alreadyReset: true,
      onAction: vi.fn(),
    });

    expect(items.map((item) => [item.label, item.disabled, item.disabledReason])).toEqual([
      ['Centre', true, 'Already centred.'],
      ['Reset transform', true, 'Already reset.'],
    ]);
  });

  it('shows unavailable transform actions disabled with their reason', () => {
    const items = buildMonitorContextMenuItems!({
      objectId: 'video-controller',
      clipId: 'clip-1',
      canFit: false,
      canCrop: false,
      missing: false,
      showTransformActions: true,
      transformDisabledReason: 'A parent of this element is on a locked track.',
      onAction: vi.fn(),
    });

    expect(items.map((item) => [item.label, item.disabled, item.disabledReason])).toEqual([
      ['Centre', true, 'A parent of this element is on a locked track.'],
      ['Reset transform', true, 'A parent of this element is on a locked track.'],
    ]);
  });

  it('disables only the transform action whose own reason blocks it', () => {
    const items = buildMonitorContextMenuItems!({
      objectId: 'picture-3',
      clipId: 'clip-3',
      canFit: false,
      canCrop: false,
      missing: false,
      showTransformActions: true,
      centreDisabledReason:
        'Position is animated or expression-driven, so Centre cannot set it here.',
      onAction: vi.fn(),
    });

    expect(items.map((item) => [item.label, item.disabled, item.disabledReason])).toEqual([
      ['Centre', true, 'Position is animated or expression-driven, so Centre cannot set it here.'],
      ['Reset transform', undefined, undefined],
    ]);
  });

  it('lets a shared reason override the per-action reasons', () => {
    const items = buildMonitorContextMenuItems!({
      objectId: 'picture-4',
      clipId: 'clip-4',
      canFit: false,
      canCrop: false,
      missing: false,
      showTransformActions: true,
      transformDisabledReason: 'The camera places this element. Change the camera instead.',
      centreDisabledReason:
        'Position is animated or expression-driven, so Centre cannot set it here.',
      resetDisabledReason:
        'Position, size or rotation is animated or expression-driven, so Reset cannot set it here.',
      onAction: vi.fn(),
    });

    expect(items.map((item) => [item.label, item.disabledReason])).toEqual([
      ['Centre', 'The camera places this element. Change the camera instead.'],
      ['Reset transform', 'The camera places this element. Change the camera instead.'],
    ]);
  });
});

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
  it('selects what the marquee touched; nothing touched keeps the selection', () => {
    expect(monitorMarqueeAction(['a', 'b'], ['z'], false)).toEqual({
      kind: 'select',
      clipIds: ['a', 'b'],
    });
    expect(monitorMarqueeAction([], ['z'], false)).toEqual({ kind: 'none' });
    expect(monitorMarqueeAction([], ['z'], true)).toEqual({ kind: 'none' });
  });

  it('only a plain click-and-release on empty canvas deselects', () => {
    const shared = setters();
    applyMonitorSelection(monitorMarqueeAction([], ['z'], false), shared);
    expect(shared.clearSelection).not.toHaveBeenCalled();
    applyMonitorSelection(monitorClickAction([], ['z'], { shift: false, alt: false }), shared);
    expect(shared.clearSelection).toHaveBeenCalledTimes(1);
    expect(shared.selectClips).not.toHaveBeenCalled();
    expect(shared.toggleSelection).not.toHaveBeenCalled();
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

describe('a clip that draws several objects (seed intro and product)', () => {
  function seedElements() {
    const base = visualProject();
    const seedObjects = {
      'intro-title': { id: 'intro-title', kind: 'text', text: 'I', transform: objectTransform },
      'scene-title': { id: 'scene-title', kind: 'text', text: 'S', transform: objectTransform },
      'product-image': {
        id: 'product-image',
        kind: 'image',
        assetId: 'img',
        transform: objectTransform,
      },
      'scene-lower-third': {
        id: 'scene-lower-third',
        kind: 'text',
        text: 'L',
        transform: objectTransform,
      },
    } as unknown as Record<string, VisualObjectV1>;
    const project = { ...base, visualObjects: { ...base.visualObjects, ...seedObjects } };
    const f: RenderFrameIR = {
      ...frame(),
      nodes: [
        node('product-image', 0, 0),
        node('scene-lower-third', 1, 300),
        node('intro-title', 2, 600),
        node('scene-title', 3, 900),
      ],
    };
    return buildMonitorElements({
      frame: f,
      nodeBounds: boundsOf(f),
      project,
      timeline: timeline([{ id: 'v1', clips: ['intro', 'product'] }]),
    });
  }

  it('every node of the clip maps to that clip', () => {
    expect(seedElements().map((element) => [element.id, element.clipId])).toEqual([
      ['scene-title', 'intro'],
      ['intro-title', 'intro'],
      ['scene-lower-third', 'product'],
      ['product-image', 'product'],
    ]);
  });

  it('clicking any node of the clip selects the clip', () => {
    const list = seedElements();
    expect(monitorHitClipIds({ x: 950, y: 950 }, list)).toEqual(['intro']);
    expect(monitorHitClipIds({ x: 350, y: 350 }, list)).toEqual(['product']);
    expect(
      monitorClickAction(monitorHitClipIds({ x: 950, y: 950 }, list), [], {
        shift: false,
        alt: false,
      }),
    ).toEqual({
      kind: 'select',
      clipIds: ['intro'],
    });
  });

  it('selecting the clip outlines all of its nodes', () => {
    const list = seedElements();
    expect(monitorSelectionOverlay(list, ['intro']).selections.map((s) => s.nodeId)).toEqual([
      'scene-title',
      'intro-title',
    ]);
    expect(monitorSelectionOverlay(list, ['product']).selections.map((s) => s.nodeId)).toEqual([
      'scene-lower-third',
      'product-image',
    ]);
  });
});
