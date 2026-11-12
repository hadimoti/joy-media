/**
 * T-M05a: the saved rotation reaches the render IR (ADR-0046 review B2).
 *
 * The Monitor and the export both build their frame with `buildRenderFrameIR`
 * from transforms resolved by `evaluateCameraExpressionTransform`, and draw it
 * with the Pixi preview path and the headless export path. These tests prove
 * that a project without rotation builds exactly the frame it built before,
 * and that a saved rotation is drawn, the same way, by both paths.
 */
import { describe, expect, it } from 'vitest';
import type { VisualObjectTransformV1, VisualObjectV1 } from '@joy-media/project-schema';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import { validateRenderFrameIR, type RenderFrameIR } from '@joy-media/render-ir';
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

function scene(rotationDeg: number | undefined): Record<string, VisualObjectV1> {
  const shapeTransform = transform({ rotationDeg: rotationDeg ?? 0 });
  if (rotationDeg === undefined) delete (shapeTransform as { rotationDeg?: number }).rotationDeg;
  return {
    box: { id: 'box', kind: 'shape', shape: 'rectangle', transform: shapeTransform },
    label: {
      id: 'label',
      kind: 'text',
      text: 'TURN',
      transform: transform({ x: 40, y: 180, scaleY: 1, rotationDeg: rotationDeg ?? 0 }),
    },
  } as Record<string, VisualObjectV1>;
}

/** The frame exactly as the Monitor and the export build it. */
function frameOf(objects: Record<string, VisualObjectV1>): RenderFrameIR {
  const resolved: ResolvedObject[] = Object.values(objects).map((object) => ({
    object,
    transform: evaluateCameraExpressionTransform(object.id, undefined, objects, 0, HEIGHT)
      .transform,
  }));
  return buildRenderFrameIR('root', 0, WIDTH, HEIGHT, resolved);
}

/** The conversion as it was before T-M05a: no rotation in the IR. */
function withoutRotation(frame: RenderFrameIR): RenderFrameIR {
  return {
    ...frame,
    nodes: frame.nodes.map((node) => {
      const { rotationDeg: _dropped, ...rest } = node.transform;
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

describe('transformToRenderTransform rotation (T-M05a)', () => {
  it('adds no rotation to the IR for 0, -0 or a value that is not finite', () => {
    for (const rotationDeg of [0, -0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(transformToRenderTransform(transform({ rotationDeg }))).toEqual({
        translateX: 70,
        translateY: 70,
        scaleX: 1,
        scaleY: 0.6,
      });
      expect(transformToRenderTransform(transform({ rotationDeg }))).not.toHaveProperty(
        'rotationDeg',
      );
    }
  });

  it('passes a saved rotation through unchanged', () => {
    expect(transformToRenderTransform(transform({ rotationDeg: 30 })).rotationDeg).toBe(30);
    expect(transformToRenderTransform(transform({ rotationDeg: -127.5 })).rotationDeg).toBe(-127.5);
  });
});

describe('a project without rotation builds and draws the same frame as before (T-M05a)', () => {
  for (const [label, rotationDeg] of [
    ['rotationDeg 0', 0],
    ['rotationDeg absent', undefined],
  ] as const) {
    it(`${label}: the IR is the old IR and both paths draw the old pixels`, () => {
      const frame = frameOf(scene(rotationDeg));
      expect(() => validateRenderFrameIR(frame)).not.toThrow();
      for (const node of frame.nodes) expect(node.transform).not.toHaveProperty('rotationDeg');
      expect(frame).toEqual(withoutRotation(frame));
      const now = digests(frame);
      const before = digests(withoutRotation(frame));
      expect(now.preview).toBe(before.preview);
      expect(now.exported).toBe(before.exported);
      expect(now.preview).toBe(now.exported);
    });
  }
});

describe('a saved rotation is drawn the same by the preview and the export (T-M05a)', () => {
  it('rotationDeg 30: the IR carries it, preview pixels equal export pixels', () => {
    const frame = frameOf(scene(30));
    expect(() => validateRenderFrameIR(frame)).not.toThrow();
    expect(frame.nodes.map((node) => node.transform.rotationDeg)).toEqual([30, 30]);
    const rotated = digests(frame);
    expect(rotated.preview).toBe(rotated.exported);
    // The rotation is really drawn: the pixels differ from the unrotated frame.
    const flat = digests(withoutRotation(frame));
    expect(rotated.preview).not.toBe(flat.preview);
    expect(rotated.exported).not.toBe(flat.exported);
  });

  it('a rotation inherited from a parent reaches the IR as well', () => {
    const objects = scene(0);
    const parent: VisualObjectV1 = {
      id: 'holder',
      kind: 'null',
      transform: transform({ x: 0, y: 0, scaleY: 1, rotationDeg: 15 }),
    } as VisualObjectV1;
    const child = { ...objects.box!, parentId: 'holder' } as VisualObjectV1;
    const frame = frameOf({ holder: parent, box: child });
    expect(frame.nodes).toHaveLength(1);
    expect(frame.nodes[0]!.transform.rotationDeg).toBe(15);
    const drawn = digests(frame);
    expect(drawn.preview).toBe(drawn.exported);
  });
});
