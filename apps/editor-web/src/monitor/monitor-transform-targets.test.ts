import { describe, expect, it, vi } from 'vitest';
import type { JoyProjectV1, SpikeProject, VisualObjectV1 } from '@joy-media/project-schema';
import {
  nodeBoundsFromBox,
  type RenderFrameIR,
  type RenderNode,
  type Transform2D,
  type VideoFrameNode,
} from '@joy-media/render-ir';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import { bindClipToObject } from '../sticker-bindings.js';
import { groupGeometry } from './monitor-transform-group.js';
import { captionNodeId } from './monitor-ids.js';
import { buildMonitorElements } from './monitor-selection.js';
import {
  TRANSFORM_BLOCK_MESSAGES,
  buildTransformTargets,
  gestureBlockReason,
} from './monitor-transform-targets.js';
import { buildMonitorOverlays, sameMonitorOverlays } from './monitor-overlay-model.js';
import {
  gestureLabel,
  gesturePatches,
  nudgePatches,
  patchesChange,
  startTransformDrag,
  type MonitorTransformHost,
} from './monitor-transform-drag.js';
import {
  createMonitorTransformPreviewStore,
  withPreviewVideoNode,
  withTransformPatches,
} from './monitor-transform-preview.js';

const crop = { left: 0, top: 0, right: 0, bottom: 0 };
function t(x: number, y: number, extra: Record<string, number> = {}) {
  return { x, y, scaleX: 1, scaleY: 1, rotationDeg: 0, opacity: 1, crop, ...extra };
}

const CAPTION = captionNodeId('clip-captions', 'seg-1', 0);

function project(
  options: {
    objects?: Record<string, Partial<VisualObjectV1>>;
    camera?: boolean;
  } = {},
): JoyProjectV1 {
  const objects: Record<string, VisualObjectV1> = {
    shape: { id: 'shape', kind: 'shape', transform: t(100, 200) },
    title: { id: 'title', kind: 'text', text: 'Hi', transform: t(300, 400) },
    'video-obj': { id: 'video-obj', kind: 'image', transform: t(0, 0) },
    holder: { id: 'holder', kind: 'null', transform: t(50, 60, { scaleX: 2, rotationDeg: 90 }) },
    child: { id: 'child', kind: 'shape', parentId: 'holder', transform: t(10, 0) },
  } as unknown as Record<string, VisualObjectV1>;
  for (const [id, patch] of Object.entries(options.objects ?? {}))
    objects[id] = { ...objects[id]!, ...patch } as VisualObjectV1;
  const base = {
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
        ...(options.camera === true ? { activeCameraId: 'cam' } : {}),
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: objects,
    captionDocuments: {},
    pluginData: {},
  } as unknown as JoyProjectV1;
  let next = bindClipToObject(base, 'clip-shape', 'shape');
  next = bindClipToObject(next, 'clip-title', 'title');
  next = bindClipToObject(next, 'clip-video', 'video-obj');
  return bindClipToObject(next, 'clip-child', 'child');
}

function timeline(locked: readonly string[] = []): SpikeProject {
  const clips = ['clip-shape', 'clip-title', 'clip-video', 'clip-child', 'clip-captions'];
  return {
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        tracks: clips.map((id) => ({
          id: `track-${id}`,
          ...(locked.includes(id) ? { locked: true } : {}),
          clips: [{ id, kind: 'video' }],
        })),
      },
    },
  } as unknown as SpikeProject;
}

const BOX = { x: 0, y: 0, width: 100, height: 100 };
const TRANSFORMS: Record<string, Transform2D> = {
  shape: { translateX: 100, translateY: 200, scaleX: 1, scaleY: 1 },
  title: { translateX: 300, translateY: 400, scaleX: 1, scaleY: 1 },
  'clip-video': { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
  child: { translateX: 50, translateY: 80, scaleX: 2, scaleY: 1, rotationDeg: 90 },
  [CAPTION]: { translateX: 0, translateY: 1500, scaleX: 1, scaleY: 1 },
};

function frame(transforms: Record<string, Transform2D> = TRANSFORMS): RenderFrameIR {
  return {
    version: 1,
    compositionId: 'root',
    timeUs: 0,
    viewport: { width: 1080, height: 1920, dpr: 1 },
    nodes: Object.entries(transforms).map(
      ([id, transform], index) =>
        ({
          id,
          kind: 'sprite',
          zIndex: index,
          opacity: 1,
          width: 100,
          height: 100,
          color: { r: 0, g: 0, b: 0, a: 255 },
          transform,
        }) as unknown as RenderNode,
    ),
  } as unknown as RenderFrameIR;
}

function targets(
  selected: readonly string[],
  options: {
    project?: JoyProjectV1;
    locked?: readonly string[];
    agentPreviewOnScreen?: boolean;
    transforms?: Record<string, Transform2D>;
  } = {},
) {
  const visual = options.project ?? project();
  const transforms = options.transforms ?? TRANSFORMS;
  const drawn = frame(transforms);
  const elements = buildMonitorElements({
    frame: drawn,
    nodeBounds: (id) =>
      transforms[id] === undefined ? undefined : nodeBoundsFromBox(id, transforms[id]!, BOX),
    project: visual,
    timeline: timeline(options.locked),
  });
  return buildTransformTargets({
    elements,
    frame: drawn,
    project: visual,
    selectedClipIds: selected,
    timeUs: 0,
    agentPreviewOnScreen: options.agentPreviewOnScreen ?? false,
  });
}

describe('transform targets', () => {
  it('one target per drawn node of a selected clip, with the object it writes', () => {
    expect(targets([])).toEqual([]);
    const list = targets(['clip-shape', 'clip-video']);
    expect(list.map((target) => [target.nodeId, target.objectId])).toEqual([
      ['clip-video', 'video-obj'],
      ['shape', 'shape'],
    ]);
    const shape = list.find((target) => target.nodeId === 'shape')!;
    expect(shape.blocked).toEqual({});
    expect(shape.local).toEqual({ x: 100, y: 200, scaleX: 1, scaleY: 1, rotationDeg: 0 });
    expect(shape.geometry.transform).toEqual({
      x: 100,
      y: 200,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
    });
    expect(shape.geometry.corners[2]).toEqual({ x: 200, y: 300 });
  });

  it('a caption has no transform to write: every gesture is greyed', () => {
    const [caption] = targets(['clip-captions']);
    expect(caption!.objectId).toBeUndefined();
    expect(caption!.blocked).toEqual({
      move: 'no-object',
      scale: 'no-object',
      rotate: 'no-object',
    });
  });

  it('a locked track, an active camera and a staged agent preview grey everything', () => {
    expect(targets(['clip-shape'], { locked: ['clip-shape'] })[0]!.blocked.move).toBe('locked');
    const camera = targets(['clip-shape'], { project: project({ camera: true }) })[0]!;
    expect(camera.blocked).toEqual({ move: 'camera', scale: 'camera', rotate: 'camera' });
    const staged = targets(['clip-shape'], { agentPreviewOnScreen: true })[0]!;
    expect(staged.blocked).toEqual({
      move: 'agent-preview',
      scale: 'agent-preview',
      rotate: 'agent-preview',
    });
    expect(TRANSFORM_BLOCK_MESSAGES['agent-preview']).toMatch(/agent preview/);
  });

  it('a value from an expression greys the gestures that write it; a keyframed one does not (T-M05b)', () => {
    const expression = targets(['clip-shape'], {
      project: project({ objects: { shape: { expressions: { x: 'time * 10' } } } }),
    })[0]!;
    expect(expression.blocked).toEqual({ move: 'expression', scale: 'expression' });
    const animated = targets(['clip-shape'], {
      project: project({
        objects: {
          shape: {
            animations: {
              rotationDeg: { keyframes: [{ timeUs: 0, value: 0, interpolation: 'linear' }] },
            },
          } as unknown as Partial<VisualObjectV1>,
        },
      }),
    })[0]!;
    // T-M05b: a keyframed value is edited on the Monitor and keyed on release.
    expect(animated.blocked).toEqual({});
  });

  it("a parented object carries its parent's world values; a parent with no size blocks moving", () => {
    const [child] = targets(['clip-child']);
    expect(child!.parent).toEqual({ x: 50, y: 60, scaleX: 2, scaleY: 1, rotationDeg: 90 });
    const flat = targets(['clip-child'], {
      project: project({ objects: { holder: { transform: t(0, 0, { scaleX: 0 }) } } }),
    })[0]!;
    expect(flat.blocked).toEqual({ move: 'parent-zero-scale', scale: 'parent-zero-scale' });
    expect(gestureBlockReason([flat], 'rotate')).toBeUndefined();
  });
});

describe('the overlay model', () => {
  it('one element: the box with 8 scale handles and a rotate handle; several: boxes only', () => {
    const [shape] = targets(['clip-shape']);
    const [overlay] = buildMonitorOverlays([shape!], 0.5);
    expect(overlay!.handles.map((handle) => handle.id)).toEqual([
      'nw',
      'n',
      'ne',
      'e',
      'se',
      's',
      'sw',
      'w',
      'rotate',
    ]);
    // 24 screen px at 50 % zoom is 48 canvas px above the top edge.
    expect(overlay!.handles.at(-1)!.point).toEqual({ x: 150, y: 152 });
    const [a, b, c, d, e, f] = overlay!.localToCanvas;
    expect({ x: a! + c! + e!, y: b! + d! + f! }).toEqual({ x: 200, y: 300 });
    const pair = buildMonitorOverlays(targets(['clip-shape', 'clip-title']), 1);
    expect(pair.every((item) => item.handles.length === 0)).toBe(true);
    expect(
      sameMonitorOverlays(pair, buildMonitorOverlays(targets(['clip-shape', 'clip-title']), 1)),
    ).toBe(true);
  });

  it('greyed handles carry their reason', () => {
    const expression = targets(['clip-shape'], {
      project: project({ objects: { shape: { expressions: { scaleX: '2' } } } }),
    });
    const [overlay] = buildMonitorOverlays(expression, 1);
    expect(overlay!.handles.find((handle) => handle.id === 'se')!.blocked).toBe('expression');
    expect(overlay!.handles.find((handle) => handle.id === 'rotate')!.blocked).toBeUndefined();
  });
});

function host() {
  return {
    preview: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  } satisfies MonitorTransformHost;
}

describe('a gesture', () => {
  it('moves every selected object once, in its own parent space', () => {
    const list = targets(['clip-shape', 'clip-child']);
    const patches = gesturePatches(
      list,
      { kind: 'move' },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      {
        shift: false,
        alt: false,
      },
    )!;
    expect(patches.get('shape')).toEqual({ x: 110, y: 200, scaleX: 1, scaleY: 1, rotationDeg: 0 });
    // The parent is turned a quarter and twice as wide: frame +x is local -y.
    expect(patches.get('child')).toEqual({ x: 10, y: -10, scaleX: 1, scaleY: 1, rotationDeg: 0 });
  });

  it('scale and rotate need exactly one element', () => {
    const list = targets(['clip-shape', 'clip-title']);
    expect(
      gesturePatches(
        list,
        { kind: 'rotate' },
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        {
          shift: false,
          alt: false,
        },
      ),
    ).toBeUndefined();
    expect(
      startTransformDrag(list, { kind: 'scale', handle: 'se' }, { x: 0, y: 0 }, host()),
    ).toEqual({ blocked: 'nothing' });
  });

  it('previews on every move and writes one step on release', () => {
    const list = targets(['clip-shape']);
    const recorder = host();
    const drag = startTransformDrag(
      list,
      { kind: 'scale', handle: 'se' },
      { x: 200, y: 300 },
      recorder,
    );
    if ('blocked' in drag) throw new Error('blocked');
    drag.update({ x: 210, y: 310 }, { shift: false, alt: false });
    drag.update({ x: 250, y: 350 }, { shift: false, alt: false });
    expect(recorder.preview).toHaveBeenCalledTimes(2);
    drag.end(true);
    drag.end(true);
    expect(recorder.commit).toHaveBeenCalledTimes(1);
    expect(recorder.commit.mock.calls[0]![0]).toBe(gestureLabel({ kind: 'scale', handle: 'se' }));
    expect(recorder.commit.mock.calls[0]![1].get('shape')).toEqual({
      x: 100,
      y: 200,
      scaleX: 1.5,
      scaleY: 1.5,
      rotationDeg: 0,
    });
    expect(drag.active()).toBe(false);
  });

  it('a release without change, or a cancel, writes nothing', () => {
    const list = targets(['clip-shape']);
    for (const commit of [true, false]) {
      const recorder = host();
      const drag = startTransformDrag(list, { kind: 'move' }, { x: 5, y: 5 }, recorder);
      if ('blocked' in drag) throw new Error('blocked');
      if (!commit) drag.update({ x: 50, y: 5 }, { shift: false, alt: false });
      drag.end(commit);
      expect(recorder.commit).not.toHaveBeenCalled();
      expect(recorder.cancel).toHaveBeenCalledTimes(1);
    }
  });

  it('a blocked gesture does not start and says why', () => {
    const staged = targets(['clip-shape'], { agentPreviewOnScreen: true });
    expect(startTransformDrag(staged, { kind: 'move' }, { x: 0, y: 0 }, host())).toEqual({
      blocked: 'agent-preview',
    });
  });

  it('a nudge is the move of one key press; no change writes nothing', () => {
    const list = targets(['clip-shape']);
    expect(nudgePatches(list, { x: 0, y: 10 })!.get('shape')!.y).toBe(210);
    expect(nudgePatches(list, { x: 0, y: 0 })).toBeUndefined();
    expect(patchesChange(list, new Map([['shape', list[0]!.local]]))).toBe(false);
  });
});

describe('live values', () => {
  it('the store tells its listeners and forgets an empty set', () => {
    const store = createMonitorTransformPreviewStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    const patches = new Map([['shape', { x: 1, y: 2, scaleX: 1, scaleY: 1, rotationDeg: 0 }]]);
    store.set(patches);
    expect(store.get()).toBe(patches);
    store.set(new Map());
    expect(store.get()).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    store.set(patches);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('the drawn project takes the live values; without any it is the same project', () => {
    const visual = project();
    expect(withTransformPatches(visual, undefined)).toBe(visual);
    const patched = withTransformPatches(
      visual,
      new Map([['shape', { x: 1, y: 2, scaleX: 3, scaleY: 4, rotationDeg: 5 }]]),
    );
    expect(patched.visualObjects.shape!.transform).toEqual({
      ...visual.visualObjects.shape!.transform,
      x: 1,
      y: 2,
      scaleX: 3,
      scaleY: 4,
      rotationDeg: 5,
    });
    expect(visual.visualObjects.shape!.transform.x).toBe(100);
  });

  it("a video picture follows its object's live values", () => {
    const visual = project();
    const node = {
      id: 'clip-video',
      kind: 'video-frame',
      zIndex: 0,
      opacity: 1,
      width: 10,
      height: 10,
      sourceTimeUs: 0,
      color: { r: 0, g: 0, b: 0, a: 0 },
      transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
    } as VideoFrameNode;
    expect(withPreviewVideoNode(node, visual, undefined, 0)).toBe(node);
    const patches = new Map([['video-obj', { x: 7, y: 8, scaleX: 2, scaleY: 2, rotationDeg: 30 }]]);
    const moved = withPreviewVideoNode(node, withTransformPatches(visual, patches), patches, 0);
    expect(moved.transform).toEqual({
      translateX: 7,
      translateY: 8,
      scaleX: 2,
      scaleY: 2,
      rotationDeg: 30,
    });
  });
});

describe('T-M05b: keyframed values and the anchor point on the targets', () => {
  const curve = (value: number) => ({
    keyframes: [
      { timeUs: 0, value, interpolation: 'linear' as const },
      { timeUs: 1_000_000, value: value + 100, interpolation: 'linear' as const },
    ],
  });

  it('a keyframed value is read from its curve at the playhead, not from the static value', () => {
    const [shape] = targets(['clip-shape'], {
      project: project({
        objects: {
          shape: {
            animations: { x: curve(140), rotationDeg: curve(5) },
          } as Partial<VisualObjectV1>,
        },
      }),
    });
    expect(shape!.local).toEqual({ x: 140, y: 200, scaleX: 1, scaleY: 1, rotationDeg: 5 });
    expect(shape!.blocked).toEqual({});
  });

  it('carries the saved anchor (the centre when there is none)', () => {
    expect(targets(['clip-shape'])[0]!.anchor).toEqual({ x: 0.5, y: 0.5 });
    const [anchored] = targets(['clip-shape'], {
      project: project({
        objects: { shape: { transform: t(100, 200, { anchorX: 0, anchorY: 1 }) } },
      }),
    });
    expect(anchored!.anchor).toEqual({ x: 0, y: 1 });
    expect(anchored!.anchorBlocked).toBeUndefined();
  });

  it('the anchor of an element that is not turned can move even with position keyframes', () => {
    const [shape] = targets(['clip-shape'], {
      project: project({
        objects: { shape: { animations: { x: curve(100) } } as Partial<VisualObjectV1> },
      }),
    });
    expect(shape!.anchorBlocked).toBeUndefined();
  });

  it('an animated rotation, or a turned element with an animated position, blocks the anchor', () => {
    const rotating = targets(['clip-shape'], {
      project: project({
        objects: { shape: { animations: { rotationDeg: curve(0) } } as Partial<VisualObjectV1> },
      }),
    })[0]!;
    expect(rotating.anchorBlocked).toBe('animated');
    // The child is drawn turned a quarter (by its parent): its position must hold still too.
    const child = targets(['clip-child'], {
      project: project({
        objects: { child: { animations: { y: curve(0) } } as Partial<VisualObjectV1> },
      }),
    })[0]!;
    expect(child.anchorBlocked).toBe('animated');
    expect(TRANSFORM_BLOCK_MESSAGES.animated).toMatch(/anchor point/);
  });

  it('an animated parent rotation or any farther ancestor scale blocks the anchor', () => {
    const animatedParent = targets(['clip-child'], {
      project: project({
        objects: {
          holder: { animations: { rotationDeg: curve(90) } } as Partial<VisualObjectV1>,
        },
      }),
    })[0]!;
    expect(animatedParent.anchorBlocked).toBe('animated');

    const animatedGrandparent = targets(['clip-child'], {
      project: project({
        objects: {
          holder: { parentId: 'outer' } as Partial<VisualObjectV1>,
          outer: {
            id: 'outer',
            kind: 'null',
            transform: t(0, 0),
            animations: { scaleX: curve(1) },
          } as Partial<VisualObjectV1>,
        },
      }),
    })[0]!;
    expect(animatedGrandparent.ancestorObjectIds).toEqual(['holder', 'outer']);
    expect(animatedGrandparent.anchorBlocked).toBe('animated');
    expect(TRANSFORM_BLOCK_MESSAGES.animated).toMatch(/picture later/i);
  });

  it('an animated scale on a turned object blocks moving its anchor', () => {
    for (const channel of ['scaleX', 'scaleY'] as const) {
      const turned = targets(['clip-shape'], {
        project: project({
          objects: {
            shape: { animations: { [channel]: curve(1) } } as Partial<VisualObjectV1>,
          },
        }),
        transforms: {
          ...TRANSFORMS,
          shape: { translateX: 100, translateY: 200, scaleX: 1, scaleY: 1, rotationDeg: 45 },
        },
      })[0]!;

      expect(turned.anchorBlocked, channel).toBe('animated');
    }
  });

  it('an expression-driven rotation on the selected object blocks moving its anchor', () => {
    const scripted = targets(['clip-shape'], {
      project: project({ objects: { shape: { expressions: { rotationDeg: 'time' } } } }),
    })[0]!;

    expect(scripted.anchorBlocked).toBe('expression');
  });

  it('an expression-driven scale on the selected object blocks moving its anchor', () => {
    for (const channel of ['scaleX', 'scaleY'] as const) {
      const scripted = targets(['clip-shape'], {
        project: project({ objects: { shape: { expressions: { [channel]: '2' } } } }),
      })[0]!;

      expect(scripted.anchorBlocked, channel).toBe('expression');
    }
  });

  it('expression-driven scale or rotation on an ancestor blocks moving the child anchor', () => {
    for (const channel of ['scaleX', 'scaleY', 'rotationDeg'] as const) {
      const scriptedAncestor = targets(['clip-child'], {
        project: project({
          objects: { holder: { expressions: { [channel]: 'time' } } },
        }),
      })[0]!;

      expect(scriptedAncestor.anchorBlocked, channel).toBe('expression');
    }
  });

  it('leaves anchor movement available when transforms are not animated or expression-driven', () => {
    const [shape] = targets(['clip-shape']);

    expect(shape!.anchorBlocked).toBeUndefined();
  });

  it('what greys everything greys the anchor too', () => {
    expect(targets(['clip-shape'], { locked: ['clip-shape'] })[0]!.anchorBlocked).toBe('locked');
    expect(targets(['clip-shape'], { project: project({ camera: true }) })[0]!.anchorBlocked).toBe(
      'camera',
    );
    expect(targets(['clip-shape'], { agentPreviewOnScreen: true })[0]!.anchorBlocked).toBe(
      'agent-preview',
    );
    expect(targets(['clip-captions'])[0]!.anchorBlocked).toBe('no-object');
    const flat = targets(['clip-child'], {
      project: project({ objects: { holder: { transform: t(0, 0, { scaleX: 0 }) } } }),
    })[0]!;
    expect(flat.anchorBlocked).toBe('parent-zero-scale');
  });

  it('a parent and its child both selected: only the parent is written, the child follows (review fix)', () => {
    // The child hangs from the shape (at 100, 200, not turned): drawn at 110, 200.
    const visual = project({
      objects: { child: { parentId: 'shape', transform: t(10, 0) } as Partial<VisualObjectV1> },
    });
    const transforms = {
      ...TRANSFORMS,
      child: { translateX: 110, translateY: 200, scaleX: 1, scaleY: 1 },
    };
    const list = targets(['clip-shape', 'clip-child'], { project: visual, transforms });
    expect(list.find((target) => target.objectId === 'child')!.ancestorObjectIds).toEqual([
      'shape',
    ]);
    const group = groupGeometry(list.map((target) => target.geometry))!;
    const none = { shift: false, alt: false };
    const world = (objects: JoyProjectV1['visualObjects'], id: string) =>
      evaluateCameraExpressionTransform(id, undefined, objects, 0, 1920).transform;
    const before = world(visual.visualObjects, 'child');
    const written = (patches: ReturnType<typeof gesturePatches>) => {
      expect(patches).toBeDefined();
      expect([...patches!.keys()]).toEqual(['shape']);
      const next = withTransformPatches(visual, patches!, 0).visualObjects;
      // The child's own values are untouched: it follows its parent.
      expect(next.child).toEqual(visual.visualObjects.child);
      return { next, parent: patches!.get('shape')! };
    };

    // Move: the child moves by the drag once (not twice, as when both were patched).
    const moved = written(
      gesturePatches(list, { kind: 'move' }, { x: 0, y: 0 }, { x: 10, y: 5 }, none),
    );
    const movedChild = world(moved.next, 'child');
    expect(movedChild.x).toBeCloseTo(before.x + 10, 9);
    expect(movedChild.y).toBeCloseTo(before.y + 5, 9);

    // Scale: the child is scaled by the parent's factor once.
    const corner = group.corners[2];
    const scaled = written(
      gesturePatches(
        list,
        { kind: 'group-scale', handle: 'se' },
        corner,
        { x: corner.x + 40, y: corner.y + 40 },
        none,
      ),
    );
    expect(scaled.parent.scaleX).not.toBeCloseTo(1, 6);
    expect(world(scaled.next, 'child').scaleX).toBeCloseTo(scaled.parent.scaleX, 9);
    expect(world(scaled.next, 'child').scaleY).toBeCloseTo(scaled.parent.scaleY, 9);

    // Rotate: the child turns by the parent's turn once, rigidly about the group.
    const { center } = group;
    const turned = written(
      gesturePatches(
        list,
        { kind: 'group-rotate' },
        { x: center.x, y: center.y - 100 },
        { x: center.x + 100, y: center.y },
        none,
      ),
    );
    expect(turned.parent.rotationDeg).toBeCloseTo(90, 6);
    const turnedChild = world(turned.next, 'child');
    const turnedParent = world(turned.next, 'shape');
    expect(turnedChild.rotationDeg).toBeCloseTo(90, 6);
    // The child stays 10 px from its parent along the parent's turned x axis.
    expect(turnedChild.x - turnedParent.x).toBeCloseTo(0, 6);
    expect(turnedChild.y - turnedParent.y).toBeCloseTo(10, 6);

    // A nudge follows the same rule.
    expect([...nudgePatches(list, { x: 1, y: 0 })!.keys()]).toEqual(['shape']);
  });

  it('the release writes a key on the keyframed channel and a static value on the others', () => {
    const visual = project({
      objects: { shape: { animations: { x: curve(100) } } as Partial<VisualObjectV1> },
    });
    const list = targets(['clip-shape'], { project: visual });
    const patches = gesturePatches(
      list,
      { kind: 'move' },
      { x: 0, y: 0 },
      { x: 15, y: 5 },
      {
        shift: false,
        alt: false,
      },
    )!;
    const written = withTransformPatches(visual, patches, 0).visualObjects.shape!;
    expect(written.animations!.x!.keyframes[0]).toEqual({
      timeUs: 0,
      value: 115,
      interpolation: 'linear',
    });
    expect(written.animations!.x!.keyframes).toHaveLength(2);
    expect(written.transform.x).toBe(100);
    expect(written.transform.y).toBe(205);
  });
});
