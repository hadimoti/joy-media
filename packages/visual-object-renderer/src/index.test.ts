import { describe, it, expect } from 'vitest';
import {
  visualObjectToRenderNode,
  buildRenderFrameIR,
  transformToRenderTransform,
} from './index.js';
import type { ResolvedObject } from './index.js';
import type { VisualObjectV1 } from '@joy-media/project-schema';
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
});
