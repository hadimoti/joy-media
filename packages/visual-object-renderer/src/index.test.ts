import { describe, it, expect } from 'vitest';
import {
  visualObjectToRenderNode,
  buildRenderFrameIR,
  transformToRenderTransform,
  isTransitionActive,
  transitionProgress,
  clipTimesFromTracks,
} from './index.js';
import type { ResolvedObject } from './index.js';
import type { TransitionV1, VisualObjectV1 } from '@joy-media/project-schema';
import { validateRenderFrameIR } from '@joy-media/render-ir';

function makeObject(
  overrides: Partial<VisualObjectV1> & { id: string; kind: VisualObjectV1['kind'] },
): VisualObjectV1 {
  return {
    transform: {
      x: 100,
      y: 200,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
    ...overrides,
  };
}

function resolved(obj: VisualObjectV1): ResolvedObject {
  return { object: obj, transform: obj.transform };
}

describe('visualObjectToRenderNode', () => {
  it('returns undefined for null objects (controllers)', () => {
    const obj = makeObject({ id: 'null-1', kind: 'null' });
    expect(visualObjectToRenderNode(resolved(obj))).toBeUndefined();
  });

  it('returns undefined for camera objects (controllers)', () => {
    const obj = makeObject({ id: 'cam-1', kind: 'camera', camera: { fieldOfViewDeg: 60 } });
    expect(visualObjectToRenderNode(resolved(obj))).toBeUndefined();
  });

  it('maps text objects to text nodes', () => {
    const obj = makeObject({ id: 'text-1', kind: 'text', text: 'Hello' });
    const node = visualObjectToRenderNode(resolved(obj));
    expect(node).toBeDefined();
    if (node === undefined || node.kind !== 'text') throw new Error('expected a text node');
    expect(node.text).toBe('Hello');
    expect(node.id).toBe('text-1');
  });

  it('maps image objects to sprite nodes with placeholder dimensions', () => {
    const obj = makeObject({ id: 'img-1', kind: 'image', assetId: 'asset-a' });
    const node = visualObjectToRenderNode(resolved(obj));
    expect(node).toBeDefined();
    if (node === undefined || node.kind !== 'sprite') throw new Error('expected a sprite node');
    expect(node.width).toBe(100);
    expect(node.height).toBe(100);
  });

  it('maps shape objects to sprite nodes', () => {
    const obj = makeObject({ id: 'rect-1', kind: 'shape', shape: 'rectangle' });
    const node = visualObjectToRenderNode(resolved(obj));
    expect(node).toBeDefined();
    expect(node!.kind).toBe('sprite');
  });

  it('preserves opacity from the resolved transform', () => {
    const obj = makeObject({
      id: 'faded',
      kind: 'text',
      text: 'x',
      transform: { ...makeObject({ id: 'x', kind: 'text' }).transform, opacity: 0.5 },
    });
    const node = visualObjectToRenderNode(resolved(obj));
    expect(node).toBeDefined();
    expect(node!.opacity).toBe(0.5);
  });
});

describe('transformToRenderTransform', () => {
  it('converts VisualObjectTransformV1 to Transform2D', () => {
    const result = transformToRenderTransform({
      x: 10,
      y: 20,
      scaleX: 2,
      scaleY: 0.5,
      rotationDeg: 45,
      opacity: 1,
      positionZ: 100,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    });
    expect(result.translateX).toBe(10);
    expect(result.translateY).toBe(20);
    expect(result.scaleX).toBe(2);
    expect(result.scaleY).toBe(0.5);
  });
});

describe('buildRenderFrameIR', () => {
  it('produces a valid RenderFrameIR from resolved objects', () => {
    const objects: ResolvedObject[] = [
      resolved(
        makeObject({
          id: 'a',
          kind: 'image',
          transform: { ...makeObject({ id: 'a', kind: 'image' }).transform, x: 0, y: 0 },
        }),
      ),
      resolved(
        makeObject({
          id: 'b',
          kind: 'text',
          text: 'Hi',
          transform: { ...makeObject({ id: 'b', kind: 'text' }).transform, y: 50 },
        }),
      ),
      resolved(
        makeObject({
          id: 'null',
          kind: 'null',
          transform: { ...makeObject({ id: 'null', kind: 'null' }).transform, x: 200, y: 300 },
        }),
      ),
    ];

    const frame = buildRenderFrameIR('comp-1', 0, 1920, 1080, objects);

    // Should not throw
    expect(() => validateRenderFrameIR(frame)).not.toThrow();

    expect(frame.compositionId).toBe('comp-1');
    expect(frame.timeUs).toBe(0);
    expect(frame.viewport.width).toBe(1920);
    expect(frame.viewport.height).toBe(1080);

    // null object should be excluded
    expect(frame.nodes.length).toBe(2);
    expect(frame.nodes[0]!.kind).toBe('sprite');
    expect(frame.nodes[1]!.kind).toBe('text');
  });

  it('returns empty nodes array when all objects are controllers', () => {
    const objects: ResolvedObject[] = [
      resolved(makeObject({ id: 'n', kind: 'null' })),
      resolved(makeObject({ id: 'c', kind: 'camera', camera: { fieldOfViewDeg: 60 } })),
    ];
    const frame = buildRenderFrameIR('c', 0, 100, 100, objects);
    expect(frame.nodes).toHaveLength(0);
    expect(() => validateRenderFrameIR(frame)).not.toThrow();
  });

  it('produces deterministic output for the same input', () => {
    const obj = resolved(makeObject({ id: 'img', kind: 'image' }));
    const a = buildRenderFrameIR('c', 0, 480, 360, [obj]);
    const b = buildRenderFrameIR('c', 0, 480, 360, [obj]);
    expect(a).toEqual(b);
  });

  it('sizes html-scene nodes from the requested frame instead of a hard-coded reel preset', () => {
    const obj = resolved(
      makeObject({
        id: 'scene',
        kind: 'html-scene',
        scenePackageId: 'joy.scene',
      }),
    );
    const frame = buildRenderFrameIR('c', 0, 1280, 720, [obj]);
    const node = frame.nodes[0];
    expect(node?.kind).toBe('video-frame');
    if (node?.kind !== 'video-frame') throw new Error('expected html scene video frame');
    expect(node.width).toBe(1280);
    expect(node.height).toBe(720);
  });

  it('attaches per-object effects and master color grade', () => {
    const obj = resolved(makeObject({ id: 'img', kind: 'image' }));
    const frame = buildRenderFrameIR('c', 0, 100, 100, [obj], {
      colorGrade: { lift: 0.1, gamma: 1.1, gain: 0.9, saturation: 0.8 },
      effectsByObjectId: {
        img: [
          { id: 'e1', effectId: 'blur', enabled: true, params: { amount: 4 } },
          { id: 'e2', effectId: 'grain', enabled: false, params: { amount: 0.2 } },
        ],
      },
    });
    expect(frame.colorGrade).toEqual({
      lift: 0.1,
      gamma: 1.1,
      gain: 0.9,
      saturation: 0.8,
    });
    const sprite = frame.nodes[0];
    expect(sprite?.kind).toBe('sprite');
    if (sprite?.kind !== 'sprite') throw new Error('expected sprite');
    expect(sprite.effects).toEqual([
      { id: 'e1', kind: 'blur', enabled: true, params: { amount: 4 } },
      { id: 'e2', kind: 'grain', enabled: false, params: { amount: 0.2 } },
    ]);
  });
});

describe('transition timing', () => {
  const transition: TransitionV1 = {
    id: 't1',
    trackId: 'track-v',
    leftClipId: 'left',
    rightClipId: 'right',
    type: 'dissolve',
    durationUs: 1_000_000,
  };
  const clipTimes = clipTimesFromTracks([
    {
      clips: [
        { id: 'left', startUs: 0 },
        { id: 'right', startUs: 5_000_000 },
      ],
    },
  ]);

  it('is inactive outside the right-clip junction window', () => {
    expect(isTransitionActive(transition, 3_000_000, clipTimes)).toBe(false);
    expect(isTransitionActive(transition, 5_000_000, clipTimes)).toBe(false);
  });

  it('is active in [startUs - durationUs, startUs)', () => {
    expect(isTransitionActive(transition, 4_000_000, clipTimes)).toBe(true);
    expect(isTransitionActive(transition, 4_999_999, clipTimes)).toBe(true);
  });

  it('computes progress relative to the junction window', () => {
    expect(transitionProgress(transition, 4_000_000, clipTimes)).toBe(0);
    expect(transitionProgress(transition, 4_500_000, clipTimes)).toBe(0.5);
    expect(transitionProgress(transition, 4_999_999, clipTimes)).toBeCloseTo(0.999999, 5);
  });

  it('emits a transition node only while active', () => {
    const objects: ResolvedObject[] = [
      resolved(makeObject({ id: 'a', kind: 'shape', shape: 'rectangle' })),
    ];
    const inactive = buildRenderFrameIR('c', 0, 100, 100, objects, {
      transitions: [transition],
      clipTimes,
    });
    expect(inactive.nodes.some((n) => n.kind === 'transition')).toBe(false);

    const active = buildRenderFrameIR('c', 4_500_000, 100, 100, objects, {
      transitions: [transition],
      clipTimes,
    });
    const node = active.nodes.find((n) => n.kind === 'transition');
    expect(node?.kind).toBe('transition');
    if (node?.kind !== 'transition') throw new Error('expected transition');
    expect(node.progress).toBe(0.5);
    expect(node.transitionType).toBe('dissolve');
    expect(node.shaderId).toBe('dissolve');
  });

  it('maps curated gl:* types onto TransitionNode.shaderId + params', () => {
    const glTransition: TransitionV1 = {
      id: 't-gl',
      trackId: 'track-v',
      leftClipId: 'left',
      rightClipId: 'right',
      type: 'gl:CrossZoom',
      durationUs: 1_000_000,
      params: { strength: 0.4 },
    };
    const active = buildRenderFrameIR('c', 4_500_000, 100, 100, [], {
      transitions: [glTransition],
      clipTimes,
    });
    const node = active.nodes.find((n) => n.kind === 'transition');
    expect(node?.kind).toBe('transition');
    if (node?.kind !== 'transition') throw new Error('expected transition');
    expect(node.shaderId).toBe('gl:CrossZoom');
    expect(node.transitionType).toBe('gl:CrossZoom');
    expect(node.params).toEqual({ strength: 0.4 });
    expect(node.leftClipId).toBe('left');
    expect(node.rightClipId).toBe('right');
    expect(node.color.a).toBe(0);
  });
});
