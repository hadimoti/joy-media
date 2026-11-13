/**
 * T-M05b: the anchor point saved in a transform reaches the render IR as the
 * node's origin (ADR-0046 section 5.8). A transform without an anchor builds
 * exactly the frame it built before; a saved anchor only changes the point the
 * element turns about, and the preview and the export draw it the same way.
 */
import { describe, expect, it } from 'vitest';
import type { VisualObjectTransformV1, VisualObjectV1 } from '@joy-media/project-schema';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import { localToFramePoint, validateRenderFrameIR, type RenderFrameIR } from '@joy-media/render-ir';
import { renderPixiPreview } from '@joy-media/renderer-pixi';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import { digestRgba } from '@joy-media/golden-render';
import { buildRenderFrameIR, transformToRenderTransform, type ResolvedObject } from './index.js';

const WIDTH = 240;
const HEIGHT = 240;

function transform(overrides: Partial<VisualObjectTransformV1> = {}): VisualObjectTransformV1 {
  return {
    x: 70,
    y: 70,
    scaleX: 1,
    scaleY: 0.6,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    ...overrides,
  };
}

function box(overrides: Partial<VisualObjectTransformV1> = {}): Record<string, VisualObjectV1> {
  return {
    box: { id: 'box', kind: 'shape', shape: 'rectangle', transform: transform(overrides) },
  } as Record<string, VisualObjectV1>;
}

function frameOf(objects: Record<string, VisualObjectV1>): RenderFrameIR {
  const resolved: ResolvedObject[] = Object.values(objects).map((object) => ({
    object,
    transform: evaluateCameraExpressionTransform(object.id, undefined, objects, 0, HEIGHT)
      .transform,
  }));
  return buildRenderFrameIR('root', 0, WIDTH, HEIGHT, resolved);
}

function withoutOrigin(frame: RenderFrameIR): RenderFrameIR {
  return {
    ...frame,
    nodes: frame.nodes.map((node) => {
      const { origin: _dropped, ...rest } = node.transform;
      return { ...node, transform: rest };
    }),
  } as RenderFrameIR;
}

function digests(frame: RenderFrameIR): { preview: string; exported: string } {
  return {
    preview: digestRgba(renderPixiPreview(frame).pixels),
    exported: digestRgba(renderHeadlessFrame(frame).pixels),
  };
}

describe('transformToRenderTransform anchor (T-M05b)', () => {
  it('adds no origin when there is no anchor, or the anchor is the centre', () => {
    for (const anchor of [{}, { anchorX: 0.5, anchorY: 0.5 }, { anchorX: 0.5 }]) {
      expect(transformToRenderTransform(transform(anchor))).toEqual({
        translateX: 70,
        translateY: 70,
        scaleX: 1,
        scaleY: 0.6,
      });
    }
  });

  it('passes a saved anchor through as the origin (a missing half is the centre)', () => {
    expect(transformToRenderTransform(transform({ anchorX: 0, anchorY: 1 })).origin).toEqual({
      x: 0,
      y: 1,
    });
    expect(transformToRenderTransform(transform({ anchorX: 0.25 })).origin).toEqual({
      x: 0.25,
      y: 0.5,
    });
    expect(
      transformToRenderTransform(transform({ anchorX: Number.NaN, anchorY: 0.5 })),
    ).not.toHaveProperty('origin');
  });
});

describe('a project without an anchor builds and draws the same frame as before (T-M05b)', () => {
  for (const rotationDeg of [0, 30]) {
    it(`rotation ${rotationDeg}: the IR has no origin and the pixels are the old pixels`, () => {
      const frame = frameOf(box({ rotationDeg }));
      expect(() => validateRenderFrameIR(frame)).not.toThrow();
      for (const node of frame.nodes) expect(node.transform).not.toHaveProperty('origin');
      expect(frame).toEqual(withoutOrigin(frame));
      const now = digests(frame);
      expect(now.preview).toBe(now.exported);
    });
  }
});

describe('a saved anchor turns the element about it, the same in preview and export (T-M05b)', () => {
  it('with rotation 0 the anchor changes no pixel', () => {
    const anchored = frameOf(box({ anchorX: 0, anchorY: 0 }));
    expect(anchored.nodes[0]!.transform.origin).toEqual({ x: 0, y: 0 });
    const plain = frameOf(box());
    expect(digests(anchored)).toEqual(digests(plain));
  });

  it('with rotation 30 the element turns about its top-left corner', () => {
    const frame = frameOf(box({ rotationDeg: 30, anchorX: 0, anchorY: 0 }));
    expect(() => validateRenderFrameIR(frame)).not.toThrow();
    const node = frame.nodes[0]!;
    // The top-left corner (the anchor) stays where it is without rotation.
    const corner = localToFramePoint(
      node.transform,
      { x: 0, y: 0, width: 100, height: 100 },
      {
        x: 0,
        y: 0,
      },
    );
    expect(corner.x).toBeCloseTo(70, 9);
    expect(corner.y).toBeCloseTo(70, 9);
    const drawn = digests(frame);
    expect(drawn.preview).toBe(drawn.exported);
    const aboutCentre = digests(frameOf(box({ rotationDeg: 30 })));
    expect(drawn.preview).not.toBe(aboutCentre.preview);
    expect(drawn.exported).not.toBe(aboutCentre.exported);
  });

  it('a parented element keeps its own anchor', () => {
    const parent = {
      id: 'holder',
      kind: 'null',
      transform: transform({ x: 0, y: 0, scaleY: 1, rotationDeg: 15 }),
    } as VisualObjectV1;
    const child = {
      ...box({ anchorX: 0, anchorY: 1 }).box!,
      parentId: 'holder',
    } as VisualObjectV1;
    const frame = frameOf({ holder: parent, box: child });
    expect(frame.nodes).toHaveLength(1);
    expect(frame.nodes[0]!.transform.origin).toEqual({ x: 0, y: 1 });
    const drawn = digests(frame);
    expect(drawn.preview).toBe(drawn.exported);
  });
});
